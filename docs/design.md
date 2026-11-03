# SparkSleuth 设计文档

> 版本 v0.2 · 状态：设计评审
> SparkSleuth 是一个面向 Apache Spark 的 AI 诊断助手：给它一个 appId 或一句"这个任务为什么慢"，它会自己沿着证据链往下钻——应用总览、Stage/Task、物理计划、数据分布、参数配置——最后给出一份带证据、可执行的诊断报告。

---

## 1. 定位

Spark 任务变慢、OOM、失败，排查过程有固定套路，但执行起来很费时间：

- 指标分散在 History Server 的多个 API 里，要反复切换页面、肉眼对比；
- 判断 "是不是数据倾斜" 需要同时看 Task 分位数、Shuffle 读写、GC 和物理计划；
- 同样的坑反复踩，经验留在个人脑子里，没有沉淀；
- 资深工程师判断准，但没法规模化。

SparkSleuth 把这些收敛成一个对话式助手：**用规则引擎保证数字准确，用大模型负责串联证据、解释原因、给出改写方案**。

### 1.1 设计原则

1. **证据优先**：任何结论都必须附上工具名和具体指标值，不允许"我觉得"。
2. **规则算数，模型讲理**：Spill 率、倾斜因子、膨胀倍数这类确定性计算由规则引擎完成，模型不心算大数。
3. **上下文经济**：工具返回默认只给摘要（≤4KB），大结果落盘后按需检索，永远不整体塞进上下文。
4. **只读安全**：一期只读 History Server，不执行任何提交、写入、改表操作。
5. **可扩展**：新增一个观测源（YARN、元数据服务、日志平台）只需新增一个 Skill 目录，不改内核。

### 1.2 非目标（一期）

- 不做任务提交、SQL 改写后的自动双跑（二期）；
- 不做多租户、SSO、细粒度权限（一期单机单用户）；
- 不覆盖非 Spark 组件（只预留扩展位）；
- 不追求实时：基于 History Server 的应用事件日志做诊断。

---

## 2. 总体架构

```
┌────────────────────────────────────────────────────────────────────────┐
│ 交互层  React + Vite + TypeScript                                       │
│  会话列表 │ 对话流（工具卡片/思考/文本）│ 诊断阶段面板 │ 报告 │ 记忆审核     │
│                    ▲ WebSocket（流式事件）                               │
├────────────────────┼───────────────────────────────────────────────────┤
│ 控制层  Node.js 20+ (Fastify + ws)                                      │
│  鉴权 │ Session 管理 & 持久化(SQLite) │ 生命周期编排 │ Cron(清理/AutoDream) │
├────────────────────┼───────────────────────────────────────────────────┤
│ Agent 运行时  自研 ReAct 循环（TypeScript）                              │
│  消息组装 │ 工具调度 │ 流式解析 │ 上下文压缩 │ 预算控制 │ 中断与恢复         │
├────────────────────┼───────────────────────────────────────────────────┤
│ 能力层  Skills（进程内注册 / 可外挂 CLI）                                 │
│  spark-history │ spark-diagnose │ session │ memory │ 扩展位…             │
├────────────────────┼───────────────────────────────────────────────────┤
│ 数据源  Spark History Server REST API (只读)                             │
└────────────────────────────────────────────────────────────────────────┘
```

### 2.1 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 交互层 | React 18 + Vite + TypeScript + Ant Design | 组件齐全，工具结果表格和代码块渲染简单 |
| 控制层 | Node.js 20+ / Fastify + ws + better-sqlite3 | 与 Agent 运行时同语言，子进程与流处理顺手；单机部署零依赖 |
| Agent 运行时 | 自研（TypeScript） | 完全可控：可精确控制上下文、工具裁剪、预算与重试；无额外进程开销 |
| 模型接入 | Anthropic Messages 协议（可配网关） | 主流网关（官方、各类中转、私有部署）均兼容；支持流式与 tool_use |
| 存储 | SQLite + 文件系统 | 单机零运维；会话事件、记忆索引入库，报告与原始日志落文件 |
| 前端构建 | Vite | 快 |

---

## 3. 目录结构

```
sparksleuth/
├── README.md
├── LICENSE
├── docs/
│   ├── design.md              # 本文档
│   ├── skills.md              # Skill 开发规范
│   └── rules.md               # 诊断规则说明
├── packages/
│   ├── core/                  # Agent 运行时 + 模型客户端 + Skill 框架
│   │   ├── src/
│   │   │   ├── llm/           # 模型客户端（流式、tool_use、重试）
│   │   │   ├── agent/         # 循环、消息、压缩、预算
│   │   │   ├── skills/        # Skill 注册、渐进披露、工具适配
│   │   │   └── types.ts
│   ├── skills-spark/          # 内置 Spark 能力
│   │   ├── src/history-client.ts
│   │   ├── src/tools/*.ts     # 数据采集工具
│   │   ├── src/rules/*.ts     # 诊断规则
│   │   └── src/skill.ts
│   ├── server/                # 控制层
│   │   ├── src/session/       # 生命周期、编排、事件映射
│   │   ├── src/memory/        # 三层记忆
│   │   ├── src/routes/
│   │   └── src/db.ts
│   └── cli/                   # 命令行入口（无 UI 也能用）
├── web/                       # React 前端
├── testenv/                   # 本地测试环境
│   ├── start-hs.sh
│   ├── jobs/*.py
│   └── run-all.sh
└── data/                      # 运行时数据（gitignore）
```

---

## 4. 会话生命周期

状态机：`created → running ⇄ waiting → finalizing → closed`，任意阶段可进入 `failed` / `cancelled`。

| 阶段 | 动作 |
|---|---|
| **初始化** | 校验入参（appId 格式、History Server 可达性）；创建会话目录 `data/workspaces/<sid>/`，内含 `reports/`、`artifacts/` |
| **装配** | 组装系统提示：方法论、可用工具清单（L1 描述）、History Server 地址、检索到的相关历史记忆摘要 |
| **执行** | 进入 Agent 循环：模型决策 → 工具执行 → 结果回灌，直到产出报告或触达预算上限；全程事件流式推送 |
| **工作区管理** | 大结果写入 `artifacts/`，只回传摘要和引用路径；定时清理过期产物 |
| **收尾** | 生成会话摘要（Index + Document）、归档完整事件日志、可选触发经验提炼 |

---

## 5. Agent 运行时

### 5.1 循环

```
messages = [system, user]
loop (maxSteps):
    resp = llm.stream(messages, tools)
    增量推送 text / thinking
    if resp.stop_reason == "tool_use":
        for each tool_call:
            result = execute(tool_call)          # 统一超时、错误包装、结果截断
            emit tool_result
        messages += assistant(resp.content) + user(tool_results)
        continue
    else:
        break
```

要点：

- **工具结果截断**：单条结果超过 `maxToolResultChars`（默认 6000 字符）自动落盘，回灌"摘要 + 文件路径 + 检索提示"。
- **错误不中断**：工具异常转成结构化错误结果回灌，让模型自己决定换参数重试还是换路径。
- **并行工具调用**：同一轮多个 tool_use 并发执行（默认并发度 4），按序回灌。
- **中断**：`AbortController` 贯穿模型请求与工具执行，用户停止时立即取消。
- **恢复**：每轮事件持久化，控制层重启后可从最后一条 assistant 消息续跑。

### 5.2 上下文管理

| 策略 | 说明 |
|---|---|
| 工具结果分级 | 摘要进上下文，全量进文件。检索工具 `artifact_query` 支持 jq 表达式、排序取 Top-N、关键字过滤 |
| 历史裁剪 | 超过 `contextBudget`（默认 120K tokens）时，把最早的若干轮工具交互压缩成一段"已完成的调查"摘要，保留首条用户消息和最近 N 轮 |
| 计划外置 | 长任务用 `todo_write` 工具维护计划，压缩时计划不丢 |

### 5.3 预算控制

单会话上限：最大步数（默认 40）、总 token 预算、墙钟超时（默认 20 分钟）。触达任一上限时，强制让模型基于现有证据产出报告，并在报告中标注"因预算限制未完成的检查项"。

---

## 6. 模型接入

通过环境变量配置，不绑定任何具体厂商：

```bash
SPARKSLEUTH_LLM_BASE_URL=https://api.anthropic.com     # 任意 Anthropic 兼容网关
SPARKSLEUTH_LLM_API_KEY=sk-...
SPARKSLEUTH_LLM_MODEL=claude-sonnet-4-5
SPARKSLEUTH_LLM_MAX_TOKENS=8192
SPARKSLEUTH_LLM_TIMEOUT_MS=300000
```

- 协议：`POST {base_url}/v1/messages`，`stream: true`，支持 `tools` / `tool_use` / `tool_result`。
- 流式解析：按 SSE 事件累积 `content_block_delta`，拼装文本、思考块与工具入参 JSON。
- 重试：429 / 5xx 指数退避（最多 3 次），网络中断自动续；流式过程中断则重发该轮。
- 成本统计：每轮记录 input/output token，会话级汇总展示。

---

## 7. 能力层：Skill

### 7.1 渐进披露

| 级别 | 载体 | 何时进入上下文 |
|---|---|---|
| **L1** | Skill 名称 + 一句话描述 + 参数摘要 | 常驻，只让模型知道"何时该用" |
| **L2** | Skill 详细说明（边界、流程、风险、常见参数） | 模型调用 `skill_load` 后进入 |
| **L3** | 工具参数 schema 全量 | 参数不确定时按域加载 |
| **L4** | 工具结果全量 | 永不整体进上下文，落盘后局部检索 |

相比"所有工具 schema 常驻"，这套机制把常驻开销从数万 token 压到千级，也让新增 Skill 不污染其他场景。

### 7.2 内置 Skill

#### `spark-history`：数据采集

对接 History Server REST API，只读。

| 工具 | 说明 |
|---|---|
| `apps_list` | 列出应用（状态、耗时、名称），用于让用户挑 appId |
| `app_summary` | 应用总览：状态、耗时、Job/Stage 数、失败数、最慢 Stage Top5、Executor 存活情况、Spill/Shuffle/GC 汇总、关键配置 |
| `stage_list` | Stage 列表，可按耗时/Spill/Shuffle 排序 |
| `stage_detail` | 单个 Stage 的 Task 分位数（耗时、GC、Shuffle Read/Write、Spill、记录数）、倾斜因子、失败 Task |
| `task_list` | Task 明细，支持排序取 Top-N（大结果落盘） |
| `executor_list` | Executor 存活/移除、移除原因聚合、内存与 GC 比例、失败 Task 数 |
| `sql_list` / `sql_detail` | SQL 列表；单条 SQL 的物理计划树（Join 类型、输出行数、Exchange、扫描文件数与大小） |
| `job_list` | Job 列表 |
| `config_get` | 应用生效配置（可按前缀过滤） |
| `error_aggregation` | 失败 Task / Stage / Executor 的错误签名聚类（归一化数字与 ID） |
| `artifact_query` | 对已落盘的大结果做局部检索 |

#### `spark-diagnose`：规则诊断

| 工具 | 说明 |
|---|---|
| `diagnose_app` | 跑全套规则，返回按严重度排序的发现列表 |
| `rule_list` | 列出所有规则及阈值，便于用户理解判定标准 |

规则输出统一结构：

```json
{
  "ruleId": "SPILL_HEAVY",
  "severity": "P0",
  "stageId": 5,
  "title": "Stage 5 发生 13.6 TB 内存 Spill",
  "evidence": {"memorySpillBytes": 14953358137753, "spillRatio": 3.2, "p50TaskSpill": "41.9 GB"},
  "possibleCauses": ["Join 后数据膨胀", "分区数过少"],
  "suggestions": ["Join 前预聚合", "提升 shuffle 分区数"]
}
```

#### `session`：会话控制

| 工具 | 作用 |
|---|---|
| `mark_purpose` | 会话定性（诊断类型、目标 appId、问题描述），前端据此更新标题与标签 |
| `report_finding` | 上报阶段性发现（阶段名、使用的工具、结论），驱动右侧"诊断阶段"面板 |
| `save_report` | 保存最终 Markdown 报告 |

#### `memory`：记忆检索

| 工具 | 作用 |
|---|---|
| `memory_search` | 检索历史会话索引（关键词 + 标签 + 时间范围） |
| `memory_get` | 读取某次会话的总结文档 |
| `experience_list` | 读取已人工审核的永久经验 |

### 7.3 扩展新 Skill

新增 `packages/skills-<name>/`，实现 `Skill` 接口（`name / description / tools / loadDetail / execute`），在配置中注册即可。HTTP 类观测源建议复用 `packages/core` 的 `httpJson`（超时、重试、限流、脱敏）与 `artifactStore`（大结果落盘）。详见 `docs/skills.md`。

---

## 8. 诊断知识

### 8.1 证据下钻路径

任何诊断都按五层推进，每一层都有明确的"看什么"和"判定标准"：

1. **应用总览**：错误、最慢 Stage、异常 Executor、SQL 数量 → 找到可疑 Stage
2. **Stage / Task**：分位数、长尾因子、Shuffle、GC、Spill → 判断是倾斜、膨胀还是资源不足
3. **物理计划**：Join 形状、扫描、聚合、Exchange → 定位到具体算子
4. **数据与元数据**：表类型、分区、key 分布、真实基数 → 解释"为什么会这样"
5. **改动与验证**：SQL / 参数 / 质量校验 / A-B 对比 → 给出可执行方案

### 8.2 内置规则

阈值全部可在配置中覆盖。

| 规则 | 判定 | 严重度 |
|---|---|---|
| `STAGE_DOMINANT` | 单 Stage 耗时占比 > 50% | P1 |
| `SPILL_HEAVY` | Spill/ShuffleRead > 1 或磁盘 Spill > 1GB | P0 |
| `TASK_SKEW` | Task 耗时 max/p50 > 5 且 max > 60s | P0 |
| `SHUFFLE_SKEW` | Shuffle Read max/p50 > 5 | P1 |
| `JOIN_EXPLOSION` | 计划中 Join 输出行数 / 最大输入行数 > 10 | P0 |
| `BNLJ` | 出现 BroadcastNestedLoopJoin / CartesianProduct | P1 |
| `SMJ_BROADCASTABLE` | SMJ 一侧小于广播阈值 10 倍且 key 含函数 | P2 |
| `GC_HEAVY` | GC 时间 / Task 时间 > 10% | P1 |
| `EXECUTOR_LOST` | 大量 Executor 被移除（OOM/驱逐/动态分配） | P1 |
| `TASK_FAILURES` | 存在失败 Task/Stage 重试 | P0 |
| `SMALL_FILES` | 扫描文件数多且平均文件 < 16MB | P2 |
| `CONF_CHECK` | AQE 关闭、skewJoin 关闭等配置风险 | P2 |

规则只负责"发现与量化"。**为什么会膨胀**（业务 key 不唯一）、**怎么改 SQL**（Top-N 截断、预聚合、去重）由模型结合 SQL 文本与物理计划推理，并给出可读的改写建议。

### 8.3 报告结构

固定六节：概览 / 性能瓶颈分析 / 根因 / 优化建议（P0–P2，含 SQL 与参数）/ 预期收益 / 证据清单。

---

## 9. 记忆系统

### 9.1 三层结构

| 层 | 存储 | 内容 |
|---|---|---|
| **Index** | `data/memory/index.jsonl` + SQLite | 每会话一条：一句话标题、标签（≤50 字）、描述（≤100 字）、appId、命中规则 |
| **Document** | `data/memory/docs/<sid>.md` | 每会话一篇（≤500 行）：背景、结论、问题路径、弯路与误判、可复用经验、证据 |
| **Full-Log** | `data/memory/logs/<sid>.jsonl` | 完整事件流，用于回放与审计 |

### 9.2 两类使用场景

- **辅助结论**：新会话装配时检索 Top-3 相似历史，注入摘要；模型在给最终结论前会主动检索，参考但不盲从。
- **Auto Dream**：每日定时汇总当天会话文档，提炼"新经验候选"，生成待审列表。人工审核（通过 / 编辑 / 驳回）后才写入 `data/memory/permanent/`，之后才会被引用。

> 记忆默认本地存储、不外发；模型调用只发送检索到的摘要片段。

---

## 10. 控制层

### 10.1 REST

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/sessions` | 创建会话并启动 |
| GET | `/api/sessions` | 会话列表 |
| GET | `/api/sessions/:sid` | 会话详情（含事件回放） |
| POST | `/api/sessions/:sid/messages` | 追问 |
| POST | `/api/sessions/:sid/cancel` \| `/finish` | 中断 / 结束并收尾 |
| GET | `/api/sessions/:sid/report` | 获取报告 |
| GET | `/api/apps` | 代理 History Server 的应用列表 |
| GET/POST | `/api/memory/*` | 检索、候选审核 |
| GET | `/api/health` | 健康检查（含 History Server 连通性） |

### 10.2 WebSocket 事件

```ts
type Event =
  | { type: 'status'; status: string }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use'; id: string; skill: string; tool: string; input: unknown }
  | { type: 'tool_result'; id: string; summary: string; isError?: boolean; artifact?: string }
  | { type: 'purpose'; type_; target; desc }
  | { type: 'finding'; stage: string; tools: string[]; finding: string }
  | { type: 'report'; path: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: 'error'; message: string };
```

### 10.3 数据表

`sessions`、`events`、`findings`、`memory_index`、`dream_candidates`、`usage_daily`。

---

## 11. 交互层

三栏布局：

- **左**：会话列表（标题、定性标签、状态）+ 新建会话（可从应用列表选择目标）
- **中**：对话流。文本 Markdown 渲染；工具调用为可折叠卡片（工具名、参数、结果摘要）；底部输入框支持追问与停止
- **右**：四个页签 —— 诊断阶段时间线 / 报告 / 中间产物 / Token 用量

独立页面：记忆中心（索引检索、文档查看、候选审核）。

---

## 12. 安全与可靠性

- API Key 只存在于服务端环境变量，**绝不下发前端、绝不写入日志**。
- 工具白名单：一期只有只读的 History Server 工具 + 本地文件写入（限 `reports/`、`artifacts/`）。
- 输出脱敏：日志与事件中过滤 URL 凭据、token 形态字符串。
- 并发上限：单实例默认 3 个活跃会话，超限排队。
- 故障恢复：进程重启后，`running` 会话标记为 `interrupted`，可从最后状态续跑。

---

## 13. 测试与回归

### 13.1 测试环境

`testenv/` 提供脚本：启动本地 History Server（事件日志目录可配）、提交一组问题作业、生成回归数据。

### 13.2 问题作业（内置 7 个）

| 作业 | 构造 | 期望命中 |
|---|---|---|
| `j1_self_join_explosion` | 超级用户导致自 Join 膨胀 | JOIN_EXPLOSION、SPILL_HEAVY、STAGE_DOMINANT |
| `j2_skew_join` | 单 key 占一半数据、关闭 AQE 倾斜处理 | TASK_SKEW |
| `j3_bnlj` | 非等值 Join 条件 | BNLJ |
| `j4_small_files` | 大量小文件后聚合 | SMALL_FILES |
| `j5_task_failures` | UDF 概率抛错触发重试 | TASK_FAILURES |
| `j6_healthy` | 正常作业（对照，要求零误报） | 无 P0/P1 |
| `j7_case1_optimized` | j1 的优化版（预聚合 + Top-N） | 用于 A/B 对照 |

### 13.3 回归

- 规则层：对每个作业断言命中规则集合，作为 CI 用例。
- 端到端：对 j1 发起"这个任务很慢"，断言最终报告包含问题 Stage、膨胀倍数与改写建议。

---

## 14. 配置一览

```bash
# 模型
SPARKSLEUTH_LLM_BASE_URL= / SPARKSLEUTH_LLM_API_KEY= / SPARKSLEUTH_LLM_MODEL=

# 数据源
SPARKSLEUTH_HS_URL=http://localhost:18080

# 运行时
SPARKSLEUTH_PORT=8787
SPARKSLEUTH_DATA_DIR=./data
SPARKSLEUTH_MAX_STEPS=40
SPARKSLEUTH_CONTEXT_BUDGET=120000
SPARKSLEUTH_MAX_TOOL_RESULT_CHARS=6000
SPARKSLEUTH_SESSION_TIMEOUT_MS=1200000
SPARKSLEUTH_CONCURRENCY=3

# 规则阈值（可选覆盖）
SPARKSLEUTH_RULE_SKEW_RATIO=5
SPARKSLEUTH_RULE_SPILL_RATIO=1
```

全部配置项见 `docs/configuration.md`。

---

## 15. 路线图

| 版本 | 内容 |
|---|---|
| **v0.1** | 测试环境；`spark-history` + `spark-diagnose` + `session` + `memory` 四个 Skill；Agent 运行时；控制层 API + WebSocket；Web UI 三栏；三层记忆；7 个回归作业 |
| **v0.2** | A/B 本地双跑验证（只写临时库）；更多规则（AQE 失效、推测执行无效、序列化开销） |
| **v0.3** | 扩展 Skill：YARN Resource Manager、元数据服务、湖仓查询引擎、调度平台、日志平台 |
| **v0.4** | 记忆向量检索；多用户与权限；Docker 一键部署 |
