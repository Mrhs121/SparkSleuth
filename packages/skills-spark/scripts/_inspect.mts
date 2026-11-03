import { HistoryClient, collectFacts } from '@sparksleuth/skills-spark';
const c = new HistoryClient(process.env.SPARKSLEUTH_HS_URL ?? 'http://localhost:18080', { timeoutMs: 20000 });
const apps = await c.listApplications({ limit: 100 });
const app = apps.find((a) => a.name === process.argv[2])!;
const f = await collectFacts(c, app.id);
for (const sql of f.sql) {
  console.log('SQL', sql.id, 'duration', sql.durationMs);
  for (const n of sql.nodes) console.log('   ', n.name, JSON.stringify(n.metrics).slice(0, 200));
}
console.log('stages:');
for (const s of f.stages) console.log('  ', s.stageId, s.durationMs, 'tasks', s.numTasks, 'skew?', JSON.stringify(s.quantiles));
