# Writing a skill

A skill is a bundle of tools plus the knowledge of when and how to use them.
It is how SparkSleuth learns about a new system without the core knowing
anything about that system.

## Anatomy

```
packages/skills-<name>/src/
├── index.ts        # exports the Skill object
├── tools/          # one file per tool
└── rules/          # optional: diagnostic rules over this skill's data
```

## Interface

```ts
export interface Skill {
  /** Short id, lowercase, used in tool names and the UI. */
  name: string;
  /** One line, shown to the model at all times. Keep it under ~120 chars. */
  description: string;
  /** When to reach for this skill, and when not to. Loaded on demand. */
  detail(): string | Promise<string>;
  /** Tools exposed to the model. */
  tools(): ToolDefinition[];
  /** Optional lifecycle hooks. */
  init?(ctx: SkillContext): Promise<void>;
}
```

## Tools

```ts
export interface ToolDefinition {
  name: string;                       // snake_case, prefixed by skill at runtime
  description: string;                // what it does, when to use it
  inputSchema: JSONSchema;            // parameters
  /** Data this tool needs; lets the collector fetch just enough. */
  requires?: string[];
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}
```

`ToolResult` is either a short summary string (goes into the context) or a
reference to an artifact plus a summary:

```ts
{ summary: "Stage 5: 1001 tasks, p50 12s, max 9m12s, spill 107.6 GB", artifact?: "stage-5-tasks.json" }
```

Return the summary. If the payload would exceed `SPARKSLEUTH_MAX_TOOL_RESULT_CHARS`,
the runtime stores it automatically and hands the model a pointer instead.

## Guidelines

1. **Summarise at the tool.** The tool knows what matters; do not dump raw JSON
   and hope the model filters it. Top-N, quantiles, and totals belong in the
   summary.
2. **Be loud about absence.** If the API returns nothing, say so explicitly
   ("no SQL plan available for this application") so the model changes course
   instead of inventing.
3. **Stay read-only** unless the skill is explicitly about writing, and then
   confine writes to the session workspace.
4. **One concern per tool.** `stage_list` lists stages; `stage_detail` explains
   one. Do not build a `get_everything` tool.
5. **Fail soft.** Throw on transport errors (the runtime converts them into a
   structured error result the model can react to); return an empty result for
   "nothing found".

## Descriptions matter more than code

The model decides whether to call a tool from its name and description alone.
Write the description as an instruction: what it returns, when to call it, what
to check next.

```ts
{
  name: "stage_detail",
  description:
    "Task-level distribution for one stage: duration, GC, shuffle read/write and " +
    "spill quantiles, skew factor, failure count. Call this after stage_list when a " +
    "stage looks slow or spilling. Needs appId and stageId; pass attempt for retried stages.",
}
```

## Registering

```ts
// packages/server/src/skills.ts
export const skills = [sparkHistory, sparkDiagnose, sessionSkill, memorySkill];
```

The runtime merges tool definitions, prefixes names with the skill id
(`spark_history_stage_detail`), and records which skill produced each result so
the UI can group them.

## Testing a skill

Point it at a local History Server, then drive it from the CLI:

```bash
pnpm cli -- tools                       # list registered tools
pnpm cli -- call spark_history_stage_detail '{"appId":"...","stageId":5}'
```

Keep a fixture app in `testenv/` that exercises the interesting branches.
