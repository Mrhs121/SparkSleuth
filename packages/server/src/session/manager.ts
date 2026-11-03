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
  initSessionWorkspace,
  resolveSessionWorkspace,
  writeSessionReport,
  type AgentEvent,
  type Config,
  type Message,
} from '@sparksleuth/core';
import { sparkSkills } from '@sparksleuth/skills-spark';
import { Db } from '../db.js';
import { MemoryStoreImpl } from '../memory/store.js';
import { generationLanguage } from '../memory/localization.js';
import { SessionGraphStore } from './graph.js';

export type ResponseLanguage = 'zh' | 'en';

/** Per-turn UI preference; omit entirely for legacy clients. */
function languagePromptSuffix(language?: ResponseLanguage): string {
  if (!language) return '';
  const name = language === 'zh' ? 'Simplified Chinese (简体中文)' : 'English';
  return `\n\n## Response language for this turn\n\nThe user interface language is ${name}. Write all user-facing explanations and model-authored prose in ${name}, including narration, findings, purpose descriptions, report titles and report Markdown. This explicit UI preference overrides the earlier "Answer in the user's language" rule and the language of the user's message, prior conversation, memories or tool output. Keep code, technical identifiers, tool names and exact quoted evidence unchanged when needed. Apply this preference throughout this turn; do not translate previously saved messages or reports.`;
}

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
  private llm: LLMClient;
  private readonly graphStore: SessionGraphStore;
  private readonly runs = new Map<string, ActiveRun>();
  private readonly subscribers = new Map<string, Set<(e: EmittedEvent) => void>>();
  private readonly textBuffers = new Map<string, string>();
  private readonly thinkingBuffers = new Map<string, string>();
  private readonly graphToolApps = new Map<string, string[]>();
  private readonly graphApps = new Map<string, Set<string>>();

  constructor(
    private readonly config: Config,
    private readonly db: Db,
    private readonly memory: MemoryStoreImpl,
  ) {
    this.llm = new LLMClient(config.llm);
    this.graphStore = new SessionGraphStore(config, db);
  }

  workspace(sid: string): string {
    return resolveSessionWorkspace(this.config.runtime.dataDir, sid);
  }

  updateConfig(config: Config): void {
    Object.assign(this.config.spark, config.spark);
    Object.assign(this.config.llm, config.llm);
    Object.assign(this.config.auth, config.auth);
    this.llm = new LLMClient(this.config.llm);
  }

  async create(input: { message: string; appId?: string; language?: ResponseLanguage }): Promise<{ sid: string }> {
    if (this.runs.size >= this.config.runtime.concurrency) {
      throw new Error(
        `Concurrency limit reached (${this.config.runtime.concurrency} active runs). Please wait for an existing session to finish or stop one.`,
      );
    }
    const sid = randomUUID();
    const title = input.message.slice(0, 60) + (input.message.length > 60 ? '…' : '');
    this.db.createSession(sid, title);
    await initSessionWorkspace(this.workspace(sid));
    this.db.updateSession(sid, { app_ids: JSON.stringify(input.appId ? [input.appId] : []) });

    // Fire and forget: the client follows progress over the websocket.
    void this.run(sid, this.firstTurn(input), input.language);
    return { sid };
  }

  private firstTurn(input: { message: string; appId?: string }): string {
    return input.appId
      ? `Spark application: ${input.appId}\n\n${input.message}`
      : input.message;
  }

  async continue(sid: string, message: string, language?: ResponseLanguage): Promise<void> {
    const session = this.db.getSession(sid);
    if (!session) throw new Error(`Unknown session ${sid}`);
    if (session.status === 'closed') {
      throw new Error(`Session ${sid} is closed and archived. Start a new investigation to continue.`);
    }
    if (this.runs.has(sid)) throw new Error('This session is still running. Wait for it to finish or cancel it.');
    if (this.runs.size >= this.config.runtime.concurrency) {
      throw new Error(
        `Concurrency limit reached (${this.config.runtime.concurrency} active runs). Please wait for an existing session to finish or stop one.`,
      );
    }
    void this.run(sid, message, language);
  }

  private async run(sid: string, userMessage: string, language?: ResponseLanguage): Promise<void> {
    const session = this.db.getSession(sid);
    if (!session) throw new Error(`Unknown session ${sid}`);
    if (session.status === 'closed') throw new Error(`Session ${sid} is closed and cannot be run.`);

    const abort = new AbortController();
    const active: ActiveRun = { abort, messages: [], usage: { input: 0, output: 0 } };
    this.runs.set(sid, active);
    this.db.updateSession(sid, { status: 'running' });
    if (language) this.db.setPreference(`session.language:${sid}`, language);

    let timeoutTimer: NodeJS.Timeout | undefined;
    if (this.config.runtime.sessionTimeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        if (this.runs.has(sid)) {
          abort.abort(new Error(`Session timed out after ${Math.round(this.config.runtime.sessionTimeoutMs / 1000)}s`));
        }
      }, this.config.runtime.sessionTimeoutMs);
      timeoutTimer.unref?.();
    }

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
              const res = await writeSessionReport(this.workspace(sid), r.title, r.markdown);
              this.emit(sid, { type: 'report', path: res.path, title: r.title });
              return res;
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
      }) + languagePromptSuffix(language);

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

      if (abort.signal.aborted || result.reason === 'aborted') {
        const currentSession = this.db.getSession(sid);
        if (currentSession?.status !== 'cancelled') {
          this.db.updateSession(sid, { status: 'cancelled' });
          this.emit(sid, { type: 'cancelled' });
        }
        return;
      }

      // Archive graphs even if no browser is connected; graph failures must not
      // change the diagnostic outcome or discard the report.
      for (const appId of this.graphApps.get(sid) ?? []) {
        if (abort.signal.aborted) break;
        try {
          await this.graphStore.refresh(sid, appId);
          this.emit(sid, { type: 'graph_available', appId, snapshotSaved: true });
        } catch (err) {
          this.emit(sid, { type: 'graph_error', appId, message: err instanceof Error ? err.message : String(err) });
        }
      }
      if (abort.signal.aborted) {
        if (this.db.getSession(sid)?.status !== 'cancelled') {
          this.db.updateSession(sid, { status: 'cancelled' });
          this.emit(sid, { type: 'cancelled' });
        }
        return;
      }
      this.db.updateSession(sid, { status: 'waiting', last_message: this.lastAssistantText(result.messages) });
      this.emit(sid, { type: 'done', reason: result.reason, usage: result.usage });
    } catch (err) {
      this.flushText(sid);
      if (abort.signal.aborted) {
        // Aborted either by cancel() or by session timeout.
        const currentSession = this.db.getSession(sid);
        if (currentSession?.status === 'cancelled') {
          // Explicitly cancelled by user; cancel() already emitted 'cancelled'
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        const isTimeout = message.toLowerCase().includes('timed out');
        this.db.updateSession(sid, { status: isTimeout ? 'failed' : 'cancelled' });
        this.emit(sid, { type: isTimeout ? 'error' : 'cancelled', message });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.db.updateSession(sid, { status: 'failed' });
      this.emit(sid, { type: 'error', message });
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      this.runs.delete(sid);
      this.graphApps.delete(sid);
      for (const key of this.graphToolApps.keys()) {
        if (key.startsWith(`${sid}:`)) this.graphToolApps.delete(key);
      }
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
      case 'tool_use': {
        if (e.skill === 'spark-history' || e.skill === 'spark-diagnose') {
          const appIds = [e.input.appId, e.input.baselineAppId, e.input.experimentAppId]
            .filter((v): v is string => typeof v === 'string' && v.length > 0);
          this.graphToolApps.set(`${sid}:${e.id}`, [...new Set(appIds)]);
        }
        this.emit(sid, { ...e });
        return;
      }
      case 'tool_result': {
        this.emit(sid, { ...e });
        const key = `${sid}:${e.id}`;
        const appIds = this.graphToolApps.get(key) ?? [];
        this.graphToolApps.delete(key);
        if (!e.isError) {
          const apps = this.graphApps.get(sid) ?? new Set<string>();
          for (const appId of appIds) {
            apps.add(appId);
            this.emit(sid, { type: 'graph_available', appId });
          }
          this.graphApps.set(sid, apps);
        }
        return;
      }
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
    const pendingToolResults: string[] = [];

    const flushAssistant = () => {
      const parts: string[] = [];
      if (pendingAssistant.trim()) parts.push(pendingAssistant.trim());
      if (pendingToolResults.length > 0) {
        parts.push(`[Previous tool findings & data:\n${pendingToolResults.join('\n')}]`);
      }
      if (parts.length > 0) {
        messages.push({ role: 'assistant', content: parts.join('\n\n') });
      }
      pendingAssistant = '';
      pendingToolResults.length = 0;
    };

    for (const row of events) {
      const payload = JSON.parse(row.payload) as EmittedEvent;
      if (payload.type === 'text' && typeof payload.text === 'string') {
        pendingAssistant += `${payload.text}\n`;
      } else if (payload.type === 'tool_result') {
        const skill = String(payload.skill ?? '');
        const tool = String(payload.tool ?? '');
        const summary = typeof payload.summary === 'string' ? payload.summary.slice(0, 1200) : '';
        if (summary && !tool.includes('todo_write')) {
          pendingToolResults.push(`• ${skill}.${tool}: ${summary}`);
        }
      } else if (payload.type === 'finding') {
        pendingToolResults.push(`• [Milestone ${payload.stage}]: ${payload.finding}`);
      } else if (payload.type === 'user_message' && typeof payload.text === 'string') {
        flushAssistant();
        messages.push({ role: 'user', content: payload.text });
      }
    }
    flushAssistant();
    return messages.slice(-16);
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

  async finish(sid: string, language?: ResponseLanguage): Promise<{ ok: boolean; summary?: SessionSummary }> {
    const session = this.db.getSession(sid);
    if (!session) throw new Error(`Unknown session ${sid}`);
    if (session.status === 'closed') {
      // Idempotent: already closed, do not duplicate summaries or re-archive
      return { ok: true };
    }
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
      const savedLanguage = this.db.getPreference(`session.language:${sid}`);
      summary = await this.summarise(transcript, language ?? (savedLanguage === 'zh' || savedLanguage === 'en' ? savedLanguage : undefined));
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

  private async summarise(transcript: string, language?: ResponseLanguage): Promise<SessionSummary> {
    const prompt = `Summarise this Spark diagnostic session for a memory index.

Return JSON only, no prose:
{"title": "short title, max 40 chars", "tags": ["3-6 lowercase tags"], "description": "one sentence, max 100 chars", "document": "markdown write-up, max 60 lines, sections: Background / Conclusion / Path taken / Dead ends and corrections / Reusable lessons"}

The document must state what was actually observed, not what was assumed.
${generationLanguage(language)}

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
