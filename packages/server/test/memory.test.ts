import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/db.js';
import { MemoryStoreImpl } from '../src/memory/store.js';

test('MemoryStoreImpl indexes, recalls by relevance and filters unrelated items', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sparksleuth-mem-'));
  try {
    const db = new Db(join(dir, 'test.db'));
    const store = new MemoryStoreImpl(join(dir, 'memory'), db);
    await store.init();

    // 1. Save two different session memories
    await store.save({
      sid: 'session-skew',
      title: 'Skewed SortMergeJoin Investigation',
      tags: ['skew', 'join', 'smj'],
      description: 'Stage 2 was slow due to a hot key in customer_id join.',
      document: 'Detailed analysis of hot key customer_id=0 causing 98MB spill.',
      appIds: ['app-skew-1'],
      rules: ['TASK_SKEW', 'SPILL_HEAVY'],
    });

    await store.save({
      sid: 'session-oom',
      title: 'Driver OutOfMemory during collect',
      tags: ['oom', 'driver', 'memory'],
      description: 'Driver ran out of memory when collecting large dataframe.',
      document: 'User called .collect() on 50 million rows.',
      appIds: ['app-oom-2'],
      rules: ['EXECUTOR_LOST'],
    });

    // 2. Search for "skew": only session-skew should match; session-oom must NOT be returned!
    const skewHits = await store.search({ keyword: 'skew' });
    assert.equal(skewHits.length, 1);
    assert.equal(skewHits[0].sid, 'session-skew');
    assert.equal(skewHits[0].title, 'Skewed SortMergeJoin Investigation');

    // 3. Search for tags: ["driver"]
    const oomHits = await store.search({ tags: ['driver'] });
    assert.equal(oomHits.length, 1);
    assert.equal(oomHits[0].sid, 'session-oom');

    // 4. Search for unrelated keyword "broadcast": neither should match!
    const noneHits = await store.search({ keyword: 'broadcast' });
    assert.equal(noneHits.length, 0, 'Unrelated keyword should return 0 hits, not bypass threshold!');

    // 5. Without keyword/tags, returns recent sessions
    const allHits = await store.search({ limit: 10 });
    assert.equal(allHits.length, 2);

    // 6. Document body retrieval
    const doc = await store.get('session-skew');
    assert.ok(doc?.includes('customer_id=0'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
