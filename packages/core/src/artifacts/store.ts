import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface ArtifactQuery {
  /** Dot path into the stored JSON, e.g. "tasks" or "0.metrics". */
  path?: string;
  /** Keep array items where every key equals the given value. */
  filter?: Record<string, string | number | boolean>;
  /** Field name to sort by (numbers first, then strings). */
  sortBy?: string;
  order?: 'asc' | 'desc';
  /** Return at most this many items. */
  top?: number;
  offset?: number;
  /** Project these fields only. */
  fields?: string[];
}

export interface StoredArtifact {
  id: string;
  path: string;
  bytes: number;
  rows?: number;
}

const MAX_QUERY_OUTPUT = 6000;

/**
 * Large tool results are never handed to the model verbatim. They are written
 * here and the model gets a pointer plus a compact query interface.
 */
export class ArtifactStore {
  constructor(private readonly dir: string) {}

  static forSession(dataDir: string, sessionId: string): ArtifactStore {
    return new ArtifactStore(resolve(dataDir, 'workspaces', sessionId, 'artifacts'));
  }

  async write(name: string, data: unknown): Promise<StoredArtifact> {
    await mkdir(this.dir, { recursive: true });
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 60);
    const id = `${safe}-${Date.now().toString(36)}.json`;
    const path = join(this.dir, id);
    const text = JSON.stringify(data, null, 2);
    await writeFile(path, text, 'utf8');
    const rows = Array.isArray(data) ? data.length : undefined;
    return { id, path, bytes: Buffer.byteLength(text), rows };
  }

  async read(id: string): Promise<unknown> {
    const text = await readFile(this.resolveSafe(id), 'utf8');
    return JSON.parse(text);
  }

  async query(id: string, q: ArtifactQuery): Promise<string> {
    let data = await this.read(id);
    if (q.path) data = resolvePath(data, q.path);
    if (Array.isArray(data)) {
      let rows = data as Record<string, unknown>[];
      if (q.filter) {
        rows = rows.filter((row) =>
          Object.entries(q.filter!).every(([k, v]) => row?.[k] === v),
        );
      }
      if (q.sortBy) {
        const dir = q.order === 'asc' ? 1 : -1;
        rows = [...rows].sort((a, b) => {
          const av = a?.[q.sortBy!] as number;
          const bv = b?.[q.sortBy!] as number;
          if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
          return String(av).localeCompare(String(bv)) * dir;
        });
      }
      if (q.offset) rows = rows.slice(q.offset);
      if (q.top) rows = rows.slice(0, q.top);
      if (q.fields) rows = rows.map((r) => Object.fromEntries(q.fields!.map((f) => [f, r?.[f]])));
      data = rows;
    }
    const text = JSON.stringify(data, null, 2);
    const total = Array.isArray(data) ? data.length : undefined;
    if (text.length <= MAX_QUERY_OUTPUT) {
      return total === undefined ? text : `${total} item(s):\n${text}`;
    }
    return `Result too large (${text.length} chars, ${total ?? 'n/a'} items). Narrow it with filter/sortBy/top/fields.\n${text.slice(0, MAX_QUERY_OUTPUT)}`;
  }

  async inspect(id: string): Promise<string> {
    const s = await stat(this.resolveSafe(id));
    const data = await this.read(id);
    if (Array.isArray(data)) {
      const sample = data.slice(0, 3);
      const first = sample[0];
      const keys = first && typeof first === 'object' && first !== null ? Object.keys(first as Record<string, unknown>) : [];
      return [
        `Artifact ${id}: Array of ${data.length} item(s) (${s.size} bytes)`,
        keys.length ? `Item fields: ${keys.join(', ')}` : '',
        `Sample (first ${sample.length} item(s)):`,
        JSON.stringify(sample, null, 2),
      ]
        .filter(Boolean)
        .join('\n');
    }
    if (typeof data === 'object' && data !== null) {
      const obj = data as Record<string, unknown>;
      const keys = Object.keys(obj);
      const summaryObj: Record<string, unknown> = {};
      for (const k of keys.slice(0, 15)) {
        const v = obj[k];
        if (Array.isArray(v)) {
          summaryObj[k] = `Array(${v.length})`;
        } else if (typeof v === 'object' && v !== null) {
          summaryObj[k] = `Object(${Object.keys(v).slice(0, 5).join(', ')})`;
        } else {
          summaryObj[k] = v;
        }
      }
      return [
        `Artifact ${id}: Object with ${keys.length} key(s) (${s.size} bytes)`,
        `Keys: ${keys.join(', ')}`,
        'Structure overview:',
        JSON.stringify(summaryObj, null, 2),
      ].join('\n');
    }
    return `Artifact ${id}: ${typeof data} (${s.size} bytes)\nValue: ${String(data).slice(0, 2000)}`;
  }

  async list(): Promise<StoredArtifact[]> {
    try {
      const names = await readdir(this.dir);
      const out: StoredArtifact[] = [];
      for (const name of names.sort().reverse()) {
        const p = join(this.dir, name);
        const s = await stat(p);
        out.push({ id: name, path: p, bytes: s.size });
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Drop artifacts older than maxAgeMs. Returns how many were removed. */
  async prune(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const a of await this.list()) {
      const s = await stat(a.path).catch(() => null);
      if (s && s.mtimeMs < cutoff) {
        await unlink(a.path).catch(() => {});
        removed++;
      }
    }
    return removed;
  }

  private resolveSafe(id: string): string {
    const p = resolve(this.dir, id);
    if (!p.startsWith(resolve(this.dir))) throw new Error(`Invalid artifact id: ${id}`);
    return p;
  }
}

function resolvePath(data: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    if (Array.isArray(acc)) {
      const i = Number.parseInt(key, 10);
      return Number.isNaN(i) ? undefined : acc[i];
    }
    return (acc as Record<string, unknown>)[key];
  }, data);
}
