import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';
import { loadConfig, resolveSessionWorkspace, writeSessionReport, type LLMClient, type Message } from '@sparksleuth/core';
import { Db } from '../src/db.js';
import { MemoryStoreImpl } from '../src/memory/store.js';
import { SessionManager } from '../src/session/manager.js';

test('SessionManager applies UI language per turn without changing user messages or legacy prompts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sparksleuth-language-'));
  const db = new Db(join(dir, 'test.db'));
  const config = loadConfig({ runtime: { dataDir: dir } });
  const memory = new MemoryStoreImpl(join(dir, 'memory'), db);
  await memory.init();
  const manager = new SessionManager(config, db, memory);
  const requests: Array<{ system: string; messages: Message[] }> = [];
  const llm = {
    complete: async (params: { system: string; messages: Message[] }) => {
      requests.push({ system: params.system, messages: structuredClone(params.messages) });
      return { blocks: [{ type: 'text' as const, text: 'mock answer' }], stopReason: 'end_turn', usage: { input: 1, output: 1 } };
    },
  };
  // Replace only the model boundary; exercise actual prompt assembly and Agent loop.
  (manager as unknown as { llm: LLMClient }).llm = llm as unknown as LLMClient;
  const waitForTurn = (sid: string): Promise<void> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('Turn did not finish')); }, 5000);
    const unsubscribe = manager.subscribe(sid, (event) => {
      if (event.type !== 'done' && event.type !== 'error') return;
      clearTimeout(timer);
      unsubscribe();
      if (event.type === 'error') reject(new Error(String(event.message)));
      else resolve();
    });
  });
  try {
    const firstMessage = 'Explain this slow Spark application in English.';
    const { sid } = await manager.create({ message: firstMessage, appId: 'local-test', language: 'zh' });
    await waitForTurn(sid);
    assert.match(requests[0].system, /The user interface language is Simplified Chinese/);
    assert.match(requests[0].system, /overrides the earlier "Answer in the user's language" rule/);
    assert.match(requests[0].system, /narration, findings, purpose descriptions, report titles and report Markdown/);
    const expectedFirst = `Spark application: local-test\n\n${firstMessage}`;
    assert.equal(requests[0].messages.at(-1)?.content, expectedFirst);

    const followUp = '请用中文解释瓶颈。';
    const englishDone = waitForTurn(sid);
    await manager.continue(sid, followUp, 'en');
    await englishDone;
    assert.match(requests[1].system, /The user interface language is English/);
    assert.doesNotMatch(requests[1].system, /The user interface language is Simplified Chinese/);
    assert.equal(requests[1].messages.at(-1)?.content, followUp);
    assert.equal(db.getPreference(`session.language:${sid}`), 'en', 'latest explicit UI language is persisted for finish');

    const legacyFollowUp = '继续诊断';
    const legacyDone = waitForTurn(sid);
    await manager.continue(sid, legacyFollowUp);
    await legacyDone;
    assert.match(requests[2].system, /Answer in the user's language\./);
    assert.doesNotMatch(requests[2].system, /## Response language for this turn/);
    assert.equal(requests[2].messages.at(-1)?.content, legacyFollowUp);
    assert.equal(db.getPreference(`session.language:${sid}`), 'en', 'omitted language does not erase saved finish preference');
    assert.deepEqual(manager.replay(sid).filter((e) => e.type === 'user_message').map((e) => e.text), [expectedFirst, followUp, legacyFollowUp]);

    const { sid: legacySid } = await manager.create({ message: 'Legacy new session' });
    await waitForTurn(legacySid);
    assert.doesNotMatch(requests[3].system, /## Response language for this turn/);
  } finally {
    db.close();
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + '/'));
    await rm(dir, { recursive: true, force: true });
  }
});

test('real create/send API routes reject non-enum languages before starting a model run', { timeout: 20_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sparksleuth-language-api-'));
  const reportMarkdown = 'English saved report with TASK_SKEW application_123_4 12.5%\n\n中文原始证据\n\n```sql\nSELECT * FROM t WHERE id = 7;\n```';
  const report = await writeSessionReport(resolveSessionWorkspace(dir, 'saved-source'), 'Original report 原文', reportMarkdown);
  const reportSource = `# Original report 原文\n\n${reportMarkdown}\n`;
  let modelCalls = 0;
  const llm = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain the request */ }
    modelCalls++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"mock answer"}}\n\ndata: {"type":"message_stop"}\n\n');
  });
  llm.listen(0, '127.0.0.1');
  await once(llm, 'listening');
  const address = llm.address();
  assert.ok(address && typeof address !== 'string');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: new URL('../', import.meta.url),
    env: {
      ...process.env,
      SPARKSLEUTH_DATA_DIR: dir,
      SPARKSLEUTH_PORT: '0',
      SPARKSLEUTH_HOST: '127.0.0.1',
      SPARKSLEUTH_TOKEN: '',
      SPARKSLEUTH_LOG_LEVEL: 'info',
      SPARKSLEUTH_LLM_BASE_URL: `http://127.0.0.1:${address.port}`,
      SPARKSLEUTH_LLM_API_KEY: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    const exited = child.exitCode !== null || child.signalCode !== null;
    if (!exited) { child.kill(); await once(child, 'exit'); }
    await new Promise<void>((resolve, reject) => llm.close((err) => err ? reject(err) : resolve()));
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + '/'));
    await rm(dir, { recursive: true, force: true });
  });
  let output = '';
  const baseUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 10_000);
    const observe = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    };
    child.stdout.on('data', observe);
    child.stderr.on('data', observe);
    child.once('error', (err) => { clearTimeout(timeout); reject(err); });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Server exited (${code}): ${output}`)); });
  });
  const post = (path: string, body: unknown) => fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const invalidLanguages = ['fr', 'ZH', '', null, 1, true, ['zh'], { language: 'en' }];
  for (const language of invalidLanguages) {
    for (const path of ['/api/sessions', '/api/sessions/missing/messages', '/api/sessions/missing/finish', '/api/memory/dream']) {
      const response = await post(path, { message: 'test', language });
      assert.equal(response.status, 400, `${path} must reject ${JSON.stringify(language)}`);
      assert.match(await response.text(), /language/);
    }
  }
  assert.equal((await fetch(`${baseUrl}/api/sessions/missing/finish`, { method: 'POST' })).status, 409, 'legacy finish without body passes validation');
  assert.equal((await fetch(`${baseUrl}/api/memory/dream`, { method: 'POST' })).status, 200, 'legacy dream without body passes validation');
  assert.equal(modelCalls, 0);
  for (const query of ['', '?language=zh', '?language=en', '?language=fr', '?language=zh&language=en']) {
    const response = await fetch(`${baseUrl}/api/sessions/saved-source/reports/${basename(report.path)}${query}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /^text\/markdown/);
    assert.equal(response.headers.get('x-sparksleuth-localization'), null);
    assert.equal(response.headers.get('x-sparksleuth-language'), null);
    assert.equal(await response.text(), reportSource, 'report GET preserves every saved byte regardless of language query');
  }
  assert.equal(modelCalls, 0, 'reading persisted reports never calls the model');
  assert.deepEqual(await (await fetch(`${baseUrl}/api/sessions`)).json(), []);

  for (const language of ['zh', 'en', undefined]) {
    const created = await post('/api/sessions', { message: 'test', language });
    assert.equal(created.status, 200);
    const { sid } = await created.json() as { sid: string };
    // Await actual completion before sending, rather than racing concurrency guards.
    const waitForCompletion = async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const detail = await (await fetch(`${baseUrl}/api/sessions/${sid}`)).json() as { running: boolean; session: { status: string } };
        // The route snapshots status before awaiting reports, so a completion
        // in between can briefly return running=false with the old status.
        if (!detail.running && detail.session.status !== 'running') {
          assert.equal(detail.session.status, 'waiting');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail('Model run did not complete');
    };
    await waitForCompletion();
    const beforeInvalid = modelCalls;
    for (const invalid of invalidLanguages) {
      assert.equal((await post(`/api/sessions/${sid}/messages`, { message: 'test', language: invalid })).status, 400);
    }
    assert.equal(modelCalls, beforeInvalid);
    const sent = await post(`/api/sessions/${sid}/messages`, { message: 'follow-up', language });
    assert.equal(sent.status, 200);
    await waitForCompletion();
  }
  assert.equal(modelCalls, 6);
});
