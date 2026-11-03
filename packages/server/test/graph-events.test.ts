import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@sparksleuth/core';
import { Db } from '../src/db.js';
import { MemoryStoreImpl } from '../src/memory/store.js';
import { SessionManager } from '../src/session/manager.js';

test('graph notifications use only actual successful Spark tool application inputs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sparksleuth-graph-events-'));
  const db = new Db(join(dir, 'test.db'));
  try {
    const config = loadConfig({ runtime: { dataDir: dir } });
    const manager = new SessionManager(config, db, new MemoryStoreImpl(join(dir, 'memory'), db));
    db.createSession('test', 'Test');
    const forward = (event: unknown) => (manager as any).forward('test', event);
    forward({ type: 'tool_use', id: '1', skill: 'spark-history', tool: 'history_sql_detail', input: { appId: 'local-1' } });
    forward({ type: 'tool_result', id: '1', skill: 'spark-history', tool: 'history_sql_detail', summary: 'SQL 0' });
    forward({ type: 'tool_use', id: '2', skill: 'spark-history', tool: 'history_sql_detail', input: { appId: 'bad' } });
    forward({ type: 'tool_result', id: '2', skill: 'spark-history', tool: 'history_sql_detail', summary: 'failed', isError: true });
    forward({ type: 'tool_use', id: '3', skill: 'memory', tool: 'search', input: { appId: 'irrelevant' } });
    forward({ type: 'tool_result', id: '3', skill: 'memory', tool: 'search', summary: 'case' });
    const events = manager.replay('test').filter((e) => e.type === 'graph_available');
    assert.equal(events.length, 1);
    assert.equal(events[0].appId, 'local-1');
    assert.equal((manager as any).graphToolApps.size, 0);
  } finally { db.close(); }
});
