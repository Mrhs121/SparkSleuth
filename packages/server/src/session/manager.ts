import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  Agent,
  ArtifactStore,
  LLMClient,
  ToolRegistry,
  buildSystemPrompt,
  createMemorySkill,
  createSessionSkill,
  type AgentEvent,
  type Config,
  type Message,
} from '@sparksleuth/core';
import { sparkSkills } from '@sparksleuth/skills-spark';
import { Db } from '../db.js';
import { MemoryStoreImpl } from '../memory/store.js';

export interface EmittedEvent {
  type: string;
  ts: number;
  [key: string]: unknown;
}

export interface SessionSummary {
  title: string;
  tags: string[];
  description: string;
  document: string;
}

interface ActiveRun {
  abort: AbortController;
  messages: Message[];
  usage: { input: number; output: number };
}

/**
 * Owns the lifecycle: create a workspace, assemble the prompt and skills, run
 * the agent, persist every event, and summarise the session at the end.
 */
export class SessionManager {
  private readonly llm: LLMClient;
  private readonly runs = new Map<string, ActiveRun>();
  private readonly subscribers = new Map<string, Set<(e: EmittedEvent) => void>>();
  private readonly textBuffers = new Map<string, string>();
  private readonly thinkingBuffers = new Map<string, string>();

  constructor(
    private readonly config: Config,
    private readonly db: Db,
    private readonly memory: MemoryStoreImpl,
  ) {
    this.llm = new LLMClient(config.llm);
  }

  workspace(sid: string): string {
    return resolve(this.config.runtime.dataDir, 'workspaces', sid);
  }

  async create(input: { message: string; appId?: string }): Promise<{ sid: string }> {
    const sid = randomUUID();
    const title = input.message.slice(0, 60) + (input.message.length > 60 ? '…' : '');
    this.db.createSession(sid, title);
    await mkdir(join(this.workspace(sid), 'reports'), { recursive: true });
    await mkdir(join(this.workspace(sid), 'artifacts'), { recursive: true });
    this.db.updateSession(sid, { app_ids: JSON.stringify(input.appId ? [input.appId] : []) });

    // Fire and forget: the client follows progress over the websocket.
    void this.run(sid, this.firstTurn(input));
    return { sid };
  }

  private firstTurn(input: { message: string; appId?: string }): string {
    return input.appId
      ? `Spark application: ${input.appId}\n\n${input.message}`
      : input.message;
  }

  async continue(sid: string, message: string): Promise<void> {
    if (this.runs.has(sid)) throw new Error('This session is still running. Wait for it to finish or cancel it.');
    void this.run(sid, message);
  }

  private async run(sid: string, userMessage: string): Promise<void> {
    const session = this.db.getSession(sid);
    if (!session) throw new Error(`Unknown session ${sid}`);

    const abort = new AbortController();
    const active: ActiveRun = { abort, messages: [], usage: { input: 0, output: 0 } };
    this.runs.set(sid, active);
    this.db.updateSession(sid, { status: 'running' });

    try {
      active.messages = await this.loadHistory(sid);
      active.messages.push({ role: 'user', content: userMessage });
      this.emit(sid, { type: 'user_message', text: userMessage });

      const artifacts = ArtifactStore.forSession(this.config.runtime.dataDir, sid);
      const registry = new ToolRegistry(
        [
          ...sparkSkills,
          createSessionSkill({
            markPurpose: async (p) => {
              this.db.updateSession(sid, { purpose: `${p.type}: ${p.desc}` });
              this.emit(sid, { type: 'purpose', purpose: p.type, target: p.target, desc: p.desc });
            },
            reportFinding: async (f) => {
              this.db.addFinding(sid, f.stage, f.tools, f.finding);
              this.emit(sid, { type: 'finding', ...f });
            },
            saveReport: async (r) => {
              const path = join(this.workspace(sid), 'reports', `report-${Date.now()}.md`);
              // The model usually opens with its own H1; do not stack two.
              const body = r.markdown.replace(/^\s*#\s+.*\n+/, '');
              await writeFile(path, `# ${r.title}\n\n${body}\n`, 'utf8');
              this.emit(sid, { type: 'report', path, title: r.title });
              return { path };
            },
          }),
          createMemorySkill(this.memory),
        ],
        { config: this.config },
      );

      const memories = await this.memory
        .search({ keyword: userMessage.slice(0, 120), limit: 3 })
        .catch(() => []);
      const experience = await this.memory.experience().catch(() => []);

      const system = buildSystemPrompt({
        catalog: registry.catalog(),
        historyServerUrl: this.config.spark.historyServerUrl,
        now: new Date().toISOString(),
        memories: memories.map((m) => `${m.title} (${m.date.slice(0, 10)}): ${m.desc}`),
        experience,
      });

      const agent = new Agent(this.llm, registry, this.config);
      const result = await agent.run({
        system,
        messages: active.messages,
        artifacts,
        sessionId: sid,
        signal: abort.signal,
        emit: (e) => this.forward(sid, e),
      });

      active.messages = result.messages;
      active.usage = result.usage;
      this.flushText(sid);
      this.db.addUsage(sid, result.usage.input, result.usage.output);
      this.db.updateSession(sid, { status: 'waiting', last_message: this.lastAssistantText(result.messages) });
      this.emit(sid, { type: 'done', reason: result.reason, usage: result.usage });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.flushText(sid);
      this.db.updateSession(sid, { status: 'failed' });
      this.emit(sid, { type: 'error', message });
    } finally {
      this.runs.delete(sid);
    }
  }

  /** Translate agent events into persisted, broadcast UI events. */
  private forward(sid: string, e: AgentEvent): void {
    switch (e.type) {
      case 'text_delta': {
        this.textBuffers.set(sid, (this.textBuffers.get(sid) ?? '') + e.text);
        this.broadcast(sid, { type: 'text_delta', text: e.text, ts: Date.now() });
        return;
      }
      case 'thinking_delta': {
        this.thinkingBuffers.set(sid, (this.thinkingBuffers.get(sid) ?? '') + e.text);
        this.broadcast(sid, { type: 'thinking_delta', text: e.text, ts: Date.now() });
        return;
      }
      case 'step_start':
        this.flushText(sid);
        this.emit(sid, { type: 'step_start', step: e.step });
        return;
      case 'usage':
        this.emit(sid, { type: 'usage', usage: e.usage });
        return;
      default:
        this.emit(sid, { ...e } as unknown as Record<string, unknown>);
    }
  }

  private flushText(sid: string): void {
    const buffered = this.textBuffers.get(sid);
    if (buffered) {
      this.textBuffers.delete(sid);
      this.db.appendEvent(sid, 'text', { type: 'text', text: buffered, ts: Date.now() });
    }
    // Thinking is coalesced the same way: one row per step, not per token.
    const thinking = this.thinkingBuffers.get(sid);
    if (thinking) {
      this.thinkingBuffers.delete(sid);
      this.db.appendEvent(sid, 'thinking', { type: 'thinking', text: thinking, ts: Date.now() });
    }
  }

  private emit(sid: string, event: Record<string, unknown>): void {
    const e: EmittedEvent = { ts: Date.now(), ...event } as EmittedEvent;
    this.db.appendEvent(sid, e.type, e);
    this.broadcast(sid, e);
  }

  private broadcast(sid: string, event: EmittedEvent): void {
    for (const cb of this.subscribers.get(sid) ?? []) {
      try {
        cb(event);
      } catch {
        // A broken subscriber must not break the run.
      }
    }
  }

  subscribe(sid: string, cb: (e: EmittedEvent) => void): () => void {
    let set = this.subscribers.get(sid);
    if (!set) {
      set = new Set();
      this.subscribers.set(sid, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (set!.size === 0) this.subscribers.delete(sid);
    };
  }

  replay(sid: string): EmittedEvent[] {
    return this.db.listEvents(sid).map((row) => JSON.parse(row.payload) as EmittedEvent);
  }

  isRunning(sid: string): boolean {
    return this.runs.has(sid);
  }

  cancel(sid: string): boolean {
    const run = this.runs.get(sid);
    if (!run) return false;
    run.abort.abort(new Error('cancelled by user'));
    this.db.updateSession(sid, { status: 'cancelled' });
    this.emit(sid, { type: 'cancelled' });
    return true;
  }

  /** Rebuild conversation state so follow-up questions keep context. */
  private async loadHistory(sid: string): Promise<Message[]> {
    const messages: Message[] = [];
    const events = this.db.listEvents(sid);
    let pendingAssistant = '';
    for (const row of events) {
      const payload = JSON.parse(row.payload) as EmittedEvent;
      if (payload.type === 'text' && typeof payload.text === 'string') {
        pendingAssistant += `${payload.text}\n`;
      } else if (payload.type === 'user_message' && typeof payload.text === 'string') {
        if (pendingAssistant.trim()) messages.push({ role: 'assistant', content: pendingAssistant.trim() });
        pendingAssistant = '';
        messages.push({ role: 'user', content: payload.text });
      }
    }
    if (pendingAssistant.trim()) messages.push({ role: 'assistant', content: pendingAssistant.trim() });
    return messages.slice(-12);
  }

  private lastAssistantText(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'assistant') continue;
      if (typeof m.content === 'string') return m.content.slice(0, 400);
      const text = m.content
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      if (text.trim()) return text.slice(0, 400);
    }
    return '';
  }

  /* ------------------------------------------------------------------ *
   * Session wrap-up: summarise into the memory index.
   * ------------------------------------------------------------------ */

  async finish(sid: string): Promise<{ ok: boolean; summary?: SessionSummary }> {
    const session = this.db.getSession(sid);
    if (!session) throw new Error(`Unknown session ${sid}`);
    if (this.runs.has(sid)) throw new Error('Session is still running');

    this.db.updateSession(sid, { status: 'finalizing' });
    const findings = this.db.listFindings(sid);
    const events = this.db.listEvents(sid);

    await this.memory.archiveLog(
      sid,
      events.map((e) => e.payload),
    );

    const transcript = this.buildTranscript(events, findings);
    let summary: SessionSummary;
    try {
      summary = await this.summarise(transcript);
    } catch {
      summary = {
        title: session.title,
        tags: [],
        description: transcript.slice(0, 100),
        document: transcript,
      };
    }

    const appIds = collectAppIds(transcript);
    const rules = [...new Set(findings.flatMap((f) => extractRuleIds(f.finding)))];
    await this.memory.save({
      sid,
      title: summary.title,
      tags: summary.tags,
      description: summary.description,
      document: summary.document,
      appIds,
      rules,
    });

    this.db.updateSession(sid, { status: 'closed', title: summary.title });
    this.emit(sid, { type: 'closed', title: summary.title });
    return { ok: true, summary };
  }

  private buildTranscript(events: Array<{ payload: string }>, findings: Array<{ stage: string; finding: string }>): string {
    const lines: string[] = [];
    for (const row of events) {
      const e = JSON.parse(row.payload) as EmittedEvent;
      if (e.type === 'user_message') lines.push(`USER: ${e.text}`);
      else if (e.type === 'text') lines.push(`ASSISTANT: ${e.text}`);
      else if (e.type === 'tool_use') lines.push(`TOOL ${String(e.skill)}.${String(e.tool)}: ${JSON.stringify(e.input).slice(0, 200)}`);
      else if (e.type === 'finding') lines.push(`FINDING [${e.stage}]: ${e.finding}`);
    }
    for (const f of findings) lines.push(`MILESTONE [${f.stage}]: ${f.finding}`);
    return lines.join('\n').slice(-24_000);
  }

  private async summarise(transcript: string): Promise<SessionSummary> {
    const prompt = `Summarise this Spark diagnostic session for a memory index.

Return JSON only, no prose:
{"title": "short title, max 40 chars", "tags": ["3-6 lowercase tags"], "description": "one sentence, max 100 chars", "document": "markdown write-up, max 60 lines, sections: Background / Conclusion / Path taken / Dead ends and corrections / Reusable lessons"}

The document must state what was actually observed, not what was assumed.

--- TRANSCRIPT ---
${transcript}`;

    const result = await this.llm.complete(
      { system: 'You write precise, compact engineering notes.', messages: [{ role: 'user', content: prompt }], tools: [] },
      {},
    );
    const text = result.blocks
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const json = extractJson(text);
    if (!json) throw new Error('summary was not JSON');
    return {
      title: String(json.title ?? 'Diagnostic session').slice(0, 80),
      tags: Array.isArray(json.tags) ? json.tags.map(String).slice(0, 8) : [],
      description: String(json.description ?? '').slice(0, 200),
      document: String(json.document ?? ''),
    };
  }

  async resumePath(sid: string): Promise<string> {
    return join(this.workspace(sid), 'reports');
  }

  async readReport(sid: string, file: string): Promise<string> {
    const safe = file.replace(/[^a-zA-Z0-9._-]/g, '');
    const path = join(this.workspace(sid), 'reports', safe);
    if (!resolve(path).startsWith(this.workspace(sid))) throw new Error('Invalid path');
    return readFile(path, 'utf8');
  }

  async listReports(sid: string): Promise<string[]> {
    const dir = join(this.workspace(sid), 'reports');
    try {
      const { readdir } = await import('node:fs/promises');
      return (await readdir(dir)).filter((f) => f.endsWith('.md')).sort().reverse();
    } catch {
      return [];
    }
  }
}

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function collectAppIds(text: string): string[] {
  const ids = new Set<string>();
  for (const m of text.matchAll(/\b(application_\d+_\d+|local-\d+)\b/g)) ids.add(m[1]);
  return [...ids].slice(0, 5);
}

function extractRuleIds(text: string): string[] {
  const known = [
    'STAGE_DOMINANT',
    'SPILL_HEAVY',
    'TASK_SKEW',
    'SHUFFLE_SKEW',
    'JOIN_EXPLOSION',
    'BNLJ',
    'SMJ_BROADCASTABLE',
    'GC_HEAVY',
    'EXECUTOR_LOST',
    'TASK_FAILURES',
    'SMALL_FILES',
    'CONF_CHECK',
  ];
  return known.filter((r) => text.includes(r));
}
