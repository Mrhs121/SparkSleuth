import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import Fastify from 'fastify';
import { loadConfig, type LLMClient } from '@sparksleuth/core';
import { Db } from '../src/db.js';
import { MemoryStoreImpl } from '../src/memory/store.js';
import { generationLanguage } from '../src/memory/localization.js';
import { registerMemoryRoutes } from '../src/memory/routes.js';
import { runDream } from '../src/memory/dream.js';
import { SessionManager } from '../src/session/manager.js';

const result = (text: string) => ({ blocks: [{ type: 'text' as const, text }], stopReason: 'end_turn' as const, usage: { input: 1, output: 1 } });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'sparksleuth-memory-language-'));
  const db = new Db(join(dir, 'test.db'));
  const memory = new MemoryStoreImpl(join(dir, 'memory'), db);
  await memory.init();
  return { dir, db, memory, close: async () => { db.close(); assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + '/')); await rm(dir, { recursive: true, force: true }); } };
}

test('memory GETs ignore language, return exact saved source shapes, never call models or write caches; approval promotes original', async () => {
  const f = await fixture();
  let clientRequests = 0;
  let modelCalls = 0;
  const client = { complete: async () => { modelCalls++; throw new Error('Reading memory must not call a model'); } } as unknown as LLMClient;
  const source = 'a self join on a non-unique user id produces N^2 rows; cap it with a Top-N window before joining. TASK_SKEW application_123_4 12.5%\n```sql\nSELECT * FROM t WHERE id = 7;\n```\n中文原始证据';
  const app = Fastify();
  registerMemoryRoutes(app, f.db, f.memory, () => { clientRequests++; return client; });
  try {
    await f.memory.save({ sid: 'one', title: 'Existing English report', tags: ['TASK_SKEW'], description: 'English description 原文', document: source, appIds: ['application_123_4'], rules: ['TASK_SKEW'] });
    await f.memory.promoteLesson(['Original English lesson with N^2 and 中文证据']);
    f.db.addDreamCandidate('2026-01-01', source);
    const original = await f.memory.get('one');
    const hits = await f.memory.search({ limit: 20 });
    const items = await f.memory.experience();
    const candidates = JSON.parse(JSON.stringify(f.db.listDreamCandidates()));
    // Simulate an old database: obsolete cached translations must be ignored and preserved.
    const sql = (f.db as unknown as { db: DatabaseSync }).db;
    assert.equal(sql.prepare("SELECT name FROM sqlite_master WHERE name = 'presentation_cache'").get(), undefined, 'fresh databases do not create the obsolete cache');
    sql.exec('CREATE TABLE presentation_cache (cache_key TEXT PRIMARY KEY, content TEXT NOT NULL, created_at INTEGER NOT NULL)');
    sql.prepare('INSERT INTO presentation_cache VALUES (?, ?, ?)').run('legacy-key', 'obsolete translated content', 1);
    const cacheBefore = sql.prepare('SELECT * FROM presentation_cache').all();
    const changesBefore = sql.prepare('SELECT total_changes() AS count').get();
    for (const query of ['', '?language=zh', '?language=en', '?language=fr', '?language=zh&language=en']) {
      const doc = await app.inject(`/api/memory/one${query}`);
      assert.equal(doc.statusCode, 200);
      assert.equal(doc.body, original);
      assert.match(String(doc.headers['content-type']), /^text\/markdown/);
      assert.equal(doc.headers['x-sparksleuth-localization'], undefined);
      assert.equal(doc.headers['x-sparksleuth-language'], undefined);
      assert.deepEqual((await app.inject(`/api/memory${query}`)).json(), hits);
      assert.deepEqual((await app.inject(`/api/memory/experience${query}`)).json(), { items });
      assert.deepEqual((await app.inject(`/api/memory/dream/candidates${query}`)).json(), candidates);
    }
    assert.deepEqual((await app.inject('/api/memory/dream/candidates?status=pending&language=en')).json(), candidates);
    assert.deepEqual((await app.inject('/api/memory/dream/candidates?status=approved&language=zh')).json(), []);
    assert.deepEqual(sql.prepare('SELECT total_changes() AS count').get(), changesBefore, 'GETs perform no database writes');
    assert.deepEqual(sql.prepare('SELECT * FROM presentation_cache').all(), cacheBefore, 'existing presentation cache is neither read nor written');
    assert.equal(clientRequests, 0, 'GETs never even request a model client');
    assert.equal(modelCalls, 0);
    const approved = await app.inject({ method: 'POST', url: `/api/memory/dream/candidates/${candidates[0].id}`, payload: { action: 'approve' } });
    assert.equal(approved.statusCode, 200);
    assert.equal(await readFile(approved.json().path, 'utf8'), `# lessons\n\n- ${items[0]}\n- ${source}\n`, 'approval writes the exact original candidate, including multiline evidence');
    assert.equal(f.db.listDreamCandidates()[0].content, source);
    assert.equal(f.db.listDreamCandidates()[0].status, 'approved');
    // Stored lesson parsing remains the original store behavior, not a translated presentation.
    assert.ok((await f.memory.experience()).includes(source.split('\n')[0]));
    assert.equal(await f.memory.get('one'), original);
    assert.equal(clientRequests, 0);
    assert.equal(modelCalls, 0);
    const emptyMemory = new MemoryStoreImpl(join(f.dir, 'empty-memory'), f.db);
    const emptyApp = Fastify();
    registerMemoryRoutes(emptyApp, f.db, emptyMemory, () => client);
    assert.equal((await emptyApp.inject({ method: 'POST', url: '/api/memory/dream' })).statusCode, 200, 'legacy no-body dream remains accepted');
    await emptyApp.close();
    for (const language of ['fr', null, ['zh'], true, 1, {}]) assert.equal((await app.inject({ method: 'POST', url: '/api/memory/dream', payload: { language } })).statusCode, 400);
    assert.equal(modelCalls, 0);
  } finally { await app.close(); await f.close(); }
});

test('finish chooses explicit language then persisted latest turn; dreams use persisted manual preference and Chinese default', async () => {
  const f = await fixture();
  const prompts: string[] = [];
  const client = { complete: async (p: { messages: Array<{ content: unknown }> }) => {
    const prompt = String(p.messages[0].content); prompts.push(prompt);
    const chinese = prompt.includes('Write all model-authored titles, descriptions, lessons and Markdown prose in Simplified Chinese');
    return result(prompt.startsWith('Summarise') ? JSON.stringify({ title: chinese ? '诊断总结' : 'Diagnostic summary', description: chinese ? '已保存的中文说明' : 'Saved English description', document: chinese ? '中文诊断记录' : 'English investigation notes', tags: [] }) : JSON.stringify({ lessons: [chinese ? '中文可复用经验' : 'Reusable English lesson'] }));
  } } as unknown as LLMClient;
  const config = loadConfig({ runtime: { dataDir: f.dir } });
  const manager = new SessionManager(config, f.db, f.memory);
  (manager as unknown as { llm: LLMClient }).llm = client;
  try {
    f.db.createSession('one', 'one'); f.db.setPreference('session.language:one', 'en');
    const first = await manager.finish('one', 'zh'); assert.match(prompts.at(-1)!, /Write all model-authored.+Simplified Chinese/);
    assert.equal(first.summary?.title, '诊断总结');
    assert.equal(await f.memory.get('one'), '# 诊断总结\n\n中文诊断记录\n');
    const callsAfterFinish = prompts.length;
    await manager.finish('one', 'en');
    assert.equal(prompts.length, callsAfterFinish, 'closed memories are not regenerated when language changes');
    assert.equal(await f.memory.get('one'), '# 诊断总结\n\n中文诊断记录\n');
    f.db.createSession('two', 'two'); f.db.setPreference('session.language:two', 'en');
    await manager.finish('two'); assert.match(prompts.at(-1)!, /Write all model-authored.+English/);
    assert.equal(await f.memory.get('two'), '# Diagnostic summary\n\nEnglish investigation notes\n');
    await runDream(f.db, f.memory, client); assert.match(prompts.at(-1)!, /Write all model-authored.+Simplified Chinese/);
    assert.ok(f.db.listDreamCandidates().some((c) => c.content === '中文可复用经验'));
    const app = Fastify(); registerMemoryRoutes(app, f.db, f.memory, () => client);
    await app.inject({ method: 'POST', url: '/api/memory/dream', payload: { language: 'en' } });
    assert.equal(f.db.getPreference('dream.language'), 'en'); await app.close();
    await runDream(f.db, f.memory, client); assert.match(prompts.at(-1)!, /Write all model-authored.+English/);
    assert.ok(f.db.listDreamCandidates().some((c) => c.content === 'Reusable English lesson'));
    await runDream(f.db, f.memory, client, { language: 'zh' }); assert.match(prompts.at(-1)!, /Write all model-authored.+Simplified Chinese/);
    assert.match(generationLanguage(), /latest user turn/);
  } finally { await f.close(); }
});
