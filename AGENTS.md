# AGENTS.md — Development Guidelines for AI Agents

This file provides system instructions, conventions, and architectural context for autonomous AI coding agents working on the SparkSleuth codebase.

---

## Monorepo Layout

```
.
├── packages/
│   ├── core/           # Agent runtime (ReAct loop, tool registry, memory/session interfaces, artifact store)
│   ├── skills-spark/   # Spark tools (History Server API client, plan/facts collector, rules engine)
│   ├── server/         # Fastify API, WebSockets, SessionManager, SQLite DB, Auto-Dream scheduler
│   └── cli/            # CLI driver using the same core agent runtime
├── web/                # React + Vite frontend
├── docs/               # System documentation
└── testenv/            # Local fixture jobs and mock History Server
```

---

## Key Invariants & Rules

1. **Deterministic arithmetic in rules, semantic reasoning in model**:
   - Skew ratios, spill volumes, file counts, and GC percentages are computed in TypeScript rules (`packages/skills-spark/src/rules/`).
   - The LLM reasons over the rule findings, cross-examines facts, inspects SQL plans, and explains root causes.

2. **Context Budget & Artifacts**:
   - Never flood the LLM context with large raw Spark metrics or JSON arrays.
   - Any tool output exceeding `runtime.maxToolResultChars` (default 6,000 chars) is automatically saved to an on-disk artifact in `workspaces/<sid>/artifacts/`.
   - The agent receives a truncated preview and pointer, and uses `core_artifact_head` to inspect structure or `core_artifact_query` to query slices.

3. **Session State Machine**:
   - `created` -> `running` -> `waiting` (awaiting user follow-up) -> `finalizing` -> `closed`.
   - If user cancels: status becomes `cancelled`. Abort signals must NEVER overwrite `cancelled` with `failed` or emit unhandled errors.
   - Closed sessions are immutable: `continue()` must reject further turns, and `finish()` must be idempotent.

4. **Security & Authentication**:
   - By default server binds `127.0.0.1`.
   - If `SPARKSLEUTH_TOKEN` is set, all `/api/*` (except `/api/health`) and `/ws/*` endpoints require token authentication (`Authorization: Bearer <token>`, `x-sparksleuth-token`, or `?token=<token>`).

5. **Shared Workspace & Hooks**:
   - Always use `resolveSessionWorkspace`, `initSessionWorkspace`, and `writeSessionReport` from `@sparksleuth/core` rather than duplicating paths or filesystem logic in CLI and server.

---

## Verification Commands

Before finishing any task, run:
```bash
pnpm typecheck   # Check TypeScript types across all 5 workspace projects
pnpm test        # Run unit & integration tests
pnpm build       # Ensure Vite frontend bundle builds cleanly
```
