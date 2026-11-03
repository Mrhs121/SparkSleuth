import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { loadConfig, resolveSessionWorkspace } from '@sparksleuth/core';
import { normalizeGraphSnapshot } from '@sparksleuth/skills-spark';
import { Db } from '../src/db.js';
import { GraphError, registerGraphRoutes, SessionGraphStore } from '../src/session/graph.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'graph-test-'));
  const config = loadConfig({ runtime: { ...loadConfig().runtime, dataDir: dir } });
  const db = new Db(join(dir, 'test.db'));
  db.createSession('s', 'test');
  db.updateSession('s', { app_ids: '["app"]', status: 'waiting' });
  let calls = 0;
  let fail = false;
  const store = new SessionGraphStore(config, db, async (appId) => {
    calls++;
    if (fail) throw new Error('offline');
    return normalizeGraphSnapshot({ appId, sourceUrl: 'hs', sqlExecutions: [], stages: [], findings: [] });
  });
  return { dir, db, config, store, calls: () => calls, fail: () => { fail = true; } };
}
test('cache replay, refresh failure preservation, and closed sessions never capture/write', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.store.get('s'), (e: unknown) => e instanceof GraphError && e.statusCode === 404);
    assert.equal(f.calls(), 0);
    const snapshot = await f.store.refresh('s');
    f.fail();
    await assert.rejects(f.store.refresh('s'), /offline/);
    assert.deepEqual(await f.store.get('s'), snapshot);
    const workspace = resolveSessionWorkspace(f.dir, 's');
    const before = await readFile(join(workspace, 'graph-app.json'), 'utf8');
    f.db.updateSession('s', { status: 'closed' });
    assert.deepEqual(await f.store.get('s'), snapshot);
    await assert.rejects(f.store.refresh('s'), /closed/);
    await assert.rejects(f.store.get('s', 'other'), /not found/);
    assert.equal(f.calls(), 2);
    assert.equal(await readFile(join(workspace, 'graph-app.json'), 'utf8'), before);
    assert.ok(!(await readdir(workspace)).some((name) => name.endsWith('.tmp')));
    f.db.createSession('closed', 'closed');
    f.db.updateSession('closed', { status: 'closed', app_ids: '["app"]' });
    await assert.rejects(f.store.get('closed'), /not found/);
    await assert.rejects(f.store.refresh('closed'), /closed/);
    await assert.rejects(readdir(resolveSessionWorkspace(f.dir, 'closed')), /ENOENT/);
  } finally { f.db.close(); }
});
test('application inference uses metadata and real tool inputs, never unrelated text or results', async () => {
  const f = await fixture();
  try {
    f.db.updateSession('s', { app_ids: '[]' });
    f.db.appendEvent('s', 'tool_use', { skill: 'spark-history', input: { appId: 'from-tool' } });
    f.db.appendEvent('s', 'tool_result', { appId: 'ignore' });
    f.db.appendEvent('s', 'tool_use', { skill: 'session', input: { appId: 'ignore-too' } });
    assert.equal((await f.store.refresh('s')).appId, 'from-tool');
    f.db.appendEvent('s', 'tool_use', { skill: 'spark-diagnose', input: { baselineAppId: 'baseline', experimentAppId: 'experiment' } });
    assert.deepEqual(f.store.applicationIds(f.db.getSession('s')!), ['from-tool', 'baseline', 'experiment']);
    await assert.rejects(f.store.refresh('s'), /multiple/);
    assert.equal((await f.store.refresh('s', 'chosen')).appId, 'chosen');
  } finally { f.db.close(); }
});
test('closure while capturing rejects persistence', async () => {
  const f = await fixture();
  const store = new SessionGraphStore(f.config, f.db, async (appId) => {
    f.db.updateSession('s', { status: 'closed' });
    return normalizeGraphSnapshot({ appId, sourceUrl: 'hs', sqlExecutions: [], stages: [], findings: [] });
  });
  try {
    await assert.rejects(store.refresh('s'), /closed/);
    await assert.rejects(readdir(resolveSessionWorkspace(f.dir, 's')), /ENOENT/);
  } finally { f.db.close(); }
});
test('registered GET and POST graph routes are token protected, replay direct snapshots and reject closed POST', async () => {
  const f = await fixture();
  const app = Fastify();
  app.addHook('onRequest', async (req, reply) => {
    if (req.headers.authorization !== 'Bearer test') return reply.code(401).send({ error: 'unauthorized' });
  });
  registerGraphRoutes(app, f.store);
  const headers = { authorization: 'Bearer test' };
  try {
    for (const method of ['GET', 'POST'] as const) {
      assert.equal((await app.inject({ method, url: '/api/sessions/s/graph' })).statusCode, 401);
    }
    assert.equal((await app.inject({ method: 'GET', url: '/api/sessions/s/graph', headers })).statusCode, 404);
    const capture = await app.inject({ method: 'POST', url: '/api/sessions/s/graph', headers, payload: {} });
    assert.equal(capture.statusCode, 200);
    assert.equal(capture.json().version, 1);
    f.fail();
    const replay = await app.inject({ method: 'GET', url: '/api/sessions/s/graph?appId=app', headers });
    assert.deepEqual(replay.json(), capture.json());
    f.db.updateSession('s', { status: 'closed' });
    assert.equal((await app.inject({ method: 'POST', url: '/api/sessions/s/graph', headers, payload: {} })).statusCode, 409);
    assert.equal((await app.inject({ method: 'GET', url: '/api/sessions/missing/graph', headers })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: '/api/sessions/s/graph', headers, payload: { appId: {} } })).statusCode, 400);
  } finally { await app.close(); f.db.close(); }
});
