import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Skill, ToolDefinition } from '../types.js';

export interface SessionHooks {
  markPurpose(payload: { type: string; target?: string; desc: string }): Promise<void>;
  reportFinding(payload: { stage: string; tools: string[]; finding: string }): Promise<void>;
  saveReport(payload: { title: string; markdown: string }): Promise<{ path: string }>;
}

export function resolveSessionWorkspace(dataDir: string, sessionId: string): string {
  return resolve(dataDir, 'workspaces', sessionId);
}

export async function initSessionWorkspace(workspaceDir: string): Promise<void> {
  await mkdir(join(workspaceDir, 'reports'), { recursive: true });
  await mkdir(join(workspaceDir, 'artifacts'), { recursive: true });
}

export async function writeSessionReport(
  workspaceDir: string,
  title: string,
  markdown: string,
): Promise<{ path: string }> {
  const reportsDir = join(workspaceDir, 'reports');
  await mkdir(reportsDir, { recursive: true });
  const path = join(reportsDir, `report-${Date.now()}.md`);
  const body = markdown.replace(/^\s*#\s+.*\n+/, '');
  await writeFile(path, `# ${title}\n\n${body}\n`, 'utf8');
  return { path };
}

/**
 * Session-level tools. They do no analysis themselves; they let the model
 * narrate its progress in a structured way the UI can render.
 */
export function createSessionSkill(hooks: SessionHooks): Skill {
  const tools: ToolDefinition[] = [
    {
      name: 'mark_purpose',
      description:
        'Declare what this session is about before investigating: the investigation type, the target application, and the question. Call it first, every session.',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['single_app', 'etl_optimize', 'lineage', 'log_analysis', 'ab_compare', 'other'],
            description: 'Investigation type',
          },
          target: { type: 'string', description: 'Target application id or object being investigated' },
          desc: { type: 'string', description: 'One sentence: what the user wants to know' },
        },
        required: ['type', 'desc'],
      },
      async execute(input) {
        await hooks.markPurpose({
          type: String(input.type ?? 'other'),
          target: input.target ? String(input.target) : undefined,
          desc: String(input.desc ?? ''),
        });
        return { summary: `Purpose recorded (${input.type}). Proceeding with the investigation.` };
      },
    },
    {
      name: 'report_finding',
      description:
        'Record a milestone of the investigation: which phase, which tools produced it, and the conclusion. Call it after each major step so the timeline stays readable.',
      inputSchema: {
        type: 'object',
        properties: {
          stage: { type: 'string', description: 'Phase label, e.g. "Phase 2: locate the slow stage"' },
          tools: { type: 'array', items: { type: 'string' }, description: 'Tools that produced this finding' },
          finding: { type: 'string', description: 'The conclusion, one or two sentences with numbers' },
        },
        required: ['stage', 'finding'],
      },
      async execute(input) {
        await hooks.reportFinding({
          stage: String(input.stage ?? ''),
          tools: (input.tools as string[]) ?? [],
          finding: String(input.finding ?? ''),
        });
        return { summary: `Finding recorded under "${input.stage}".` };
      },
    },
    {
      name: 'save_report',
      description:
        'Save the final diagnostic report as Markdown in the session workspace and surface it in the UI. Call it once, at the end, when the investigation is complete.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Report title' },
          markdown: { type: 'string', description: 'Full report in Markdown' },
        },
        required: ['title', 'markdown'],
      },
      async execute(input) {
        const saved = await hooks.saveReport({
          title: String(input.title ?? 'Diagnostic report'),
          markdown: String(input.markdown ?? ''),
        });
        return { summary: `Report saved to ${saved.path}. The investigation is complete.` };
      },
    },
  ];

  return {
    name: 'session',
    description: 'Record the purpose, milestones and final report of an investigation.',
    detail: () => `# Session tools

Use these to make the investigation legible while you work.

1. **mark_purpose** — call once at the start. It sets the session title and the
   target, and tells the UI what kind of investigation this is.
2. **report_finding** — call after each phase that produced a conclusion.
   Typical phases for an application diagnosis:
   - Phase 1: overview and anomaly triage
   - Phase 2: locate the dominant stage
   - Phase 3: confirm the root cause in the plan
   - Phase 4: recommendations
   Keep each finding to one or two sentences with real numbers.
3. **save_report** — call once at the end with the full Markdown report.

Do not batch all findings at the end; the timeline is what makes the
investigation auditable.`,
    tools: () => tools,
  };
}
