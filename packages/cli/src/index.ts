#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Agent,
  ArtifactStore,
  LLMClient,
  ToolRegistry,
  buildSystemPrompt,
  createMemorySkill,
  createSessionSkill,
  loadConfig,
  loadDotEnv,
  type AgentEvent,
  type MemoryHit,
  type MemoryStore,
} from '@sparksleuth/core';
import { sparkSkills } from '@sparksleuth/skills-spark';

loadDotEnv();

const [, , command, ...rest] = process.argv;

function usage(): void {
  console.log(`sparksleuth <command>

  apps                          list applications on the History Server
  call <tool> [json]            call a tool directly (no model involved)
  tools                         list registered tools
  diagnose <appId> [question]   run a full diagnosis
  ask "<question>"              start an investigation from a free-form question

Environment:
  SPARKSLEUTH_LLM_BASE_URL, SPARKSLEUTH_LLM_API_KEY, SPARKSLEUTH_LLM_MODEL
  SPARKSLEUTH_HS_URL            Spark History Server base URL
`);
}

/** Session hooks for the CLI: print milestones instead of pushing them to a UI. */
function cliHooks() {
  const findings: string[] = [];
  let reportPath = '';
  return {
    findings,
    get reportPath() {
      return reportPath;
    },
    hooks: {
      async markPurpose(p: { type: string; target?: string; desc: string }) {
        console.log(`\n[focused] ${p.type}${p.target ? ` → ${p.target}` : ''}: ${p.desc}`);
      },
      async reportFinding(p: { stage: string; tools: string[]; finding: string }) {
        findings.push(`${p.stage}: ${p.finding}`);
        console.log(`\n[${p.stage}] ${p.finding}`);
      },
      async saveReport(p: { title: string; markdown: string }) {
        reportPath = resolve(process.cwd(), 'data', 'reports', `${Date.now()}.md`);
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync(resolve(process.cwd(), 'data', 'reports'), { recursive: true });
        writeFileSync(reportPath, `# ${p.title}\n\n${p.markdown}\n`, 'utf8');
        return { path: reportPath };
      },
    },
  };
}

function emptyMemory(): MemoryStore {
  return {
    async search(): Promise<MemoryHit[]> {
      return [];
    },
    async get() {
      return null;
    },
    async experience() {
      return [];
    },
  };
}

function buildRegistry(config: ReturnType<typeof loadConfig>) {
  const session = cliHooks();
  const skills = [
    ...sparkSkills,
    createSessionSkill(session.hooks),
    createMemorySkill(emptyMemory()),
  ];
  const registry = new ToolRegistry(skills, { config });
  return { registry, session };
}

function printEvent(e: AgentEvent): void {
  if (e.type === 'text_delta') process.stdout.write(e.text);
  else if (e.type === 'tool_use') console.log(`\n\n🔧 ${e.skill}.${e.tool} ${JSON.stringify(e.input)}`);
  else if (e.type === 'tool_result') console.log(`\n   ↳ ${e.isError ? 'ERROR: ' : ''}${e.summary.split('\n').slice(0, 6).join('\n   ')}`);
  else if (e.type === 'usage') console.log(`\n   [tokens in=${e.usage.input} out=${e.usage.output}]`);
  else if (e.type === 'error') console.error(`\n!! ${e.message}`);
}

async function main(): Promise<void> {
  switch (command) {
    case 'apps': {
      const config = loadConfig();
      const { registry } = buildRegistry(config);
      const res = await registry.execute('spark_history_apps_list', { limit: 20 }, {
        sessionId: 'cli',
        artifacts: new ArtifactStore(resolve(config.runtime.dataDir, 'cli-artifacts')),
        config,
      });
      console.log(res.summary);
      return;
    }

    case 'tools': {
      const config = loadConfig();
      const { registry } = buildRegistry(config);
      for (const t of registry.list()) console.log(`${t.fullName.padEnd(40)} ${t.def.description.slice(0, 90)}`);
      return;
    }

    case 'call': {
      const [tool, json] = rest;
      if (!tool) throw new Error('usage: call <tool> [json]');
      const config = loadConfig();
      const { registry } = buildRegistry(config);
      const started = Date.now();
      const res = await registry.execute(tool, json ? JSON.parse(json) : {}, {
        sessionId: 'cli',
        artifacts: new ArtifactStore(resolve(config.runtime.dataDir, 'cli-artifacts')),
        config,
      });
      console.log(res.summary);
      if (res.artifact) console.log(`\n[artifact] ${res.artifact}`);
      console.error(`\n(${Date.now() - started}ms)`);
      return;
    }

    case 'diagnose':
    case 'ask': {
      const config = loadConfig();
      if (!config.llm.apiKey) throw new Error('SPARKSLEUTH_LLM_API_KEY is not set');
      const { registry, session } = buildRegistry(config);
      const appId = command === 'diagnose' ? rest[0] : undefined;
      const question =
        command === 'diagnose'
          ? rest.slice(1).join(' ') || `Diagnose Spark application ${appId}.`
          : rest.join(' ');

      const llm = new LLMClient(config.llm);
      const agent = new Agent(llm, registry, config);
      const artifacts = ArtifactStore.forSession(config.runtime.dataDir, `cli-${Date.now()}`);
      const system = buildSystemPrompt({
        catalog: registry.catalog(),
        historyServerUrl: config.spark.historyServerUrl,
        now: new Date().toISOString(),
      });

      console.log(`\n> ${question}\n`);
      const result = await agent.run({
        system,
        messages: [{ role: 'user', content: question }],
        artifacts,
        sessionId: 'cli',
        emit: printEvent,
      });
      console.log(`\n\n[done: ${result.reason}, in=${result.usage.input} out=${result.usage.output}]`);
      if (session.reportPath) console.log(`[report] ${session.reportPath}`);
      return;
    }

    default:
      usage();
      if (command && command !== 'help') process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

void existsSync;
