/**
 * Sanity check the rule engine against the fixture jobs.
 *
 *   pnpm --filter @sparksleuth/skills-spark exec tsx ../../testenv/verify-rules.ts
 *
 * Requires a running History Server with the testenv jobs in it.
 */
import { HistoryClient, collectFacts, runRules } from '@sparksleuth/skills-spark';

const url = process.env.SPARKSLEUTH_HS_URL ?? 'http://localhost:18080';
const client = new HistoryClient(url, { timeoutMs: 20_000 });

const apps = await client.listApplications({ limit: 100 });
const byName = new Map<string, string>();
for (const app of apps) if (!byName.has(app.name)) byName.set(app.name, app.id); // newest first

for (const [name, id] of [...byName].sort()) {
  const facts = await collectFacts(client, id).catch((err) => {
    console.error(name, 'failed:', err instanceof Error ? err.message : err);
    return null;
  });
  if (!facts) continue;
  const findings = runRules(facts);
  const summary = findings.map((f) => `${f.severity}:${f.ruleId}`).join(' ') || '(no findings)';
  console.log(`${name.padEnd(28)} ${String(Math.round(facts.durationMs / 1000)).padStart(4)}s  ${summary}`);
}
