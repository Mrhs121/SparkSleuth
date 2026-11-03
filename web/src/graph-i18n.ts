import type { GraphAnnotation } from './graph';
import type { Lang } from './i18n';

// Presentation only: never rewrite snapshot titles, evidence, operator names, or raw metrics.
type Bilingual = readonly [zh: string, en: string];
const text = (value: Bilingual, lang: Lang): string => value[lang === 'zh' ? 0 : 1];
const sourceText = (raw: string, lang: Lang): string => `${lang === 'zh' ? '[未翻译原文]' : '[Source text]'} ${raw}`;
const missing = (lang: Lang): string => text(['未提供', 'not provided'], lang);

/** Literal causes emitted by all twelve rules. Unknown errors/causes stay visible, not guessed. */
const causes: Record<string, Bilingual> = {
  'skewed data': ['数据倾斜', 'skewed data'],
  'excessive shuffle': ['Shuffle 数据量过大', 'excessive shuffle'],
  'spilling': ['发生溢写', 'spilling'],
  'a genuinely heavy operator': ['算子本身计算量较大', 'a genuinely heavy operator'],
  'the working set does not fit in execution memory': ['工作集超出执行内存容量', 'the working set does not fit in execution memory'],
  'row fan-out upstream inflates the data': ['上游行数膨胀导致数据量增加', 'row fan-out upstream inflates the data'],
  'too few partitions, so each task handles too much': ['分区过少，单个任务处理的数据量过大', 'too few partitions, so each task handles too much'],
  'hot partition key': ['分区键存在热点', 'hot partition key'],
  'uneven file sizes': ['文件大小不均', 'uneven file sizes'],
  'one executor starved of resources': ['某个 Executor 资源不足', 'one executor starved of resources'],
  'a hot key in the shuffle': ['Shuffle 键存在热点', 'a hot key in the shuffle'],
  'a partitioner that does not spread the key space': ['分区器未能均匀分散键空间', 'a partitioner that does not spread the key space'],
  'the join key is not unique on one side, producing a many-to-many join': ['一侧 Join 键不唯一，产生多对多 Join', 'the join key is not unique on one side, producing a many-to-many join'],
  'a self join on a low-cardinality or duplicated key': ['在低基数或重复键上执行自连接', 'a self join on a low-cardinality or duplicated key'],
  'a function-wrapped key that defeats the optimizer': ['Join 键被函数包装，妨碍优化器优化', 'a function-wrapped key that defeats the optimizer'],
  'a non-equi join condition (range, LIKE, inequality)': ['非等值 Join 条件（范围、LIKE、不等式）', 'a non-equi join condition (range, LIKE, inequality)'],
  'a missing or unusable join key': ['缺少 Join 键或 Join 键不可用', 'a missing or unusable join key'],
  'the optimizer could not derive an equi-join': ['优化器无法推导等值 Join', 'the optimizer could not derive an equi-join'],
  'the join key is wrapped in a function, so statistics cannot be used': ['Join 键被函数包装，无法利用统计信息', 'the join key is wrapped in a function, so statistics cannot be used'],
  'the broadcast threshold is configured too low': ['广播阈值配置过低', 'the broadcast threshold is configured too low'],
  'estimated size is unreliable because statistics are missing': ['缺少统计信息，估算大小不可靠', 'estimated size is unreliable because statistics are missing'],
  'heap too small for the working set': ['堆内存不足以容纳工作集', 'heap too small for the working set'],
  'oversized partitions': ['分区过大', 'oversized partitions'],
  'object churn from wide rows': ['宽行导致大量对象分配与回收', 'object churn from wide rows'],
  'heap pressure': ['堆内存压力', 'heap pressure'],
  'large aggregation state per task': ['单个任务的聚合状态过大', 'large aggregation state per task'],
  'container killed for exceeding memory limits': ['容器因超出内存限制被终止', 'container killed for exceeding memory limits'],
  'node pressure from oversized tasks': ['超大任务导致节点资源压力', 'node pressure from oversized tasks'],
  'unstable nodes': ['节点不稳定', 'unstable nodes'],
  'shuffle fetch failures': ['Shuffle 拉取失败', 'shuffle fetch failures'],
  'data skew causing oversized tasks': ['数据倾斜导致任务过大', 'data skew causing oversized tasks'],
  'external dependency failure': ['外部依赖故障', 'external dependency failure'],
  'too many output partitions upstream': ['上游输出分区过多', 'too many output partitions upstream'],
  'frequent small appends': ['频繁追加少量数据', 'frequent small appends'],
  'AQE is off, so skew and partition coalescing cannot help': ['AQE 已关闭，无法使用倾斜优化和分区合并', 'AQE is off, so skew and partition coalescing cannot help'],
  'adaptive skew join handling is off': ['自适应倾斜 Join 优化已关闭', 'adaptive skew join handling is off'],
};

function localizeCause(raw: string, lang: Lang): string {
  const known = (Object.hasOwn(causes, raw) ? causes[raw] : undefined) ?? Object.values(causes).find((pair) => pair.includes(raw));
  if (known) return text(known, lang);
  let match = raw.match(/^(.+) of shuffle spread over only (\d+) partitions$/);
  if (match) return lang === 'zh'
    ? `${match[1]} 的 Shuffle 数据仅分布在 ${formatCount(Number(match[2]), lang)} 个分区上`
    : `${match[1]} of shuffle spread over only ${formatCount(Number(match[2]), lang)} partitions`;
  match = raw.match(/^overhead is only ([\d.]+%) of executor memory$/);
  if (match) return lang === 'zh' ? `内存开销仅占 Executor 内存的 ${match[1]}` : raw;
  return sourceText(raw, lang);
}

const names: Record<string, Bilingual> = {
  stageId: ['阶段 ID', 'Stage ID'], attemptId: ['尝试 ID', 'Attempt ID'], sqlId: ['SQL ID', 'SQL ID'], nodeId: ['节点 ID', 'Node ID'],
  operator: ['算子', 'Operator'], joins: ['Join 算子', 'Join operators'], name: ['名称', 'Name'], details: ['详情', 'Details'], status: ['状态', 'Status'],
  stageDuration: ['阶段耗时', 'Stage duration'], totalStageTime: ['阶段总耗时', 'Total stage time'], share: ['耗时占比', 'Time share'], tasks: ['任务数', 'Tasks'],
  memorySpill: ['内存溢写量', 'Memory spill'], diskSpill: ['磁盘溢写量', 'Disk spill'], shuffleRead: ['Shuffle 读取量', 'Shuffle read'], spillRatio: ['溢写 / Shuffle 读取比', 'Spill / shuffle read ratio'], p50TaskSpill: ['任务溢写量中位数', 'Median task spill'],
  p50TaskDuration: ['任务耗时中位数', 'Median task duration'], p95TaskDuration: ['任务耗时 P95', 'P95 task duration'], maxTaskDuration: ['任务最长耗时', 'Maximum task duration'], skewFactor: ['倾斜倍数', 'Skew factor'],
  p50ShuffleRead: ['Shuffle 读取量中位数', 'Median shuffle read'], maxShuffleRead: ['最大 Shuffle 读取量', 'Maximum shuffle read'],
  joinOutputRows: ['Join 输出行数', 'Join output rows'], largestInputRows: ['最大输入行数', 'Largest input rows'], totalInputRows: ['总输入行数', 'Total input rows'], fanoutVsLargestInput: ['相对最大输入的膨胀倍数', 'Fan-out vs largest input'], fanoutVsTotalInput: ['相对总输入的膨胀倍数', 'Fan-out vs total input'], sqlDuration: ['SQL 耗时', 'SQL duration'],
  outputRows: ['输出行数', 'Output rows'], smallestInput: ['最小输入大小', 'Smallest input size'], broadcastThreshold: ['广播阈值', 'Broadcast threshold'],
  executorGcRatio: ['Executor GC 占比', 'Executor GC ratio'], activeExecutors: ['活跃 Executor 数', 'Active executors'], p50Gc: ['GC 耗时中位数', 'Median GC time'], gcRatio: ['GC 耗时占比', 'GC time ratio'],
  removed: ['移除的 Executor 数', 'Removed executors'], totalExecutors: ['Executor 总数', 'Total executors'], reasons: ['移除原因（原文）', 'Removal reasons (source text)'], failedTasks: ['失败任务数', 'Failed tasks'], killedTasks: ['终止任务数', 'Killed tasks'], errorClusters: ['错误聚类（原文）', 'Error clusters (source text)'],
  files: ['文件数', 'Files'], totalSize: ['文件总大小', 'Total file size'], averageFileSize: ['平均文件大小', 'Average file size'], error: ['规则错误（原文）', 'Rule error (source text)'],
  numTasks: ['任务数', 'Tasks'], numActiveTasks: ['活跃任务数', 'Active tasks'], numCompleteTasks: ['完成任务数', 'Completed tasks'], numFailedTasks: ['失败任务数', 'Failed tasks'], numKilledTasks: ['终止任务数', 'Killed tasks'],
  submissionTime: ['提交时间', 'Submission time'], firstTaskLaunchedTime: ['首个任务启动时间', 'First task launched'], completionTime: ['完成时间', 'Completion time'], executorRuntime: ['Executor 运行时间（ms）', 'Executor runtime (ms)'], durationMs: ['耗时（ms）', 'Duration (ms)'],
  inputBytes: ['输入字节数', 'Input bytes'], inputRecords: ['输入记录数', 'Input records'], outputBytes: ['输出字节数', 'Output bytes'], outputRecords: ['输出记录数', 'Output records'], shuffleReadBytes: ['Shuffle 读取字节数', 'Shuffle read bytes'], shuffleReadRecords: ['Shuffle 读取记录数', 'Shuffle read records'], shuffleWriteBytes: ['Shuffle 写入字节数', 'Shuffle write bytes'], shuffleWriteRecords: ['Shuffle 写入记录数', 'Shuffle write records'], memoryBytesSpilled: ['内存溢写字节数', 'Memory bytes spilled'], diskBytesSpilled: ['磁盘溢写字节数', 'Disk bytes spilled'],
  p50ShuffleWrite: ['Shuffle 写入量中位数', 'Median shuffle write'], maxShuffleWrite: ['最大 Shuffle 写入量', 'Maximum shuffle write'],
  p50DurationMs: ['任务耗时中位数（ms）', 'Median task duration (ms)'], p95DurationMs: ['任务耗时 P95（ms）', 'P95 task duration (ms)'], maxDurationMs: ['任务最长耗时（ms）', 'Maximum task duration (ms)'], durationSkew: ['任务耗时倾斜倍数', 'Task duration skew'], shuffleReadSkew: ['Shuffle 读取倾斜倍数', 'Shuffle read skew'], p50GcMs: ['GC 耗时中位数（ms）', 'Median GC time (ms)'], maxGcMs: ['GC 最长耗时（ms）', 'Maximum GC time (ms)'], p50Spill: ['溢写量中位数', 'Median spill'], maxSpill: ['最大溢写量', 'Maximum spill'],
  'number of columnar batches': ['列式批次数', 'Number of columnar batches'], 'columnar batches': ['列式批次数', 'Columnar batches'], 'Columnar batches': ['列式批次数', 'Columnar batches'], 'scan time': ['扫描耗时', 'Scan time'], 'metadata time': ['元数据读取耗时', 'Metadata time'], 'time in aggregation build': ['构建聚合耗时', 'Time in aggregation build'], 'time in aggregation': ['聚合耗时', 'Time in aggregation'], 'aggregation time': ['聚合耗时', 'Aggregation time'], 'records read': ['读取记录数', 'Records read'], 'number of records read': ['读取记录数', 'Number of records read'], 'local blocks read': ['本地读取块数', 'Local blocks read'], 'remote blocks read': ['远程读取块数', 'Remote blocks read'], 'remote bytes read to disk': ['远程读取至磁盘的字节数', 'Remote bytes read to disk'], 'data read': ['读取数据量', 'Data read'], 'number of dynamic part': ['动态分区数', 'Number of dynamic partitions'], 'number of output rows': ['输出行数', 'Number of output rows'], numOutputRows: ['输出行数', 'Number of output rows'], 'number of files read': ['读取文件数', 'Number of files read'], 'number of files': ['文件数', 'Number of files'], 'size of files read': ['读取文件大小', 'Size of files read'], 'size of files': ['文件大小', 'Size of files'], 'data size': ['数据大小', 'Data size'], 'spill size': ['溢写大小', 'Spill size'], duration: ['耗时', 'Duration'], 'time to collect': ['收集耗时', 'Time to collect'], 'time to broadcast': ['广播耗时', 'Time to broadcast'], 'number of partitions': ['分区数', 'Number of partitions'], 'peak memory': ['峰值内存', 'Peak memory'], 'sort time': ['排序耗时', 'Sort time'], 'shuffle bytes written': ['Shuffle 写入字节数', 'Shuffle bytes written'], 'shuffle records written': ['Shuffle 写入记录数', 'Shuffle records written'], 'shuffle write time': ['Shuffle 写入耗时', 'Shuffle write time'], 'remote bytes read': ['远程读取字节数', 'Remote bytes read'], 'local bytes read': ['本地读取字节数', 'Local bytes read'], 'fetch wait time': ['拉取等待耗时', 'Fetch wait time'], 'number of rows': ['行数', 'Number of rows'],
};

export function localizeMetricName(key: string, lang: Lang): string {
  return Object.hasOwn(names, key) ? text(names[key], lang) : key;
}

const countKeys = new Set([
  'tasks', 'numTasks', 'numActiveTasks', 'numCompleteTasks', 'numFailedTasks', 'numKilledTasks',
  'joinOutputRows', 'largestInputRows', 'totalInputRows', 'outputRows', 'activeExecutors', 'removed', 'totalExecutors', 'failedTasks', 'killedTasks', 'files',
  'inputRecords', 'outputRecords', 'shuffleReadRecords', 'shuffleWriteRecords',
  'number of output rows', 'numOutputRows', 'number of files read', 'number of files', 'number of partitions', 'shuffle records written', 'number of rows',
  'number of columnar batches', 'columnar batches', 'Columnar batches', 'records read', 'number of records read', 'local blocks read', 'remote blocks read', 'number of dynamic part',
]);
function parseCount(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return;
  // Strict: never reinterpret IDs, Spark metric summaries, or arbitrary source text.
  const match = value.trim().match(/^([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*([万亿])?$/);
  if (!match) return;
  const number = Number(match[1].replaceAll(',', '')) * (match[2] === '亿' ? 100_000_000 : match[2] === '万' ? 10_000 : 1);
  return Number.isFinite(number) ? number : undefined;
}
function formatCount(value: number, lang: Lang): string {
  if (lang === 'en') return new Intl.NumberFormat('en-US', { maximumFractionDigits: 12 }).format(value);
  const magnitude = Math.abs(value);
  const unit = magnitude >= 100_000_000 ? '亿' : magnitude >= 10_000 ? '万' : '';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 12 }).format(value / (unit === '亿' ? 100_000_000 : unit === '万' ? 10_000 : 1)) + unit;
}

export function localizeEvidenceValue(key: string, value: unknown, lang: Lang): string {
  if (value === undefined || value === null) return missing(lang);
  if (countKeys.has(key)) {
    const count = parseCount(value);
    if (count !== undefined) return formatCount(count, lang);
  }
  if (key === 'status' && typeof value === 'string') {
    const statuses: Record<string, Bilingual> = {
      ACTIVE: ['运行中', 'Active'], RUNNING: ['运行中', 'Running'], COMPLETE: ['已完成', 'Complete'], COMPLETED: ['已完成', 'Completed'], FAILED: ['失败', 'Failed'], PENDING: ['待运行', 'Pending'], SKIPPED: ['已跳过', 'Skipped'], KILLED: ['已终止', 'Killed'], SUCCEEDED: ['成功', 'Succeeded'],
    };
    if (Object.hasOwn(statuses, value)) return text(statuses[value], lang);
  }
  if (value === 'n/a (no shuffle read)') return text(['不适用（无 Shuffle 读取）', 'n/a (no shuffle read)'], lang);
  if (key.startsWith('spark.') && typeof value === 'string') {
    const separator = value.indexOf(' — ');
    if (separator !== -1) return `${value.slice(0, separator)} — ${localizeCause(value.slice(separator + 3), lang)}`;
  }
  if (Array.isArray(value)) return value.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join('; ');
  return typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** Titles are selected by ruleId and structured evidence, never translated by title regex. */
export function localizeAnnotation(a: GraphAnnotation, lang: Lang): { title: string; explanation: string } {
  const e = a.evidence;
  const v = (key: string) => localizeEvidenceValue(key, e[key], lang);
  const stageId = a.target.scope === 'stage' ? a.target.stageId : e.stageId;
  const sqlId = a.target.scope === 'sql' || a.target.scope === 'node' ? a.target.sqlId : e.sqlId;
  const stage = `${lang === 'zh' ? '阶段' : 'Stage'} ${stageId ?? '?'}`;
  const sql = `SQL ${sqlId ?? '?'}`;
  let title: string;
  if (Object.hasOwn(e, 'error')) {
    title = lang === 'zh' ? `规则 ${a.ruleId} 执行失败` : `Rule ${a.ruleId} failed to evaluate`;
    return { title, explanation: sourceText(String(e.error), lang) };
  }
  switch (a.ruleId) {
    case 'STAGE_DOMINANT': title = lang === 'zh' ? `${stage} 占阶段总耗时的 ${v('share')}` : `${stage} takes ${v('share')} of stage time`; break;
    case 'SPILL_HEAVY': title = lang === 'zh' ? `${stage} 内存溢写 ${v('memorySpill')}，磁盘溢写 ${v('diskSpill')}` : `${stage} spilled ${v('memorySpill')} to memory and ${v('diskSpill')} to disk`; break;
    case 'TASK_SKEW': title = lang === 'zh' ? `${stage} 存在任务倾斜：最慢任务耗时为中位数的 ${v('skewFactor')}` : `${stage} is skewed: slowest task is ${v('skewFactor')} the median`; break;
    case 'SHUFFLE_SKEW': title = lang === 'zh' ? `${stage} Shuffle 读取不均：最大分片为中位数的 ${v('skewFactor')}` : `${stage} reads uneven shards: largest is ${v('skewFactor')} the median`; break;
    case 'JOIN_EXPLOSION': title = lang === 'zh' ? `${sql}：${v('operator')} 将 ${v('largestInputRows')} 行输入膨胀为 ${v('joinOutputRows')} 行（${v('fanoutVsLargestInput')}）` : `${sql}: ${v('operator')} turns ${v('largestInputRows')} input rows into ${v('joinOutputRows')} rows (${v('fanoutVsLargestInput')})`; break;
    case 'BNLJ': title = lang === 'zh' ? `${sql} 使用 ${v('operator')} — 二次方级成本` : `${sql} uses ${v('operator')} — quadratic cost`; break;
    case 'SMJ_BROADCASTABLE': {
      const joins = Array.isArray(e.joins) && e.joins.length ? v('joins') : missing(lang);
      title = lang === 'zh' ? `${sql} 使用 ${joins}，对仅 ${v('smallestInput')} 的一侧进行 Shuffle` : `${sql} uses ${joins} and shuffles a side that is only ${v('smallestInput')}`;
      break;
    }
    case 'GC_HEAVY':
      title = Object.hasOwn(e, 'executorGcRatio')
        ? lang === 'zh' ? `Executor 将 ${v('executorGcRatio')} 的时间用于 GC` : `Executors spend ${v('executorGcRatio')} of their time in GC`
        : lang === 'zh' ? `${stage}：任务 GC 耗时占比中位数为 ${v('gcRatio')}` : `${stage}: median task spends ${v('gcRatio')} of its time in GC`;
      break;
    case 'EXECUTOR_LOST': title = lang === 'zh' ? `${v('removed')} 个 Executor 在压力下被移除` : `${v('removed')} executor(s) removed under pressure`; break;
    case 'TASK_FAILURES': title = lang === 'zh' ? `${stage} 有 ${v('failedTasks')} 个任务失败` : `${stage} failed ${v('failedTasks')} task(s)`; break;
    case 'SMALL_FILES': title = lang === 'zh' ? `${sql}：${v('files')} 个文件，平均大小 ${v('averageFileSize')}` : `${sql}: ${v('files')} files averaging ${v('averageFileSize')}`; break;
    case 'CONF_CHECK': {
      const count = formatCount(Object.keys(e).filter((key) => key.startsWith('spark.')).length, lang);
      title = lang === 'zh' ? `${count} 项配置值得重新评估` : `${count} configuration item(s) worth revisiting`;
      break;
    }
    default: return { title: sourceText(a.title, lang), explanation: a.explanation ? sourceText(a.explanation, lang) : '' };
  }
  return { title, explanation: a.explanation.split('; ').filter(Boolean).map((cause) => localizeCause(cause, lang)).join(lang === 'zh' ? '；' : '; ') };
}

const warnings: Record<string, Bilingual> = {
  'Rule facts inspect up to 5 SQL executions and task quantiles for up to 6 stages; unannotated nodes are not a health guarantee.': [
    '规则事实最多检查 5 个 SQL 执行记录和 6 个阶段的任务分位数；未标注节点不代表一定健康。',
    'Rule facts inspect up to 5 SQL executions and task quantiles for up to 6 stages; unannotated nodes are not a health guarantee.',
  ],
  'JOIN_EXPLOSION estimates input rows from existing rule node-order heuristics; annotations are suspected causes, not verified causal topology.': [
    'JOIN_EXPLOSION 使用现有规则的节点顺序启发式估算输入行数；标注是疑似原因，不是已验证的因果拓扑。',
    'JOIN_EXPLOSION estimates input rows from existing rule node-order heuristics; annotations are suspected causes, not verified causal topology.',
  ],
  'session not found': ['会话不存在', 'session not found'],
  'appId is required: no application recorded for this session': ['需要 appId：此会话没有已记录的应用', 'appId is required: no application recorded for this session'],
  'appId is required: session has multiple applications': ['需要 appId：此会话包含多个应用', 'appId is required: session has multiple applications'],
  'graph snapshot not found; capture it with POST': ['图快照不存在；请采集快照', 'graph snapshot not found; capture it with POST'],
  'graph snapshot could not be read': ['无法读取图快照', 'graph snapshot could not be read'],
  'closed sessions cannot create or refresh graphs': ['已归档会话不能创建或刷新图快照', 'closed sessions cannot create or refresh graphs'],
};

export function localizeGraphWarning(raw: string, lang: Lang): string {
  if (Object.hasOwn(warnings, raw)) return text(warnings[raw], lang);
  const match = raw.match(/^SQL (\d+): (.*)$/s);
  if (match) {
    const sql = `SQL ${match[1]}`;
    const messages: Record<string, Bilingual> = {
      'graph topology unavailable': ['图拓扑不可用', 'graph topology unavailable'],
      'nodes without source IDs omitted': ['已省略缺少来源 ID 的节点', 'nodes without source IDs omitted'],
      'source edges reference missing nodes; endpoints retained without invented nodes': ['来源边引用了缺失节点；保留端点，但不会虚构节点', 'source edges reference missing nodes; endpoints retained without invented nodes'],
    };
    if (Object.hasOwn(messages, match[2])) return `${sql}: ${text(messages[match[2]], lang)}`;
    const detail = match[2].match(/^detail unavailable \((.*)\)$/s);
    if (detail) return `${sql}: ${text(['详情不可用', 'detail unavailable'], lang)} (${sourceText(detail[1], lang)})`;
  }
  if (raw.startsWith('graph capture failed: ')) return `${text(['图采集失败', 'graph capture failed'], lang)}: ${localizeGraphWarning(raw.slice('graph capture failed: '.length), lang)}`;
  return sourceText(raw, lang);
}
