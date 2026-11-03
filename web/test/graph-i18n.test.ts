import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { GraphAnnotation } from '../src/graph.ts';
import { localizeAnnotation, localizeEvidenceValue, localizeGraphWarning, localizeMetricName } from '../src/graph-i18n.ts';

function annotation(ruleId: string, evidence: Record<string, unknown>, explanation = ''): GraphAnnotation {
  return { findingId: `${ruleId}:test`, ruleId, severity: 'P1', role: 'observation',
    target: { scope: 'stage', appId: 'app', stageId: 7, attemptId: 0 }, evidence,
    title: 'Intentionally unrelated raw title SQL 999 Stage 999', explanation };
}
const fixtures: Array<[string, Record<string, unknown>, string, string, string]> = [
  ['STAGE_DOMINANT', { share: '65.0%', stageDuration: '1.2 min', totalStageTime: '2 min', tasks: 200 }, 'skewed data', '65.0%', '占阶段总耗时'],
  ['SPILL_HEAVY', { memorySpill: '20 GB', diskSpill: '3 GB', shuffleRead: '10 GB', spillRatio: '2.0x' }, 'the working set does not fit in execution memory', '20 GB', '内存溢写'],
  ['TASK_SKEW', { skewFactor: '8.0x', p50TaskDuration: '10 s', maxTaskDuration: '80 s' }, 'hot partition key', '8.0x', '任务倾斜'],
  ['SHUFFLE_SKEW', { skewFactor: '6.0x', p50ShuffleRead: '10 MB', maxShuffleRead: '60 MB' }, 'a hot key in the shuffle', '6.0x', '读取不均'],
  ['JOIN_EXPLOSION', { sqlId: 2, operator: 'SortMergeJoin [key#123], Inner', largestInputRows: '123.4万', joinOutputRows: '1.234亿', fanoutVsLargestInput: '100.0x' }, 'the join key is not unique on one side, producing a many-to-many join', '123,400,000', '膨胀'],
  ['BNLJ', { sqlId: 2, operator: 'BroadcastNestedLoopJoin BuildRight, Inner', outputRows: '10万' }, 'a non-equi join condition (range, LIKE, inequality)', 'BroadcastNestedLoopJoin BuildRight, Inner', '二次方'],
  ['SMJ_BROADCASTABLE', { sqlId: 2, smallestInput: '5 MB', joins: ['SortMergeJoin [key#123], LeftOuter'] }, 'the broadcast threshold is configured too low', 'SortMergeJoin [key#123], LeftOuter', '一侧'],
  ['GC_HEAVY', { p50Gc: '3 s', p50TaskDuration: '20 s', gcRatio: '15.0%' }, 'heap pressure', '15.0%', 'GC'],
  ['EXECUTOR_LOST', { removed: 3, activeExecutors: 4 }, 'container killed for exceeding memory limits', '3 executor(s)', '被移除'],
  ['TASK_FAILURES', { failedTasks: 10, killedTasks: 2, status: 'FAILED' }, 'external dependency failure', '10 task(s)', '任务失败'],
  ['SMALL_FILES', { sqlId: 2, files: '1.2万', averageFileSize: '1 MB', totalSize: '12 GB' }, 'frequent small appends', '12,000 files', '平均大小'],
  ['CONF_CHECK', { 'spark.sql.adaptive.enabled': 'false — AQE is off, so skew and partition coalescing cannot help' }, 'AQE is off, so skew and partition coalescing cannot help', '1 configuration item(s)', '配置'],
];

for (const [ruleId, evidence, cause, english, chinese] of fixtures) {
  test(`${ruleId}: bilingual titles use structured evidence, not stored title`, () => {
    const a = annotation(ruleId, evidence, cause);
    const en = localizeAnnotation(a, 'en'); const zh = localizeAnnotation(a, 'zh');
    assert.ok(en.title.includes(english), en.title);
    assert.ok(zh.title.includes(chinese), zh.title);
    assert.equal(en.explanation, cause);
    assert.match(zh.explanation, /[\u4e00-\u9fff]/);
    assert.ok(!zh.explanation.includes('[未翻译原文]'));
    assert.ok(!en.title.includes('999')); assert.ok(!zh.title.includes('999'));
  });
}

test('JOIN count format and technical operator names are exact in both languages', () => {
  const a = annotation('JOIN_EXPLOSION', fixtures[4][1]);
  a.target = { scope: 'node', appId: 'app', sqlId: 0, nodeId: 9 };
  assert.equal(localizeAnnotation(a, 'en').title, 'SQL 0: SortMergeJoin [key#123], Inner turns 1,234,000 input rows into 123,400,000 rows (100.0x)');
  assert.equal(localizeAnnotation(a, 'zh').title, 'SQL 0：SortMergeJoin [key#123], Inner 将 123.4万 行输入膨胀为 1.234亿 行（100.0x）');
  for (const [raw, en, zh] of [['1.2万', '12,000', '1.2万'], ['2.35亿', '235,000,000', '2.35亿'], ['12345', '12,345', '1.2345万'], ['1,234', '1,234', '1,234'], ['0', '0', '0'], ['10000', '10,000', '1万']]) {
    assert.equal(localizeEvidenceValue('joinOutputRows', raw, 'en'), en);
    assert.equal(localizeEvidenceValue('joinOutputRows', raw, 'zh'), zh);
  }
  assert.equal(localizeEvidenceValue('joinOutputRows', '1.2万 rows (total)', 'en'), '1.2万 rows (total)');
  assert.equal(localizeEvidenceValue('nodeId', '12345', 'zh'), '12345');
  assert.equal(localizeEvidenceValue('operator', 'Scan parquet [key#12]', 'zh'), 'Scan parquet [key#12]');
});

test('executor GC and stage GC are distinguished by evidence, not raw title', () => {
  const executor = annotation('GC_HEAVY', { executorGcRatio: '20.0%', activeExecutors: 3 });
  assert.equal(localizeAnnotation(executor, 'en').title, 'Executors spend 20.0% of their time in GC');
  assert.ok(!localizeAnnotation(executor, 'zh').title.includes('Stage'));
  assert.equal(localizeAnnotation(annotation('GC_HEAVY', { gcRatio: '15.0%' }), 'en').title, 'Stage 7: median task spends 15.0% of its time in GC');
});

test('every current literal cause and configuration pattern has a bilingual mapping', () => {
  // Guard against backend cause additions being silently presented as a made-up translation.
  const rules = readFileSync(new URL('../../packages/skills-spark/src/rules/index.ts', import.meta.url), 'utf8');
  const causeBlocks = [...rules.matchAll(/possibleCauses:\s*([\s\S]*?)(?=\s*suggestions:)/g)];
  const literals = causeBlocks.flatMap((block) => [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const issues = [...rules.matchAll(/issue: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(literals.length >= 30);
  for (const cause of [...literals, ...issues, '20 GB of shuffle spread over only 200 partitions', 'overhead is only 5% of executor memory']) {
    const a = annotation('CONF_CHECK', {}, cause);
    assert.ok(!localizeAnnotation(a, 'zh').explanation.includes('[未翻译原文]'), cause);
    assert.equal(localizeAnnotation(a, 'en').explanation, cause);
  }
});

test('optional or missing evidence is safe and does not invent metric values', () => {
  for (const [id] of fixtures) {
    for (const lang of ['zh', 'en'] as const) {
      const result = localizeAnnotation(annotation(id, {}), lang);
      assert.ok(result.title.length > 0);
      assert.ok(!result.title.includes('undefined')); assert.ok(!result.title.includes('NaN'));
      assert.equal(result.explanation, '');
    }
  }
  assert.equal(localizeEvidenceValue('p50TaskSpill', undefined, 'en'), 'not provided');
  assert.equal(localizeEvidenceValue('p50TaskSpill', null, 'zh'), '未提供');
  assert.equal(localizeEvidenceValue('spillRatio', 'n/a (no shuffle read)', 'zh'), '不适用（无 Shuffle 读取）');
});

test('raw JSON and evidence remain untouched after both languages and all helpers', () => {
  for (const [id, evidence, explanation] of fixtures) {
    const a = annotation(id, structuredClone(evidence), explanation);
    Object.freeze(a.evidence); Object.freeze(a);
    const before = JSON.stringify(a);
    for (const lang of ['zh', 'en'] as const) {
      localizeAnnotation(a, lang);
      for (const [key, value] of Object.entries(a.evidence)) { localizeEvidenceValue(key, value, lang); localizeMetricName(key, lang); }
    }
    assert.equal(JSON.stringify(a), before);
  }
  const values = { errors: { 'OOM at <id>': 3 }, joins: ['SortMergeJoin', 'SortMergeJoin [k#1]'] };
  const before = JSON.stringify(values);
  assert.equal(localizeEvidenceValue('errorClusters', values.errors, 'zh'), '{"OOM at <id>":3}');
  assert.equal(localizeEvidenceValue('joins', values.joins, 'zh'), 'SortMergeJoin; SortMergeJoin [k#1]');
  assert.equal(JSON.stringify(values), before);
});

test('unknown rules and causes retain visibly flagged original text; rule failures are not normal findings', () => {
  const a = annotation('FUTURE_RULE', {}, 'new root cause 原因');
  assert.equal(localizeAnnotation(a, 'en').title, `[Source text] ${a.title}`);
  assert.equal(localizeAnnotation(a, 'zh').explanation, '[未翻译原文] new root cause 原因');
  assert.equal(localizeAnnotation(annotation('TASK_FAILURES', {}, 'java.lang.OutOfMemoryError: exact raw stack'), 'en').explanation, '[Source text] java.lang.OutOfMemoryError: exact raw stack');
  const failure = localizeAnnotation(annotation('SPILL_HEAVY', { error: 'network exact reason' }), 'zh');
  assert.equal(failure.title, '规则 SPILL_HEAVY 执行失败');
  assert.equal(failure.explanation, '[未翻译原文] network exact reason');
});

test('metric names, status and configuration evidence localize without guessing unknown names', () => {
  assert.equal(localizeMetricName('joinOutputRows', 'zh'), 'Join 输出行数');
  assert.equal(localizeMetricName('number of output rows', 'en'), 'Number of output rows');
  assert.equal(localizeMetricName('shuffleReadBytes', 'zh'), 'Shuffle 读取字节数');
  assert.equal(localizeMetricName('stageId', 'zh'), '阶段 ID');
  assert.equal(localizeMetricName('Columnar batches', 'zh'), '列式批次数');
  assert.equal(localizeMetricName('scan time', 'zh'), '扫描耗时');
  assert.equal(localizeMetricName('time in aggregation build', 'zh'), '构建聚合耗时');
  assert.equal(localizeMetricName('local blocks read', 'zh'), '本地读取块数');
  assert.equal(localizeMetricName('spark.sql.adaptive.enabled', 'zh'), 'spark.sql.adaptive.enabled');
  assert.equal(localizeMetricName('futureMetricName', 'zh'), 'futureMetricName');
  assert.equal(localizeMetricName('toString', 'zh'), 'toString');
  assert.equal(localizeGraphWarning('constructor', 'en'), '[Source text] constructor');
  assert.equal(localizeAnnotation(annotation('TASK_FAILURES', {}, 'toString'), 'zh').explanation, '[未翻译原文] toString');
  assert.equal(localizeEvidenceValue('status', 'FAILED', 'zh'), '失败');
  assert.equal(localizeEvidenceValue('status', 'FUTURE', 'zh'), 'FUTURE');
  assert.equal(localizeEvidenceValue('spark.sql.adaptive.skewJoin.enabled', 'false — adaptive skew join handling is off', 'zh'), 'false — 自适应倾斜 Join 优化已关闭');
});

const backendWarnings = [
  'Rule facts inspect up to 5 SQL executions and task quantiles for up to 6 stages; unannotated nodes are not a health guarantee.',
  'JOIN_EXPLOSION estimates input rows from existing rule node-order heuristics; annotations are suspected causes, not verified causal topology.',
  'SQL 0: graph topology unavailable', 'SQL 12: nodes without source IDs omitted',
  'SQL 15: source edges reference missing nodes; endpoints retained without invented nodes',
  'session not found', 'appId is required: no application recorded for this session',
  'appId is required: session has multiple applications', 'graph snapshot not found; capture it with POST',
  'graph snapshot could not be read', 'closed sessions cannot create or refresh graphs',
];
test('known backend warnings localize and preserve technical identifiers and trust caveats', () => {
  for (const raw of backendWarnings) {
    assert.equal(localizeGraphWarning(raw, 'en'), raw);
    const zh = localizeGraphWarning(raw, 'zh');
    assert.match(zh, /[\u4e00-\u9fff]/); assert.ok(!zh.includes('[未翻译原文]'));
  }
  assert.ok(localizeGraphWarning(backendWarnings[1], 'zh').includes('JOIN_EXPLOSION'));
  assert.ok(localizeGraphWarning(backendWarnings[2], 'zh').includes('SQL 0'));
  assert.ok(localizeGraphWarning(backendWarnings[4], 'zh').includes('不会虚构节点'));
});
test('capture/detail failures retain unknown nested reasons visibly and never translate arbitrary source text', () => {
  assert.equal(localizeGraphWarning('SQL 3: detail unavailable (HTTP 503: exact upstream text)', 'zh'), 'SQL 3: 详情不可用 ([未翻译原文] HTTP 503: exact upstream text)');
  assert.equal(localizeGraphWarning('graph capture failed: SQL 3: detail unavailable (socket closed)', 'en'), 'graph capture failed: SQL 3: detail unavailable ([Source text] socket closed)');
  assert.equal(localizeGraphWarning('new backend warning raw 原文', 'en'), '[Source text] new backend warning raw 原文');
  assert.equal(localizeGraphWarning('SQL 3: future warning', 'zh'), '[未翻译原文] SQL 3: future warning');
});
