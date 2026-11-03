import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { LLMClient, loadConfig, loadDotEnv } from '@sparksleuth/core';
import { HistoryClient } from '@sparksleuth/skills-spark';
import { Db } from './db.js';
import { MemoryStoreImpl } from './memory/store.js';
import { runDream, scheduleDream } from './memory/dream.js';
import { SessionManager } from './session/manager.js';

loadDotEnv();

const config = loadConfig();
const db = new Db(resolve(config.runtime.dataDir, 'sparksleuth.db'));
const memory = new MemoryStoreImpl(resolve(config.runtime.dataDir, 'memory'), db);
const manager = new SessionManager(config, db, memory);
const llm = new LLMClient(config.llm);

await memory.init();

const app = Fastify({ logger: { level: process.env.SPARKSLEUTH_LOG_LEVEL ?? 'info' } });
await app.register(fastifyWebsocket);

/* ------------------------------------------------------------------ *
 * Health and discovery
 * ------------------------------------------------------------------ */

app.get('/api/health', async () => {
  const hs = await new HistoryClient(config.spark.historyServerUrl, { timeoutMs: 5000 }).ping();
  return {
    ok: true,
    historyServer: hs,
    model: { baseUrl: config.llm.baseUrl, model: config.llm.model, configured: Boolean(config.llm.apiKey) },
    version: '0.1.0',
  };
});

app.get('/api/apps', async (_req, reply) => {
  const client = new HistoryClient(config.spark.historyServerUrl, { timeoutMs: 10_000 });
  try {
    const apps = await client.listApplications({ limit: 30 });
    return apps.map((a) => ({
      id: a.id,
      name: a.name,
      completed: Boolean(a.attempts?.[0]?.completed),
      startTime: a.attempts?.[0]?.startTime,
      durationMs: a.attempts?.[0]?.duration,
      user: a.attempts?.[0]?.sparkUser,
    }));
  } catch (err) {
    return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

app.post<{ Body: { message?: string; appId?: string } }>('/api/sessions', async (req, reply) => {
  const message = req.body?.message?.trim();
  if (!message) return reply.code(400).send({ error: 'message is required' });
  const { sid } = await manager.create({ message, appId: req.body?.appId });
  return { sid };
});

app.get('/api/sessions', async () => {
  return db.listSessions().map((s) => ({
    sid: s.sid,
    title: s.title,
    status: s.status,
    purpose: s.purpose,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    usage: { input: s.claude_usage_input, output: s.claude_usage_output },
    running: manager.isRunning(s.sid),
  }));
});

app.get<{ Params: { sid: string } }>('/api/sessions/:sid', async (req, reply) => {
  const session = db.getSession(req.params.sid);
  if (!session) return reply.code(404).send({ error: 'not found' });
  return {
    session: {
      sid: session.sid,
      title: session.title,
      status: session.status,
      purpose: session.purpose,
      createdAt: session.created_at,
    },
    events: manager.replay(session.sid),
    findings: db.listFindings(session.sid).map((f) => ({
      stage: f.stage,
      tools: JSON.parse(f.tools) as string[],
      finding: f.finding,
      ts: f.ts,
    })),
    reports: await manager.listReports(session.sid),
    running: manager.isRunning(session.sid),
  };
});

app.post<{ Params: { sid: string }; Body: { message?: string } }>('/api/sessions/:sid/messages', async (req, reply) => {
  const message = req.body?.message?.trim();
  if (!message) return reply.code(400).send({ error: 'message is required' });
  if (!db.getSession(req.params.sid)) return reply.code(404).send({ error: 'not found' });
  try {
    await manager.continue(req.params.sid, message);
    return { ok: true };
  } catch (err) {
    return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post<{ Params: { sid: string } }>('/api/sessions/:sid/cancel', async (req) => {
  return { ok: manager.cancel(req.params.sid) };
});

app.post<{ Params: { sid: string } }>('/api/sessions/:sid/finish', async (req, reply) => {
  try {
    const result = await manager.finish(req.params.sid);
    return result;
  } catch (err) {
    return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get<{ Params: { sid: string; file: string } }>('/api/sessions/:sid/reports/:file', async (req, reply) => {
  try {
    const text = await manager.readReport(req.params.sid, req.params.file);
    return reply.type('text/markdown').send(text);
  } catch {
    return reply.code(404).send({ error: 'not found' });
  }
});

/* ------------------------------------------------------------------ *
 * Memory
 * ------------------------------------------------------------------ */

app.get<{ Querystring: { keyword?: string; days?: string; limit?: string } }>('/api/memory', async (req) => {
  const hits = await memory.search({
    keyword: req.query.keyword,
    days: req.query.days ? Number(req.query.days) : undefined,
    limit: req.query.limit ? Number(req.query.limit) : 20,
  });
  return hits;
});

app.get<{ Params: { sid: string } }>('/api/memory/:sid', async (req, reply) => {
  const doc = await memory.get(req.params.sid);
  if (!doc) return reply.code(404).send({ error: 'not found' });
  return reply.type('text/markdown').send(doc);
});

app.get('/api/memory/experience', async () => {
  return { items: await memory.experience() };
});

app.post('/api/memory/dream', async () => {
  const result = await runDream(db, memory, llm);
  return result;
});

app.get<{ Querystring: { status?: string } }>('/api/memory/dream/candidates', async (req) => {
  return db.listDreamCandidates(req.query.status);
});

app.post<{ Params: { id: string }; Body: { action?: 'approve' | 'reject' } }>(
  '/api/memory/dream/candidates/:id',
  async (req, reply) => {
    const id = Number(req.params.id);
    const candidates = db.listDreamCandidates().filter((c) => c.id === id);
    const candidate = candidates[0];
    if (!candidate) return reply.code(404).send({ error: 'not found' });
    if (req.body?.action === 'approve') {
      const path = await memory.promoteLesson([candidate.content], 'lessons');
      db.reviewDreamCandidate(id, 'approved');
      return { ok: true, path };
    }
    db.reviewDreamCandidate(id, 'rejected');
    return { ok: true };
  },
);

/* ------------------------------------------------------------------ *
 * WebSocket: live events
 * ------------------------------------------------------------------ */

app.register(async (instance) => {
  instance.get<{ Params: { sid: string } }>('/ws/sessions/:sid', { websocket: true }, (socket, req) => {
    const sid = req.params.sid;
    const send = (e: unknown) => {
      try {
        socket.send(JSON.stringify(e));
      } catch {
        /* socket closed */
      }
    };

    for (const event of manager.replay(sid)) send(event);
    send({ type: 'replay_complete', ts: Date.now() });

    const unsubscribe = manager.subscribe(sid, send);
    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
  });
});

/* ------------------------------------------------------------------ *
 * Static web build (production)
 * ------------------------------------------------------------------ */

const here = dirname(fileURLToPath(import.meta.url));
const webDist = resolve(here, '../../../web/dist');
app.log.info({ webDist, exists: existsSync(webDist) }, 'static web root');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, prefix: '/' });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.sendFile('index.html');
  });
}

if (!config.llm.apiKey) {
  app.log.warn('SPARKSLEUTH_LLM_API_KEY is not set: sessions will fail when they call the model.');
}

scheduleDream(2, () => runDream(db, memory, llm));

await app.listen({ port: config.runtime.port, host: process.env.SPARKSLEUTH_HOST ?? '127.0.0.1' });
app.log.info(`SparkSleuth listening on http://127.0.0.1:${config.runtime.port}`);

void join;
