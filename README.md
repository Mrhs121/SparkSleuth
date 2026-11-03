# SparkSleuth

**An AI diagnostic assistant for Apache Spark.** Give it an appId, or just ask "why was this job slow?" — it walks the evidence chain on its own and comes back with a report you can act on.

> Status: early development. Design is settled; implementation in progress.

---

## Why

Diagnosing a slow or failing Spark job follows a well-known path, but doing it by hand is slow:

- metrics are scattered across a pile of History Server endpoints that you compare by eye;
- "is this data skew?" needs task quantiles, shuffle I/O, GC and the physical plan looked at together;
- the same pitfalls get rediscovered by every engineer;
- the experienced person gets it right, but can't be everywhere.

SparkSleuth turns that into one conversation. **Rules do the arithmetic; the model does the reasoning.**

## How it works

```
Web UI (React)  ──WebSocket──▶  Control layer (Node.js)
                                   │
                                   ▼
                            Agent runtime (own ReAct loop)
                                   │
                                   ▼
                            Skills (spark-history, spark-diagnose, …)
                                   │
                                   ▼
                            Spark History Server (read-only)
```

- **Rules + model, two tracks.** Spill ratio, skew factor and join fan-out are computed deterministically by a rule engine. The model links the evidence, explains the cause, and writes the fix.
- **Progressive disclosure.** Only one-line skill descriptions sit in the prompt; tool schemas and full results are loaded on demand. Large results go to disk and are queried locally — they never flood the context.
- **Evidence-first.** Every conclusion carries the tool name and the numbers behind it.
- **Read-only by default.** Phase one touches nothing but the History Server.

## What it looks at

| Layer | Signal |
|---|---|
| App overview | failures, slowest stages, executor health, spill/shuffle/GC totals |
| Stage & task | quantiles, long-tail factor, GC, spill, shuffle skew |
| Physical plan | join shape, row fan-out, exchanges, scan size and file count |
| Data & config | partition counts, key distribution, AQE and memory settings |
| Recommendations | SQL rewrite and parameter changes, ranked P0–P2, with expected gain |

Twelve built-in rules cover stage dominance, heavy spill, task and shuffle skew, join explosion, broadcast-nested-loop joins, broadcastable sort-merge joins, GC pressure, executor loss, task failures, small files and risky configs.

## Quick start

```bash
# 1. point it at a model gateway (any Anthropic-compatible endpoint)
export SPARKSLEUTH_LLM_BASE_URL=https://api.anthropic.com
export SPARKSLEUTH_LLM_API_KEY=sk-...
export SPARKSLEUTH_LLM_MODEL=claude-sonnet-4-5

# 2. point it at your History Server
export SPARKSLEUTH_HS_URL=http://localhost:18080

# 3. run
pnpm install
pnpm dev
```

Then open the web UI and ask about an application.

No History Server handy? `testenv/` spins one up locally with a set of deliberately broken jobs:

```bash
./testenv/start-hs.sh
./testenv/run-all.sh
```

## Documentation

- [Design](docs/design.md) — architecture, agent runtime, rules, memory
- [Skills](docs/skills.md) — how to add a new observation source
- [Rules](docs/rules.md) — each rule's threshold and rationale

## Roadmap

| Version | Focus |
|---|---|
| v0.1 | History Server skills, rule engine, agent runtime, web UI, three-tier memory |
| v0.2 | A/B validation runs (sandboxed writes only) |
| v0.3 | More sources: YARN, metadata, lakehouse query engine, scheduler, logs |
| v0.4 | Vector search over memory, multi-user, Docker |

## License

Apache-2.0
