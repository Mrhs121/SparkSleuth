import type { LLMClient } from '@sparksleuth/core';
import { Db } from '../db.js';
import { MemoryStoreImpl } from './store.js';

/**
 * Once a day, look back over recent sessions and propose lessons.
 * Nothing is promoted automatically: a human reviews each candidate first.
 */
export async function runDream(
  db: Db,
  memory: MemoryStoreImpl,
  llm: LLMClient,
  opts: { days?: number; maxSessions?: number } = {},
): Promise<{ candidates: number }> {
  const days = opts.days ?? 7;
  const docs = await memory.listDocuments(opts.maxSessions ?? 20);
  const cutoff = Date.now() - days * 86_400_000;
  const recent = docs.filter((d) => Date.parse(d.date) >= cutoff);
  if (!recent.length) return { candidates: 0 };

  const bodies: string[] = [];
  for (const d of recent) {
    const body = await memory.get(d.sid);
    if (body) bodies.push(`### ${d.title}\n${body.slice(0, 3000)}`);
  }
  if (!bodies.length) return { candidates: 0 };

  const prompt = `Below are write-ups of recent Spark diagnostic sessions.

Extract reusable lessons: patterns that would change how a future investigation is conducted. Good lessons are specific, checkable, and generalise beyond one application (for example "a self join on a non-unique user id produces N^2 rows; cap it with a Top-N window before joining").

Bad lessons are restatements of one incident ("the j1 job was slow"), obvious ("check the metrics"), or speculative.

Return JSON only: {"lessons": ["...", "..."]} with at most 5 items, each under 200 characters. Return an empty array if nothing generalises.

--- SESSIONS ---
${bodies.join('\n\n').slice(0, 20_000)}`;

  const result = await llm.complete(
    { system: 'You extract durable engineering lessons from incident notes.', messages: [{ role: 'user', content: prompt }], tools: [] },
    {},
  );
  const text = result.blocks
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const parsed = parseJson(text);
  const lessons: string[] = Array.isArray(parsed?.lessons) ? parsed!.lessons.map(String) : [];
  const today = new Date().toISOString().slice(0, 10);
  for (const lesson of lessons.slice(0, 5)) db.addDreamCandidate(today, lesson.trim());
  return { candidates: lessons.length };
}

function parseJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Schedule the dream to run once a day at the given local hour. */
export function scheduleDream(hour: number, task: () => Promise<unknown>): NodeJS.Timeout {
  const tick = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = next.getTime() - now.getTime();
    const timer = setTimeout(async () => {
      try {
        await task();
      } catch (err) {
        console.error('[dream] failed:', err instanceof Error ? err.message : err);
      }
      scheduleNext();
    }, delay);
    timer.unref?.();
    return timer;
  };
  let handle: NodeJS.Timeout;
  const scheduleNext = () => {
    handle = tick();
  };
  handle = tick();
  return handle;
}
