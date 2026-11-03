import { HttpError, httpJson } from '@sparksleuth/core';

export interface SparkApplication {
  id: string;
  name: string;
  attempts: Array<{
    attemptId?: string;
    startTime: string;
    endTime?: string;
    lastUpdated?: string;
    duration?: number;
    sparkUser?: string;
    completed?: boolean;
    appSparkVersion?: string;
  }>;
}

export interface JobSummary {
  jobId: number;
  name?: string;
  status?: string;
  submissionTime?: string;
  completionTime?: string;
  stageIds?: number[];
  numTasks?: number;
  numCompletedTasks?: number;
  numFailedTasks?: number;
  numActiveTasks?: number;
  numSkippedTasks?: number;
}

export interface StageSummary {
  stageId: number;
  attemptId: number;
  status: string;
  name?: string;
  details?: string;
  numTasks: number;
  numActiveTasks?: number;
  numCompleteTasks?: number;
  numFailedTasks?: number;
  numKilledTasks?: number;
  submissionTime?: string;
  firstTaskLaunchedTime?: string;
  completionTime?: string;
  executorRuntime?: number;
  inputBytes?: number;
  inputRecords?: number;
  outputBytes?: number;
  outputRecords?: number;
  shuffleReadBytes?: number;
  shuffleReadRecords?: number;
  shuffleWriteBytes?: number;
  shuffleWriteRecords?: number;
  memoryBytesSpilled?: number;
  diskBytesSpilled?: number;
  /** Present only on sources that explicitly expose stage topology. */
  parentIds?: number[];
}

export interface QuantileRow {
  quantile: number;
  duration?: number;
  executorRunTime?: number;
  executorDeserializeTime?: number;
  resultSize?: number;
  jvmGcTime?: number;
  memoryBytesSpilled?: number;
  diskBytesSpilled?: number;
  shuffleReadMetrics?: { readBytes?: number; readRecords?: number; remoteBytesRead?: number };
  shuffleWriteMetrics?: { writeBytes?: number; writeRecords?: number };
  inputMetrics?: { bytesRead?: number; recordsRead?: number };
}

export interface TaskRow {
  taskId: number;
  index: number;
  attempt: number;
  executorId: string;
  host?: string;
  status: string;
  duration: number;
  gcTime?: number;
  errorMessage?: string;
  shuffleReadMetrics?: { readBytes?: number; readRecords?: number };
  shuffleWriteMetrics?: { writeBytes?: number; writeRecords?: number };
  memoryBytesSpilled?: number;
  diskBytesSpilled?: number;
  inputMetrics?: { bytesRead?: number; recordsRead?: number };
  outputMetrics?: { bytesWritten?: number; recordsWritten?: number };
}

export interface ExecutorSummary {
  id: string;
  hostPort?: string;
  isActive?: boolean;
  removeReason?: string;
  rddBlocks?: number;
  memoryUsed?: number;
  maxMemory?: number;
  diskUsed?: number;
  totalCores?: number;
  maxTasks?: number;
  activeTasks?: number;
  failedTasks?: number;
  completedTasks?: number;
  totalTasks?: number;
  totalDuration?: number;
  totalGCTime?: number;
  totalInputBytes?: number;
  totalShuffleRead?: number;
  totalShuffleWrite?: number;
  memoryMetrics?: Record<string, number>;
}

export interface SqlNode {
  nodeId?: number;
  nodeName: string;
  wholeStageCodegenId?: number;
  metrics?: Array<{ name: string; value: string }>;
}

export interface SqlExecution {
  id: number;
  status?: string;
  description?: string;
  submissionTime?: string;
  duration?: number;
  successJobIds?: number[];
  failedJobIds?: number[];
  nodes?: SqlNode[];
  edges?: Array<{ fromId: number; toId: number }>;
  planDescription?: string;
}

export interface EnvInfo {
  /** Spark returns this as an array of [key, value] pairs, not objects. */
  sparkProperties?: Array<[string, string]> | Array<{ key: string; value: string }>;
  runtime?: Record<string, string>;
}

/** Reads the Spark History Server REST API. Read-only by construction. */
export class HistoryClient {
  constructor(
    private readonly baseUrl: string,
    private readonly opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ) {}

  private get<T>(path: string): Promise<T> {
    return httpJson<T>(`${this.baseUrl}/api/v1${path}`, {
      timeoutMs: this.opts.timeoutMs ?? 30_000,
      signal: this.opts.signal,
    });
  }

  async ping(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const v = await this.get<{ sparkVersion?: string }>('/version');
      return { ok: true, version: v?.sparkVersion };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listApplications(params: { status?: string; limit?: number } = {}): Promise<SparkApplication[]> {
    const q = new URLSearchParams();
    if (params.status) q.set('status', params.status);
    q.set('limit', String(params.limit ?? 50));
    const apps = await this.get<SparkApplication[]>(`/applications?${q}`);
    return (apps ?? []).sort((a, b) => (b.attempts?.[0]?.startTime ?? '').localeCompare(a.attempts?.[0]?.startTime ?? ''));
  }

  async getApplication(appId: string): Promise<SparkApplication> {
    // The endpoint returns a single object; some versions wrap it in an array.
    const data = await this.get<SparkApplication | SparkApplication[]>(
      `/applications/${encodeURIComponent(appId)}`,
    );
    const app = Array.isArray(data) ? data[0] : data;
    if (!app) throw new HttpError(404, `${this.baseUrl}/api/v1/applications/${appId}`, 'application not found');
    return app;
  }

  async getJobs(appId: string): Promise<JobSummary[]> {
    return (await this.get<JobSummary[]>(`/applications/${encodeURIComponent(appId)}/jobs`)) ?? [];
  }

  async getStages(appId: string): Promise<StageSummary[]> {
    return (await this.get<StageSummary[]>(`/applications/${encodeURIComponent(appId)}/stages`)) ?? [];
  }

  async getStageAttempt(appId: string, stageId: number, attemptId = 0): Promise<StageSummary> {
    return this.get<StageSummary>(
      `/applications/${encodeURIComponent(appId)}/stages/${stageId}/${attemptId}`,
    );
  }

  async getTaskQuantiles(
    appId: string,
    stageId: number,
    attemptId = 0,
    quantiles = '0.05,0.25,0.5,0.75,0.95,1.0',
  ): Promise<QuantileRow[]> {
    try {
      const raw = await this.get<unknown>(
        `/applications/${encodeURIComponent(appId)}/stages/${stageId}/${attemptId}/taskSummary?quantiles=${quantiles}`,
      );
      return normalizeTaskSummary(raw);
    } catch {
      return [];
    }
  }

  async getTaskList(
    appId: string,
    stageId: number,
    attemptId = 0,
    params: { offset?: number; length?: number; sortBy?: string } = {},
  ): Promise<{ rows: TaskRow[]; total: number }> {
    const q = new URLSearchParams({
      offset: String(params.offset ?? 0),
      length: String(params.length ?? 200),
    });
    if (params.sortBy) q.set('sortBy', params.sortBy);
    // The header carries the total task count.
    const res = await fetch(
      `${this.baseUrl}/api/v1/applications/${encodeURIComponent(appId)}/stages/${stageId}/${attemptId}/taskList?${q}`,
      { signal: this.opts.signal },
    );
    if (!res.ok) {
      throw new HttpError(res.status, res.url, await res.text().catch(() => ''));
    }
    const total = Number.parseInt(res.headers.get('x-total-number-of-tasks') ?? '0', 10);
    const rows = (await res.json()) as TaskRow[];
    return { rows: rows ?? [], total: Number.isFinite(total) ? total : rows.length };
  }

  async getExecutors(appId: string, all = false): Promise<ExecutorSummary[]> {
    const path = all ? 'allexecutors' : 'executors';
    return (await this.get<ExecutorSummary[]>(`/applications/${encodeURIComponent(appId)}/${path}`)) ?? [];
  }

  async getSqlList(appId: string, strict = false): Promise<SqlExecution[]> {
    try {
      return (await this.get<SqlExecution[]>(`/applications/${encodeURIComponent(appId)}/sql`)) ?? [];
    } catch (error) {
      if (strict) throw error;
      return [];
    }
  }

  async getSqlExecution(appId: string, executionId: number): Promise<SqlExecution> {
    return this.get<SqlExecution>(
      `/applications/${encodeURIComponent(appId)}/sql/${executionId}?details=true&planDescription=true`,
    );
  }

  /** Spark properties as a plain map, whatever shape the API returned. */
  async getSparkConfig(appId: string): Promise<Record<string, string>> {
    const env = await this.getEnvironment(appId);
    const out: Record<string, string> = {};
    for (const entry of env.sparkProperties ?? []) {
      if (Array.isArray(entry)) {
        const [k, v] = entry;
        if (k !== undefined) out[String(k)] = String(v ?? '');
      } else if (entry && typeof entry === 'object' && 'key' in entry) {
        out[String((entry as { key: string }).key)] = String((entry as { value: string }).value ?? '');
      }
    }
    return out;
  }

  async getEnvironment(appId: string): Promise<EnvInfo> {
    try {
      return await this.get<EnvInfo>(`/applications/${encodeURIComponent(appId)}/environment`);
    } catch {
      return {} as EnvInfo;
    }
  }
}

/** Spark emits timestamps like 2026-11-03T12:00:00.000GMT, which Date parses loosely. */
export function parseSparkTime(value?: string): number | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/GMT$/, 'Z').replace(' ', 'T');
  const t = Date.parse(normalized);
  return Number.isNaN(t) ? undefined : t;
}

export function stageDuration(stage: StageSummary, now = Date.now()): number {
  const start = parseSparkTime(stage.submissionTime);
  if (start === undefined) return 0;
  const end = parseSparkTime(stage.completionTime) ?? now;
  return Math.max(0, end - start);
}

export function appDuration(app: SparkApplication, now = Date.now()): number {
  const attempt = app.attempts?.[0];
  if (!attempt) return 0;
  const start = parseSparkTime(attempt.startTime);
  const end = parseSparkTime(attempt.endTime) ?? now;
  if (start === undefined) return 0;
  return Math.max(0, end - start);
}

export function isRunning(app: SparkApplication): boolean {
  return !app.attempts?.[0]?.completed;
}

/**
 * Spark's taskSummary endpoint is column oriented:
 * {quantiles: [...], duration: [...]}. Turn it into rows so callers can think
 * in records instead of parallel arrays.
 */
export function normalizeTaskSummary(raw: unknown): QuantileRow[] {
  if (Array.isArray(raw)) return raw as QuantileRow[];
  if (!raw || typeof raw !== 'object') return [];
  const data = raw as Record<string, any>;
  const quantiles: number[] = Array.isArray(data.quantiles) ? data.quantiles : [];
  if (!quantiles.length) return [];
  const col = (path: string[]): unknown[] => {
    let cur: any = data;
    for (const key of path) cur = cur?.[key];
    return Array.isArray(cur) ? cur : [];
  };
  return quantiles.map((q, i) => ({
    quantile: q,
    duration: Number(col(['duration'])[i] ?? 0),
    executorRunTime: Number(col(['executorRunTime'])[i] ?? 0),
    executorDeserializeTime: Number(col(['executorDeserializeTime'])[i] ?? 0),
    resultSize: Number(col(['resultSize'])[i] ?? 0),
    jvmGcTime: Number(col(['jvmGcTime'])[i] ?? 0),
    memoryBytesSpilled: Number(col(['memoryBytesSpilled'])[i] ?? 0),
    diskBytesSpilled: Number(col(['diskBytesSpilled'])[i] ?? 0),
    inputMetrics: {
      bytesRead: Number(col(['inputMetrics', 'bytesRead'])[i] ?? 0),
      recordsRead: Number(col(['inputMetrics', 'recordsRead'])[i] ?? 0),
    },
    shuffleReadMetrics: {
      readBytes: Number(col(['shuffleReadMetrics', 'readBytes'])[i] ?? 0),
      readRecords: Number(col(['shuffleReadMetrics', 'readRecords'])[i] ?? 0),
      remoteBytesRead: Number(col(['shuffleReadMetrics', 'remoteBytesRead'])[i] ?? 0),
    },
    shuffleWriteMetrics: {
      writeBytes: Number(col(['shuffleWriteMetrics', 'writeBytes'])[i] ?? 0),
      writeRecords: Number(col(['shuffleWriteMetrics', 'writeRecords'])[i] ?? 0),
    },
  }));
}
