import type { Skill } from '@sparksleuth/core';
import { diagnoseTools, historyTools } from './tools/index.js';

export const sparkHistorySkill: Skill = {
  name: 'spark-history',
  description:
    'Query a Spark History Server for an application: overview, stages, task quantiles, executors, SQL plans, config, clustered task errors. Read-only.',
  detail: () => `# spark-history

Reads the Spark History Server REST API. Everything here is an observation, not
an interpretation — the diagnosis skill and your own reasoning do that part.

## Tools

| tool | what it gives you | when to use |
|---|---|---|
| \`apps_list\` | recent applications | no appId given, or the user described a job loosely |
| \`app_summary\` | status, duration, slowest stages, executor health, totals | always, first |
| \`stage_list\` | all stages with duration, share, shuffle, spill | to see the shape of the job |
| \`stage_detail\` | task quantiles, skew factor, slowest tasks, failed tasks | on any stage that is slow or spilling |
| \`task_list\` | raw task rows (artifact-backed) | hunting a specific outlier |
| \`executor_list\` | active/removed executors, GC, memory, removal reasons | spill, GC or failures suggest pressure |
| \`sql_list\` | SQL executions by duration | to connect a stage to a query |
| \`sql_detail\` | physical plan with row counts per operator | to confirm where data inflates |
| \`job_list\` | jobs and their stages | to map stages back to jobs |
| \`config_get\` | effective Spark config, filterable | before recommending parameter changes |
| \`error_aggregation\` | normalised failure clusters | when tasks failed |

## Practical notes

- Times and sizes are reported for humans: "1.2 TB", "9m12s". Use them verbatim
  in findings; do not re-derive units.
- \`stage_detail\` needs the stage to have finished at least some tasks. For an
  ACTIVE stage it may return only partial data; that is expected, not an error.
- Row counts in \`sql_detail\` come from the plan's metrics and are cumulative
  per operator. A join whose output exceeds its largest input is the signature
  of a many-to-many join.
- If an endpoint returns nothing, it usually means the feature was not used
  (for example, no SQL executions in a RDD job). Say so rather than guessing.
- Large results (\`task_list\`, \`facts\`) are stored as artifacts. Query them with
  \`core_artifact_query\` using filter/sortBy/top instead of reading them whole.`,
  tools: () => historyTools,
};

export const sparkDiagnoseSkill: Skill = {
  name: 'spark-diagnose',
  description:
    'Run the built-in diagnostic rules over a Spark application and get ranked findings (spill, skew, join fan-out, GC, executor loss, failures, small files, config risks) with evidence.',
  detail: () => `# spark-diagnose

A rule engine over the data from spark-history. The rules do the arithmetic so
you do not have to; you do the explanation and the rewrite.

## Tools

- \`diagnose_app\` — collect facts and run every rule. Returns findings ranked
  P0/P1/P2, each with evidence, likely causes and directions. Facts and findings
  are also saved as an artifact for follow-up queries.
- \`rule_list\` — the rule catalogue, to explain the methodology.
- \`facts\` — the raw structured facts, when you need to reason beyond the rules.

## How to read findings

- **P0** is likely the main cause. If several P0s fire on the same stage, they
  are probably the same problem seen from different angles.
- **P1** is significant; address it in the same change.
- **P2** is hygiene. Mention it, do not lead with it.

A finding is a location and a measurement, not a conclusion. Your job:

1. Take the top finding's stage or SQL.
2. Confirm it with \`stage_detail\` or \`sql_detail\`.
3. Explain the mechanism: why does this operator see this many rows, and why is
   that number unexpected given the input size?
4. Propose a change that removes the mechanism, not just the symptom.

## Rewriting advice

Prefer, in this order:

1. **Less data** — filter earlier, project fewer columns, shrink the time window.
2. **Less fan-out** — de-duplicate or pre-aggregate before the join, cap rows per
   key with a window function.
3. **Better shape** — make the join an equi-join on a precomputed column, so
   broadcast and statistics work.
4. **More parallelism** — partitions, memory, overhead. Last resort, because it
   costs money and does not fix the mechanism.

For each recommendation state the change (SQL snippet or config), the expected
effect with a number, and the risk.`,
  tools: () => diagnoseTools,
};

export const sparkSkills: Skill[] = [sparkHistorySkill, sparkDiagnoseSkill];

export { HistoryClient, parseSparkTime, stageDuration, appDuration, isRunning } from './history-client.js';
export type { SparkApplication, StageSummary, ExecutorSummary, SqlExecution, TaskRow, QuantileRow, JobSummary } from './history-client.js';
export { collectFacts } from './facts.js';
export { collectGraphSnapshot, normalizeGraphSnapshot } from './graph.js';
export type { GraphSnapshot, GraphSqlExecution, GraphNode, GraphStage, GraphMetric, GraphAnnotation, GraphTarget } from './graph.js';
export type { AppFacts, StageFacts, SqlFacts, PlanNodeFacts } from './facts.js';
export { runRules, allRules } from './rules/index.js';
export type { Finding, Rule, Severity, Thresholds } from './rules/index.js';
