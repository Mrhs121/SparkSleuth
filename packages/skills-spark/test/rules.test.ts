import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppFacts, PlanNodeFacts, StageFacts } from '../src/facts.js';
import { runRules, type Thresholds } from '../src/rules/index.js';

/** Mirrors the formatter the rules use, so the test does not pin a locale. */
function count(n: number): string {
  return n.toLocaleString('en-US');
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

const thresholds: Thresholds = {
  skewRatio: 5,
  spillRatio: 1,
  gcRatio: 0.1,
  fanoutRatio: 10,
  dominantRatio: 0.5,
};

function stage(overrides: Partial<StageFacts> = {}): StageFacts {
  return {
    stageId: 0,
    attemptId: 0,
    name: 'stage 0',
    status: 'COMPLETE',
    durationMs: 10_000,
    numTasks: 10,
    failedTasks: 0,
    killedTasks: 0,
    inputBytes: 0,
    outputBytes: 0,
    shuffleReadBytes: 0,
    shuffleWriteBytes: 0,
    memorySpill: 0,
    diskSpill: 0,
    failedTaskSamples: [],
    ...overrides,
  };
}

function node(name: string, rows?: number, extra: Record<string, number> = {}): PlanNodeFacts {
  const metrics: Record<string, number> = { ...extra };
  if (rows !== undefined) metrics['number of output rows'] = rows;
  return { name, metrics };
}

function facts(overrides: Partial<AppFacts> = {}): AppFacts {
  return {
    appId: 'application_1_1',
    appName: 'test',
    running: false,
    durationMs: 60_000,
    stages: [],
    jobs: [],
    executors: { active: 4, total: 4, removed: [], failedTasks: 0, gcRatio: 0, memoryUsedRatio: 0.3, totalCores: 8 },
    sql: [],
    config: {},
    collectedAt: new Date().toISOString(),
    ...overrides,
  };
}

function ids(f: ReturnType<typeof runRules>): string[] {
  return f.map((x) => `${x.ruleId}:${x.severity}`);
}

test('a healthy application produces no P0 or P1 findings', () => {
  const f = runRules(
    facts({
      stages: [stage({ stageId: 0, durationMs: 20_000 }), stage({ stageId: 1, durationMs: 18_000 })],
      config: {
        'spark.sql.adaptive.enabled': 'true',
        'spark.sql.shuffle.partitions': '200',
        'spark.executor.memory': '4g',
        'spark.executor.memoryOverhead': '1g',
      },
    }),
    thresholds,
  );
  assert.deepEqual(
    f.filter((x) => x.severity === 'P0' || x.severity === 'P1'),
    [],
  );
});

test('SPILL_HEAVY fires when spill exceeds shuffle read', () => {
  const f = runRules(facts({ stages: [stage({ memorySpill: 3 * GB, shuffleReadBytes: 100 * MB })] }), thresholds);
  const finding = f.find((x) => x.ruleId === 'SPILL_HEAVY');
  assert.ok(finding, 'expected SPILL_HEAVY');
  assert.equal(finding!.severity, 'P0');
  assert.equal(finding!.scope?.stageId, 0);
});

test('SPILL_HEAVY stays quiet when the working set fits', () => {
  const f = runRules(facts({ stages: [stage({ memorySpill: 10 * MB, shuffleReadBytes: 500 * MB })] }), thresholds);
  assert.equal(f.find((x) => x.ruleId === 'SPILL_HEAVY'), undefined);
});

test('TASK_SKEW fires on a long tail', () => {
  const f = runRules(
    facts({
      stages: [
        stage({
          numTasks: 100,
          quantiles: {
            p50DurationMs: 5_000,
            p95DurationMs: 200_000,
            maxDurationMs: 600_000,
            p50GcMs: 0,
            maxGcMs: 0,
            p50ShuffleRead: 0,
            maxShuffleRead: 0,
            p50ShuffleWrite: 0,
            maxShuffleWrite: 0,
            p50Spill: 0,
            maxSpill: 0,
            durationSkew: 120,
            shuffleReadSkew: 0,
          },
        }),
      ],
    }),
    thresholds,
  );
  assert.ok(f.find((x) => x.ruleId === 'TASK_SKEW'));
});

test('TASK_SKEW ignores a short tail below the duration floor', () => {
  const f = runRules(
    facts({
      stages: [
        stage({
          quantiles: {
            p50DurationMs: 100,
            p95DurationMs: 900,
            maxDurationMs: 2_000,
            p50GcMs: 0,
            maxGcMs: 0,
            p50ShuffleRead: 0,
            maxShuffleRead: 0,
            p50ShuffleWrite: 0,
            maxShuffleWrite: 0,
            p50Spill: 0,
            maxSpill: 0,
            durationSkew: 20,
            shuffleReadSkew: 0,
          },
        }),
      ],
    }),
    thresholds,
  );
  assert.equal(f.find((x) => x.ruleId === 'TASK_SKEW'), undefined);
});

test('JOIN_EXPLOSION reads the join inputs from the node order', () => {
  const f = runRules(
    facts({
      sql: [
        {
          id: 0,
          description: 'self join',
          durationMs: 30_000,
          nodes: [
            node('Range', 200_000),
            node('Generate', 3_200_000),
            node('BroadcastExchange', 3_200_000),
            node('Range', 3),
            node('Generate', 18_000),
            node('BroadcastHashJoin', 77_990_000),
            node('HashAggregate', 24_000_000),
            node('Execute InsertIntoHadoopFsRelationCommand', 24_000_000),
          ],
        },
      ],
    }),
    thresholds,
  );
  const finding = f.find((x) => x.ruleId === 'JOIN_EXPLOSION');
  assert.ok(finding, 'expected JOIN_EXPLOSION');
  assert.match(finding!.title, /24x|24\.4x/);
  assert.equal(finding!.evidence.joinOutputRows, '7799.00万');
});

test('JOIN_EXPLOSION ignores a normal one-to-many join', () => {
  const f = runRules(
    facts({
      sql: [
        {
          id: 1,
          description: 'dimension join',
          durationMs: 5_000,
          nodes: [node('Scan parquet', 10_000_000), node('Scan parquet', 500), node('BroadcastHashJoin', 10_050_000)],
        },
      ],
    }),
    thresholds,
  );
  assert.equal(f.find((x) => x.ruleId === 'JOIN_EXPLOSION'), undefined);
});

test('BNLJ fires on a broadcast nested loop join', () => {
  const f = runRules(
    facts({
      sql: [
        {
          id: 2,
          description: 'non-equi',
          durationMs: 40_000,
          nodes: [node('Scan parquet', 400_000), node('BroadcastNestedLoopJoin', 120_000_000)],
        },
      ],
    }),
    thresholds,
  );
  const finding = f.find((x) => x.ruleId === 'BNLJ');
  assert.ok(finding);
  assert.equal(finding!.evidence.operator, 'BroadcastNestedLoopJoin');
});

test('TASK_FAILURES clusters repeated error messages', () => {
  const f = runRules(
    facts({
      stages: [
        stage({
          status: 'FAILED',
          failedTasks: 3,
          failedTaskSamples: [
            'java.lang.IllegalArgumentException: bad value 42',
            'java.lang.IllegalArgumentException: bad value 99',
            'java.lang.OutOfMemoryError: Java heap space',
          ],
        }),
      ],
    }),
    thresholds,
  );
  const finding = f.find((x) => x.ruleId === 'TASK_FAILURES');
  assert.ok(finding);
  const clusters = finding!.evidence.errorClusters as Record<string, number>;
  assert.equal(Object.values(clusters).reduce((a, b) => a + b, 0), 3);
});

test('SMALL_FILES fires on a scan of many tiny files', () => {
  const f = runRules(
    facts({
      sql: [
        {
          id: 3,
          description: 'scan',
          durationMs: 8_000,
          nodes: [node('Scan parquet', 40_000, { 'number of files': 2_000, 'size of files': 20 * MB })],
        },
      ],
    }),
    thresholds,
  );
  const finding = f.find((x) => x.ruleId === 'SMALL_FILES');
  assert.ok(finding);
  assert.equal(finding!.evidence.files, count(2000));
});

test('CONF_CHECK flags AQE being switched off', () => {
  const f = runRules(facts({ config: { 'spark.sql.adaptive.enabled': 'false' } }), thresholds);
  const finding = f.find((x) => x.ruleId === 'CONF_CHECK');
  assert.ok(finding);
  assert.ok(Object.keys(finding!.evidence).includes('spark.sql.adaptive.enabled'));
});

test('findings are ordered by severity', () => {
  const f = runRules(
    facts({
      stages: [stage({ memorySpill: 5 * GB, shuffleReadBytes: 10 * MB })],
      config: { 'spark.sql.adaptive.enabled': 'false' },
    }),
    thresholds,
  );
  assert.deepEqual(ids(f), ['SPILL_HEAVY:P0', 'CONF_CHECK:P2']);
});

test('a rule that throws does not take the run down', () => {
  const broken = { ...facts(), stages: [stage()] } as AppFacts;
  Object.defineProperty(broken, 'stages', {
    get() {
      throw new Error('boom');
    },
  });
  const f = runRules(broken, thresholds);
  assert.ok(Array.isArray(f));
});
