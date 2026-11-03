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
