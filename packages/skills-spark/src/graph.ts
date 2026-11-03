import { createHash } from 'node:crypto';
import { collectFacts, parseMetric, type AppFacts } from './facts.js';
import { HistoryClient, type SqlExecution, type StageSummary } from './history-client.js';
import { runRules, type Finding, type Severity, type Thresholds } from './rules/index.js';

export type GraphTarget =
  | { scope: 'application'; appId: string }
  | { scope: 'sql'; appId: string; sqlId: number }
  | { scope: 'node'; appId: string; sqlId: number; nodeId: number }
  | { scope: 'stage'; appId: string; stageId: number; attemptId?: number };
export interface GraphAnnotation {
  findingId: string;
  ruleId: string;
  severity: Severity;
  role: 'root_cause' | 'symptom' | 'observation';
  target: GraphTarget;
  evidence: Record<string, unknown>;
  explanation: string;
  title: string;
}
export interface GraphMetric { name: string; raw: string; numeric: number }
export interface GraphNode {
  /** String form of the original ID, scoped by its containing execution/application. */
  id: string;
  nodeId: number;
  name: string;
  metrics: GraphMetric[];
  annotations: GraphAnnotation[];
}
export interface GraphSqlExecution {
  id: number;
  description: string;
  status?: string;
  nodes: GraphNode[];
  edges: Array<{ source: string; target: string }>;
  findings: GraphAnnotation[];
  graphAvailable: boolean;
}
export interface GraphStage {
  id: string;
  stageId: number;
  attemptId: number;
  name: string;
  status: string;
  metrics: Record<string, number | string>;
  /** Only supplied when the source explicitly reports parents. Never inferred from jobs/order. */
  parentIds?: number[];
  annotations: GraphAnnotation[];
}
export interface GraphSnapshot {
  version: 1;
  appId: string;
  capturedAt: string;
  source: { type: 'spark-history-server'; url: string; warnings: string[] };
  sqlExecutions: GraphSqlExecution[];
  stages: GraphStage[];
  findings: GraphAnnotation[];
}

/** Pure normalization: only real IDs and edges; the rules retain ownership of arithmetic. */
export function normalizeGraphSnapshot(input: {
  appId: string; sourceUrl: string; sqlExecutions: SqlExecution[]; stages: StageSummary[];
  findings: Finding[]; facts?: AppFacts; warnings?: string[]; capturedAt?: string;
}): GraphSnapshot {
  const warnings = [...(input.warnings ?? [])];
  const sqlExecutions: GraphSqlExecution[] = input.sqlExecutions.map((sql) => {
    const nodes = (sql.nodes ?? []).filter((n) => typeof n.nodeId === 'number').map((n) => ({
      id: String(n.nodeId), nodeId: n.nodeId!, name: n.nodeName,
      metrics: (n.metrics ?? []).map((m) => ({ name: m.name, raw: m.value, numeric: parseMetric(m.value) })),
      annotations: [] as GraphAnnotation[],
    }));
    const graphAvailable = Array.isArray(sql.nodes) && Array.isArray(sql.edges) && nodes.length > 0;
    if (!graphAvailable) warnings.push(`SQL ${sql.id}: graph topology unavailable`);
    if (nodes.length !== (sql.nodes ?? []).length) warnings.push(`SQL ${sql.id}: nodes without source IDs omitted`);
    if ((sql.edges ?? []).some((edge) => !nodes.some((node) => node.nodeId === edge.fromId)
      || !nodes.some((node) => node.nodeId === edge.toId))) warnings.push(`SQL ${sql.id}: source edges reference missing nodes; endpoints retained without invented nodes`);
    return {
      id: sql.id, description: sql.description ?? '', status: sql.status, nodes,
      // Preserve direction and endpoints, even if a source endpoint has no corresponding node.
      edges: (sql.edges ?? []).map((e) => ({ source: String(e.fromId), target: String(e.toId) })),
      findings: [], graphAvailable,
    };
  });
  const stages: GraphStage[] = input.stages.map((stage) => {
    const attemptId = stage.attemptId ?? 0;
    const metrics: Record<string, number | string> = {};
    for (const [key, value] of Object.entries(stage)) {
      if (typeof value === 'number' || typeof value === 'string') metrics[key] = value;
    }
    const facts = input.facts?.stages.find((s) => s.stageId === stage.stageId && s.attemptId === attemptId);
    if (facts) {
      metrics.durationMs = facts.durationMs;
      for (const [key, value] of Object.entries(facts.quantiles ?? {})) metrics[key] = value;
    }
    return {
      id: `${stage.stageId}:${attemptId}`, stageId: stage.stageId, attemptId,
      name: stage.name ?? `Stage ${stage.stageId}`, status: stage.status, metrics,
      ...(Array.isArray(stage.parentIds) ? { parentIds: [...stage.parentIds] } : {}), annotations: [],
    };
  });
  const findings = input.findings.map((finding): GraphAnnotation => {
    let target: GraphTarget = { scope: 'application', appId: input.appId };
    const stageId = finding.scope?.stageId;
    const sqlId = finding.scope?.sqlId ?? numericId(finding.evidence.sqlId);
    if (stageId !== undefined) {
      const matching = stages.filter((s) => s.stageId === stageId);
      target = { scope: 'stage', appId: input.appId, stageId,
        ...(matching.length === 1 ? { attemptId: matching[0].attemptId } : {}) };
    } else if (sqlId !== undefined) {
      target = { scope: 'sql', appId: input.appId, sqlId };
      const sql = sqlExecutions.find((s) => s.id === sqlId);
      const nodeId = numericId(finding.evidence.nodeId);
      let matching: GraphNode[] = [];
      if (nodeId !== undefined) matching = sql?.nodes.filter((n) => n.nodeId === nodeId) ?? [];
      else {
        // Real rule formats: operator:string (JOIN_EXPLOSION/BNLJ), joins:string[] (SMJ).
        // SMALL_FILES has neither: it stays SQL scoped, even with a single scan.
        const names = typeof finding.evidence.operator === 'string' ? [finding.evidence.operator]
          : Array.isArray(finding.evidence.joins) && finding.evidence.joins.length === 1
            && typeof finding.evidence.joins[0] === 'string' ? [finding.evidence.joins[0]] : [];
        if (names.length === 1) matching = sql?.nodes.filter((n) => n.name === names[0]) ?? [];
      }
      if (matching.length === 1) target = { scope: 'node', appId: input.appId, sqlId, nodeId: matching[0].nodeId };
    }
    const annotation: GraphAnnotation = {
      findingId: `${finding.ruleId}:${createHash('sha256').update(JSON.stringify({ appId: input.appId, scope: finding.scope, evidence: finding.evidence })).digest('hex').slice(0, 16)}`, ruleId: finding.ruleId, severity: finding.severity,
      role: target.scope === 'node' && ['JOIN_EXPLOSION', 'BNLJ', 'SMALL_FILES'].includes(finding.ruleId)
        ? 'root_cause' : target.scope === 'stage' ? 'symptom' : 'observation',
      target, evidence: finding.evidence, explanation: finding.possibleCauses.join('; '), title: finding.title,
    };
    if (target.scope === 'node') sqlExecutions.find((s) => s.id === target.sqlId)?.nodes
      .find((n) => n.nodeId === target.nodeId)?.annotations.push(annotation);
    else if (target.scope === 'sql') sqlExecutions.find((s) => s.id === target.sqlId)?.findings.push(annotation);
    else if (target.scope === 'stage' && target.attemptId !== undefined) stages
      .find((s) => s.stageId === target.stageId && s.attemptId === target.attemptId)?.annotations.push(annotation);
    return annotation;
  });
  return { version: 1, appId: input.appId, capturedAt: input.capturedAt ?? new Date().toISOString(),
    source: { type: 'spark-history-server', url: input.sourceUrl, warnings }, sqlExecutions, stages, findings };
}
function numericId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** All HTTP uses HistoryClient; callers supply an overall abort deadline as well as per-request timeouts. */
export async function collectGraphSnapshot(client: HistoryClient, appId: string, sourceUrl: string,
  thresholds?: Thresholds): Promise<GraphSnapshot> {
  const facts = await collectFacts(client, appId);
  const [stages, summaries] = await Promise.all([client.getStages(appId), client.getSqlList(appId, true)]);
  const findings = runRules(facts, thresholds);
  const warnings: string[] = ['Rule facts inspect up to 5 SQL executions and task quantiles for up to 6 stages; unannotated nodes are not a health guarantee.'];
  if (findings.some((f) => f.ruleId === 'JOIN_EXPLOSION')) {
    warnings.push('JOIN_EXPLOSION estimates input rows from existing rule node-order heuristics; annotations are suspected causes, not verified causal topology.');
  }
  const sqlExecutions: SqlExecution[] = [];
  // Limit detail concurrency rather than flooding the History Server with a large SQL list.
  for (let offset = 0; offset < summaries.length; offset += 4) {
    sqlExecutions.push(...await Promise.all(summaries.slice(offset, offset + 4).map(async (summary) => {
      try { return await client.getSqlExecution(appId, summary.id); }
      catch (error) {
        // Refresh must not replace a replayable snapshot with a partial network-failure graph.
        throw new Error(`SQL ${summary.id}: detail unavailable (${error instanceof Error ? error.message : String(error)})`);
      }
    })));
  }
  return normalizeGraphSnapshot({ appId, sourceUrl, sqlExecutions, stages, findings, facts, warnings });
}
