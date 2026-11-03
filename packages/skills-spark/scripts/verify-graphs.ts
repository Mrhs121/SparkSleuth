import assert from 'node:assert/strict';
import { collectGraphSnapshot, HistoryClient } from '../src/index.js';

const url = process.env.SPARKSLEUTH_HS_URL ?? 'http://localhost:18080';
const client = new HistoryClient(url, { timeoutMs: 10_000, signal: AbortSignal.timeout(60_000) });
const apps = await client.listApplications({ limit: 100 });
for (const prefix of ['j1', 'j7']) {
  const app = apps.find((a) => a.name.toLowerCase().startsWith(`${prefix}_`));
  assert.ok(app, `${prefix} fixture is unavailable`);
  const snapshot = await collectGraphSnapshot(client, app.id, url);
  for (const sql of snapshot.sqlExecutions) {
    const original = await client.getSqlExecution(app.id, sql.id);
    assert.deepEqual(sql.edges, (original.edges ?? []).map((e) => ({ source: String(e.fromId), target: String(e.toId) })));
    for (const node of sql.nodes) assert.ok(original.nodes?.some((n) => n.nodeId === node.nodeId));
  }
  console.log(JSON.stringify({ appId: app.id, name: app.name,
    sqlExecutions: snapshot.sqlExecutions.length, nodes: snapshot.sqlExecutions.reduce((n, s) => n + s.nodes.length, 0),
    edges: snapshot.sqlExecutions.reduce((n, s) => n + s.edges.length, 0), stages: snapshot.stages.length,
    annotations: snapshot.findings.map((f) => ({ ruleId: f.ruleId, target: f.target })), warnings: snapshot.source.warnings }));
}
