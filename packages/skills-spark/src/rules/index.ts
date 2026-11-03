import type { AppFacts, SqlFacts, StageFacts } from '../facts.js';
import { getMetric, isJoinNode, isScanNode } from '../facts.js';
import { bytes, count, duration, pct, ratio } from '@sparksleuth/core';

export type Severity = 'P0' | 'P1' | 'P2';

export interface Finding {
  ruleId: string;
  severity: Severity;
  title: string;
  scope?: { stageId?: number; stageName?: string; sqlId?: number; executor?: string };
  evidence: Record<string, unknown>;
  possibleCauses: string[];
  suggestions: string[];
}

export interface Thresholds {
  skewRatio: number;
  spillRatio: number;
  gcRatio: number;
  fanoutRatio: number;
  dominantRatio: number;
}

export interface Rule {
  id: string;
  severity: Severity;
  /** One line, shown by the rule_list tool. */
  description: string;
  evaluate(facts: AppFacts, t: Thresholds): Finding[];
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/* ------------------------------------------------------------------ *
 * 1. One stage dominates the wall clock
 * ------------------------------------------------------------------ */
const stageDominant: Rule = {
  id: 'STAGE_DOMINANT',
  severity: 'P1',
  description: `A single stage accounts for more than ${'50%'} of total stage time`,
  evaluate(facts, t) {
    const total = facts.stages.reduce((acc, s) => acc + s.durationMs, 0);
    if (total <= 0) return [];
    return facts.stages
      .filter((s) => s.durationMs > 30_000 && s.durationMs / total > t.dominantRatio)
      .map((s) => ({
        ruleId: 'STAGE_DOMINANT',
        severity: 'P1' as const,
        title: `Stage ${s.stageId} takes ${pct(s.durationMs / total)} of stage time`,
        scope: { stageId: s.stageId, stageName: s.name },
        evidence: {
          stageDuration: duration(s.durationMs),
          totalStageTime: duration(total),
          share: pct(s.durationMs / total),
          tasks: s.numTasks,
        },
        possibleCauses: ['skewed data', 'excessive shuffle', 'spilling', 'a genuinely heavy operator'],
        suggestions: ['Focus the investigation on this stage before anything else'],
      }));
  },
};

/* ------------------------------------------------------------------ *
 * 2. Spilling to memory or disk
 * ------------------------------------------------------------------ */
const spillHeavy: Rule = {
  id: 'SPILL_HEAVY',
  severity: 'P0',
  description: `Memory spill exceeds shuffle read (${'ratio > 1'}) or disk spill exceeds 1 GB`,
  evaluate(facts, t) {
    const out: Finding[] = [];
    for (const s of facts.stages) {
      const spillRatioValue = s.shuffleReadBytes > 0 ? s.memorySpill / s.shuffleReadBytes : s.memorySpill > 0 ? Infinity : 0;
      const heavy = spillRatioValue > t.spillRatio || s.diskSpill > GB;
      if (!heavy) continue;
      out.push({
        ruleId: 'SPILL_HEAVY',
        severity: 'P0',
        title: `Stage ${s.stageId} spilled ${bytes(s.memorySpill)} to memory and ${bytes(s.diskSpill)} to disk`,
        scope: { stageId: s.stageId, stageName: s.name },
        evidence: {
          memorySpill: bytes(s.memorySpill),
          diskSpill: bytes(s.diskSpill),
          shuffleRead: bytes(s.shuffleReadBytes),
          spillRatio: Number.isFinite(spillRatioValue) ? ratio(spillRatioValue) : 'n/a (no shuffle read)',
          tasks: s.numTasks,
          p50TaskSpill: s.quantiles ? bytes(s.quantiles.p50Spill) : undefined,
        },
        possibleCauses: [
          'the working set does not fit in execution memory',
          'row fan-out upstream inflates the data',
          'too few partitions, so each task handles too much',
        ],
        suggestions: [
          'find the operator that inflates rows before tuning memory',
          'consider raising shuffle partitions so each task holds less',
        ],
      });
    }
    return out;
  },
};

/* ------------------------------------------------------------------ *
 * 3. Task duration skew
 * ------------------------------------------------------------------ */
const taskSkew: Rule = {
  id: 'TASK_SKEW',
  severity: 'P0',
  description: `Max task duration is more than ${'5x'} the median and above 60s`,
  evaluate(facts, t) {
    const out: Finding[] = [];
    for (const s of facts.stages) {
      const q = s.quantiles;
      if (!q || q.p50DurationMs <= 0) continue;
      // A long tail under five seconds cannot matter much; between five seconds
      // and a minute it is real but rarely urgent.
      if (q.durationSkew > t.skewRatio && q.maxDurationMs > 5_000) {
        out.push({
          ruleId: 'TASK_SKEW',
          severity: q.maxDurationMs > 60_000 ? 'P0' : 'P1',
          title: `Stage ${s.stageId} is skewed: slowest task is ${ratio(q.durationSkew)} the median`,
          scope: { stageId: s.stageId, stageName: s.name },
          evidence: {
            p50TaskDuration: duration(q.p50DurationMs),
            p95TaskDuration: duration(q.p95DurationMs),
            maxTaskDuration: duration(q.maxDurationMs),
            skewFactor: ratio(q.durationSkew),
            tasks: s.numTasks,
          },
          possibleCauses: ['hot partition key', 'uneven file sizes', 'one executor starved of resources'],
          suggestions: [
            'enable adaptive skew join handling (spark.sql.adaptive.skewJoin.enabled)',
            'salt the hot key or pre-aggregate it separately',
            'repartition on a higher-cardinality key',
          ],
        });
      }
    }
    return out;
  },
};

/* ------------------------------------------------------------------ *
 * 4. Shuffle read skew
 * ------------------------------------------------------------------ */
const shuffleSkew: Rule = {
  id: 'SHUFFLE_SKEW',
  severity: 'P1',
  description: `Max shuffle read is more than ${'5x'} the median`,
  evaluate(facts, t) {
    const out: Finding[] = [];
    for (const s of facts.stages) {
      const q = s.quantiles;
      if (!q || q.p50ShuffleRead <= 0) continue;
      if (q.shuffleReadSkew > t.skewRatio && q.maxShuffleRead > 1 * MB) {
        out.push({
          ruleId: 'SHUFFLE_SKEW',
          severity: q.maxShuffleRead > 100 * MB ? 'P1' : 'P2',
          title: `Stage ${s.stageId} reads uneven shards: largest is ${ratio(q.shuffleReadSkew)} the median`,
          scope: { stageId: s.stageId, stageName: s.name },
          evidence: {
            p50ShuffleRead: bytes(q.p50ShuffleRead),
            maxShuffleRead: bytes(q.maxShuffleRead),
            skewFactor: ratio(q.shuffleReadSkew),
          },
          possibleCauses: ['a hot key in the shuffle', 'a partitioner that does not spread the key space'],
          suggestions: ['inspect key distribution before the shuffle', 'salt the hot key'],
        });
      }
    }
    return out;
  },
};

/* ------------------------------------------------------------------ *
 * 5. Join fan-out
 * ------------------------------------------------------------------ */
const joinExplosion: Rule = {
  id: 'JOIN_EXPLOSION',
  severity: 'P0',
  description: `A join emits more than ${'10x'} its largest input`,
  evaluate(facts, t) {
    const out: Finding[] = [];
    for (const sql of facts.sql) {
      // Spark lists plan nodes children-first, so everything before a join node
      // is upstream of it. That gives us the join's real inputs without having
      // to rebuild the tree from the plan text.
      sql.nodes.forEach((join, index) => {
        if (!isJoinNode(join.name) || /NestedLoop|Cartesian/i.test(join.name)) return;
        const inputs = sql.nodes
          .slice(0, index)
          .filter((n) => !isJoinNode(n.name) && !/Exchange|WholeStageCodegen|Execute|WriteFiles/i.test(n.name))
          .map((n) => n.metrics['number of output rows'] ?? n.metrics['numOutputRows'] ?? 0)
          .filter((n) => n > 0);
        if (!inputs.length) return;

        const outRows = join.metrics['number of output rows'] ?? join.metrics['numOutputRows'] ?? 0;
        const maxInput = Math.max(...inputs);
        const totalInput = inputs.reduce((a, b) => a + b, 0);
        if (outRows <= 0 || maxInput <= 0) return;
        const fanout = outRows / maxInput;
        if (fanout <= t.fanoutRatio) return;

        out.push({
          ruleId: 'JOIN_EXPLOSION',
          severity: 'P0',
          title: `SQL ${sql.id}: ${join.name} turns ${count(maxInput)} input rows into ${count(outRows)} rows (${ratio(fanout)})`,
          scope: { sqlId: sql.id },
          evidence: {
            sqlId: sql.id,
            operator: join.name,
            joinOutputRows: count(outRows),
            largestInputRows: count(maxInput),
            totalInputRows: count(totalInput),
            fanoutVsLargestInput: ratio(fanout),
            fanoutVsTotalInput: ratio(outRows / totalInput),
            sqlDuration: duration(sql.durationMs),
          },
          possibleCauses: [
            'the join key is not unique on one side, producing a many-to-many join',
            'a self join on a low-cardinality or duplicated key',
            'a function-wrapped key that defeats the optimizer',
          ],
          suggestions: [
            'de-duplicate or pre-aggregate before the join',
            'cap the fan-out per key with a Top-N window if the business allows',
            'verify the join key is actually one-to-one',
          ],
        });
      });
    }
    return out;
  },
};

/* ------------------------------------------------------------------ *
 * 6. Broadcast nested loop join / cartesian product
 * ------------------------------------------------------------------ */
const bnlj: Rule = {
  id: 'BNLJ',
  severity: 'P1',
  description: 'The physical plan contains a broadcast nested loop join or cartesian product',
  evaluate(facts) {
    const out: Finding[] = [];
    for (const sql of facts.sql) {
      const nodes = sql.nodes.filter((n) => /BroadcastNestedLoopJoin|CartesianProduct/i.test(n.name));
      for (const n of nodes) {
        out.push({
          ruleId: 'BNLJ',
          severity: 'P1',
          title: `SQL ${sql.id} uses ${n.name} — quadratic cost`,
          scope: { sqlId: sql.id },
          evidence: {
            sqlId: sql.id,
            operator: n.name,
            outputRows: count(n.metrics['number of output rows'] ?? 0),
            sqlDuration: duration(sql.durationMs),
          },
          possibleCauses: [
            'a non-equi join condition (range, LIKE, inequality)',
            'a missing or unusable join key',
            'the optimizer could not derive an equi-join',
          ],
          suggestions: [
            'rewrite as an equi-join where possible',
            'pre-filter the smaller side so the cross product is bounded',
          ],
        });
      }
    }
    return out;
  },
};

/* ------------------------------------------------------------------ *
 * 7. Sort-merge join where broadcast would do
 * ------------------------------------------------------------------ */
const smjBroadcastable: Rule = {
  id: 'SMJ_BROADCASTABLE',
  severity: 'P2',
  description: 'A sort-merge join has a side small enough to broadcast',
  evaluate(facts) {
    const out: Finding[] = [];
    const threshold = Number.parseInt(facts.config['spark.sql.autoBroadcastJoinThreshold'] ?? '10485760', 10) || 10 * MB;
    for (const sql of facts.sql) {
      const smj = sql.nodes.filter((n) => /SortMergeJoin/i.test(n.name));
      if (!smj.length) continue;
      const scans = sql.nodes
        .filter((n) => isScanNode(n.name))
        .map((n) => n.metrics['size of files'] ?? n.metrics['data size'] ?? 0)
        .filter((n) => n > 0);
      if (!scans.length) continue;
      const smallest = Math.min(...scans);
      if (smallest > threshold * 10) continue;
      out.push({
        ruleId: 'SMJ_BROADCASTABLE',
        severity: 'P2',
        title: `SQL ${sql.id} shuffles a side that is only ${bytes(smallest)}`,
        scope: { sqlId: sql.id },
        evidence: {
          sqlId: sql.id,
          smallestInput: bytes(smallest),
          broadcastThreshold: bytes(threshold),
          joins: smj.map((n) => n.name),
        },
        possibleCauses: [
          'the join key is wrapped in a function, so statistics cannot be used',
          'the broadcast threshold is configured too low',
          'estimated size is unreliable because statistics are missing',
        ],
        suggestions: [
          'precompute the expression as a column so the join becomes an equi-join',
          'raise spark.sql.autoBroadcastJoinThreshold if the side really is small',
          'run ANALYZE TABLE so the optimizer sees the real size',
        ],
      });
    }
    return out;
  },
};

/* ------------------------------------------------------------------ *
 * 8. GC pressure
 * ------------------------------------------------------------------ */
const gcHeavy: Rule = {
  id: 'GC_HEAVY',
  severity: 'P1',
  description: `GC time exceeds ${'10%'} of task time`,
  evaluate(facts, t) {
    const out: Finding[] = [];
    if (facts.executors.gcRatio > t.gcRatio) {
      out.push({
        ruleId: 'GC_HEAVY',
        severity: 'P1',
        title: `Executors spend ${pct(facts.executors.gcRatio)} of their time in GC`,
        evidence: {
          executorGcRatio: pct(facts.executors.gcRatio),
          activeExecutors: facts.executors.active,
        },
        possibleCauses: ['heap too small for the working set', 'oversized partitions', 'object churn from wide rows'],
        suggestions: [
          'increase executor memory or reduce rows per task',
          'prefer fewer, wider rows over many small objects',
          'check whether spill pressure and GC pressure share a root cause',
        ],
      });
    }
    for (const s of facts.stages) {
      const q = s.quantiles;
      if (!q || q.p50DurationMs <= 0) continue;
      const r = q.p50GcMs / q.p50DurationMs;
      // A few hundred milliseconds of GC inside a sub-second task is noise.
      if (r > t.gcRatio && q.p50DurationMs > 10_000 && q.p50GcMs > 1_000) {
        out.push({
          ruleId: 'GC_HEAVY',
          severity: 'P1',
          title: `Stage ${s.stageId}: median task spends ${pct(r)} of its time in GC`,
          scope: { stageId: s.stageId, stageName: s.name },
          evidence: { p50Gc: duration(q.p50GcMs), p50TaskDuration: duration(q.p50DurationMs), gcRatio: pct(r) },
          possibleCauses: ['heap pressure', 'large aggregation state per task'],
          suggestions: ['increase memory or split the work into more partitions'],
        });
      }
    }
    return out;
  },
};

/* ------------------------------------------------------------------ *
 * 9. Executor loss
 * ------------------------------------------------------------------ */
const executorLost: Rule = {
  id: 'EXECUTOR_LOST',
  severity: 'P1',
  description: 'Executors were removed for reasons other than normal scale-down',
  evaluate(facts) {
    const suspicious = facts.executors.removed.filter(
      (r) => !/dynamic|decommission|idle|sparkContext stopped|finished/i.test(r.reason),
    );
    if (!suspicious.length) return [];
    const total = suspicious.reduce((acc, r) => acc + r.count, 0);
    const looksLikeMemory = suspicious.some((r) => /memory|oom|killed|137|143|exit/i.test(r.reason));
    return [
      {
        ruleId: 'EXECUTOR_LOST',
        severity: 'P1',
        title: `${total} executor(s) removed under pressure`,
        evidence: {
          removed: total,
          activeExecutors: facts.executors.active,
          totalExecutors: facts.executors.total,
          reasons: suspicious.slice(0, 5).map((r) => `${r.count}x ${r.reason}`),
        },
        possibleCauses: looksLikeMemory
          ? ['container killed for exceeding memory limits', 'node pressure from oversized tasks']
          : ['unstable nodes', 'shuffle fetch failures'],
        suggestions: [
          'raise executor memory overhead if containers are being killed',
          'reduce partition size so a single task cannot exhaust the container',
          'correlate removal times with the slowest stage',
        ],
      },
    ];
  },
};

/* ------------------------------------------------------------------ *
 * 10. Task failures
 * ------------------------------------------------------------------ */
const taskFailures: Rule = {
  id: 'TASK_FAILURES',
  severity: 'P0',
  description: 'Tasks or stages failed and were retried',
  evaluate(facts) {
    const out: Finding[] = [];
    const failedStages = facts.stages.filter((s) => s.failedTasks > 0 || s.status === 'FAILED');
    for (const s of failedStages) {
      const clusters = clusterErrors(s.failedTaskSamples);
      out.push({
        ruleId: 'TASK_FAILURES',
        severity: 'P0',
        title: `Stage ${s.stageId} failed ${s.failedTasks} task(s)`,
        scope: { stageId: s.stageId, stageName: s.name },
        evidence: {
          failedTasks: s.failedTasks,
          killedTasks: s.killedTasks,
          status: s.status,
          errorClusters: clusters,
        },
        possibleCauses: clusters.length
          ? Object.keys(clusters)
          : ['data skew causing oversized tasks', 'external dependency failure'],
        suggestions: [
          'fix the dominant error first; retries hide the cost but not the cause',
          'check whether failures cluster on specific executors or hosts',
        ],
      });
    }
    return out;
  },
};

/* ------------------------------------------------------------------ *
 * 11. Small files
 * ------------------------------------------------------------------ */
const smallFiles: Rule = {
  id: 'SMALL_FILES',
  severity: 'P2',
  description: 'A scan reads many small files',
  evaluate(facts) {
    const out: Finding[] = [];
    for (const sql of facts.sql) {
      for (const n of sql.nodes.filter((x) => isScanNode(x.name))) {
        const files = getMetric(n, ['number of files read', 'number of files']) ?? 0;
        const size = getMetric(n, ['size of files read', 'size of files']) ?? 0;
        if (files < 1000 || size <= 0) continue;
        const avg = size / files;
        if (avg >= 16 * MB) continue;
        out.push({
          ruleId: 'SMALL_FILES',
          severity: files >= 5000 ? 'P1' : 'P2',
          title: `SQL ${sql.id}: ${count(files)} files averaging ${bytes(avg)}`,
          scope: { sqlId: sql.id },
          evidence: { sqlId: sql.id, files: count(files), totalSize: bytes(size), averageFileSize: bytes(avg) },
          possibleCauses: ['too many output partitions upstream', 'frequent small appends'],
          suggestions: ['compact the table', 'reduce write partitions', 'enable automatic compaction on the target format'],
        });
        break;
      }
    }
    return out;
  },
};

/* ------------------------------------------------------------------ *
 * 12. Configuration risks
 * ------------------------------------------------------------------ */
const confCheck: Rule = {
  id: 'CONF_CHECK',
  severity: 'P2',
  description: 'Configuration values commonly associated with poor performance',
  evaluate(facts) {
    const c = facts.config;
    const notes: Array<{ key: string; value: string; issue: string; fix: string }> = [];

    if (c['spark.sql.adaptive.enabled'] === 'false') {
      notes.push({ key: 'spark.sql.adaptive.enabled', value: 'false', issue: 'AQE is off, so skew and partition coalescing cannot help', fix: 'enable AQE' });
    }
    if (c['spark.sql.adaptive.enabled'] !== 'false' && c['spark.sql.adaptive.skewJoin.enabled'] === 'false') {
      notes.push({ key: 'spark.sql.adaptive.skewJoin.enabled', value: 'false', issue: 'adaptive skew join handling is off', fix: 'enable adaptive skew join handling' });
    }
    const partitions = Number.parseInt(c['spark.sql.shuffle.partitions'] ?? '', 10);
    const totalShuffle = facts.stages.reduce((a, s) => a + s.shuffleWriteBytes, 0);
    if (Number.isFinite(partitions) && partitions > 0 && totalShuffle > 10 * GB && partitions < 400) {
      notes.push({
        key: 'spark.sql.shuffle.partitions',
        value: String(partitions),
        issue: `${bytes(totalShuffle)} of shuffle spread over only ${partitions} partitions`,
        fix: 'raise shuffle partitions so each task handles a reasonable slice',
      });
    }
    const mem = c['spark.executor.memory'];
    const overhead = c['spark.executor.memoryOverhead'];
    if (mem && overhead) {
      const memMb = toMb(mem);
      const ovMb = toMb(overhead);
      if (memMb && ovMb && ovMb / memMb < 0.1) {
        notes.push({
          key: 'spark.executor.memoryOverhead',
          value: overhead,
          issue: `overhead is only ${pct(ovMb / memMb, 0)} of executor memory`,
          fix: 'raise overhead (10-15% of executor memory) to avoid container kills',
        });
      }
    }
    if (!notes.length) return [];
    return [
      {
        ruleId: 'CONF_CHECK',
        severity: 'P2',
        title: `${notes.length} configuration item(s) worth revisiting`,
        evidence: Object.fromEntries(notes.map((n) => [n.key, `${n.value} — ${n.issue}`])),
        possibleCauses: notes.map((n) => n.issue),
        suggestions: notes.map((n) => n.fix),
      },
    ];
  },
};

export const allRules: Rule[] = [
  stageDominant,
  spillHeavy,
  taskSkew,
  shuffleSkew,
  joinExplosion,
  bnlj,
  smjBroadcastable,
  gcHeavy,
  executorLost,
  taskFailures,
  smallFiles,
  confCheck,
];

/** Sensible starting points; `loadConfig()` can override each one. */
export const DEFAULT_THRESHOLDS: Thresholds = {
  skewRatio: 5,
  spillRatio: 1,
  gcRatio: 0.1,
  fanoutRatio: 10,
  dominantRatio: 0.5,
};

export function runRules(facts: AppFacts, thresholds: Thresholds = DEFAULT_THRESHOLDS): Finding[] {
  const findings: Finding[] = [];
  for (const rule of allRules) {
    try {
      findings.push(...rule.evaluate(facts, thresholds));
    } catch (err) {
      // A broken rule must never take the whole diagnosis down.
      findings.push({
        ruleId: rule.id,
        severity: 'P2',
        title: `Rule ${rule.id} failed to evaluate`,
        evidence: { error: err instanceof Error ? err.message : String(err) },
        possibleCauses: [],
        suggestions: [],
      });
    }
  }
  const order: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}

function clusterErrors(samples: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const raw of samples) {
    const key = raw
      .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
      .replace(/\b\d+\b/g, '<n>')
      .replace(/application_\d+_\d+/g, '<app>')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 140);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function toMb(v: string): number {
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*([kmg])?b?$/i);
  if (!m) return 0;
  const n = Number.parseFloat(m[1]);
  const unit = (m[2] ?? 'm').toLowerCase();
  return unit === 'g' ? n * 1024 : unit === 'k' ? n / 1024 : n;
}

export type { StageFacts, SqlFacts };
