import test from 'node:test';
import assert from 'node:assert/strict';
import { annotationTone, followUpText, layoutGraph, nodeAnnotations, parseGraphSnapshot, parseGraphTarget, stageAnnotations, type GraphAnnotation, type GraphSnapshot } from '../src/graph.ts';

function snapshot(): GraphSnapshot {
  return { version: 1, appId: 'app-one', capturedAt: '2026-11-03T09:00:00Z', source: { type: 'spark-history-server', url: 'http://history', warnings: [] },
    sqlExecutions: [{ id: 2, description: 'Join', graphAvailable: true, findings: [], nodes: [
      { id: '11', nodeId: 11, name: 'Join', metrics: [{ name: 'rows', raw: '1,234', numeric: 1234 }], annotations: [] },
      { id: '22', nodeId: 22, name: 'Join', metrics: [], annotations: [] },
      { id: '33', nodeId: 33, name: 'Scan', metrics: [], annotations: [] },
    ], edges: [{ source: '33', target: '11' }, { source: '22', target: '11' }] }],
    stages: [{ id: '5:0', stageId: 5, attemptId: 0, name: 'Stage 5', status: 'COMPLETE', metrics: { spill: 10 }, annotations: [] }], findings: [] };
}
function finding(target: GraphAnnotation['target']): GraphAnnotation {
  return { findingId: 'f1', ruleId: 'SPILL', severity: 'P1', role: 'symptom', target, evidence: { spill: 10 }, title: 'Spill', explanation: 'Actual rule evidence' };
}

test('wire snapshot retains exact IDs, edge directions and raw metrics', () => {
  const original = snapshot();
  assert.deepEqual(parseGraphSnapshot(JSON.parse(JSON.stringify(original))), original);
});
test('layout retains branch/multi-input topology, never uses node list order', () => {
  const graph = snapshot().sqlExecutions[0];
  const nodes = graph.nodes.map((n) => ({ id: n.id, label: n.name, subtitle: '', annotations: n.annotations }));
  const layout = layoutGraph(nodes, graph.edges);
  assert.deepEqual(layout.edges, graph.edges);
  assert.ok(layout.nodes.find((n) => n.id === '11')!.y > layout.nodes.find((n) => n.id === '33')!.y);
  assert.equal(layoutGraph(nodes, []).edges.length, 0);
});
test('missing edge endpoints are explicit and not repaired', () => {
  const graph = snapshot(); graph.sqlExecutions[0].edges.push({ source: 'missing', target: '11' });
  const parsed = parseGraphSnapshot(graph);
  assert.equal(parsed.sqlExecutions[0].edges.length, 3);
  const layout = layoutGraph(parsed.sqlExecutions[0].nodes.map((n) => ({ id: n.id, label: n.name, subtitle: '', annotations: [] })), parsed.sqlExecutions[0].edges);
  assert.equal(layout.missingEdges, 1); assert.equal(layout.edges.length, 2);
});
test('duplicate operator names bind only exact app/execution/node targets', () => {
  const graph = snapshot(); graph.findings = [finding({ scope: 'node', appId: 'app-one', sqlId: 2, nodeId: 11 })];
  assert.equal(nodeAnnotations(graph, 2, 11).length, 1);
  assert.equal(nodeAnnotations(graph, 2, 22).length, 0);
  graph.findings[0].target.appId = 'app-other';
  assert.equal(nodeAnnotations(graph, 2, 11).length, 0);
});
test('Stage findings never map to SQL operators or ambiguous attempts', () => {
  const graph = snapshot(); graph.findings = [finding({ scope: 'stage', appId: 'app-one', stageId: 5 })];
  assert.equal(nodeAnnotations(graph, 2, 11).length, 0);
  assert.equal(stageAnnotations(graph, graph.stages[0]).length, 1);
  graph.stages.push({ ...graph.stages[0], id: '5:1', attemptId: 1 });
  assert.equal(stageAnnotations(graph, graph.stages[0]).length, 0);
  assert.equal(stageAnnotations(graph, graph.stages[1]).length, 0);
});
test('unstructured and malformed targets never produce guessed identifiers', () => {
  assert.equal(parseGraphTarget('Stage 5 SQL 2 node 11'), undefined);
  assert.equal(parseGraphTarget({ scope: 'node', appId: 'app-one', sqlId: '2', nodeId: 11 }), undefined);
  assert.deepEqual(parseGraphTarget({ scope: 'stage', appId: 'app-one', stageId: 0, attemptId: 0 }), { scope: 'stage', appId: 'app-one', stageId: 0, attemptId: 0 });
});
test('invalid snapshots are rejected rather than inventing graphs', () => {
  assert.throws(() => parseGraphSnapshot({}));
  const graph = snapshot(); graph.sqlExecutions[0].nodes.push({ ...graph.sqlExecutions[0].nodes[0] });
  assert.throws(() => parseGraphSnapshot(graph), /Duplicate/);
});
test('cycles terminate and preserve genuine edges', () => {
  const edges = [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }];
  assert.deepEqual(layoutGraph(['a', 'b'].map((id) => ({ id, label: id, subtitle: '', annotations: [] })), edges).edges, edges);
});
test('follow-up preserves exact IDs/evidence; no findings stays neutral', () => {
  const target = { scope: 'node' as const, appId: 'app-one', sqlId: 0, nodeId: 11 };
  const draft = followUpText(target, { raw: '1,234 rows' }, 'Review', 'Evidence');
  assert.ok(draft.includes(JSON.stringify(target, null, 2)));
  assert.ok(draft.includes('1,234 rows'));
  assert.ok(!draft.includes('stageId'));
  assert.equal(annotationTone([]), 'observation');
});
