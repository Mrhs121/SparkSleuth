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
import { registerMemoryRoutes } from './memory/routes.js';
import { languageBodySchema, type GenerationLanguage } from './memory/localization.js';
import { SessionManager } from './session/manager.js';
import { registerGraphRoutes, SessionGraphStore } from './session/graph.js';

loadDotEnv();

const config = loadConfig();
const db = new Db(resolve(config.runtime.dataDir, 'sparksleuth.db'));
const memory = new MemoryStoreImpl(resolve(config.runtime.dataDir, 'memory'), db);
const manager = new SessionManager(config, db, memory);
let llm = new LLMClient(config.llm);

await memory.init();

const app = Fastify({ logger: { level: process.env.SPARKSLEUTH_LOG_LEVEL ?? 'info' } });
await app.register(fastifyWebsocket);

app.addHook('onRequest', async (req, reply) => {
  if (!config.auth.token) {
    return;
  }
  // Only guard /api and /ws endpoints
  if (!req.url.startsWith('/api') && !req.url.startsWith('/ws')) {
    return;
  }
  // Allow /api/health so discovery and authRequired status can be inspected
  if (req.url === '/api/health' || req.url.startsWith('/api/health?')) {
    return;
  }

  const authHeader = req.headers.authorization;
  const tokenHeader = req.headers['x-sparksleuth-token'];
  const queryToken = (req.query as Record<string, string> | undefined)?.token;
  let provided = '';
  if (authHeader && authHeader.startsWith('Bearer ')) {
    provided = authHeader.slice(7).trim();
  } else if (typeof tokenHeader === 'string') {
    provided = tokenHeader.trim();
  } else if (typeof queryToken === 'string') {
    provided = queryToken.trim();
  }

  if (provided !== config.auth.token) {
    return reply.code(401).send({ error: 'unauthorized: valid token required' });
  }
});

/* ------------------------------------------------------------------ *
 * Health and configuration
 * ------------------------------------------------------------------ */

app.get('/api/health', async () => {
  const hs = await new HistoryClient(config.spark.historyServerUrl, { timeoutMs: 5000 }).ping();
  return {
    ok: true,
    historyServer: hs,
    model: { baseUrl: config.llm.baseUrl, model: config.llm.model, configured: Boolean(config.llm.apiKey) },
    authRequired: Boolean(config.auth.token),
    version: '0.1.0',
  };
});

app.get('/api/config', async () => {
  return {
    spark: {
      historyServerUrl: config.spark.historyServerUrl,
    },
    llm: {
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      maxTokens: config.llm.maxTokens,
      hasApiKey: Boolean(config.llm.apiKey),
      apiKeyPreview: config.llm.apiKey
        ? `${config.llm.apiKey.slice(0, 6)}...${config.llm.apiKey.slice(-4)}`
        : '',
    },
    auth: {
      required: Boolean(config.auth.token),
    },
  };
});

app.post<{
  Body: {
    spark?: { historyServerUrl?: string };
    llm?: { baseUrl?: string; apiKey?: string; model?: string; maxTokens?: number };
    auth?: { token?: string };
  };
}>('/api/config', async (req) => {
  const body = req.body ?? {};
  if (body.spark?.historyServerUrl) {
    config.spark.historyServerUrl = body.spark.historyServerUrl.replace(/\/+$/, '');
  }
  if (body.llm) {
    if (body.llm.baseUrl) config.llm.baseUrl = body.llm.baseUrl.replace(/\/+$/, '');
    if (body.llm.apiKey !== undefined && body.llm.apiKey !== '') config.llm.apiKey = body.llm.apiKey.trim();
    if (body.llm.model) config.llm.model = body.llm.model.trim();
    if (body.llm.maxTokens) config.llm.maxTokens = body.llm.maxTokens;
  }
  if (body.auth?.token !== undefined) {
    config.auth.token = body.auth.token.trim();
  }

  manager.updateConfig(config);
  llm = new LLMClient(config.llm);

  return {
    ok: true,
    spark: {
      historyServerUrl: config.spark.historyServerUrl,
    },
    llm: {
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      maxTokens: config.llm.maxTokens,
      hasApiKey: Boolean(config.llm.apiKey),
      apiKeyPreview: config.llm.apiKey
        ? `${config.llm.apiKey.slice(0, 6)}...${config.llm.apiKey.slice(-4)}`
        : '',
    },
    auth: {
      required: Boolean(config.auth.token),
    },
  };
});

app.post<{ Body: { url?: string } }>('/api/config/test-hs', async (req) => {
  const targetUrl = (req.body?.url || config.spark.historyServerUrl).replace(/\/+$/, '');
  const start = Date.now();
  try {
    const client = new HistoryClient(targetUrl, { timeoutMs: 5000 });
    const ping = await client.ping();
    const durationMs = Date.now() - start;
    if (!ping.ok) {
      return { ok: false, error: ping.error ?? 'Failed to reach History Server', durationMs };
    }
    let appsCount = 0;
    try {
      const apps = await client.listApplications({ limit: 5 });
      appsCount = apps.length;
    } catch {}
    return { ok: true, version: ping.version, appsCount, durationMs };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
});

app.post<{ Body: { baseUrl?: string; apiKey?: string; model?: string } }>('/api/config/test-llm', async (req) => {
  const baseUrl = (req.body?.baseUrl || config.llm.baseUrl).replace(/\/+$/, '');
  const apiKey = req.body?.apiKey || config.llm.apiKey;
  const model = req.body?.model || config.llm.model;

  if (!apiKey) {
    return { ok: false, error: 'API key is required to test LLM connection' };
  }

  const start = Date.now();
  const testClient = new LLMClient({
    baseUrl,
    apiKey,
    model,
    maxTokens: 50,
    timeoutMs: 15_000,
  });

  try {
    const res = await testClient.complete({
      system: 'Respond with "ok".',
      messages: [{ role: 'user', content: 'ping' }],
      tools: [],
    });
    const textBlock = res.blocks.find((b) => b.type === 'text');
    return {
      ok: true,
      durationMs: Date.now() - start,
      reply: textBlock?.type === 'text' ? textBlock.text.slice(0, 50) : 'ok',
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
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

const graphStore = new SessionGraphStore(config, db);
registerGraphRoutes(app, graphStore);

// Keep language as an enum-only schema: Ajv must not coerce non-string input
// (for example ['zh']) into a valid preference before the run is started.
const sessionMessageBodySchema = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    appId: { type: 'string' },
    language: { enum: ['zh', 'en'] },
  },
};

app.post<{ Body: { message?: string; appId?: string; language?: 'zh' | 'en' } }>('/api/sessions', {
  schema: { body: sessionMessageBodySchema },
}, async (req, reply) => {
  const message = req.body?.message?.trim();
  if (!message) return reply.code(400).send({ error: 'message is required' });
  const { sid } = await manager.create({ message, appId: req.body?.appId, language: req.body?.language });
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
  const findingEvents = manager.replay(session.sid).filter((event) => event.type === 'finding');
  return {
    session: {
      appIds: graphStore.applicationIds(session),
      sid: session.sid,
      title: session.title,
      status: session.status,
      purpose: session.purpose,
      createdAt: session.created_at,
    },
    events: manager.replay(session.sid),
    findings: db.listFindings(session.sid).map((f, index) => ({
      target: findingEvents[index]?.type === 'finding' ? findingEvents[index].target : undefined,
      stage: f.stage,
      tools: JSON.parse(f.tools) as string[],
      finding: f.finding,
      ts: f.ts,
    })),
    reports: await manager.listReports(session.sid),
    running: manager.isRunning(session.sid),
  };
});

app.post<{ Params: { sid: string }; Body: { message?: string; language?: 'zh' | 'en' } }>('/api/sessions/:sid/messages', {
  schema: { body: sessionMessageBodySchema },
}, async (req, reply) => {
  const message = req.body?.message?.trim();
  if (!message) return reply.code(400).send({ error: 'message is required' });
  if (!db.getSession(req.params.sid)) return reply.code(404).send({ error: 'not found' });
  try {
    await manager.continue(req.params.sid, message, req.body?.language);
    return { ok: true };
  } catch (err) {
    return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post<{ Params: { sid: string } }>('/api/sessions/:sid/cancel', async (req) => {
  return { ok: manager.cancel(req.params.sid) };
});

app.post<{ Params: { sid: string }; Body: { language?: GenerationLanguage } }>('/api/sessions/:sid/finish', {
  schema: { body: languageBodySchema },
  preValidation: async (req) => { if (req.body === undefined) req.body = {}; },
}, async (req, reply) => {
  try {
    const result = await manager.finish(req.params.sid, req.body?.language);
    return result;
  } catch (err) {
    return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get<{ Params: { sid: string; file: string } }>('/api/sessions/:sid/reports/:file', async (req, reply) => {
  try {
    // Viewing always returns the saved source, regardless of legacy language query parameters.
    const text = await manager.readReport(req.params.sid, req.params.file);
    return reply.type('text/markdown').send(text);
  } catch {
    return reply.code(404).send({ error: 'not found' });
  }
});

/* ------------------------------------------------------------------ *
 * Memory
 * ------------------------------------------------------------------ */

registerMemoryRoutes(app, db, memory, () => llm);

/* ------------------------------------------------------------------ *
 * WebSocket: live events
 * ------------------------------------------------------------------ */

app.register(async (instance) => {
  instance.get<{ Params: { sid: string }; Querystring: { token?: string } }>('/ws/sessions/:sid', { websocket: true }, (socket, req) => {
    const sid = req.params.sid;
    if (config.auth.token) {
      const authHeader = req.headers.authorization;
      const tokenHeader = req.headers['x-sparksleuth-token'];
      const queryToken = req.query?.token;
      let provided = '';
      if (authHeader && authHeader.startsWith('Bearer ')) {
        provided = authHeader.slice(7).trim();
      } else if (typeof tokenHeader === 'string') {
        provided = tokenHeader.trim();
      } else if (typeof queryToken === 'string') {
        provided = queryToken.trim();
      }
      if (provided !== config.auth.token) {
        socket.close(1008, 'Unauthorized');
        return;
      }
    }

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
} else {
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.code(503).type('text/html').send(`<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>SparkSleuth — Frontend Not Built</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #fafaf9; color: #1c1917; padding: 48px 24px; line-height: 1.6; }
      .card { max-width: 580px; margin: 0 auto; background: #fff; border: 1px solid #e7e5e4; border-radius: 12px; padding: 28px 32px; box-shadow: 0 2px 8px rgba(0,0,0,0.04); }
      h1 { font-size: 20px; margin: 0 0 12px; color: #ea580c; }
      pre { background: #1c1917; color: #fafaf9; padding: 12px 14px; border-radius: 8px; font-size: 13px; overflow-x: auto; }
      code { font-family: ui-monospace, Menlo, monospace; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Frontend Assets Not Found</h1>
      <p>SparkSleuth server is running, but the frontend distribution at <code>${webDist}</code> has not been built yet.</p>
      <p>To compile the frontend assets, run:</p>
      <pre>pnpm --filter @sparksleuth/web build</pre>
      <p>Or start the Vite development server in the <code>web/</code> directory.</p>
    </div>
  </body>
</html>`);
  });
}

if (!config.llm.apiKey) {
  app.log.warn('SPARKSLEUTH_LLM_API_KEY is not set: sessions will fail when they call the model.');
}

scheduleDream(2, () => runDream(db, memory, llm));

await app.listen({ port: config.runtime.port, host: process.env.SPARKSLEUTH_HOST ?? '127.0.0.1' });
app.log.info(`SparkSleuth listening on http://127.0.0.1:${config.runtime.port}`);

void join;
