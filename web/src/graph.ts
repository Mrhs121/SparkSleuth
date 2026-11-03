// Local wire contract: no runtime dependency on backend packages.
export type GraphTarget =
  | { scope: 'application'; appId: string }
  | { scope: 'sql'; appId: string; sqlId: number }
  | { scope: 'node'; appId: string; sqlId: number; nodeId: number }
  | { scope: 'stage'; appId: string; stageId: number; attemptId?: number };
export interface GraphAnnotation {
  findingId: string; ruleId: string; severity: 'P0' | 'P1' | 'P2';
  role: 'root_cause' | 'symptom' | 'observation'; target: GraphTarget;
  evidence: Record<string, unknown>; explanation: string; title: string;
}
export interface GraphNode {
  id: string; nodeId: number; name: string;
  metrics: { name: string; raw: string; numeric: number | null }[];
  annotations: GraphAnnotation[];
}
export interface GraphEdge { source: string; target: string }
export interface GraphSqlExecution {
  id: number; description: string; status?: string; nodes: GraphNode[];
  edges: GraphEdge[]; findings: GraphAnnotation[]; graphAvailable: boolean;
}
export interface GraphStage {
  id: string; stageId: number; attemptId: number; name: string; status: string;
  metrics: Record<string, number | string>; parentIds?: number[]; annotations: GraphAnnotation[];
}
export interface GraphSnapshot {
  version: 1; appId: string; capturedAt: string;
  source: { type: 'spark-history-server'; url: string; warnings: string[] };
  sqlExecutions: GraphSqlExecution[]; stages: GraphStage[]; findings: GraphAnnotation[];
}
export interface GraphNavigation { target?: GraphTarget; revision: number }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
export function parseGraphTarget(value: unknown): GraphTarget | undefined {
  if (!record(value) || typeof value.appId !== 'string' || !value.appId) return;
  const { appId } = value;
  if (value.scope === 'application') return { scope: 'application', appId };
  if (value.scope === 'sql' && finite(value.sqlId)) return { scope: 'sql', appId, sqlId: value.sqlId };
  if (value.scope === 'node' && finite(value.sqlId) && finite(value.nodeId)) return { scope: 'node', appId, sqlId: value.sqlId, nodeId: value.nodeId };
  if (value.scope === 'stage' && finite(value.stageId) && (value.attemptId === undefined || finite(value.attemptId))) return { scope: 'stage', appId, stageId: value.stageId, ...(value.attemptId !== undefined ? { attemptId: value.attemptId } : {}) };
}
function annotations(value: unknown): GraphAnnotation[] {
  if (!Array.isArray(value)) throw new Error('Invalid graph annotations');
  return value.map((a: unknown) => {
    if (!record(a) || typeof a.findingId !== 'string' || typeof a.ruleId !== 'string' || !['P0', 'P1', 'P2'].includes(String(a.severity)) || !['root_cause', 'symptom', 'observation'].includes(String(a.role)) || !record(a.evidence) || typeof a.explanation !== 'string' || typeof a.title !== 'string') throw new Error('Invalid graph annotation');
    const target = parseGraphTarget(a.target);
    if (!target) throw new Error('Invalid graph annotation target');
    return { ...a, target } as unknown as GraphAnnotation;
  });
}
/** Reject malformed wire data instead of repairing topology or guessing identifiers. */
export function parseGraphSnapshot(value: unknown): GraphSnapshot {
  if (!record(value) || value.version !== 1 || typeof value.appId !== 'string' || !value.appId || typeof value.capturedAt !== 'string' || !record(value.source) || value.source.type !== 'spark-history-server' || typeof value.source.url !== 'string' || !Array.isArray(value.source.warnings) || !value.source.warnings.every((x) => typeof x === 'string') || !Array.isArray(value.sqlExecutions) || !Array.isArray(value.stages)) throw new Error('Invalid or unsupported graph snapshot');
  const sqlExecutions = value.sqlExecutions.map((sql: unknown): GraphSqlExecution => {
    if (!record(sql) || !finite(sql.id) || typeof sql.description !== 'string' || typeof sql.graphAvailable !== 'boolean' || !Array.isArray(sql.nodes) || !Array.isArray(sql.edges)) throw new Error('Invalid SQL graph');
    const nodes = sql.nodes.map((n: unknown): GraphNode => {
      if (!record(n) || typeof n.id !== 'string' || !finite(n.nodeId) || typeof n.name !== 'string' || !Array.isArray(n.metrics)) throw new Error('Invalid SQL node');
      const metrics = n.metrics.map((m: unknown) => {
        if (!record(m) || typeof m.name !== 'string' || typeof m.raw !== 'string' || !(m.numeric === null || finite(m.numeric))) throw new Error('Invalid SQL metric');
        return { name: m.name, raw: m.raw, numeric: m.numeric };
      });
      return { id: n.id, nodeId: n.nodeId, name: n.name, metrics, annotations: annotations(n.annotations) };
    });
    if (new Set(nodes.map((n) => n.id)).size !== nodes.length || new Set(nodes.map((n) => n.nodeId)).size !== nodes.length) throw new Error('Duplicate SQL node IDs');
    const edges = sql.edges.map((edge: unknown): GraphEdge => {
      if (!record(edge) || typeof edge.source !== 'string' || typeof edge.target !== 'string') throw new Error('Invalid SQL edge');
      return { source: edge.source, target: edge.target };
    });
    return { id: sql.id, description: sql.description, ...(typeof sql.status === 'string' ? { status: sql.status } : {}), graphAvailable: sql.graphAvailable, nodes, edges, findings: annotations(sql.findings) };
  });
  const stages = value.stages.map((s: unknown): GraphStage => {
    if (!record(s) || typeof s.id !== 'string' || !finite(s.stageId) || !finite(s.attemptId) || typeof s.name !== 'string' || typeof s.status !== 'string' || !record(s.metrics) || !Object.values(s.metrics).every((m) => typeof m === 'string' || finite(m)) || (s.parentIds !== undefined && (!Array.isArray(s.parentIds) || !s.parentIds.every(finite)))) throw new Error('Invalid Stage attempt');
    return { id: s.id, stageId: s.stageId, attemptId: s.attemptId, name: s.name, status: s.status, metrics: s.metrics as Record<string, number | string>, ...(s.parentIds !== undefined ? { parentIds: s.parentIds as number[] } : {}), annotations: annotations(s.annotations) };
  });
  if (new Set(stages.map((s) => s.id)).size !== stages.length) throw new Error('Duplicate Stage attempt IDs');
  return { version: 1, appId: value.appId, capturedAt: value.capturedAt, source: value.source as GraphSnapshot['source'], sqlExecutions, stages, findings: annotations(value.findings) };
}
export interface LayoutNode { id: string; label: string; subtitle: string; annotations: GraphAnnotation[]; x: number; y: number }
/** Layout consumes only supplied edges. Cycles are retained, never inferred. */
export function layoutGraph(nodes: Omit<LayoutNode, 'x' | 'y'>[], edges: GraphEdge[]) {
  const ids = new Set(nodes.map((n) => n.id));
  const validEdges = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  const indegree = new Map(nodes.map((n) => [n.id, 0]));
  const depth = new Map(nodes.map((n) => [n.id, 0]));
  validEdges.forEach((e) => indegree.set(e.target, indegree.get(e.target)! + 1));
  const queue = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    for (const edge of validEdges.filter((e) => e.source === id)) {
      depth.set(edge.target, Math.max(depth.get(edge.target)!, depth.get(id)! + 1));
      indegree.set(edge.target, indegree.get(edge.target)! - 1);
      if (indegree.get(edge.target) === 0) queue.push(edge.target);
    }
  }
  const rows = new Map<number, number>();
  const placed = nodes.map((node) => {
    const level = depth.get(node.id)!; const row = rows.get(level) ?? 0; rows.set(level, row + 1);
    return { ...node, x: row * 238 + 24, y: level * 126 + 24 };
  });
  return { nodes: placed, edges: validEdges, missingEdges: edges.length - validEdges.length, width: Math.max(280, ...placed.map((n) => n.x + 234)), height: Math.max(170, ...placed.map((n) => n.y + 118)) };
}
export function dedupeAnnotations(items: GraphAnnotation[]) { return [...new Map(items.map((a) => [a.findingId, a])).values()]; }
export function nodeAnnotations(snapshot: GraphSnapshot, sqlId: number, nodeId: number) {
  const sql = snapshot.sqlExecutions.find((s) => s.id === sqlId);
  return dedupeAnnotations([...snapshot.findings, ...(sql?.findings ?? []), ...(sql?.nodes.find((n) => n.nodeId === nodeId)?.annotations ?? [])]).filter((a) => a.target.scope === 'node' && a.target.appId === snapshot.appId && a.target.sqlId === sqlId && a.target.nodeId === nodeId);
}
export function stageAnnotations(snapshot: GraphSnapshot, stage: GraphStage) {
  return dedupeAnnotations([...snapshot.findings, ...stage.annotations]).filter((a) => a.target.scope === 'stage' && a.target.appId === snapshot.appId && a.target.stageId === stage.stageId && (a.target.attemptId === stage.attemptId || (a.target.attemptId === undefined && snapshot.stages.filter((s) => s.stageId === stage.stageId).length === 1)));
}
export function annotationTone(items: GraphAnnotation[]) { return items.some((a) => a.role === 'root_cause') ? 'root_cause' : items.some((a) => a.role === 'symptom') ? 'symptom' : 'observation'; }
export function followUpText(target: GraphTarget, evidence: unknown, intro: string, label: string) { return `${intro}\n${JSON.stringify(target, null, 2)}\n\n${label}:\n${JSON.stringify(evidence, null, 2)}`; }
