# Contributing to SparkSleuth

Thank you for your interest in contributing to SparkSleuth!

SparkSleuth is an AI-powered diagnostic assistant for Apache Spark that combines deterministic rule-based analysis with LLM-driven reasoning.

---

## Architecture Overview

SparkSleuth is structured as a pnpm monorepo:

- `packages/core`: Core agent ReAct loop, tool registry, artifact storage, and LLM client.
- `packages/skills-spark`: Spark-specific tools (History Server client, plan analyzers, fact collectors, and diagnostic rules).
- `packages/server`: Fastify web and WebSocket backend, SQLite persistence, session manager, and auto-dream memory engine.
- `packages/cli`: Command-line interface for running investigations or tools directly.
- `web`: Modern React + Vite frontend for interactive investigations.

---

## Development Setup

### Prerequisites

- Node.js >= 23.4 (uses built-in `node:sqlite`)
- pnpm >= 10.0

### Getting Started

```bash
# Clone the repository
git clone https://github.com/your-org/sparksleuth.git
cd sparksleuth

# Install dependencies
pnpm install

# Setup environment variables
cp .env.example .env
# Edit .env with your LLM API key and Spark History Server URL

# Start development servers (server on :8787, web on :5173)
pnpm dev
```

### Running Tests and Typechecks

```bash
# Typecheck all packages
pnpm typecheck

# Run all unit and integration tests
pnpm test

# Build frontend production assets
pnpm build
```

---

## Adding a Diagnostic Rule

Diagnostic rules reside in `packages/skills-spark/src/rules/index.ts`.

When creating a new rule:
1. Define a unique rule id in UPPER_SNAKE_CASE (e.g. `MY_RULE`).
2. Specify default thresholds in `packages/core/src/config.ts` if configurable.
3. Keep the rule deterministic: read facts from `AppFacts` and return `Finding[]`.
4. Always add a unit test in `packages/skills-spark/test/rules.test.ts` covering both positive (trigger) and negative (quiet) cases.

---

## Pull Request Guidelines

1. **Keep it focused**: PRs should address a single issue or feature.
2. **Include tests**: All changes in `core`, `server`, or `skills-spark` must include automated tests.
3. **Run checks**: Ensure `pnpm typecheck` and `pnpm test` pass before submitting.
4. **Commit messages**: Use clear, conventional commit messages (e.g. `fix: cancel preserves cancelled state`, `feat: add compare_apps tool`).
