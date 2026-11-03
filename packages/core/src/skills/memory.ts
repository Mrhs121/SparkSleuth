import type { Skill, ToolDefinition } from '../types.js';

export interface MemoryHit {
  sid: string;
  title: string;
  tags: string[];
  desc: string;
  date: string;
  appIds?: string[];
  rules?: string[];
}

export interface MemoryStore {
  search(query: { keyword?: string; tags?: string[]; days?: number; limit?: number }): Promise<MemoryHit[]>;
  get(sid: string): Promise<string | null>;
  experience(topic?: string): Promise<string[]>;
}

/**
 * Gives the model access to what previous investigations concluded.
 * Read-only: writing memory is the control layer's job, not the model's.
 */
export function createMemorySkill(store: MemoryStore): Skill {
  const tools: ToolDefinition[] = [
    {
      name: 'search',
      description:
        'Search summaries of past investigations by keyword, tag or recency. Call it before concluding, to see whether a similar case was diagnosed before.',
      inputSchema: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: 'Free text, matched against title, tags and description' },
          tags: { type: 'array', items: { type: 'string' } },
          days: { type: 'number', description: 'Only look back this many days' },
          limit: { type: 'number', description: 'Max results, default 5' },
        },
      },
      async execute(input) {
        const hits = await store.search({
          keyword: input.keyword as string | undefined,
          tags: input.tags as string[] | undefined,
          days: input.days as number | undefined,
          limit: (input.limit as number) ?? 5,
        });
        if (!hits.length) return { summary: 'No similar past investigation found.' };
        return {
          summary: [
            `Found ${hits.length} past investigation(s):`,
            '',
            ...hits.map(
              (h) =>
                `- **${h.title}** (${h.date.slice(0, 10)}, session ${h.sid})\n  ${h.desc}${h.tags.length ? `\n  tags: ${h.tags.join(', ')}` : ''}`,
            ),
            '',
            'Use memory_get with a session id to read the full write-up.',
          ].join('\n'),
        };
      },
    },
    {
      name: 'get',
      description: 'Read the full write-up of a past investigation: conclusion, path taken, dead ends and reusable lessons.',
      inputSchema: {
        type: 'object',
        properties: { sid: { type: 'string', description: 'Session id from memory_search' } },
        required: ['sid'],
      },
      async execute(input) {
        const doc = await store.get(String(input.sid));
        if (!doc) return { summary: `No document for session ${input.sid}.`, isError: true };
        return { summary: doc.slice(0, 6000) };
      },
    },
    {
      name: 'experience',
      description: 'Read lessons that a human reviewed and promoted to permanent memory. These outrank raw past sessions.',
      inputSchema: {
        type: 'object',
        properties: { topic: { type: 'string', description: 'Optional topic filter' } },
      },
      async execute(input) {
        const items = await store.experience(input.topic as string | undefined);
        if (!items.length) return { summary: 'No reviewed lessons recorded yet.' };
        return { summary: items.map((e) => `- ${e}`).join('\n') };
      },
    },
  ];

  return {
    name: 'memory',
    description: 'Search summaries of past investigations and reviewed lessons.',
    detail: () => `# Memory tools

Every finished investigation is summarised into an index entry and a document.

- **search** — before you conclude, look for a similar case. A previous
  diagnosis of the same rule firing on the same kind of pipeline is strong
  context, but it is not evidence for *this* application. Verify against the
  current numbers.
- **get** — read the full document for a session. Useful when the summary
  mentions the same symptom you are seeing.
- **experience** — lessons a human reviewed and promoted. Treat these as
  organisational knowledge and prefer them over raw sessions when they conflict.

Never cite memory as evidence in the report. Cite the tools you ran.`,
    tools: () => tools,
  };
}
