import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SessionRow {
  sid: string;
  created_at: number;
  updated_at: number;
  title: string;
  purpose: string | null;
  status: string;
  app_ids: string | null;
  claude_usage_input: number;
  claude_usage_output: number;
}

export interface EventRow {
  sid: string;
  seq: number;
  ts: number;
  type: string;
  payload: string;
}

export interface FindingRow {
  sid: string;
  seq: number;
  ts: number;
  stage: string;
  tools: string;
  finding: string;
}

export interface MemoryIndexRow {
  sid: string;
  created_at: number;
  title: string;
  tags: string;
  description: string;
  app_ids: string;
  rules: string;
}

export interface DreamCandidateRow {
  id: number;
  date: string;
  content: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: number;
  reviewed_at: number | null;
}

/**
 * SQLite persistence. Deliberately thin: the schema is small enough that
 * hand-written SQL is clearer than an ORM.
 */
export class Db {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        purpose TEXT,
        status TEXT NOT NULL DEFAULT 'created',
        app_ids TEXT,
        last_message TEXT,
        claude_usage_input INTEGER NOT NULL DEFAULT 0,
        claude_usage_output INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS events (
        sid TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (sid, seq)
      );
      CREATE TABLE IF NOT EXISTS findings (
        sid TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        stage TEXT NOT NULL,
        tools TEXT NOT NULL,
        finding TEXT NOT NULL,
        PRIMARY KEY (sid, seq)
      );
      CREATE TABLE IF NOT EXISTS memory_index (
        sid TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        title TEXT NOT NULL,
        tags TEXT NOT NULL,
        description TEXT NOT NULL,
        app_ids TEXT NOT NULL DEFAULT '[]',
        rules TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS local_preferences (
        preference_key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dream_candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        reviewed_at INTEGER
      );
    `);
  }

  /* ---------------- sessions ---------------- */

  createSession(sid: string, title: string): void {
    const now = Date.now();
    this.db
      .prepare('INSERT INTO sessions (sid, created_at, updated_at, title, status) VALUES (?, ?, ?, ?, ?)')
      .run(sid, now, now, title, 'created');
  }

  updateSession(sid: string, patch: Partial<Pick<SessionRow, 'title' | 'purpose' | 'status' | 'app_ids'>> & { last_message?: string }): void {
    const sets: string[] = ['updated_at = ?'];
    const values: Array<string | number> = [Date.now()];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      values.push(v as string);
    }
    values.push(sid);
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE sid = ?`).run(...values);
  }

  addUsage(sid: string, input: number, output: number): void {
    this.db
      .prepare('UPDATE sessions SET claude_usage_input = claude_usage_input + ?, claude_usage_output = claude_usage_output + ?, updated_at = ? WHERE sid = ?')
      .run(input, output, Date.now(), sid);
  }

  getSession(sid: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE sid = ?').get(sid) as SessionRow | undefined;
  }

  listSessions(limit = 50): SessionRow[] {
    return this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?').all(limit) as unknown as SessionRow[];
  }

  /* ---------------- events ---------------- */

  appendEvent(sid: string, type: string, payload: unknown): number {
    const seq = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE sid = ?').get(sid) as { m: number }).m + 1;
    this.db
      .prepare('INSERT INTO events (sid, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)')
      .run(sid, seq, Date.now(), type, JSON.stringify(payload));
    return seq;
  }

  listEvents(sid: string, sinceSeq = 0): EventRow[] {
    return this.db.prepare('SELECT * FROM events WHERE sid = ? AND seq > ? ORDER BY seq').all(sid, sinceSeq) as unknown as EventRow[];
  }

  /* ---------------- findings ---------------- */

  addFinding(sid: string, stage: string, tools: string[], finding: string): void {
    const seq = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM findings WHERE sid = ?').get(sid) as { m: number }).m + 1;
    this.db
      .prepare('INSERT INTO findings (sid, seq, ts, stage, tools, finding) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sid, seq, Date.now(), stage, JSON.stringify(tools), finding);
  }

  listFindings(sid: string): FindingRow[] {
    return this.db.prepare('SELECT * FROM findings WHERE sid = ? ORDER BY seq').all(sid) as unknown as FindingRow[];
  }

  /* ---------------- memory ---------------- */

  upsertMemoryIndex(row: MemoryIndexRow): void {
    this.db
      .prepare(
        `INSERT INTO memory_index (sid, created_at, title, tags, description, app_ids, rules)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET title = excluded.title, tags = excluded.tags,
           description = excluded.description, app_ids = excluded.app_ids, rules = excluded.rules`,
      )
      .run(row.sid, row.created_at, row.title, row.tags, row.description, row.app_ids, row.rules);
  }

  listMemoryIndex(limit = 200): MemoryIndexRow[] {
    return this.db.prepare('SELECT * FROM memory_index ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as MemoryIndexRow[];
  }

  /* ---------------- dream ---------------- */

  addDreamCandidate(date: string, content: string): void {
    this.db
      .prepare('INSERT INTO dream_candidates (date, content, status, created_at) VALUES (?, ?, ?, ?)')
      .run(date, content, 'pending', Date.now());
  }

  listDreamCandidates(status?: string): DreamCandidateRow[] {
    const sql = status
      ? 'SELECT * FROM dream_candidates WHERE status = ? ORDER BY created_at DESC'
      : 'SELECT * FROM dream_candidates ORDER BY created_at DESC';
    return (status ? this.db.prepare(sql).all(status) : this.db.prepare(sql).all()) as unknown as DreamCandidateRow[];
  }

  reviewDreamCandidate(id: number, status: 'approved' | 'rejected'): void {
    this.db
      .prepare('UPDATE dream_candidates SET status = ?, reviewed_at = ? WHERE id = ?')
      .run(status, Date.now(), id);
  }

  getPreference(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM local_preferences WHERE preference_key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setPreference(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO local_preferences (preference_key, value) VALUES (?, ?)').run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
