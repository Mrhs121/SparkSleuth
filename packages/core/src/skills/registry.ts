import type { ArtifactStore } from '../artifacts/store.js';
import type { Config } from '../config.js';
import type { LLMToolSchema } from '../llm/client.js';
import type { AgentEvent, Skill, ToolContext, ToolDefinition, ToolResult } from '../types.js';

export interface RegisteredTool {
  fullName: string;
  skill: string;
  def: ToolDefinition;
}

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'done';
}

/**
 * Holds every tool the model can call, including the three meta tools that
 * implement progressive disclosure (skill_load) and artifact access.
 */
export class ToolRegistry {
  private readonly byName = new Map<string, RegisteredTool>();
  private readonly bySkill = new Map<string, Skill>();
  readonly todos: TodoItem[] = [];

  constructor(
    skills: Skill[],
    private readonly deps: { config: Config; onEvent?: (e: AgentEvent) => void },
  ) {
    for (const skill of skills) {
      this.bySkill.set(skill.name, skill);
      for (const def of skill.tools()) {
        const fullName = `${sanitize(skill.name)}_${sanitize(def.name)}`;
        this.byName.set(fullName, { fullName, skill: skill.name, def });
      }
    }
    this.registerMetaTools();
  }

  list(): RegisteredTool[] {
    return [...this.byName.values()];
  }

  schemas(): LLMToolSchema[] {
    return this.list().map(({ fullName, def }) => ({
      name: fullName,
      description: def.description,
      input_schema: def.inputSchema,
    }));
  }

  /** One-line per tool, shown to the model so it knows what exists. */
  catalog(): string {
    const lines: string[] = [];
    for (const skill of this.bySkill.values()) {
      lines.push(`- **${skill.name}**: ${skill.description}`);
      const tools = this.list().filter((t) => t.skill === skill.name);
      if (tools.length > 0) {
        lines.push(
          `  tools: ${tools.map((t) => t.fullName.replace(`${sanitize(skill.name)}_`, '')).join(', ')}`,
        );
      }
    }
    return lines.join('\n');
  }

  async execute(
    fullName: string,
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const entry = this.byName.get(fullName);
    if (!entry) {
      return { summary: `Unknown tool: ${fullName}. Available: ${this.list().map((t) => t.fullName).join(', ')}`, isError: true };
    }
    try {
      const result = await entry.def.execute(input ?? {}, ctx);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { summary: `Tool ${fullName} failed: ${msg}`, isError: true };
    }
  }

  private registerMetaTools(): void {
    const meta: Array<{ skill: string; def: ToolDefinition }> = [
      {
        skill: 'core',
        def: {
          name: 'skill_load',
          description:
            'Load the detailed instructions for one skill: when to use it, its workflow, boundaries and common parameters. Call this before using a skill for the first time in a session. Returns the skill manual as text.',
          inputSchema: {
            type: 'object',
            properties: { name: { type: 'string', description: 'Skill name, e.g. spark-history' } },
            required: ['name'],
          },
          execute: async (input) => {
            const skill = this.bySkill.get(String(input.name));
            if (!skill) {
              return {
                summary: `No such skill: ${input.name}. Available: ${[...this.bySkill.keys()].join(', ')}`,
                isError: true,
              };
            }
            return { summary: await skill.detail() };
          },
        },
      },
      {
        skill: 'core',
        def: {
          name: 'artifact_query',
          description:
            'Query a large result that was written to an artifact instead of being pasted into the conversation. Use filter/sortBy/top/fields to pull only what you need.',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Artifact id from a previous tool result' },
              path: { type: 'string', description: 'Dot path into the JSON, e.g. tasks or 0.metrics' },
              filter: { type: 'object', description: 'Keep array items matching these field values' },
              sortBy: { type: 'string', description: 'Field to sort by' },
              order: { type: 'string', enum: ['asc', 'desc'] },
              top: { type: 'number', description: 'Return at most N items' },
              offset: { type: 'number' },
              fields: { type: 'array', items: { type: 'string' }, description: 'Project these fields' },
            },
            required: ['id'],
          },
          execute: async (input, ctx) => {
            const text = await ctx.artifacts.query(String(input.id), {
              path: input.path as string | undefined,
              filter: input.filter as Record<string, string | number | boolean> | undefined,
              sortBy: input.sortBy as string | undefined,
              order: input.order as 'asc' | 'desc' | undefined,
              top: input.top as number | undefined,
              offset: input.offset as number | undefined,
              fields: input.fields as string[] | undefined,
            });
            return { summary: text };
          },
        },
      },
      {
        skill: 'core',
        def: {
          name: 'todo_write',
          description:
            'Maintain the investigation plan for a multi-step diagnosis. Call it when starting a non-trivial investigation and after finishing each major step. The plan survives context compaction.',
          inputSchema: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    content: { type: 'string' },
                    status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
                  },
                  required: ['id', 'content', 'status'],
                },
              },
            },
            required: ['items'],
          },
          execute: async (input) => {
            const items = (input.items as TodoItem[]) ?? [];
            this.todos.splice(0, this.todos.length, ...items);
            const rendered = items
              .map((i) => `${i.status === 'done' ? '[x]' : i.status === 'in_progress' ? '[~]' : '[ ]'} ${i.content}`)
              .join('\n');
            return { summary: `Plan updated:\n${rendered}` };
          },
        },
      },
    ];

    for (const { skill, def } of meta) {
      const fullName = `core_${def.name}`;
      this.byName.set(fullName, { fullName, skill, def });
    }
    this.bySkill.set('core', {
      name: 'core',
      description: 'Built-in tools: skill manuals, artifact queries, investigation plan.',
      detail: () => 'Core tools are always available.',
      tools: () => [],
    });
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

export type { ToolContext };
