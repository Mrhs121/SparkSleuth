import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Lang = 'zh' | 'en';

const STORAGE_KEY = 'sparksleuth_lang';

export const translations = {
  zh: {
    graphHighlightedFindings: '规则发现 · 点击定位',
    tabGraph: '诊断图', graphApplication: '应用', graphSessionApplication: '会话应用',
    graphLoading: '读取图快照…', graphRefresh: '采集 / 刷新', graphReload: '重新读取',
    graphReadOnly: '已归档会话：仅浏览已保存快照，不采集或发送追问。',
    graphMissing: '尚无已保存的图快照。', graphLoadError: '图快照加载失败', graphWrongApp: '快照与选定应用不匹配',
    graphRetained: '保留上次成功读取的快照，以下数据可能不是最新。',
    graphNoSnapshot: '尚无诊断图', graphNoSnapshotHint: '需要真实 History Server 图数据；缺失时不会生成或推测执行图。',
    graphCaptured: '采集时间', graphSource: '数据来源 · History Server', graphSqlView: 'SQL 执行图', graphStageView: 'Stage 指标',
    graphExecution: 'SQL execution', graphNoSql: '无 SQL execution', graphRootCause: '疑似根因', graphSymptom: '症状 / 资源压力', graphObservation: '观察',
    graphSqlTrust: '仅显示接口返回的真实节点和有向边，不推断因果传播或 Stage 映射。',
    graphStageTrust: '展示实际 Stage attempt 指标；仅明确且唯一的父 Stage 引用画边，不代表完整 DAG。',
    graphTargetMissing: '该明确 ID 不在当前快照中，请手动选择；不会猜测节点。', graphAttemptAmbiguous: '此 Stage 包含多个 attempt，请手动选择。',
    graphMissingEndpoints: '存在未返回的边端点；相关边未绘制。', graphStageParentsMissing: '部分父 Stage 缺失或 attempt 不唯一，未绘制对应边。',
    graphMissingTopology: '此 SQL 未返回完整图拓扑。', graphNoSqlNodes: '当前 execution 未返回真实 SQL 图节点。', graphNoStages: '尚无 Stage attempt 指标。',
    graphMetrics: '执行指标', graphNoMetrics: '接口未提供节点指标。', graphRawMetrics: '原始指标与归一化值', graphRuleEvidence: '规则与证据',
    graphNoRules: '未命中规则；不代表绝对健康。', graphNoRulesShort: '未命中规则', graphEvidence: '证据',
    graphFollowUpIntro: '请基于以下准确对象标识与证据继续诊断，区分疑似根因、症状和观察，不推测未证实的映射。',
    graphFollowUp: '填入追问', graphConfirmSend: '仅填入聊天输入框，请审阅证据后自行确认发送。',
    graphSelectNode: '选择节点查看原始指标、确定性规则与证据。', graphScopeFindings: '应用 / SQL 级发现（未绑定算子）',
    graphPanHint: '拖拽平移 · 滚轮缩放', graphZoomOut: '缩小', graphZoomIn: '放大', graphFit: '适配',
    graphCanvasLabel: '真实执行证据图，可选择节点', graphViewInGraph: '在图中查看',
    // Brand & Common
    brandName: 'SparkSleuth',
    brandSub: '性能诊断专家',
    langToggle: 'EN',
    langTitle: '切换为英文 / Switch to English',
    newInvestigation: '新建诊断',
    pastInvestigations: '历史诊断会话',
    noInvestigations: '暂无历史诊断记录',
    memory: '知识沉淀',
    settings: '系统设置',
    historyServerConnected: 'History Server 已连接',
    historyServerOffline: 'History Server 离线',
    modelKeyMissing: '模型 Key 未配置',
    edit: '配置',
    keyHint: '⌘N',
    cancel: '取消',
    save: '保存',
    copy: '复制',
    copied: '已复制',
    hide: '收起',
    details: '详情',

    // Status
    status_created: '新建',
    status_running: '诊断中',
    status_waiting: '等待追问',
    status_finalizing: '归档中',
    status_closed: '已归档',
    status_failed: '诊断异常',
    status_cancelled: '已停止',

    // Hero Launcher
    heroTag: '智能诊断专家',
    heroTitle: 'Spark 性能与根因诊断',
    heroSubtitle:
      '针对 Apache Spark 任务的自动化根因分析。交叉审查执行指标、分区分布与 SQL 物理执行计划。',
    targetApp: '目标 Spark 应用',
    refreshApps: '刷新应用列表',
    configure: '配置连接',
    diagnosticPlaybooks: '诊断策略与场景',
    startInvestigation: '发起诊断',
    shortcutHintHero: '↵ 发起诊断 · ⇧↵ 换行',
    missingKeyBanner: '大模型 API Key 尚未配置，点击此处前往「系统设置」配置。',

    // Playbooks
    pb_skew_title: '倾斜与溢写分析',
    pb_skew_desc: '检测长尾任务、数据倾斜的 Partition 键及内存向磁盘的溢写。',
    pb_skew_query: '深度分析此任务是否存在数据倾斜、长尾任务以及内存向磁盘溢写的问题。',

    pb_bottleneck_title: '耗时瓶颈与阶段延迟',
    pb_bottleneck_desc: '排查耗时最长的 Dominant Stage、调度延迟及执行器资源瓶颈。',
    pb_bottleneck_query: '分析各阶段中耗时最长的是哪个 Stage？耗时主要消耗在计算还是调度上？',

    pb_memory_title: '执行器内存与 GC 压力',
    pb_memory_desc: '检查垃圾回收 GC 耗时占比、堆内存占用以及 OOM 潜在风险。',
    pb_memory_query: '排查各执行器的堆内存压力、GC 停顿占比以及是否有 Executor 退出事件。',

    pb_plan_title: '物理计划与 Join 优化',
    pb_plan_desc: '审查 SMJ 与广播 Join 策略、AQE 自适应规则及笛卡尔积隐患。',
    pb_plan_query: '详细检查该作业的 SQL 物理执行计划，排查 Join 算子选择及 AQE 自适应执行情况。',

    // AppSelect
    selectPlaceholder: '从 Spark History Server 选择目标应用 (或直接输入问题)...',
    searchPlaceholder: '按 App ID、作业名称或提交人搜索...',
    appsCount: (filtered: number, total: number) => `显示 ${filtered} / ${total} 个应用`,
    clearTargetApp: '清除已选目标应用',
    noAppsFound: '未找到符合条件的应用',
    noAppsAvailable: 'History Server 未返回任何应用',
    completed: '已完成',
    runningState: '运行中',
    byUser: (user: string) => `提交人: ${user}`,

    // Topbar & Stream
    stopInvestigation: '停止诊断',
    closeAndRemember: '结案并归档记忆',
    archiving: '归档中…',
    archivedBadge: '已结案并沉淀至知识库',
    emptyInitTitle: '诊断会话已就绪',
    emptyInitDesc:
      '正在从 Spark History Server 获取应用元数据与初始指标。阶段分析、倾斜检测与执行计划将实时在此呈现。',
    analyzingSpinner: '正在研判证据链、执行计划与任务分位数指标…',
    reasoningTrace: '推理链与思考过程',
    linesCount: (n: number) => `${n} 行`,
    executingTools: (n: number) => `正在执行 ${n} 个诊断工具…`,
    completedTools: (n: number) => `已完成 ${n} 个诊断工具调用`,
    callsCount: (n: number) => `${n} 次调用`,
    inputParams: '入参详情',
    execSummary: '执行摘要',
    savedArtifact: '已保存产物:',
    settingsTooltip: '系统配置',
    composerPlaceholderApp: (appId: string) => `已选择 ${appId}。描述异常现象或直接回车发起全链路自动诊断… (↵ 发送，⇧↵ 换行)`,
    composerPlaceholderGeneral: '描述 Spark 异常现象，或直接输入 Spark 调优/原理问题… (↵ 发送，⇧↵ 换行)',
    composerSessionPlaceholder: '输入跟进追问或指定分析指标/Stage编号… (↵ 发送，⇧↵ 换行)',
    composerDisabledPlaceholder: '当前诊断已结案归档。请点击左上方「新建诊断」发起新会话。',
    send: '发送',
    investigating: '诊断中...',
    shortcutHintChat: '↵ 发送 · ⇧↵ 换行',

    // Inspector
    tabTimeline: '阶段推导',
    tabReport: '诊断报告',
    tabTokens: 'Token 消耗',
    noFindings: '诊断过程中发现的阶段瓶颈与里程碑结论将在此按序呈现。',
    noReport: '暂未生成总结报告。诊断得出最终结论后将自动撰写报告。',
    copyReport: '复制报告',
    copiedReport: '已复制',
    tokenConsumption: 'Token 消耗明细',
    promptTokens: '输入 (Prompt)',
    completionTokens: '输出 (Completion)',
    totalTokens: '总消耗 Tokens',
    resizerTooltip: '按住拖拽调整面板宽度 (双击恢复默认 420px)',

    contentLoading: '正在加载内容…',
    contentLoadError: '内容加载失败；如有已加载内容，将继续保留。',
    contentRetry: '重试加载',
    memoryActionError: '知识库操作失败',

    // Memory View
    memoryTitle: '诊断知识库与经验沉淀',
    memorySubtitle: '历史诊断案例归档与经过实战检验的永久规则库。',
    runDream: '执行 Auto-Dream 提炼',
    reflecting: '正在提炼中…',
    backToChat: '返回对话',
    pastCases: '历史案例档案',
    searchCasesPlaceholder: '搜索关键词、症状标签或应用 ID…',
    noCasesMatched: '没有匹配的诊断案例。',
    tabLearnings: '规则提炼与待审议建议',
    tabDoc: '诊断报告与过程记录',
    backToLearningsBtn: '← 返回规则与提炼建议',
    candidateTitle: '待审议规则提案',
    noCandidates: '当前没有待审议的规则提炼建议。',
    approveRule: '批准为常驻规则',
    rejectRule: '忽略',
    approvedTitle: '已生效的常驻经验规则',
    noApprovedRules: '暂无已生效规则。请在上方审议并批准模型提炼出的规则建议。',

    // Settings Modal
    settingsTitle: '系统配置',
    settingsSubtitle: '管理 Spark History Server 连接、大模型网关与系统鉴权',
    tabHs: 'Spark 历史服务器',
    tabLlm: '大模型网关',
    tabAuth: '安全与鉴权',
    hsUrlLabel: 'History Server Endpoint 地址',
    testConnection: '测试连接',
    testing: '测试中...',
    hsConnected: '连接成功',
    hsFailed: '连接失败',
    sparkVersion: 'Spark 版本:',
    appsIndexed: '已索引应用数:',
    commonDefaults: '常用预设:',
    llmBaseUrlLabel: '模型网关 Base URL',
    apiKeyLabel: 'API Key',
    keyConfigured: '服务器已配置 Key',
    showKey: '显示',
    hideKey: '隐藏',
    modelIdLabel: '模型标识 (Model Identifier)',
    maxTokensLabel: '最大补全 Token 数 (Max Tokens)',
    quickSelectModel: '常用模型推荐:',
    testModelBtn: '测试模型网关连通性',
    testingModel: '测试网关中...',
    modelConnected: '模型响应正常',
    modelFailed: '模型测试失败',
    modelReply: '模型回复:',
    authTokenLabel: '服务器访问令牌 (SPARKSLEUTH_TOKEN)',
    authTokenHelp:
      '当服务端配置了访问令牌时在此输入。本地开发或仅监听 127.0.0.1 时可留空。',
    saveAndApply: '保存并应用',
    applying: '正在应用...',
    configSaved: '配置已保存并生效。',
  },

  en: {
    graphHighlightedFindings: 'Rule findings · select to locate',
    tabGraph: 'Graph', graphApplication: 'Application', graphSessionApplication: 'Session application',
    graphLoading: 'Loading snapshot…', graphRefresh: 'Capture / refresh', graphReload: 'Reload snapshot',
    graphReadOnly: 'Archived session: saved snapshots only; capture and follow-ups are disabled.',
    graphMissing: 'No saved graph snapshot is available.', graphLoadError: 'Graph snapshot failed', graphWrongApp: 'Snapshot does not match the selected application',
    graphRetained: 'Keeping the last successful snapshot; the data below may be stale.',
    graphNoSnapshot: 'No diagnostic graph yet', graphNoSnapshotHint: 'Real History Server graph data is required. Missing topology is never invented.',
    graphCaptured: 'Captured', graphSource: 'Source · History Server', graphSqlView: 'SQL execution', graphStageView: 'Stage metrics',
    graphExecution: 'SQL execution', graphNoSql: 'No SQL executions', graphRootCause: 'Suspected root cause', graphSymptom: 'Symptom / pressure', graphObservation: 'Observation',
    graphSqlTrust: 'Only authentic nodes and directed edges. No inferred causal paths or Stage mappings.',
    graphStageTrust: 'Actual Stage attempt metrics. Edges require explicit, uniquely resolved parents; this is not a complete DAG.',
    graphTargetMissing: 'This explicit ID is missing from the snapshot. Select manually; no node is guessed.', graphAttemptAmbiguous: 'Multiple attempts match this Stage. Select an attempt manually.',
    graphMissingEndpoints: 'Some edge endpoints were not returned; those edges are not drawn.', graphStageParentsMissing: 'Some parents are missing or have ambiguous attempts; corresponding edges are not drawn.',
    graphMissingTopology: 'This SQL execution did not return complete graph topology.', graphNoSqlNodes: 'No authentic SQL graph nodes for this execution.', graphNoStages: 'No Stage attempt metrics available.',
    graphMetrics: 'Execution metrics', graphNoMetrics: 'No metrics supplied for this node.', graphRawMetrics: 'Raw and normalized metrics', graphRuleEvidence: 'Rules and evidence',
    graphNoRules: 'No rules triggered; this does not guarantee health.', graphNoRulesShort: 'No rules triggered', graphEvidence: 'Evidence',
    graphFollowUpIntro: 'Continue diagnosis using these exact identifiers and evidence. Distinguish suspected root causes, symptoms and observations; do not invent unverified mappings.',
    graphFollowUp: 'Prepare follow-up', graphConfirmSend: 'Draft only. Review the evidence in the composer and confirm sending yourself.',
    graphSelectNode: 'Select a node to inspect metrics, deterministic rules and evidence.', graphScopeFindings: 'Application / SQL findings (not bound to operators)',
    graphPanHint: 'Drag to pan · scroll to zoom', graphZoomOut: 'Zoom out', graphZoomIn: 'Zoom in', graphFit: 'Fit',
    graphCanvasLabel: 'Authentic execution evidence graph with selectable nodes', graphViewInGraph: 'View in graph',
    // Brand & Common
    brandName: 'SparkSleuth',
    brandSub: 'Performance & Diagnostics',
    langToggle: '中文',
    langTitle: 'Switch to Chinese / 切换为中文',
    newInvestigation: 'New Investigation',
    pastInvestigations: 'Past Investigations',
    noInvestigations: 'No investigations yet.',
    memory: 'Memory',
    settings: 'Settings',
    historyServerConnected: 'History Server Live',
    historyServerOffline: 'History Server Offline',
    modelKeyMissing: 'Model API key missing',
    edit: 'Edit',
    keyHint: '⌘N',
    cancel: 'Cancel',
    save: 'Save',
    copy: 'Copy',
    copied: 'Copied',
    hide: 'Hide',
    details: 'Details',

    // Status
    status_created: 'New',
    status_running: 'Analyzing',
    status_waiting: 'Awaiting User',
    status_finalizing: 'Summarising',
    status_closed: 'Archived',
    status_failed: 'Failed',
    status_cancelled: 'Stopped',

    // Hero Launcher
    heroTag: 'Diagnostic Copilot',
    heroTitle: 'Spark Performance & Diagnostics',
    heroSubtitle:
      'Autonomous root-cause analysis for Apache Spark applications. Cross-examines execution metrics, partition distributions, and SQL physical plans.',
    targetApp: 'Target Spark Application',
    refreshApps: 'Refresh application list',
    configure: 'Configure',
    diagnosticPlaybooks: 'Diagnostic Playbooks',
    startInvestigation: 'Start Investigation',
    shortcutHintHero: '↵ Start investigation · ⇧↵ New line',
    missingKeyBanner: 'LLM API key is not configured. Click here to configure your model gateway in Settings.',

    // Playbooks
    pb_skew_title: 'Skew & Spill Analysis',
    pb_skew_desc: 'Detect long-tail tasks, skewed partition keys, and memory spill to disk.',
    pb_skew_query: 'Analyze this job for data skew, task duration stragglers, and memory spill.',

    pb_bottleneck_title: 'Bottleneck & Stage Latency',
    pb_bottleneck_desc: 'Trace dominant stages, scheduling delays, and executor distribution.',
    pb_bottleneck_query: 'What stages are consuming the most wall-clock time and where is the critical path bottleneck?',

    pb_memory_title: 'Executor Memory & GC',
    pb_memory_desc: 'Inspect GC pause ratios, executor heap pressure, and loss events.',
    pb_memory_query: 'Check executor memory metrics, garbage collection pause overhead, and OOM indicators.',

    pb_plan_title: 'Physical Plan & Join Optimization',
    pb_plan_desc: 'Audit SortMergeJoin vs BroadcastHashJoin, AQE, and Cartesian products.',
    pb_plan_query: 'Examine the SQL physical execution plan, join types, and opportunities for broadcast joins.',

    // AppSelect
    selectPlaceholder: 'Select an application from Spark History Server (or ask general query)...',
    searchPlaceholder: 'Search by app ID, job name, or user...',
    appsCount: (filtered: number, total: number) => `${filtered} of ${total} applications`,
    clearTargetApp: 'Clear target app',
    noAppsFound: 'No applications match your search query.',
    noAppsAvailable: 'No applications available from History Server.',
    completed: 'COMPLETED',
    runningState: 'RUNNING',
    byUser: (user: string) => `by ${user}`,

    // Topbar & Stream
    stopInvestigation: 'Stop Investigation',
    closeAndRemember: 'Close & Remember',
    archiving: 'Archiving…',
    archivedBadge: 'Archived in memory',
    emptyInitTitle: 'Investigation Initialized',
    emptyInitDesc:
      'Gathering initial facts and metrics from the Spark History Server. Task metrics, stage skew, and physical plans will appear in this feed.',
    analyzingSpinner: 'Analyzing evidence, query plans and task distributions…',
    reasoningTrace: 'Reasoning Trace',
    linesCount: (n: number) => `${n} lines`,
    executingTools: (n: number) => `Executing ${n} diagnostic tools…`,
    completedTools: (n: number) => `Completed ${n} diagnostic tools`,
    callsCount: (n: number) => `${n} calls`,
    inputParams: 'Input Parameters',
    execSummary: 'Execution Summary',
    savedArtifact: 'Saved Artifact:',
    settingsTooltip: 'System Settings',
    composerPlaceholderApp: (appId: string) => `Targeting ${appId}. Describe symptoms or press Enter to launch full diagnostic… (↵ to send, ⇧↵ for newline)`,
    composerPlaceholderGeneral: 'Describe symptoms or ask a general Spark question… (↵ to send, ⇧↵ for newline)',
    composerSessionPlaceholder: 'Ask a follow-up question or specify a stage/metric to inspect… (↵ to send, ⇧↵ for newline)',
    composerDisabledPlaceholder: 'This investigation is concluded and archived. Start a new investigation to continue.',
    send: 'Send',
    investigating: 'Investigating...',
    shortcutHintChat: '↵ Send · ⇧↵ New line',

    // Inspector
    tabTimeline: 'Timeline',
    tabReport: 'Report',
    tabTokens: 'Tokens',
    noFindings: 'Milestones and stage findings will appear here during diagnosis.',
    noReport: 'No diagnostic report generated yet. The assistant writes one when concluding.',
    copyReport: 'Copy',
    copiedReport: 'Copied',
    tokenConsumption: 'Token Consumption',
    promptTokens: 'Prompt (Input)',
    completionTokens: 'Completion (Output)',
    totalTokens: 'Total Tokens',
    resizerTooltip: 'Drag to resize inspector width (double-click to reset 420px)',

    contentLoading: 'Loading content…',
    contentLoadError: 'Content could not be loaded. Previously loaded content is retained when available.',
    contentRetry: 'Retry loading',
    memoryActionError: 'Memory operation failed',

    // Memory View
    memoryTitle: 'Institutional Memory',
    memorySubtitle: 'Past diagnostic learnings and verified engineering rules.',
    runDream: 'Run Auto-Dream',
    reflecting: 'Reflecting…',
    backToChat: 'Back to Chat',
    pastCases: 'Past Investigations',
    searchCasesPlaceholder: 'Search keywords, symptoms, tags…',
    noCasesMatched: 'No past cases matched.',
    tabLearnings: 'Learnings & Candidate Rules',
    tabDoc: 'Investigation Document',
    backToLearningsBtn: '← Back to Rules & Proposals',
    candidateTitle: 'Candidate Rule Proposals',
    noCandidates: 'No lesson proposals awaiting review.',
    approveRule: 'Approve as Rule',
    rejectRule: 'Reject',
    approvedTitle: 'Approved Permanent Rules',
    noApprovedRules: 'None yet. Approve candidate proposals to promote them.',

    // Settings Modal
    settingsTitle: 'System Settings',
    settingsSubtitle: 'Manage Spark History Server connection, LLM gateway, and security',
    tabHs: 'Spark History Server',
    tabLlm: 'LLM Gateway',
    tabAuth: 'Security & Auth',
    hsUrlLabel: 'History Server Endpoint URL',
    testConnection: 'Test Connection',
    testing: 'Testing...',
    hsConnected: 'Connected',
    hsFailed: 'Connection Failed',
    sparkVersion: 'Spark Version:',
    appsIndexed: 'Applications Indexed:',
    commonDefaults: 'Common Defaults:',
    llmBaseUrlLabel: 'Model Gateway Base URL',
    apiKeyLabel: 'API Key',
    keyConfigured: 'Key configured on server',
    showKey: 'Show',
    hideKey: 'Hide',
    modelIdLabel: 'Model Identifier',
    maxTokensLabel: 'Max Completion Tokens',
    quickSelectModel: 'Quick Select Model:',
    testModelBtn: 'Test Model Connection',
    testingModel: 'Testing Gateway...',
    modelConnected: 'Model Connected',
    modelFailed: 'Model Test Failed',
    modelReply: 'Response:',
    authTokenLabel: 'Server Access Token (SPARKSLEUTH_TOKEN)',
    authTokenHelp:
      'When set, all requests to /api/* and /ws/* require this token. Leave empty to disable authentication (safe when bound to 127.0.0.1).',
    saveAndApply: 'Save & Apply',
    applying: 'Applying...',
    configSaved: 'Configuration saved and applied.',
  },
};

interface I18nContextType {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: typeof translations.zh;
}

const I18nContext = createContext<I18nContextType>({
  lang: 'zh',
  setLang: () => {},
  t: translations.zh,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'en' ? 'en' : 'zh';
  });

  const setLang = (newLang: Lang) => {
    setLangState(newLang);
    localStorage.setItem(STORAGE_KEY, newLang);
  };

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const value = {
    lang,
    setLang,
    t: translations[lang],
  };

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}
