import test from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError, languageBody } from '../src/api.ts';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { search: '' } } });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
} });

test('language body contains only explicit current generation language', () => {
  assert.deepEqual(JSON.parse(languageBody('zh')), { language: 'zh' });
  assert.deepEqual(JSON.parse(languageBody('en')), { language: 'en' });
});

test('memory/report GET reads return original native shapes without language or translation requests', async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const path = new URL(String(url), 'http://localhost').pathname;
    if (path === '/api/memory/experience') return Response.json({ items: ['原始经验', 'Original rule'] });
    if (path === '/api/memory') return Response.json([
      { sid: 'sid', title: '原始标题', desc: '原始描述', tags: [], date: '2026-11-03' },
      { sid: 'sid2', title: 'Original title', description: 'Original description', desc: 'legacy', tags: [], date: '2026-11-03' },
    ]);
    if (path === '/api/memory/dream/candidates') return Response.json([{ id: 1, date: '2026-11-03', content: '原始候选', status: 'pending' }]);
    return new Response('# 原始报告\nOriginal saved text');
  };
  try {
    const signal = new AbortController().signal;
    const memory = await api.memory('spill & skew 中文', signal);
    assert.equal(memory[0].description, '原始描述');
    assert.equal(memory[1].description, 'Original description');
    const doc = await api.memoryDoc('exact/sid', signal);
    const experience = await api.experience(signal);
    const candidates = await api.dreamCandidates(signal);
    const report = await api.report('exact/sid', 'report name.md', signal);
    await api.memory();
    assert.equal(calls.length, 6);
    for (const call of calls) {
      const url = new URL(call.url, 'http://localhost');
      assert.equal(url.searchParams.has('language'), false);
      assert.equal(url.searchParams.has('lang'), false);
      assert.equal(call.init?.method, undefined);
      assert.equal(call.init?.body, undefined);
    }
    for (const call of calls.slice(0, 5)) assert.equal(call.init?.signal, signal);
    assert.equal(new URL(calls[0].url, 'http://localhost').searchParams.get('keyword'), 'spill & skew 中文');
    assert.equal(calls[5].url, '/api/memory');
    assert.match(calls[1].url, /exact%2Fsid/);
    assert.match(calls[4].url, /report%20name\.md/);
    assert.equal(doc, '# 原始报告\nOriginal saved text');
    assert.equal(report, doc);
    assert.deepEqual(experience, { items: ['原始经验', 'Original rule'] });
    assert.equal(candidates[0].content, '原始候选');
  } finally { globalThis.fetch = originalFetch; }
});

test('explicit finish and dream requests preserve active language JSON in both languages', async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return Response.json({ ok: true, candidates: 1 }); };
  try {
    for (const language of ['zh', 'en'] as const) {
      await api.finish('exact/session', language);
      await api.dream(language);
    }
    assert.deepEqual(calls.map((call) => call.url), ['/api/sessions/exact%2Fsession/finish', '/api/memory/dream', '/api/sessions/exact%2Fsession/finish', '/api/memory/dream']);
    for (const [index, language] of ['zh', 'zh', 'en', 'en'].entries()) {
      assert.equal(calls[index].init?.method, 'POST');
      assert.deepEqual(JSON.parse(String(calls[index].init?.body)), { language });
      assert.equal((calls[index].init?.headers as Record<string, string>)['content-type'], 'application/json');
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('failed Markdown requests are errors, not rendered error bodies', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: 'unauthorized' }, { status: 401 });
  try {
    await assert.rejects(api.memoryDoc('sid'), (error: unknown) => error instanceof ApiError && error.status === 401);
    await assert.rejects(api.report('sid', 'report.md'), /unauthorized/);
  } finally { globalThis.fetch = originalFetch; }
});
