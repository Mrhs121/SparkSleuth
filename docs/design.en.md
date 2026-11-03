# SparkSleuth Design Document

> Version: v0.2 · Status: Implementation & Verification  
> SparkSleuth is an AI diagnostic assistant for Apache Spark: given an appId or a symptom such as "why was this job slow?", it navigates the evidence chain—application overview, stages/tasks, physical query plan, data distribution, and configuration—and generates an actionable, evidence-backed diagnostic report.

---

## 1. Motivation & Principles

Diagnosing Spark job slowdowns, OOM errors, and task failures follows established operational patterns, but manual execution is tedious:
- Metrics are scattered across multiple History Server REST endpoints.
- Validating data skew requires cross-referencing task quantiles, shuffle I/O, GC time, and the physical plan simultaneously.
- Lessons and post-mortems live in individual memory rather than shared institutional knowledge.

SparkSleuth turns this into an automated, interactive workflow:
**Deterministic rules compute arithmetic; LLMs synthesize evidence and explain root causes.**

### Core Principles

1. **Evidence First**: All conclusions must cite tool outputs and specific metric numbers.
2. **Rules Compute, Models Reason**: Skew factors, spill ratios, and fan-out are calculated deterministically in TypeScript rules; the model does not attempt mental arithmetic on large numbers.
3. **Context Economy**: Tool results return compact summaries (≤6 KB); large payloads are written to local artifacts and queried on demand.
4. **Read-Only Safety**: Diagnoses interact exclusively with read-only APIs (e.g. Spark History Server).
5. **Extensibility**: Adding new data sources (e.g. YARN, log platforms, metastores) requires only a new Skill without touching the core runtime.

---

## 2. Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│ Interaction Layer: React + Vite + TypeScript                           │
│  Session list │ Live chat stream │ Timeline milestones │ Reports │ Memory│
│                    ▲ WebSocket (streaming events)                      │
├────────────────────┼───────────────────────────────────────────────────┤
│ Control Layer: Node.js (Fastify + ws)                                  │
│  Token auth │ SessionManager & SQLite │ Life-cycle guard │ Auto-Dream  │
├────────────────────┼───────────────────────────────────────────────────┤
│ Agent Runtime: Custom ReAct Loop (TypeScript)                          │
│  Prompt assembly │ Tool scheduling │ Context truncation & artifacts   │
├────────────────────┼───────────────────────────────────────────────────┤
│ Capability Layer: Skills                                               │
│  spark-history │ spark-diagnose │ session │ memory │ core tools        │
├────────────────────┼───────────────────────────────────────────────────┤
│ Data Source: Apache Spark History Server (Read-only REST)              │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Three-Tier Memory Architecture

1. **Tier 1: In-Session Context**:
   - Reconstructed dialogue history including user inputs, assistant reasoning, and compact tool execution summaries.
   - Guarded by session token budget (`SPARKSLEUTH_CONTEXT_BUDGET`).

2. **Tier 2: Episodic Memory (Case Index)**:
   - Upon closing a session (`session_save_report` + wrap-up), the session is summarized into an indexed document in `data/memory/docs/<sid>.md`.
   - SQLite search index ranks past cases using keyword relevance, tag matching, and time-decay recency bonus.

3. **Tier 3: Permanent Experience (Auto-Dream)**:
   - A daily reflection task (`scheduleDream`) examines recent diagnostic sessions, extracting reusable generalized rules.
   - Proposed rules are queued for human review (`pending`), and once approved, promoted to permanent system guidelines.

---

## 4. Diagnostics & Comparison

- **12 Deterministic Rules**: Evaluates stage dominance, skew, memory/disk spill, Cartesian joins, broadcast viability, GC pressure, executor loss, small files, and config pitfalls.
- **A/B Comparison Tool (`compare_apps`)**: Compares baseline vs optimized runs (e.g. j1 vs j7), computing deltas for duration, spill, shuffle volume, GC, configuration changes, and resolved findings.

## 5. Diagnostic Graphs: Real Execution Evidence in Chat

### Sources and trust boundaries

Use the actual SQL `nodes` and `edges` returned by the History Server SQL detail endpoint. Verified on Spark 3.5.5: node IDs, edge endpoints and formatted metrics are available. Never synthesize edges from list order or ask the model to invent topology. Show Stage attempts with actual metrics; draw Stage edges only when explicit parent IDs exist. Missing topology/mappings must be visible. Do not equate a slow node with a root cause or merge initial/final AQE plans into fabricated causality.

### Versioned graph snapshots and annotations

Persist `version/appId/capturedAt/source/sqlExecutions/stages/findings`. Keep original SQL node IDs, names, metric strings, normalized numbers and edge endpoints. Annotations contain `findingId/ruleId/severity/role/target/evidence/explanation`. Roles distinguish suspected root causes, symptoms and observations. Only bind operator findings when the rule's SQL/node evidence identifies a unique node; otherwise keep the finding at SQL scope. Stage spill/skew/failure findings stay at Stage scope without proven operator mapping. Existing rules compute the arithmetic. No speculative causal edge highlighting in the first release.

### API and lifecycle

Token-protected `GET /api/sessions/:sid/graph` reads the stored snapshot; `POST /api/sessions/:sid/graph` captures or refreshes one, optionally selecting an application. Resolve application IDs from stored session metadata and actual tool inputs. Store JSON in the shared session workspace. Refresh failure preserves the previous snapshot. Closed sessions can only read existing snapshots, never create or refresh them. Emit compact `graph_available` notifications after Spark tools, while full graphs remain in REST responses and files rather than LLM context. Graph errors must not fail an agent run.

### Chat integration

Add an inspector Graph tab with execution/Stage selection, SVG pan/zoom/fit, selected-node evidence and severity badges. Red indicates a suspected operator root cause; orange indicates symptoms/resource pressure; neutral colors indicate observations. No findings means “no rules triggered”, not a guarantee of health. Timeline “View in graph” actions use explicit IDs; unstructured findings open the graph without guessing a node. Node follow-up buttons populate the composer with exact application/node/Stage IDs and evidence for human confirmation. Closed sessions remain read-only.

### Language contract

Rule titles and explanations are deterministic, not LLM-generated. Render them and human-readable metric/evidence names using the current UI language from structured rule IDs/evidence, including language-appropriate number formatting. Switching languages updates cached snapshots immediately without recapture or translation-model calls. Keep exact operator names, IDs, original metrics and raw JSON unchanged for auditing. New chat turns include an optional `language: zh | en`; the per-turn system prompt enforces that preference. Legacy callers without a language retain user-language behavior. Existing saved conversations/reports are not silently rewritten.

**Language is chosen at generation/save time, never at read time.** Session finalization and manual Dream accept the UI language; scheduled Dream uses the last persisted preference, defaulting to Chinese. Generate and save prose in that language; approving a proposal preserves its original content. Memory/report GET endpoints always return the saved source unchanged, without model calls or translations. Switching UI language changes static labels and deterministic graph-rule presentation only; existing English records remain English and existing Chinese records remain Chinese.

### First release and acceptance

Implement SQL topology, Stage metrics, deterministic annotations, finding navigation, node follow-ups and replayable snapshots. Full Stage DAG topology, precise cross-layer mapping and causal-path inference are deferred until source evidence is available. Begin with a lightweight layered SVG renderer, preserving an upgrade path to React Flow/ELK. Tests cover edge fidelity, duplicate operators, missing graphs, no invented mappings, authenticated snapshot endpoints, closed-session guards, offline replay and both flagged/unflagged applications. Verify real j1/j7 payloads, typecheck, tests and the web build.
