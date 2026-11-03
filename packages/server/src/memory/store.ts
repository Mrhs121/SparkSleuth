import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryHit, MemoryStore } from '@sparksleuth/core';
import { Db } from '../db.js';

export interface MemoryEntry {
  sid: string;
  title: string;
  tags: string[];
  description: string;
  document: string;
  appIds?: string[];
  rules?: string[];
}

/**
 * Three tiers, as separate files plus an index:
 *   index  — one searchable row per session
 *   doc    — the write-up behind that row
 *   log    — the raw event stream, for replay and audit
 * Plus `permanent/`: lessons a human approved, which outrank raw sessions.
 */
export class MemoryStoreImpl implements MemoryStore {
  constructor(
    private readonly dir: string,
    private readonly db: Db,
  ) {}

  private get indexFile(): string {
    return join(this.dir, 'index.jsonl');
  }
  private docsDir(): string {
    return join(this.dir, 'docs');
  }
  private logsDir(): string {
    return join(this.dir, 'logs');
  }
  private permanentDir(): string {
    return join(this.dir, 'permanent');
  }

  async init(): Promise<void> {
    await mkdir(this.docsDir(), { recursive: true });
    await mkdir(this.logsDir(), { recursive: true });
    await mkdir(this.permanentDir(), { recursive: true });
  }

  async search(query: { keyword?: string; tags?: string[]; days?: number; limit?: number }): Promise<MemoryHit[]> {
    const since = query.days ? Date.now() - query.days * 86_400_000 : 0;
    const rows = this.db.listMemoryIndex(500).filter((r) => r.created_at >= since);

    const keyword = query.keyword?.toLowerCase().trim();
    const wanted = query.tags?.map((t) => t.toLowerCase()) ?? [];
    const hasQuery = Boolean(keyword || wanted.length > 0);

    const scored = rows
      .map((r) => {
        const tags = safeJson<string[]>(r.tags, []);
        let relevance = 0;
        if (keyword) {
          const haystack = `${r.title} ${r.description} ${r.tags}`.toLowerCase();
          if (haystack.includes(keyword)) relevance += 3;
          for (const word of keyword.split(/\s+/).filter(Boolean)) {
            if (haystack.includes(word)) relevance += 1;
          }
        }
        for (const t of wanted) {
          if (tags.some((tag) => tag.toLowerCase().includes(t))) relevance += 2;
        }

        // Recency bonus: small weight in [0, 0.5] decaying over 30 days.
        const ageMs = Math.max(0, Date.now() - r.created_at);
        const recencyBonus = Math.max(0, 0.5 * (1 - ageMs / (30 * 86_400_000)));

        const score = relevance + recencyBonus;
        return { r, tags, relevance, score };
      })
      .filter((x) => (hasQuery ? x.relevance > 0 : x.score > 0))
      .sort((a, b) => b.score - a.score)
      .slice(0, query.limit ?? 5);

    return scored.map(({ r, tags }) => ({
      sid: r.sid,
      title: r.title,
      tags,
      desc: r.description,
      date: new Date(r.created_at).toISOString(),
      appIds: safeJson<string[]>(r.app_ids, []),
      rules: safeJson<string[]>(r.rules, []),
    }));
  }

  async get(sid: string): Promise<string | null> {
    const path = join(this.docsDir(), `${sid}.md`);
    if (!existsSync(path)) return null;
    return readFile(path, 'utf8');
  }

  async experience(topic?: string): Promise<string[]> {
    if (!existsSync(this.permanentDir())) return [];
    const files = await readdir(this.permanentDir());
    const out: string[] = [];
    for (const file of files.filter((f) => f.endsWith('.md'))) {
      const text = await readFile(join(this.permanentDir(), file), 'utf8');
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('- ')) continue;
        if (topic && !trimmed.toLowerCase().includes(topic.toLowerCase())) continue;
        out.push(trimmed.slice(2));
      }
    }
    return out.slice(0, 20);
  }

  async save(entry: MemoryEntry): Promise<void> {
    await this.init();
    await writeFile(join(this.docsDir(), `${entry.sid}.md`), `# ${entry.title}\n\n${entry.document}\n`, 'utf8');
    await appendFile(
      this.indexFile,
      `${JSON.stringify({ ...entry, savedAt: new Date().toISOString() })}\n`,
      'utf8',
    );
    this.db.upsertMemoryIndex({
      sid: entry.sid,
      created_at: Date.now(),
      title: entry.title,
      tags: JSON.stringify(entry.tags),
      description: entry.description,
      app_ids: JSON.stringify(entry.appIds ?? []),
      rules: JSON.stringify(entry.rules ?? []),
    });
  }

  async archiveLog(sid: string, lines: string[]): Promise<void> {
    await this.init();
    await writeFile(join(this.logsDir(), `${sid}.jsonl`), lines.join('\n'), 'utf8');
  }

  async promoteLesson(lines: string[], topic = 'lessons'): Promise<string> {
    await this.init();
    const path = join(this.permanentDir(), `${topic}.md`);
    const header = existsSync(path) ? '' : `# ${topic}\n\n`;
    await appendFile(path, `${header}${lines.map((l) => `- ${l.replace(/^-\s*/, '')}`).join('\n')}\n`, 'utf8');
    return path;
  }

  async listDocuments(limit = 50): Promise<Array<{ sid: string; title: string; description: string; tags: string[]; date: string }>> {
    return this.db.listMemoryIndex(limit).map((r) => ({
      sid: r.sid,
      title: r.title,
      description: r.description,
      tags: safeJson<string[]>(r.tags, []),
      date: new Date(r.created_at).toISOString(),
    }));
  }
}

function safeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
