import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@sparksleuth/core';
import { Db } from '../src/db.js';
import { MemoryStoreImpl } from '../src/memory/store.js';
import { SessionManager } from '../src/session/manager.js';

test('SessionManager: cancel preserves cancelled status, closed session is idempotent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sparksleuth-sess-'));
  try {
    const config = loadConfig({
      runtime: {
        dataDir: dir,
        concurrency: 2,
        sessionTimeoutMs: 60_000,
      },
    });
    const db = new Db(join(dir, 'test.db'));
    const memory = new MemoryStoreImpl(join(dir, 'memory'), db);
    await memory.init();

    const manager = new SessionManager(config, db, memory);

    // Mock llm with a controllable hanging run to test cancellation mid-flight
    (manager as any).llm = {
      complete: (params: any, _cb: any) => {
        if (params.tools && params.tools.length > 0) {
          return new Promise((_resolve, reject) => {
            params.signal?.addEventListener('abort', () => {
              reject(new Error('cancelled by user'));
            });
          });
        }
        return Promise.resolve({
          blocks: [{ type: 'text', text: JSON.stringify({ title: 'Test Summary', tags: ['test'], description: 'desc', document: 'doc' }) }],
          usage: { input: 10, output: 10 },
        });
      },
    };

    // 1. Create a session and ensure it is running
    const { sid } = await manager.create({ message: 'test run' });
    assert.ok(manager.isRunning(sid));

    // 2. Test cancel() mid-flight
    const cancelled = manager.cancel(sid);
    assert.equal(cancelled, true);

    // Give async run a moment to hit catch block and cleanup
    await new Promise((r) => setTimeout(r, 50));

    const sessCancelled = db.getSession(sid);
    assert.equal(sessCancelled?.status, 'cancelled', 'Status should remain cancelled, NOT overwritten to failed!');
    assert.equal(manager.isRunning(sid), false);

    // 3. Test finish() on a session and idempotency
    db.updateSession(sid, { status: 'waiting' });
    const finishRes1 = await manager.finish(sid);
    assert.equal(finishRes1.ok, true);

    const closedSess = db.getSession(sid);
    assert.equal(closedSess?.status, 'closed');

    // Calling finish() a second time on closed session must be idempotent and return ok
    const finishRes2 = await manager.finish(sid);
    assert.equal(finishRes2.ok, true);

    // 4. Continuing a closed session must be rejected with clear error
    await assert.rejects(
      async () => {
        await manager.continue(sid, 'another question');
      },
      (err: Error) => {
        assert.ok(err.message.includes('closed and archived'));
        return true;
      },
    );

    // 5. Test history reconstruction retaining tool results
    db.appendEvent(sid, 'tool_result', {
      type: 'tool_result',
      id: 'call_test',
      skill: 'spark-history',
      tool: 'stage_detail',
      summary: 'Stage 2 has 98MB spill and 135x skew factor.',
      ts: Date.now(),
    });
    db.appendEvent(sid, 'user_message', {
      type: 'user_message',
      text: 'How to fix the spill?',
      ts: Date.now(),
    });

    const history = await (manager as any).loadHistory(sid);
    assert.ok(history.length >= 2);
    const assistantMsg = history.find((m: any) => m.role === 'assistant');
    assert.ok(assistantMsg, 'Expected assistant message reconstructed in history');
    assert.ok(assistantMsg.content.includes('Previous tool findings & data'));
    assert.ok(assistantMsg.content.includes('Stage 2 has 98MB spill'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SessionManager enforces concurrency limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sparksleuth-conc-'));
  try {
    const config = loadConfig({
      runtime: {
        dataDir: dir,
        concurrency: 1, // Only 1 concurrent run allowed
      },
    });
    const db = new Db(join(dir, 'test.db'));
    const memory = new MemoryStoreImpl(join(dir, 'memory'), db);
    await memory.init();

    const manager = new SessionManager(config, db, memory);

    // Simulate an active run in runs map
    (manager as any).runs.set('active-1', { abort: new AbortController() });

    // Trying to create a new session should throw concurrency limit error
    await assert.rejects(
      async () => {
        await manager.create({ message: 'second session' });
      },
      (err: Error) => {
        assert.ok(err.message.includes('Concurrency limit reached'));
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
