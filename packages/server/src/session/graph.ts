import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { initSessionWorkspace, resolveSessionWorkspace, type Config } from '@sparksleuth/core';
import { collectGraphSnapshot, HistoryClient, type GraphSnapshot } from '@sparksleuth/skills-spark';
import type { Db, SessionRow } from '../db.js';

export class GraphError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); }
}
/** Session-owned graph files, separate from artifacts and never inserted into model context. */
export class SessionGraphStore {
  constructor(private readonly config: Config, private readonly db: Db,
    private readonly capture: (appId: string) => Promise<GraphSnapshot> = (appId) => {
      const signal = AbortSignal.timeout(60_000);
      const url = this.config.spark.historyServerUrl;
      return collectGraphSnapshot(new HistoryClient(url, { timeoutMs: 10_000, signal }), appId, url, {
        skewRatio: this.config.rules.skewRatio, spillRatio: this.config.rules.spillRatio,
        gcRatio: this.config.rules.gcRatio, fanoutRatio: this.config.rules.fanoutRatio,
        dominantRatio: this.config.rules.dominantRatio,
      });
    }) {}

  private session(sid: string): SessionRow {
    const session = this.db.getSession(sid);
    if (!session) throw new GraphError(404, 'session not found');
    return session;
  }
  /** Only structured metadata and actual persisted Spark tool inputs; no natural-language guessing. */
  applicationIds(session: SessionRow): string[] {
    const ids: string[] = [];
    const add = (id: unknown) => { if (typeof id === 'string' && id.trim() && !ids.includes(id.trim())) ids.push(id.trim()); };
    try { const stored: unknown = JSON.parse(session.app_ids ?? '[]'); if (Array.isArray(stored)) stored.forEach(add); } catch {}
    for (const event of this.db.listEvents(session.sid)) {
      if (event.type !== 'tool_use') continue;
      try {
        const payload = JSON.parse(event.payload) as { skill?: string; input?: Record<string, unknown> };
        if (payload.skill !== 'spark-history' && payload.skill !== 'spark-diagnose') continue;
        add(payload.input?.appId);
        add(payload.input?.baselineAppId);
        add(payload.input?.experimentAppId);
      } catch {}
    }
    return ids;
  }
  private select(session: SessionRow, explicit?: string): string {
    if (explicit?.trim()) return explicit.trim();
    const ids = this.applicationIds(session);
    if (ids.length === 0) throw new GraphError(400, 'appId is required: no application recorded for this session');
    if (ids.length > 1) throw new GraphError(400, 'appId is required: session has multiple applications');
    return ids[0];
  }
  private path(sid: string, appId: string): string {
    // Encoding protects filenames against separators; workspace resolution is shared with reports.
    return join(resolveSessionWorkspace(this.config.runtime.dataDir, sid), `graph-${encodeURIComponent(appId)}.json`);
  }
  async get(sid: string, explicit?: string): Promise<GraphSnapshot> {
    const session = this.session(sid);
    const appId = this.select(session, explicit);
    try {
      const snapshot = JSON.parse(await readFile(this.path(sid, appId), 'utf8')) as GraphSnapshot;
      if (snapshot.version !== 1 || snapshot.appId !== appId) throw new Error('invalid graph snapshot');
      return snapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new GraphError(404, 'graph snapshot not found; capture it with POST');
      throw new GraphError(500, 'graph snapshot could not be read');
    }
  }
  async refresh(sid: string, explicit?: string): Promise<GraphSnapshot> {
    const session = this.session(sid);
    if (session.status === 'closed') throw new GraphError(409, 'closed sessions cannot create or refresh graphs');
    const appId = this.select(session, explicit);
    let snapshot: GraphSnapshot;
    try { snapshot = await this.capture(appId); }
    catch (error) { throw new GraphError(502, `graph capture failed: ${error instanceof Error ? error.message : String(error)}`); }
    // Session may close while requests are in flight: check again before any workspace/file mutation.
    if (this.session(sid).status === 'closed') throw new GraphError(409, 'closed sessions cannot create or refresh graphs');
    await initSessionWorkspace(resolveSessionWorkspace(this.config.runtime.dataDir, sid));
    const destination = this.path(sid, appId);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(snapshot), { encoding: 'utf8', flag: 'wx' });
    // Same-directory rename is atomic: failed capture/write never overwrites the last good snapshot.
    await rename(temporary, destination);
    return snapshot;
  }
}

/** Register after the server's existing global token-authentication hook. */
export function registerGraphRoutes(app: FastifyInstance, store: SessionGraphStore): void {
  app.get<{ Params: { sid: string }; Querystring: { appId?: string } }>('/api/sessions/:sid/graph', async (req, reply) => {
    try { return await store.get(req.params.sid, req.query.appId); }
    catch (error) { return reply.code(error instanceof GraphError ? error.statusCode : 500).send({ error: (error as Error).message }); }
  });
  app.post<{ Params: { sid: string }; Body: { appId?: string } }>('/api/sessions/:sid/graph', {
    schema: { body: { type: 'object', properties: { appId: { type: 'string', minLength: 1 } }, additionalProperties: false } },
  }, async (req, reply) => {
    try { return await store.refresh(req.params.sid, req.body?.appId); }
    catch (error) { return reply.code(error instanceof GraphError ? error.statusCode : 500).send({ error: (error as Error).message }); }
  });
}
