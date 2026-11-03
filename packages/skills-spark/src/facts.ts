import {
  HistoryClient,
  type ExecutorSummary,
  type JobSummary,
  type QuantileRow,
  type SqlExecution,
  type StageSummary,
  appDuration,
  isRunning,
  parseSparkTime,
  stageDuration,
} from './history-client.js';

export interface QuantileSummary {
  p50DurationMs: number;
  maxDurationMs: number;
  p95DurationMs: number;
  p50GcMs: number;
  maxGcMs: number;
  p50ShuffleRead: number;
  maxShuffleRead: number;
  p50ShuffleWrite: number;
  maxShuffleWrite: number;
  p50Spill: number;
  maxSpill: number;
  durationSkew: number;
  shuffleReadSkew: number;
}

export interface StageFacts {
  stageId: number;
  attemptId: number;
  name: string;
  status: string;
  durationMs: number;
  numTasks: number;
  failedTasks: number;
  killedTasks: number;
  inputBytes: number;
  outputBytes: number;
  shuffleReadBytes: number;
  shuffleWriteBytes: number;
  memorySpill: number;
  diskSpill: number;
  quantiles?: QuantileSummary;
  failedTaskSamples: string[];
}

export interface PlanNodeFacts {
  nodeId?: number;
  name: string;
  metrics: Record<string, number>;
}

export interface SqlFacts {
  id: number;
  description: string;
  durationMs: number;
  status?: string;
  jobIds: number[];
  nodes: PlanNodeFacts[];
  planText?: string;
}

export interface ExecutorFacts {
  active: number;
  total: number;
  removed: Array<{ reason: string; count: number }>;
  failedTasks: number;
  gcRatio: number;
  memoryUsedRatio: number;
  totalCores: number;
}

export interface AppFacts {
  appId: string;
  appName: string;
  running: boolean;
  startTime?: string;
  durationMs: number;
  sparkUser?: string;
  sparkVersion?: string;
  stages: StageFacts[];
  jobs: JobSummary[];
  executors: ExecutorFacts;
  sql: SqlFacts[];
  config: Record<string, string>;
  collectedAt: string;
}

export interface CollectOptions {
  signal?: AbortSignal;
  topStages?: number;
  topSql?: number;
  historyServerUrl?: string;
}

/**
 * Pulls everything the rules need in one pass, and nothing more.
 * Expensive endpoints (task quantiles, plans) are limited to the stages and
 * SQL executions that can actually matter.
 */
export async function collectFacts(
  client: HistoryClient,
  appId: string,
  opts: CollectOptions = {},
): Promise<AppFacts> {
  const topStages = opts.topStages ?? 6;
  const topSql = opts.topSql ?? 5;
  const now = Date.now();

  const [app, stagesRaw, jobs, executorsRaw, sqlRaw, env] = await Promise.all([
    client.getApplication(appId),
    client.getStages(appId),
    client.getJobs(appId).catch(() => []),
    client.getExecutors(appId, true).catch(() => []),
    client.getSqlList(appId).catch(() => []),
    client.getEnvironment(appId).catch((): { sparkProperties?: Array<[string, string]> } => ({})),
  ]);

  const stages: StageFacts[] = stagesRaw.map((s) => ({
    stageId: s.stageId,
    attemptId: s.attemptId ?? 0,
    name: s.name ?? `stage ${s.stageId}`,
    status: s.status,
    durationMs: stageDuration(s, now),
    numTasks: s.numTasks ?? 0,
    failedTasks: s.numFailedTasks ?? 0,
    killedTasks: s.numKilledTasks ?? 0,
    inputBytes: s.inputBytes ?? 0,
    outputBytes: s.outputBytes ?? 0,
    shuffleReadBytes: s.shuffleReadBytes ?? 0,
    shuffleWriteBytes: s.shuffleWriteBytes ?? 0,
    memorySpill: s.memoryBytesSpilled ?? 0,
    diskSpill: s.diskBytesSpilled ?? 0,
    failedTaskSamples: [],
  }));

  // Only the stages worth looking at get the expensive task-level breakdown.
  const interesting = [...stages]
    .sort((a, b) => b.durationMs + b.memorySpill / 1e6 - (a.durationMs + a.memorySpill / 1e6))
    .slice(0, topStages);

  await Promise.all(
    interesting.map(async (stage) => {
      const [quantiles, tasks] = await Promise.all([
        client.getTaskQuantiles(appId, stage.stageId, stage.attemptId),
        stage.failedTasks > 0
          ? client.getTaskList(appId, stage.stageId, stage.attemptId, { length: 500 })
          : Promise.resolve({ rows: [], total: 0 }),
      ]);
      stage.quantiles = summarizeQuantiles(quantiles);
      stage.failedTaskSamples = tasks.rows
        .filter((t) => t.status === 'FAILED' && t.errorMessage)
        .slice(0, 5)
        .map((t) => t.errorMessage as string);
    }),
  );

  const sql: SqlFacts[] = [];
  const topSqlList = [...sqlRaw].sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0)).slice(0, topSql);
  await Promise.all(
    topSqlList.map(async (s) => {
      let detail: SqlExecution = s;
      try {
        detail = await client.getSqlExecution(appId, s.id);
      } catch {
        // Plan details are optional; the summary still carries duration and ids.
      }
      sql.push(toSqlFacts(detail));
    }),
  );
  sql.sort((a, b) => b.durationMs - a.durationMs);

  const config: Record<string, string> = {};
  for (const entry of env.sparkProperties ?? []) {
    if (Array.isArray(entry)) config[String(entry[0])] = String(entry[1] ?? '');
    else if (entry && typeof entry === 'object' && 'key' in entry) config[String((entry as any).key)] = String((entry as any).value ?? '');
  }

  return {
    appId,
    appName: app.name,
    running: isRunning(app),
    startTime: app.attempts?.[0]?.startTime,
    durationMs: appDuration(app, now),
    sparkUser: app.attempts?.[0]?.sparkUser,
    sparkVersion: app.attempts?.[0]?.appSparkVersion,
    stages,
    jobs,
    executors: summarizeExecutors(executorsRaw),
    sql,
    config,
    collectedAt: new Date(now).toISOString(),
  };
}

export function summarizeQuantiles(rows: QuantileRow[]): QuantileSummary | undefined {
  if (!rows.length) return undefined;
  const at = (q: number): QuantileRow | undefined =>
    rows.find((r) => Math.abs(r.quantile - q) < 1e-6) ?? rows.reduce((best, r) => (Math.abs(r.quantile - q) < Math.abs(best.quantile - q) ? r : best), rows[0]);

  const p50 = at(0.5);
  const p95 = at(0.95);
  const max = at(1.0);
  if (!p50 || !max) return undefined;

  const dur = (r?: QuantileRow) => r?.duration ?? 0;
  const gc = (r?: QuantileRow) => r?.jvmGcTime ?? 0;
  const sRead = (r?: QuantileRow) => r?.shuffleReadMetrics?.readBytes ?? 0;
  const sWrite = (r?: QuantileRow) => r?.shuffleWriteMetrics?.writeBytes ?? 0;
  const spill = (r?: QuantileRow) => (r?.memoryBytesSpilled ?? 0) + (r?.diskBytesSpilled ?? 0);

  return {
    p50DurationMs: dur(p50),
    p95DurationMs: dur(p95),
    maxDurationMs: dur(max),
    p50GcMs: gc(p50),
    maxGcMs: gc(max),
    p50ShuffleRead: sRead(p50),
    maxShuffleRead: sRead(max),
    p50ShuffleWrite: sWrite(p50),
    maxShuffleWrite: sWrite(max),
    p50Spill: spill(p50),
    maxSpill: spill(max),
    durationSkew: dur(p50) > 0 ? dur(max) / dur(p50) : 0,
    shuffleReadSkew: sRead(p50) > 0 ? sRead(max) / sRead(p50) : 0,
  };
}

function summarizeExecutors(rows: ExecutorSummary[]): ExecutorFacts {
  const active = rows.filter((e) => e.isActive).length;
  const reasonCounts = new Map<string, number>();
  for (const e of rows) {
    if (e.isActive) continue;
    const reason = e.removeReason?.trim();
    if (!reason) continue;
    const key = reason.length > 90 ? `${reason.slice(0, 90)}...` : reason;
    reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
  }
  const totalGc = rows.reduce((acc, e) => acc + (e.totalGCTime ?? 0), 0);
  const totalDuration = rows.reduce((acc, e) => acc + (e.totalDuration ?? 0), 0);
  const memUsed = rows.filter((e) => e.isActive).reduce((acc, e) => acc + (e.memoryUsed ?? 0), 0);
  const memMax = rows.filter((e) => e.isActive).reduce((acc, e) => acc + (e.maxMemory ?? 0), 0);

  return {
    active,
    total: rows.length,
    removed: [...reasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    failedTasks: rows.reduce((acc, e) => acc + (e.failedTasks ?? 0), 0),
    gcRatio: totalDuration > 0 ? totalGc / totalDuration : 0,
    memoryUsedRatio: memMax > 0 ? memUsed / memMax : 0,
    totalCores: rows.reduce((acc, e) => acc + (e.totalCores ?? 0), 0),
  };
}

function toSqlFacts(s: SqlExecution): SqlFacts {
  return {
    id: s.id,
    description: s.description ?? '',
    durationMs: s.duration ?? 0,
    status: s.status,
    jobIds: [...(s.successJobIds ?? []), ...(s.failedJobIds ?? [])],
    nodes: (s.nodes ?? []).map((n) => ({
      nodeId: n.nodeId,
      name: n.nodeName,
      metrics: Object.fromEntries((n.metrics ?? []).map((m) => [m.name, parseMetric(m.value)])),
    })),
    planText: s.planDescription,
  };
}

const BYTE_UNITS: Record<string, number> = {
  b: 1,
  bytes: 1,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
};

/** Time units, normalised to milliseconds. */
const TIME_UNITS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  ms: 1,
  s: 1000,
  sec: 1000,
  min: 60_000,
  h: 3_600_000,
};

/**
 * Spark prints plan metrics as human strings: "12,345", "1133.8 KiB",
 * "563 ms (0 ms, 3 ms, 59 ms ...)" and "total (min, med, max (...))\n563 ms ...".
 * Convert them to base units (bytes, milliseconds) so rules can do arithmetic.
 */
export function parseMetric(value: string | number | undefined): number {
  if (typeof value === 'number') return value;
  if (!value) return 0;
  // Aggregate metrics put a summary label on the first line and the total next.
  const text = value.includes('\n') ? value.split('\n').slice(1).join(' ') : value;
  const m = text
    .replace(/,/g, '')
    .trim()
    .match(/^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*([a-zA-Z]+)?/);
  if (!m) return 0;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n)) return 0;
  const unit = (m[2] ?? '').toLowerCase();
  if (unit in BYTE_UNITS) return n * BYTE_UNITS[unit];
  if (unit in TIME_UNITS) return n * TIME_UNITS[unit];
  return n;
}

/** Read the first metric that exists; Spark renames these between versions. */
export function getMetric(node: { metrics: Record<string, number> }, names: string[]): number | undefined {
  for (const name of names) {
    const value = node.metrics[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

/** True for nodes that represent a join operator. */
export function isJoinNode(name: string): boolean {
  return /Join|CartesianProduct/i.test(name);
}

export function isScanNode(name: string): boolean {
  return /Scan|TableScan|FileSourceScan/i.test(name);
}

export { parseSparkTime };
