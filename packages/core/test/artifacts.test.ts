import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../src/artifacts/store.js';

test('ArtifactStore writes, queries, inspects and lists artifacts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sparksleuth-art-'));
  try {
    const store = new ArtifactStore(dir);

    // 1. Write an array artifact
    const sampleData = [
      { taskId: 1, durationMs: 1500, status: 'SUCCESS' },
      { taskId: 2, durationMs: 4500, status: 'SUCCESS' },
      { taskId: 3, durationMs: 800, status: 'FAILED' },
    ];
    const stored = await store.write('tasks_sample', sampleData);
    assert.ok(stored.id.startsWith('tasks_sample-'));
    assert.equal(stored.rows, 3);

    // 2. Query with filter, sort, and fields
    const queryResult = await store.query(stored.id, {
      filter: { status: 'SUCCESS' },
      sortBy: 'durationMs',
      order: 'desc',
      fields: ['taskId', 'durationMs'],
    });
    assert.ok(queryResult.includes('2 item(s)'));
    assert.ok(queryResult.includes('"taskId": 2'));
    assert.ok(queryResult.includes('"durationMs": 4500'));

    // 3. Inspect artifact structure
    const head = await store.inspect(stored.id);
    assert.ok(head.includes('Array of 3 item(s)'));
    assert.ok(head.includes('taskId, durationMs, status'));

    // 4. List artifacts
    const list = await store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, stored.id);

    // 5. Inspect an object artifact
    const objStored = await store.write('metrics_obj', {
      totalSpill: 1024,
      nested: { a: 1, b: 2 },
      records: [1, 2, 3],
    });
    const objHead = await store.inspect(objStored.id);
    assert.ok(objHead.includes('Object with 3 key(s)'));
    assert.ok(objHead.includes('totalSpill'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
