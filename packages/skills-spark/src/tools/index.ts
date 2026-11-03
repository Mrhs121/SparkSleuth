import type { ToolDefinition } from '@sparksleuth/core';
import { bytes, count, duration, httpJson, pct, ratio } from '@sparksleuth/core';
import {
  HistoryClient,
  appDuration,
  isRunning,
  parseSparkTime,
  stageDuration,
  type StageSummary,
} from '../history-client.js';
import { collectFacts, parseMetric, type AppFacts } from '../facts.js';
import { DEFAULT_THRESHOLDS, runRules, allRules, type Finding, type Thresholds } from '../rules/index.js';

export function historyClient(ctx: { config: { spark: { historyServerUrl: string } }; signal?: AbortSignal }): HistoryClient {
  return new HistoryClient(ctx.config.spark.historyServerUrl, {
    timeoutMs: 30_000,
    signal: ctx.signal,
  });
}

const appIdParam = {
  appId: { type: 'string', description: 'Spark application id, e.g. application_1700000000000_0042' },
};

/* ------------------------------------------------------------------ */

const appsList: ToolDefinition = {
  name: 'apps_list',
  description:
    'List applications known to the History Server, newest first. Use it when the user has not given an appId, or to find the most recent failed or running job.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['completed', 'running', 'failed', 'incomplete'], description: 'Filter by status' },
      limit: { type: 'number', description: 'Maximum rows (default 20)' },
    },
  },
  async execute(input, ctx) {
    const client = historyClient(ctx);
    const apps = await client.listApplications({
      status: input.status as string | undefined,
      limit: (input.limit as number) ?? 20,
    });
    if (!apps.length) return { summary: 'No applications found on the History Server.' };
    const now = Date.now();
    const rows = apps.slice(0, (input.limit as number) ?? 20).map((a) => {
      const att = a.attempts?.[0];
      const state = att?.completed ? 'COMPLETE' : 'RUNNING';
      return `| ${a.id} | ${truncateText(a.name ?? '', 42)} | ${state} | ${duration(appDuration(a, now))} | ${att?.sparkUser ?? ''} |`;
    });
    return {
      summary: [
        `Found ${apps.length} application(s):`,
        '',
        '| appId | name | status | duration | user |',
        '|---|---|---|---|---|',
        ...rows,
      ].join('\n'),
    };
  },
};

const appSummary: ToolDefinition = {
  name: 'app_summary',
  description:
    'Overview of one application: status, duration, job/stage counts, the slowest stages, executor health, and totals for shuffle, spill and GC. Start here.',
  inputSchema: { type: 'object', properties: { ...appIdParam }, required: ['appId'] },
  async execute(input, ctx) {
    const appId = String(input.appId);
    const client = historyClient(ctx);
    const now = Date.now();
    const [app, stages, jobs, executors, env] = await Promise.all([
      client.getApplication(appId),
      client.getStages(appId),
      client.getJobs(appId).catch(() => []),
      client.getExecutors(appId, true).catch(() => []),
      client.getEnvironment(appId).catch((): { sparkProperties?: Array<[string, string]> } => ({})),
    ]);

    const totalShuffleWrite = stages.reduce((a, s) => a + (s.shuffleWriteBytes ?? 0), 0);
    const totalShuffleRead = stages.reduce((a, s) => a + (s.shuffleReadBytes ?? 0), 0);
    const totalMemSpill = stages.reduce((a, s) => a + (s.memoryBytesSpilled ?? 0), 0);
    const totalDiskSpill = stages.reduce((a, s) => a + (s.diskBytesSpilled ?? 0), 0);
    const failedStages = stages.filter((s) => (s.numFailedTasks ?? 0) > 0 || s.status === 'FAILED');
    const activeExec = executors.filter((e) => e.isActive).length;
    const slowest = [...stages]
      .sort((a, b) => stageDuration(b, now) - stageDuration(a, now))
      .slice(0, 5);

    const cfg = await client.getSparkConfig(appId);
    const keyConfig = [
      'spark.sql.adaptive.enabled',
      'spark.sql.adaptive.skewJoin.enabled',
      'spark.sql.shuffle.partitions',
      'spark.executor.memory',
      'spark.executor.cores',
      'spark.executor.memoryOverhead',
      'spark.sql.autoBroadcastJoinThreshold',
    ]
      .filter((k) => cfg[k] !== undefined)
      .map((k) => `${k}=${cfg[k]}`);

    return {
      summary: [
        `## Application ${app.id}`,
        `- name: ${app.name}`,
        `- status: ${isRunning(app) ? 'RUNNING' : 'COMPLETED'}${failedStages.length ? ` (${failedStages.length} stage(s) had failures)` : ''}`,
        `- duration: ${duration(appDuration(app, now))}, user: ${app.attempts?.[0]?.sparkUser ?? 'n/a'}, spark ${app.attempts?.[0]?.appSparkVersion ?? ''}`,
        `- jobs: ${jobs.length} (failed: ${jobs.filter((j) => (j.numFailedTasks ?? 0) > 0 || j.status === 'FAILED').length}), stages: ${stages.length}`,
        `- executors: ${activeExec} active / ${executors.length} total, cores: ${executors.reduce((a, e) => a + (e.totalCores ?? 0), 0)}`,
        '',
        '### Totals',
        `- shuffle write ${bytes(totalShuffleWrite)}, read ${bytes(totalShuffleRead)}`,
        `- memory spill ${bytes(totalMemSpill)}, disk spill ${bytes(totalDiskSpill)}`,
        '',
        '### Slowest stages',
        '| stage | name | status | duration | tasks | failed | shuffle write | spill |',
        '|---|---|---|---|---|---|---|---|',
        ...slowest.map(
          (s) =>
            `| ${s.stageId} | ${truncateText(s.name ?? '', 34)} | ${s.status} | ${duration(stageDuration(s, now))} | ${s.numTasks ?? 0} | ${s.numFailedTasks ?? 0} | ${bytes(s.shuffleWriteBytes)} | ${bytes((s.memoryBytesSpilled ?? 0) + (s.diskBytesSpilled ?? 0))} |`,
        ),
        keyConfig.length ? `\n### Key config\n${keyConfig.map((c) => `- ${c}`).join('\n')}` : '',
        '',
        'Next: call `stage_list` or `stage_detail` on the slowest stage, and `executor_list` if executors look unhealthy.',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },
};

const stageList: ToolDefinition = {
  name: 'stage_list',
  description:
    'List stages with duration, task counts, shuffle, spill and failure counts. Sort by duration (default), spill or shuffle.',
  inputSchema: {
    type: 'object',
    properties: {
      ...appIdParam,
      sortBy: { type: 'string', enum: ['duration', 'spill', 'shuffleWrite', 'shuffleRead'], description: 'Sort key, default duration' },
      limit: { type: 'number', description: 'Maximum rows, default 20' },
    },
    required: ['appId'],
  },
  async execute(input, ctx) {
    const client = historyClient(ctx);
    const stages = await client.getStages(String(input.appId));
    const now = Date.now();
    const key = (input.sortBy as string) ?? 'duration';
    const score = (s: StageSummary) =>
      key === 'spill'
        ? (s.memoryBytesSpilled ?? 0) + (s.diskBytesSpilled ?? 0)
        : key === 'shuffleWrite'
          ? (s.shuffleWriteBytes ?? 0)
          : key === 'shuffleRead'
            ? (s.shuffleReadBytes ?? 0)
            : stageDuration(s, now);

    const sorted = [...stages].sort((a, b) => score(b) - score(a));
    const limit = (input.limit as number) ?? 20;
    const total = stages.reduce((a, s) => a + stageDuration(s, now), 0);

    return {
      summary: [
        `## ${stages.length} stages (sorted by ${key})`,
        '| stage | name | status | duration | share | tasks | failed | shuffle w/r | spill |',
        '|---|---|---|---|---|---|---|---|---|',
        ...sorted.slice(0, limit).map((s) => {
          const d = stageDuration(s, now);
          return `| ${s.stageId} | ${truncateText(s.name ?? '', 30)} | ${s.status} | ${duration(d)} | ${total > 0 ? pct(d / total) : 'n/a'} | ${s.numTasks ?? 0} | ${s.numFailedTasks ?? 0} | ${bytes(s.shuffleWriteBytes)} / ${bytes(s.shuffleReadBytes)} | ${bytes((s.memoryBytesSpilled ?? 0) + (s.diskBytesSpilled ?? 0))} |`;
        }),
      ].join('\n'),
    };
  },
};

const stageDetail: ToolDefinition = {
  name: 'stage_detail',
  description:
    'Task-level distribution for one stage: quantiles for duration, GC, shuffle read/write and spill, plus the skew factor and failed task errors. Call after stage_list when a stage looks slow or is spilling.',
  inputSchema: {
    type: 'object',
    properties: {
      ...appIdParam,
      stageId: { type: 'number', description: 'Stage id' },
      attemptId: { type: 'number', description: 'Stage attempt, default 0' },
      sampleTasks: { type: 'number', description: 'Include up to N task rows (default 0 = summary only)' },
    },
    required: ['appId', 'stageId'],
  },
  async execute(input, ctx) {
    const appId = String(input.appId);
    const stageId = Number(input.stageId);
    const attemptId = Number(input.attemptId ?? 0);
    const client = historyClient(ctx);

    const [stage, quantiles] = await Promise.all([
      client.getStageAttempt(appId, stageId, attemptId),
      client.getTaskQuantiles(appId, stageId, attemptId),
    ]);
    const sampleSize = Number(input.sampleTasks ?? 0);
    const tasks = sampleSize > 0 ? await client.getTaskList(appId, stageId, attemptId, { length: sampleSize }) : null;

    if (!quantiles.length) {
      return {
        summary: `Stage ${stageId} (attempt ${attemptId}): no task-level data available yet${stage.status === 'ACTIVE' ? ' (stage still running)' : ''}.`,
      };
    }

    const at = (q: number) => quantiles.find((r) => Math.abs(r.quantile - q) < 1e-6) ?? quantiles[quantiles.length - 1];
    const p50 = at(0.5);
    const p95 = at(0.95);
    const max = at(1);
    const skew = (p50?.duration ?? 0) > 0 ? (max?.duration ?? 0) / (p50?.duration ?? 1) : 0;

    const lines = [
      `## Stage ${stageId} (attempt ${attemptId}) — ${stage.name ?? ''}`,
      `- status: ${stage.status}, tasks: ${stage.numTasks ?? 0} (failed ${stage.numFailedTasks ?? 0}, killed ${stage.numKilledTasks ?? 0})`,
      `- duration: ${duration(stageDuration(stage))}, shuffle write ${bytes(stage.shuffleWriteBytes)}, read ${bytes(stage.shuffleReadBytes)}`,
      `- spill: memory ${bytes(stage.memoryBytesSpilled)}, disk ${bytes(stage.diskBytesSpilled)}`,
      '',
      '### Task quantiles',
      '| quantile | duration | GC | shuffle read | shuffle write | spill |',
      '|---|---|---|---|---|---|',
      ...quantiles.map(
        (r) =>
          `| p${Math.round(r.quantile * 100)} | ${duration(r.duration)} | ${duration(r.jvmGcTime)} | ${bytes(r.shuffleReadMetrics?.readBytes)} | ${bytes(r.shuffleWriteMetrics?.writeBytes)} | ${bytes((r.memoryBytesSpilled ?? 0) + (r.diskBytesSpilled ?? 0))} |`,
      ),
      '',
      `- skew factor (max/p50 duration): ${ratio(skew)}`,
      `- shuffle read skew (max/p50): ${ratio((p50?.shuffleReadMetrics?.readBytes ?? 0) > 0 ? (max?.shuffleReadMetrics?.readBytes ?? 0) / (p50?.shuffleReadMetrics?.readBytes ?? 1) : 0)}`,
      `- p95 duration: ${duration(p95?.duration)}, max: ${duration(max?.duration)}`,
    ];

    if (tasks && tasks.rows.length) {
      const slowest = [...tasks.rows].sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0)).slice(0, 10);
      lines.push('', '### Slowest tasks', '| task | executor | duration | shuffle read | spill | status |', '|---|---|---|---|---|---|');
      for (const t of slowest) {
        lines.push(
          `| ${t.taskId} | ${t.executorId} | ${duration(t.duration)} | ${bytes(t.shuffleReadMetrics?.readBytes)} | ${bytes((t.memoryBytesSpilled ?? 0) + (t.diskBytesSpilled ?? 0))} | ${t.status} |`,
        );
      }
    }

    const failed = tasks?.rows.filter((t) => t.status === 'FAILED' && t.errorMessage) ?? [];
    if (failed.length) {
      lines.push('', '### Failed task errors');
      for (const t of failed.slice(0, 5)) lines.push(`- task ${t.taskId}: ${truncateText(t.errorMessage!, 300)}`);
    }

    return { summary: lines.join('\n') };
  },
};

const taskList: ToolDefinition = {
  name: 'task_list',
  description:
    'Raw task rows for a stage, sorted by a metric. Use for outlier hunting after stage_detail has shown a problem. Large output is written to an artifact.',
  inputSchema: {
    type: 'object',
    properties: {
      ...appIdParam,
      stageId: { type: 'number' },
      attemptId: { type: 'number' },
      limit: { type: 'number', description: 'Rows to fetch, default 500' },
      offset: { type: 'number' },
    },
    required: ['appId', 'stageId'],
  },
  async execute(input, ctx) {
    const client = historyClient(ctx);
    const limit = Number(input.limit ?? 500);
    const res = await client.getTaskList(String(input.appId), Number(input.stageId), Number(input.attemptId ?? 0), {
      offset: Number(input.offset ?? 0),
      length: limit,
    });
    const rows = res.rows.map((t) => ({
      taskId: t.taskId,
      executorId: t.executorId,
      host: t.host,
      status: t.status,
      durationMs: t.duration,
      gcMs: t.gcTime,
      shuffleReadBytes: t.shuffleReadMetrics?.readBytes ?? 0,
      shuffleWriteBytes: t.shuffleWriteMetrics?.writeBytes ?? 0,
      memorySpill: t.memoryBytesSpilled ?? 0,
      diskSpill: t.diskBytesSpilled ?? 0,
      inputRecords: t.inputMetrics?.recordsRead ?? 0,
      errorMessage: t.errorMessage,
    }));
    const stored = await ctx.artifacts.write(`tasks-${input.stageId}`, rows);
    const slowest = [...rows].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
    return {
      artifact: stored.id,
      summary: [
        `Fetched ${rows.length} of ${res.total} tasks for stage ${input.stageId}. Full rows: artifact \`${stored.id}\`.`,
        '',
        '| task | executor | duration | shuffle read | spill | status |',
        '|---|---|---|---|---|---|',
        ...slowest.map(
          (t) =>
            `| ${t.taskId} | ${t.executorId} | ${duration(t.durationMs)} | ${bytes(t.shuffleReadBytes)} | ${bytes(t.memorySpill + t.diskSpill)} | ${t.status} |`,
        ),
      ].join('\n'),
    };
  },
};

const executorList: ToolDefinition = {
  name: 'executor_list',
  description:
    'Executor inventory: active vs removed, removal reasons, GC and memory ratios, failed task counts. Use it when spill, GC or task failures suggest resource pressure.',
  inputSchema: {
    type: 'object',
    properties: { ...appIdParam, includeRemoved: { type: 'boolean', description: 'Include removed executors (default true)' } },
    required: ['appId'],
  },
  async execute(input, ctx) {
    const client = historyClient(ctx);
    const all = input.includeRemoved !== false;
    const executors = await client.getExecutors(String(input.appId), all);
    const active = executors.filter((e) => e.isActive);
    const removed = executors.filter((e) => !e.isActive);
    const totalGc = active.reduce((a, e) => a + (e.totalGCTime ?? 0), 0);
    const totalDur = active.reduce((a, e) => a + (e.totalDuration ?? 0), 0);
    const memUsed = active.reduce((a, e) => a + (e.memoryUsed ?? 0), 0);
    const memMax = active.reduce((a, e) => a + (e.maxMemory ?? 0), 0);

    const reasons = new Map<string, number>();
    for (const e of removed) {
      const r = (e.removeReason ?? 'unknown').slice(0, 80);
      reasons.set(r, (reasons.get(r) ?? 0) + 1);
    }

    return {
      summary: [
        `## Executors: ${active.length} active, ${removed.length} removed`,
        `- total GC time ${duration(totalGc)} of ${duration(totalDur)} (${pct(totalDur > 0 ? totalGc / totalDur : 0)})`,
        `- heap used ${bytes(memUsed)} of ${bytes(memMax)} (${pct(memMax > 0 ? memUsed / memMax : 0)})`,
        `- failed tasks across executors: ${executors.reduce((a, e) => a + (e.failedTasks ?? 0), 0)}`,
        '',
        reasons.size ? '### Removal reasons' : '',
        ...[...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `- ${n}x ${r}`),
        '',
        reasons.size || active.length
          ? 'Interpretation: driver-initiated kills with "dynamic allocation" are usually benign scale-down; OOM, container killed or exit codes point at memory pressure.'
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },
};

const sqlListTool: ToolDefinition = {
  name: 'sql_list',
  description: 'SQL executions in the application with duration and status, longest first. Use it to connect a slow stage to a query.',
  inputSchema: { type: 'object', properties: { ...appIdParam, limit: { type: 'number' } }, required: ['appId'] },
  async execute(input, ctx) {
    const client = historyClient(ctx);
    const list = await client.getSqlList(String(input.appId));
    if (!list.length) return { summary: 'No SQL executions recorded (the job may not use the SQL engine).' };
    const sorted = [...list].sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0));
    return {
      summary: [
        `## ${list.length} SQL execution(s)`,
        '| id | duration | status | jobs | description |',
        '|---|---|---|---|---|',
        ...sorted.slice(0, (input.limit as number) ?? 15).map(
          (s) =>
            `| ${s.id} | ${duration(s.duration)} | ${s.status ?? ''} | ${[...(s.successJobIds ?? []), ...(s.failedJobIds ?? [])].join(',') || 'n/a'} | ${truncateText((s.description ?? '').replace(/\s+/g, ' '), 80)} |`,
        ),
      ].join('\n'),
    };
  },
};

const sqlDetail: ToolDefinition = {
  name: 'sql_detail',
  description:
    'Physical plan for one SQL execution: operator tree with row counts, join types, exchanges and scans. This is where you confirm why data inflates.',
  inputSchema: {
    type: 'object',
    properties: { ...appIdParam, executionId: { type: 'number' }, maxNodes: { type: 'number', description: 'Node limit, default 40' } },
    required: ['appId', 'executionId'],
  },
  async execute(input, ctx) {
    const client = historyClient(ctx);
    const sql = await client.getSqlExecution(String(input.appId), Number(input.executionId));
    const maxNodes = Number(input.maxNodes ?? 40);
    const nodes = (sql.nodes ?? []).slice(0, maxNodes);
    const important = ['number of output rows', 'number of files', 'size of files', 'shuffle records written', 'shuffle bytes written', 'scan time total (min, med, max (a.k.a. duration))'];

    const lines = [
      `## SQL ${sql.id} — ${duration(sql.duration)}`,
      `- status: ${sql.status ?? 'n/a'}, jobs: ${[...(sql.successJobIds ?? []), ...(sql.failedJobIds ?? [])].join(',') || 'n/a'}`,
      `- description: ${truncateText((sql.description ?? '').replace(/\s+/g, ' '), 300)}`,
      '',
      '### Operators (row counts are cumulative for the operator)',
      '| node | operator | output rows | other metrics |',
      '|---|---|---|---|',
    ];
    for (const n of nodes) {
      const m = Object.fromEntries((n.metrics ?? []).map((x) => [x.name, x.value]));
      const rows = m['number of output rows'] ? count(parseMetric(m['number of output rows'])) : 'n/a';
      const others = important
        .filter((k) => k !== 'number of output rows' && m[k])
        .map((k) => `${k.replace(/ \(.*\)/, '')}=${k.includes('files') || k.includes('size') ? bytes(parseMetric(m[k])) : m[k]}`)
        .join(', ');
      lines.push(`| ${n.nodeId ?? ''} | ${n.nodeName} | ${rows} | ${truncateText(others, 90)} |`);
    }
    if ((sql.nodes?.length ?? 0) > maxNodes) lines.push('', `(${sql.nodes!.length - maxNodes} more operators not shown)`);
    if (sql.planDescription) {
      lines.push('', '### Plan', '```', truncateText(sql.planDescription.replace(/\\n/g, '\n'), 2500), '```');
    }
    return { summary: lines.join('\n') };
  },
};

const jobListTool: ToolDefinition = {
  name: 'job_list',
  description: 'Jobs with stage ids and task counts. Useful to map stages back to jobs.',
  inputSchema: { type: 'object', properties: { ...appIdParam, limit: { type: 'number' } }, required: ['appId'] },
  async execute(input, ctx) {
    const client = historyClient(ctx);
    const jobs = await client.getJobs(String(input.appId));
    if (!jobs.length) return { summary: 'No jobs recorded.' };
    return {
      summary: [
        `## ${jobs.length} job(s)`,
        '| job | status | stages | tasks (done/failed) | name |',
        '|---|---|---|---|---|',
        ...jobs.slice(0, (input.limit as number) ?? 30).map(
          (j) =>
            `| ${j.jobId} | ${j.status ?? (j.completionTime ? 'done' : 'running')} | ${(j.stageIds ?? []).join(',')} | ${j.numCompletedTasks ?? 0}/${j.numFailedTasks ?? 0} | ${truncateText(j.name ?? '', 40)} |`,
        ),
      ].join('\n'),
    };
  },
};

const configGet: ToolDefinition = {
  name: 'config_get',
  description: 'Effective Spark configuration for the application. Filter by key prefix to keep the output small.',
  inputSchema: { type: 'object', properties: { ...appIdParam, prefix: { type: 'string', description: 'Key prefix, e.g. spark.sql.adaptive' } }, required: ['appId'] },
  async execute(input, ctx) {
    const client = historyClient(ctx);
    const config = await client.getSparkConfig(String(input.appId));
    const prefix = input.prefix as string | undefined;
    const props = Object.entries(config).filter(([k]) => !prefix || k.startsWith(prefix));
    if (!props.length) return { summary: `No configuration entries${prefix ? ` with prefix ${prefix}` : ''}.` };
    return {
      summary: [
        `${props.length} configuration entries${prefix ? ` (prefix ${prefix})` : ''}:`,
        '',
        ...props.slice(0, 80).map(([k, v]) => `- ${k}=${v}`),
      ].join('\n'),
    };
  },
};

const errorAggregation: ToolDefinition = {
  name: 'error_aggregation',
  description: 'Clusters task failure messages across failed stages by normalised signature, so one root error becomes one line.',
  inputSchema: { type: 'object', properties: { ...appIdParam }, required: ['appId'] },
  async execute(input, ctx) {
    const client = historyClient(ctx);
    const stages = await client.getStages(String(input.appId));
    const failed = stages.filter((s) => (s.numFailedTasks ?? 0) > 0 || s.status === 'FAILED');
    if (!failed.length) return { summary: 'No failed tasks or stages — the application completed cleanly.' };

    const clusters = new Map<string, { count: number; stages: Set<number>; sample: string }>();
    for (const s of failed.slice(0, 10)) {
      const tasks = await client.getTaskList(String(input.appId), s.stageId, s.attemptId ?? 0, { length: 500 });
      for (const t of tasks.rows.filter((r) => r.status === 'FAILED' && r.errorMessage)) {
        const key = t.errorMessage!
          .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
          .replace(/\b\d+\b/g, '<n>')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 160);
        const cur = clusters.get(key) ?? { count: 0, stages: new Set<number>(), sample: t.errorMessage! };
        cur.count++;
        cur.stages.add(s.stageId);
        clusters.set(key, cur);
      }
    }

    const top = [...clusters.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 10);
    return {
      summary: [
        `## ${failed.length} stage(s) with failures, ${top.length} distinct error signature(s)`,
        '',
        ...top.map(
          ([sig, v], i) =>
            `${i + 1}. **${v.count}x** in stage(s) ${[...v.stages].join(',')}\n   \`${truncateText(sig, 180)}\``,
        ),
      ].join('\n'),
    };
  },
};

export const historyTools: ToolDefinition[] = [
  appsList,
  appSummary,
  stageList,
  stageDetail,
  taskList,
  executorList,
  sqlListTool,
  sqlDetail,
  jobListTool,
  configGet,
  errorAggregation,
];

/* ------------------------------------------------------------------ *
 * Diagnosis tools
 * ------------------------------------------------------------------ */

function thresholds(ctx: { config: { rules: Thresholds } }): Thresholds {
  return { ...DEFAULT_THRESHOLDS, ...ctx.config.rules };
}

function renderFinding(f: Finding): string {
  const scope = f.scope?.stageId !== undefined ? ` (stage ${f.scope.stageId})` : f.scope?.sqlId !== undefined ? ` (SQL ${f.scope.sqlId})` : '';
  const evidence = Object.entries(f.evidence)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `    ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('\n');
  return [
    `- **[${f.severity}] ${f.ruleId}**${scope}: ${f.title}`,
    evidence,
    f.possibleCauses.length ? `    likely causes: ${f.possibleCauses.slice(0, 3).join('; ')}` : '',
    f.suggestions.length ? `    directions: ${f.suggestions.slice(0, 3).join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const diagnoseApp: ToolDefinition = {
  name: 'diagnose_app',
  description:
    'Run every diagnostic rule against an application and return ranked findings with evidence. This is the fastest path from appId to a cause. Use it early, then drill into the stages it points at.',
  inputSchema: {
    type: 'object',
    properties: {
      ...appIdParam,
      topStages: { type: 'number', description: 'Stages to profile in depth (default 6)' },
      topSql: { type: 'number', description: 'SQL executions to analyse (default 5)' },
    },
    required: ['appId'],
  },
  async execute(input, ctx) {
    const client = historyClient(ctx);
    const facts = await collectFacts(client, String(input.appId), {
      signal: ctx.signal,
      topStages: Number(input.topStages ?? 6),
      topSql: Number(input.topSql ?? 5),
    });
    const findings = runRules(facts, thresholds(ctx as any));
    const stored = await ctx.artifacts.write('diagnosis', { facts, findings });

    const bySeverity = { P0: findings.filter((f) => f.severity === 'P0'), P1: findings.filter((f) => f.severity === 'P1'), P2: findings.filter((f) => f.severity === 'P2') };

    const lines = [
      `## Diagnosis of ${facts.appId} — ${facts.appName}`,
      `${facts.running ? 'RUNNING' : 'COMPLETED'}, duration ${duration(facts.durationMs)}, ${facts.stages.length} stages, ${facts.executors.active}/${facts.executors.total} executors active`,
      `Findings: ${bySeverity.P0.length} P0, ${bySeverity.P1.length} P1, ${bySeverity.P2.length} P2`,
      '',
      ...(findings.length ? findings.map(renderFinding) : ['No rule fired. The application looks healthy from the available metrics.']),
      '',
      `Full facts and findings saved as artifact \`${stored.id}\` (query with core_artifact_query for task-level detail).`,
    ];
    return { summary: lines.join('\n'), artifact: stored.id };
  },
};

const ruleList: ToolDefinition = {
  name: 'rule_list',
  description: 'List the diagnostic rules, their severity and what they detect. Use it to explain the methodology to the user.',
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    return {
      summary: [
        '## Diagnostic rules',
        '| rule | severity | detects |',
        '|---|---|---|',
        ...allRules.map((r) => `| ${r.id} | ${r.severity} | ${r.description} |`),
      ].join('\n'),
    };
  },
};

const factsDump: ToolDefinition = {
  name: 'facts',
  description:
    'Return the structured facts collected for an application (stage table, executor summary, plan nodes, config) for reasoning that the rules do not cover. Sizeable: prefer diagnose_app first.',
  inputSchema: { type: 'object', properties: { ...appIdParam }, required: ['appId'] },
  async execute(input, ctx) {
    const client = historyClient(ctx);
    const facts: AppFacts = await collectFacts(client, String(input.appId), { signal: ctx.signal });
    const stored = await ctx.artifacts.write('facts', facts);
    return {
      artifact: stored.id,
      summary: [
        `Facts for ${facts.appId} written to artifact \`${stored.id}\`.`,
        `- stages: ${facts.stages.length}, executors: ${facts.executors.active}/${facts.executors.total}, sql: ${facts.sql.length}`,
        `- top stage: ${facts.stages.sort((a, b) => b.durationMs - a.durationMs)[0]?.stageId ?? 'n/a'}`,
        'Query it with core_artifact_query, e.g. {"id":"' + stored.id + '","path":"stages","sortBy":"durationMs","top":5}',
      ].join('\n'),
    };
  },
};

const compareApps: ToolDefinition = {
  name: 'compare_apps',
  description:
    'Compare two Spark applications (A/B testing, before vs after optimization, or fast vs slow run). Compares wall-clock duration, spill, shuffle volume, GC pressure, key configuration differences, and resolved diagnostic findings.',
  inputSchema: {
    type: 'object',
    properties: {
      baselineAppId: { type: 'string', description: 'Application ID of the baseline/original run' },
      experimentAppId: { type: 'string', description: 'Application ID of the comparison/optimized run' },
    },
    required: ['baselineAppId', 'experimentAppId'],
  },
  async execute(input, ctx) {
    const baseId = String(input.baselineAppId);
    const expId = String(input.experimentAppId);
    const client = historyClient(ctx);

    const [baseFacts, expFacts] = await Promise.all([
      collectFacts(client, baseId, { signal: ctx.signal, topStages: 10 }),
      collectFacts(client, expId, { signal: ctx.signal, topStages: 10 }),
    ]);

    const ruleThresholds = thresholds(ctx as any);
    const baseFindings = runRules(baseFacts, ruleThresholds);
    const expFindings = runRules(expFacts, ruleThresholds);

    const baseSpill = baseFacts.stages.reduce((acc, s) => acc + s.memorySpill, 0);
    const expSpill = expFacts.stages.reduce((acc, s) => acc + s.memorySpill, 0);
    const baseShuffle = baseFacts.stages.reduce((acc, s) => acc + s.shuffleReadBytes, 0);
    const expShuffle = expFacts.stages.reduce((acc, s) => acc + s.shuffleReadBytes, 0);

    const durDelta = expFacts.durationMs - baseFacts.durationMs;
    const durPct = baseFacts.durationMs > 0 ? ((durDelta / baseFacts.durationMs) * 100).toFixed(1) : '0';
    const durSign = durDelta <= 0 ? 'faster' : 'slower';

    // Config diff
    const allConfigKeys = new Set([...Object.keys(baseFacts.config), ...Object.keys(expFacts.config)]);
    const configDiff: Array<{ key: string; baseline: string; experiment: string }> = [];
    for (const k of allConfigKeys) {
      if (baseFacts.config[k] !== expFacts.config[k]) {
        configDiff.push({
          key: k,
          baseline: baseFacts.config[k] ?? '(not set)',
          experiment: expFacts.config[k] ?? '(not set)',
        });
      }
    }

    // Findings diff
    const baseRuleIds = new Set(baseFindings.map((f) => f.ruleId));
    const expRuleIds = new Set(expFindings.map((f) => f.ruleId));
    const resolvedFindings = [...baseRuleIds].filter((r) => !expRuleIds.has(r));
    const newFindings = [...expRuleIds].filter((r) => !baseRuleIds.has(r));

    const comparisonArtifact = {
      baseline: { appId: baseId, facts: baseFacts, findings: baseFindings },
      experiment: { appId: expId, facts: expFacts, findings: expFindings },
      configDiff,
      resolvedFindings,
      newFindings,
    };

    const stored = await ctx.artifacts.write('ab_comparison', comparisonArtifact);

    const rows = [
      `## A/B Comparison: ${baseId} → ${expId}`,
      `**Duration**: ${duration(baseFacts.durationMs)} → ${duration(expFacts.durationMs)} (${Math.abs(Number(durPct))}% ${durSign})`,
      '',
      '| Metric | Baseline (A) | Experiment (B) | Delta |',
      '|---|---|---|---|',
      `| Duration | ${duration(baseFacts.durationMs)} | ${duration(expFacts.durationMs)} | ${durDelta < 0 ? '-' : '+'}${duration(Math.abs(durDelta))} (${durPct}%) |`,
      `| Memory Spill | ${bytes(baseSpill)} | ${bytes(expSpill)} | ${bytes(expSpill - baseSpill)} |`,
      `| Shuffle Read | ${bytes(baseShuffle)} | ${bytes(expShuffle)} | ${bytes(expShuffle - baseShuffle)} |`,
      `| Stages | ${baseFacts.stages.length} | ${expFacts.stages.length} | ${expFacts.stages.length - baseFacts.stages.length} |`,
      `| Executor GC Ratio | ${pct(baseFacts.executors.gcRatio)} | ${pct(expFacts.executors.gcRatio)} | ${pct(expFacts.executors.gcRatio - baseFacts.executors.gcRatio)} |`,
      `| Failed Tasks | ${baseFacts.executors.failedTasks} | ${expFacts.executors.failedTasks} | ${expFacts.executors.failedTasks - baseFacts.executors.failedTasks} |`,
      '',
    ];

    if (resolvedFindings.length > 0) {
      rows.push(`**Eliminated Findings (${resolvedFindings.length})**: ${resolvedFindings.join(', ')}`);
    }
    if (newFindings.length > 0) {
      rows.push(`**New Findings (${newFindings.length})**: ${newFindings.join(', ')}`);
    }

    if (configDiff.length > 0) {
      rows.push('', '### Spark Config Differences:');
      rows.push('| Configuration | Baseline | Experiment |');
      rows.push('|---|---|---|');
      for (const d of configDiff.slice(0, 10)) {
        rows.push(`| \`${d.key}\` | \`${d.baseline}\` | \`${d.experiment}\` |`);
      }
      if (configDiff.length > 10) {
        rows.push(`*...and ${configDiff.length - 10} more configuration differences in artifact*`);
      }
    }

    rows.push('', `Full comparison artifact: \`${stored.id}\`.`);

    return {
      summary: rows.join('\n'),
      artifact: stored.id,
    };
  },
};

export const diagnoseTools: ToolDefinition[] = [diagnoseApp, ruleList, factsDump, compareApps];

export { httpJson, parseSparkTime };
function truncateText(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}
