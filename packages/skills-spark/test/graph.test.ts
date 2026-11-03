import assert from 'node:assert/strict';
import test from 'node:test';
import { collectGraphSnapshot, normalizeGraphSnapshot } from '../src/graph.js';
import { HistoryClient } from '../src/history-client.js';
import { runRules } from '../src/rules/index.js';
import type { AppFacts } from '../src/facts.js';
import type { Finding } from '../src/rules/index.js';

const finding = (ruleId: string, evidence: Record<string, unknown>, scope = { sqlId: 7 }): Finding => ({
  ruleId, severity: 'P0', title: ruleId, evidence, scope, possibleCauses: ['suspected'], suggestions: [],
});
const graph = (findings: Finding[] = []) => normalizeGraphSnapshot({
  appId: 'app', sourceUrl: 'http://history', findings,
  sqlExecutions: [{ id: 7, nodes: [
    { nodeId: 40, nodeName: 'Scan', metrics: [{ name: 'size', value: '2 KiB' }] },
    { nodeId: 9, nodeName: 'Join' }, { nodeId: 3, nodeName: 'Join' },
  ], edges: [{ fromId: 40, toId: 3 }, { fromId: 3, toId: 9 }, { fromId: 40, toId: 9 }] }],
  stages: [{ stageId: 2, attemptId: 0, status: 'COMPLETE', numTasks: 3, diskBytesSpilled: 44 }],
});
test('graph preserves source IDs, directions, branching, raw and normalized metrics', () => {
  const snapshot = graph();
  assert.deepEqual(snapshot.sqlExecutions[0].edges, [
    { source: '40', target: '3' }, { source: '3', target: '9' }, { source: '40', target: '9' },
  ]);
  assert.deepEqual(snapshot.sqlExecutions[0].nodes[0].metrics, [{ name: 'size', raw: '2 KiB', numeric: 2048 }]);
  assert.equal(snapshot.stages[0].metrics.diskBytesSpilled, 44);
  assert.equal(snapshot.stages[0].parentIds, undefined);
});
test('duplicate operators and unlocated small-file findings never guess a node', () => {
  const snapshot = graph([finding('JOIN_EXPLOSION', { operator: 'Join' }), finding('SMALL_FILES', { files: '5000' }),
    finding('SMJ_BROADCASTABLE', { joins: ['Join', 'Join'] })]);
  assert.ok(snapshot.findings.every((f) => f.target.scope === 'sql'));
  assert.equal(snapshot.sqlExecutions[0].findings.length, 3);
  assert.ok(snapshot.sqlExecutions[0].nodes.every((n) => n.annotations.length === 0));
});
test('only exact unique names or explicit node IDs bind findings', () => {
  const snapshot = graph([finding('BNLJ', { operator: 'Scan' }), finding('JOIN_EXPLOSION', { nodeId: 3 }),
    finding('BNLJ', { operator: 'scan' }), finding('JOIN_EXPLOSION', { nodeId: 999, operator: 'Scan' })]);
  assert.deepEqual(snapshot.findings.map((f) => f.target.scope), ['node', 'node', 'sql', 'sql']);
  assert.equal(snapshot.sqlExecutions[0].nodes[2].annotations.length, 1);
});
test('stage findings remain stage scoped and explicit parents alone are retained', () => {
  const snapshot = normalizeGraphSnapshot({ appId: 'app', sourceUrl: 'hs', sqlExecutions: [],
    stages: [{ stageId: 2, attemptId: 0, status: 'FAILED', numTasks: 3, parentIds: [1] },
      { stageId: 2, attemptId: 1, status: 'COMPLETE', numTasks: 3 }],
    findings: [{ ...finding('SPILL_HEAVY', {}), scope: { stageId: 2 } }],
  });
  assert.deepEqual(snapshot.findings[0].target, { scope: 'stage', appId: 'app', stageId: 2 });
  assert.deepEqual(snapshot.stages[0].parentIds, [1]);
  assert.ok(snapshot.stages.every((s) => s.annotations.length === 0));
});
test('missing graphs and node IDs are visible; never synthesize topology from plans', () => {
  const snapshot = normalizeGraphSnapshot({ appId: 'app', sourceUrl: 'hs', stages: [], findings: [],
    sqlExecutions: [{ id: 1, planDescription: 'Scan -> Join' },
      { id: 2, nodes: [{ nodeName: 'Scan' }], edges: [] }],
  });
  assert.ok(snapshot.sqlExecutions.every((s) => !s.graphAvailable && !s.nodes.length && !s.edges.length));
  assert.ok(snapshot.source.warnings.some((w) => w.includes('without source IDs')));
});
test('SQL detail network failure rejects capture instead of degrading a stored graph', async () => {
  const client = new HistoryClient('http://unused');
  client.getApplication = async () => ({ id: 'app', name: 'app', attempts: [] });
  client.getStages = async () => [];
  client.getJobs = async () => [];
  client.getExecutors = async () => [];
  client.getEnvironment = async () => ({});
  client.getSqlList = async () => [{ id: 1 }];
  client.getSqlExecution = async () => { throw new Error('offline'); };
  await assert.rejects(collectGraphSnapshot(client, 'app', 'hs'), /detail unavailable.*offline/);
});
test('operator rule evidence keeps original node identifiers', () => {
  const facts: AppFacts = {
    appId: 'app', appName: 'app', running: false, durationMs: 100, collectedAt: '',
    stages: [], jobs: [], config: {}, executors: { active: 0, total: 0, removed: [], failedTasks: 0,
      gcRatio: 0, memoryUsedRatio: 0, totalCores: 0 },
    sql: [{ id: 7, description: '', durationMs: 100, jobIds: [], nodes: [
      { nodeId: 40, name: 'Scan', metrics: { 'number of output rows': 100, 'number of files': 5000, 'size of files': 10000 } },
      { nodeId: 9, name: 'Join', metrics: { 'number of output rows': 2000 } },
      { nodeId: 3, name: 'BroadcastNestedLoopJoin', metrics: {} },
    ] }],
  };
  const findings = runRules(facts);
  assert.equal(findings.find((f) => f.ruleId === 'JOIN_EXPLOSION')?.evidence.nodeId, 9);
  assert.equal(findings.find((f) => f.ruleId === 'BNLJ')?.evidence.nodeId, 3);
  assert.equal(findings.find((f) => f.ruleId === 'SMALL_FILES')?.evidence.nodeId, 40);
});
