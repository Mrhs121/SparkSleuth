import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, ApiError } from './api.ts';
import { useI18n } from './i18n.tsx';
import { localizeAnnotation, localizeMetricName, localizeEvidenceValue, localizeGraphWarning } from './graph-i18n.ts';
import { annotationTone, dedupeAnnotations, followUpText, layoutGraph, nodeAnnotations, parseGraphSnapshot, stageAnnotations,
  type GraphAnnotation, type GraphNavigation, type GraphSnapshot, type GraphTarget } from './graph.ts';

export function GraphPanel({ sid, active, readOnly, appIds, signal, navigation, onFollowUp, onNavigate }: {
  sid: string; active: boolean; readOnly: boolean; appIds: string[];
  signal: { revision: number; appId?: string; snapshotSaved?: boolean }; navigation: GraphNavigation;
  onFollowUp: (text: string) => void; onNavigate: (target: GraphTarget) => void;
}) {
  const { t, lang } = useI18n();
  const [appId, setAppId] = useState('');
  const [snapshots, setSnapshots] = useState<Record<string, GraphSnapshot>>({});
  const [defaultApp, setDefaultApp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [view, setView] = useState<'sql' | 'stage'>('sql');
  const [sqlId, setSqlId] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [navigationError, setNavigationError] = useState('');
  const request = useRef(0);
  const handledSignal = useRef(0);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const snapshot = snapshots[appId || defaultApp];
  const options = [...new Set([...appIds, ...Object.keys(snapshots), ...(navigation.target ? [navigation.target.appId] : [])])];

  useEffect(() => {
    if (!appId && !defaultApp && options.length) setAppId(navigation.target?.appId || signal.appId || options[0]);
  }, [appId, defaultApp, appIds.join('|'), signal.appId, navigation.revision]);

  const load = useCallback(async (capture: boolean) => {
    const revision = ++request.current;
    setBusy(true); setError('');
    const requestedApp = appId || undefined;
    try {
      let value: unknown;
      if (capture && !readOnlyRef.current) value = await api.captureGraph(sid, requestedApp);
      else {
        try { value = await api.graph(sid, requestedApp); }
        catch (err) {
          if (!(err instanceof ApiError) || err.status !== 404 || readOnlyRef.current) throw err;
          value = await api.captureGraph(sid, requestedApp);
        }
      }
      const graph = parseGraphSnapshot(value);
      if (requestedApp && graph.appId !== requestedApp) throw new Error(t.graphWrongApp);
      if (revision !== request.current) return;
      setSnapshots((prev) => ({ ...prev, [graph.appId]: graph }));
      setDefaultApp(graph.appId);
    } catch (err) {
      if (revision === request.current) setError(err instanceof ApiError && err.status === 404 ? t.graphMissing : `${t.graphLoadError}: ${localizeGraphWarning(err instanceof Error ? err.message : String(err), lang)}`);
    } finally { if (revision === request.current) setBusy(false); }
  }, [sid, appId, lang, t.graphWrongApp, t.graphMissing, t.graphLoadError]);

  useEffect(() => {
    if (!active || (!appId && !defaultApp && options.length)) return;
    const fresh = signal.revision > handledSignal.current;
    if (fresh) handledSignal.current = signal.revision;
    void load(fresh && !signal.snapshotSaved && (!signal.appId || !appId || signal.appId === appId));
    return () => { request.current++; };
  }, [active, load, signal.revision, defaultApp, appIds.join('|'), readOnly]);

  useEffect(() => {
    if (!navigation.target) { setSelected(null); setNavigationError(''); return; }
    setAppId(navigation.target.appId);
    setView(navigation.target.scope === 'stage' ? 'stage' : 'sql');
    setSelected(null); setNavigationError('');
    if (navigation.target.scope === 'sql' || navigation.target.scope === 'node') setSqlId(navigation.target.sqlId);
    else setSqlId(null);
  }, [navigation.revision]);

  useEffect(() => {
    if (!snapshot) return;
    const target = navigation.target;
    if (!target || target.appId !== snapshot.appId) return;
    if (target.scope === 'node') {
      const sql = snapshot.sqlExecutions.find((s) => s.id === target.sqlId);
      const node = sql?.nodes.find((n) => n.nodeId === target.nodeId);
      setSelected(node?.id ?? null); setNavigationError(node ? '' : t.graphTargetMissing);
    } else if (target.scope === 'sql') {
      setNavigationError(snapshot.sqlExecutions.some((s) => s.id === target.sqlId) ? '' : t.graphTargetMissing);
    } else if (target.scope === 'stage') {
      const matches = snapshot.stages.filter((s) => s.stageId === target.stageId && (target.attemptId === undefined || target.attemptId === s.attemptId));
      setSelected(matches.length === 1 ? matches[0].id : null);
      setNavigationError(matches.length === 1 ? '' : matches.length > 1 ? t.graphAttemptAmbiguous : t.graphTargetMissing);
    }
  }, [snapshot, navigation.revision, t.graphTargetMissing, t.graphAttemptAmbiguous]);

  const sql = snapshot?.sqlExecutions.find((s) => s.id === sqlId) ?? (sqlId === null ? snapshot?.sqlExecutions[0] : undefined);
  const layout = useMemo(() => {
    if (!snapshot) return layoutGraph([], []);
    if (view === 'sql') return layoutGraph((sql?.nodes ?? []).map((n) => ({ id: n.id, label: n.name, subtitle: `${lang === 'zh' ? '节点' : 'node'} ${n.nodeId}`, annotations: nodeAnnotations(snapshot, sql!.id, n.nodeId) })), sql?.edges ?? []);
    // Stage parent IDs do not identify attempts: draw only when a parent resolves uniquely.
    const edges = snapshot.stages.flatMap((s) => (s.parentIds ?? []).flatMap((parentId) => {
      const parents = snapshot.stages.filter((p) => p.stageId === parentId);
      return parents.length === 1 ? [{ source: parents[0].id, target: s.id }] : [];
    }));
    return layoutGraph(snapshot.stages.map((s) => ({ id: s.id, label: s.name || `${lang === 'zh' ? '阶段' : 'Stage'} ${s.stageId}`, subtitle: `${lang === 'zh' ? '阶段' : 'Stage'} ${s.stageId} · ${lang === 'zh' ? '尝试' : 'attempt'} ${s.attemptId}`, annotations: stageAnnotations(snapshot, s) })), edges);
  }, [snapshot, view, sql, lang]);
  const stage = view === 'stage' ? snapshot?.stages.find((s) => s.id === selected) : undefined;
  const node = view === 'sql' ? sql?.nodes.find((n) => n.id === selected) : undefined;
  const target: GraphTarget | undefined = snapshot && (stage ? { scope: 'stage', appId: snapshot.appId, stageId: stage.stageId, attemptId: stage.attemptId } : node && sql ? { scope: 'node', appId: snapshot.appId, sqlId: sql.id, nodeId: node.nodeId } : undefined);
  const selectedAnnotations = snapshot && stage ? stageAnnotations(snapshot, stage) : snapshot && node && sql ? nodeAnnotations(snapshot, sql.id, node.nodeId) : [];
  const scopedAnnotations = snapshot ? dedupeAnnotations([...snapshot.findings, ...(view === 'sql' ? sql?.findings ?? [] : [])]).filter((a) => a.target.appId === snapshot.appId && (a.target.scope === 'application' || (view === 'sql' && a.target.scope === 'sql' && a.target.sqlId === sql?.id) || (view === 'stage' && a.target.scope === 'stage' && a.target.attemptId === undefined && snapshot.stages.filter((s) => a.target.scope === 'stage' && s.stageId === a.target.stageId).length !== 1))) : [];
  const metrics = stage?.metrics ?? (node ? Object.fromEntries(node.metrics.map((m) => [m.name, m.raw])) : {});
  const unresolvedParents = view === 'stage' && snapshot?.stages.some((s) => s.parentIds?.some((id) => snapshot.stages.filter((p) => p.stageId === id).length !== 1));

  return <section className="graph-panel" hidden={!active} aria-label={t.tabGraph}>
    <div className="graph-controls">
      <label>{t.graphApplication}<select value={appId || defaultApp} onChange={(e) => { setAppId(e.target.value); setSqlId(null); setSelected(null); setNavigationError(''); }}>
        {!options.length && <option value="">{t.graphSessionApplication}</option>}
        {options.map((id) => <option value={id} key={id}>{id}</option>)}
      </select></label>
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void load(!readOnly)}>{busy ? t.graphLoading : readOnly ? t.graphReload : t.graphRefresh}</button>
    </div>
    {readOnly && <div className="graph-notice">{t.graphReadOnly}</div>}
    {error && <div className="graph-error" role="alert">{error}{snapshot && <div>{t.graphRetained}</div>}</div>}
    {!snapshot && !busy && <div className="graph-empty"><strong>{t.graphNoSnapshot}</strong><p>{t.graphNoSnapshotHint}</p></div>}
    {!snapshot && busy && <div className="graph-empty" role="status">{t.graphLoading}</div>}
    {snapshot && <>
      <div className="graph-meta"><span>{t.graphCaptured} {new Date(snapshot.capturedAt).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')}</span><span>v{snapshot.version}</span></div>
      <details className="graph-source"><summary>{t.graphSource}</summary><code>{snapshot.source.url}</code></details>
      {snapshot.source.warnings.map((warning, i) => <div className="graph-notice" key={i}>{localizeGraphWarning(warning, lang)}</div>)}
      <div className="graph-view-switch"><button type="button" className={view === 'sql' ? 'active' : ''} onClick={() => { setView('sql'); setSelected(null); }}>{t.graphSqlView}</button><button type="button" className={view === 'stage' ? 'active' : ''} onClick={() => { setView('stage'); setSelected(null); }}>{t.graphStageView}</button></div>
      {view === 'sql' && <label className="graph-execution">{t.graphExecution}<select value={sql?.id ?? ''} onChange={(e) => { setSqlId(Number(e.target.value)); setSelected(null); setNavigationError(''); }}>
        {!sql && <option value="">{t.graphNoSql}</option>}
        {snapshot.sqlExecutions.map((s) => <option value={s.id} key={s.id}>SQL {s.id} · {s.description || s.status}</option>)}
      </select></label>}
      <div className="graph-legend"><span className="root_cause">{t.graphRootCause}</span><span className="symptom">{t.graphSymptom}</span><span className="observation">{t.graphObservation}</span></div>
      <p className="graph-caption">{view === 'sql' ? t.graphSqlTrust : t.graphStageTrust}</p>
      {navigationError && <div className="graph-notice" role="status">{navigationError}</div>}
      {layout.missingEdges > 0 && <div className="graph-notice">{t.graphMissingEndpoints}</div>}
      {unresolvedParents && <div className="graph-notice">{t.graphStageParentsMissing}</div>}
      {view === 'sql' && sql && !sql.graphAvailable && <div className="graph-notice">{t.graphMissingTopology}</div>}
      {snapshot.findings.length > 0 && <details className="graph-findings-list" open><summary>{t.graphHighlightedFindings} ({snapshot.findings.length})</summary>
        {snapshot.findings.map((a) => <button key={a.findingId} type="button" className={`graph-finding-jump ${a.role}`} onClick={() => onNavigate(a.target)}><span className="graph-finding-severity">{a.severity}</span><span><strong>{localizeAnnotation(a, lang).title}</strong><small>{a.ruleId} · {JSON.stringify(a.target)}</small><small>{Object.entries(a.evidence).filter(([key, value]) => !['appId', 'sqlId', 'nodeId', 'stageId', 'attemptId', 'operator'].includes(key) && (typeof value === 'number' || typeof value === 'string')).sort(([keyA, valueA], [keyB, valueB]) => { const priority = ['fanoutVsLargestInput', 'joinOutputRows', 'largestInputRows', 'memorySpill', 'diskSpill', 'memoryBytesSpilled', 'diskBytesSpilled']; const rank = (key: string, value: unknown) => { const index = priority.indexOf(key); return index >= 0 ? index : typeof value === 'number' ? priority.length : priority.length + 1; }; return rank(keyA, valueA) - rank(keyB, valueB); }).slice(0, 3).map(([key, value]) => `${localizeMetricName(key, lang)}: ${localizeEvidenceValue(key, value, lang)}`).join(' · ')}</small></span></button>)}
      </details>}
      {layout.nodes.length ? <GraphCanvas layout={layout} selected={selected} onSelect={setSelected} /> : <div className="graph-empty">{view === 'sql' ? t.graphNoSqlNodes : t.graphNoStages}</div>}
      {target ? <div className="graph-evidence">
        <div className="graph-evidence-header"><strong>{node?.name || stage?.name}</strong><button type="button" aria-label={t.hide} onClick={() => setSelected(null)}>×</button></div>
        <pre className="graph-target">{JSON.stringify(target, null, 2)}</pre>
        <h4>{t.graphMetrics}</h4>
        {Object.keys(metrics).length ? <dl className="graph-metrics">{Object.entries(metrics).map(([name, value]) => <div key={name}><dt>{localizeMetricName(name, lang)}</dt><dd>{localizeEvidenceValue(name, value, lang)}</dd></div>)}</dl> : <p className="graph-caption">{t.graphNoMetrics}</p>}
        {node && <details><summary>{t.graphRawMetrics}</summary><pre>{JSON.stringify(node.metrics, null, 2)}</pre></details>}
        <h4>{t.graphRuleEvidence}</h4>
        {selectedAnnotations.length ? selectedAnnotations.map((a) => <Annotation key={a.findingId} annotation={a} />) : <p className="graph-caption">{t.graphNoRules}</p>}
        <button type="button" className="btn btn-secondary graph-followup" disabled={readOnly} onClick={() => onFollowUp(followUpText(target, { metrics: node?.metrics ?? stage?.metrics, findings: selectedAnnotations.map((a) => ({ findingId: a.findingId, ruleId: a.ruleId, evidence: a.evidence, explanation: localizeAnnotation(a, lang).explanation })) }, t.graphFollowUpIntro, t.graphEvidence))}>{t.graphFollowUp}</button>
        <p className="graph-caption">{readOnly ? t.graphReadOnly : t.graphConfirmSend}</p>
      </div> : <p className="graph-caption graph-select-hint">{t.graphSelectNode}</p>}
      {scopedAnnotations.length > 0 && <div className="graph-scope-findings"><h4>{t.graphScopeFindings}</h4>{scopedAnnotations.map((a) => <Annotation key={a.findingId} annotation={a} />)}</div>}
      {!snapshot.findings.length && !layout.nodes.some((n) => n.annotations.length) && !scopedAnnotations.length && <p className="graph-caption">{t.graphNoRules}</p>}
    </>}
  </section>;
}

function Annotation({ annotation: a }: { annotation: GraphAnnotation }) {
  const { t, lang } = useI18n();
  const role = a.role === 'root_cause' ? t.graphRootCause : a.role === 'symptom' ? t.graphSymptom : t.graphObservation;
  return <article className={`graph-annotation ${a.role}`}><div className="graph-badges"><span>{a.severity}</span><span>{role}</span><code>{a.ruleId}</code></div><strong>{localizeAnnotation(a, lang).title}</strong><p>{localizeAnnotation(a, lang).explanation}</p><dl className="graph-metrics">{Object.entries(a.evidence).map(([key, value]) => <div key={key}><dt>{localizeMetricName(key, lang)}</dt><dd>{localizeEvidenceValue(key, value, lang)}</dd></div>)}</dl><details><summary>{t.graphEvidence} · {lang === 'zh' ? '原始 JSON' : 'raw JSON'}</summary><pre>{JSON.stringify(a.evidence, null, 2)}</pre></details></article>;
}

function GraphCanvas({ layout, selected, onSelect }: { layout: ReturnType<typeof layoutGraph>; selected: string | null; onSelect: (id: string) => void }) {
  const { t, lang } = useI18n();
  const marker = `graph-arrow-${useId().replace(/:/g, '')}`;
  const ref = useRef<SVGSVGElement>(null);
  const [camera, setCamera] = useState({ x: 0, y: 0, scale: 1 });
  const drag = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);
  const fit = useCallback(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const scale = Math.max(0.08, Math.min(1.5, (rect.width - 24) / layout.width, (rect.height - 24) / layout.height));
    setCamera({ x: (rect.width - layout.width * scale) / 2, y: (rect.height - layout.height * scale) / 2, scale });
  }, [layout.width, layout.height]);
  useEffect(() => { fit(); const observer = new ResizeObserver(fit); if (ref.current) observer.observe(ref.current); return () => observer.disconnect(); }, [fit]);
  useEffect(() => {
    if (!selected) return;
    const node = layout.nodes.find((n) => n.id === selected); const rect = ref.current?.getBoundingClientRect();
    if (node && rect) setCamera((prev) => ({ scale: Math.max(prev.scale, 0.8), x: rect.width / 2 - (node.x + 105) * Math.max(prev.scale, 0.8), y: rect.height / 2 - (node.y + 43) * Math.max(prev.scale, 0.8) }));
  }, [selected, layout]);
  const zoom = useCallback((factor: number, x?: number, y?: number) => {
    const rect = ref.current?.getBoundingClientRect(); if (!rect) return;
    const cx = x ?? rect.width / 2; const cy = y ?? rect.height / 2;
    setCamera((prev) => { const scale = Math.max(0.08, Math.min(3, prev.scale * factor)); return { scale, x: cx - (cx - prev.x) * scale / prev.scale, y: cy - (cy - prev.y) * scale / prev.scale }; });
  }, []);
  useEffect(() => {
    const svg = ref.current; if (!svg) return;
    const wheel = (e: WheelEvent) => { e.preventDefault(); const rect = svg.getBoundingClientRect(); zoom(Math.exp(-e.deltaY * 0.002), e.clientX - rect.left, e.clientY - rect.top); };
    svg.addEventListener('wheel', wheel, { passive: false }); return () => svg.removeEventListener('wheel', wheel);
  }, [zoom]);
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  return <div className="graph-canvas-wrap"><div className="graph-canvas-toolbar"><span>{t.graphPanHint}</span><button type="button" aria-label={t.graphZoomOut} onClick={() => zoom(0.8)}>−</button><span>{Math.round(camera.scale * 100)}%</span><button type="button" aria-label={t.graphZoomIn} onClick={() => zoom(1.25)}>+</button><button type="button" onClick={fit}>{t.graphFit}</button></div>
    <svg ref={ref} className="graph-canvas" role="img" aria-label={t.graphCanvasLabel}
      onPointerDown={(e) => { if ((e.target as Element).closest('[data-graph-node]')) return; e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, originX: camera.x, originY: camera.y }; }}
      onPointerMove={(e) => { const d = drag.current; if (d) setCamera((prev) => ({ ...prev, x: d.originX + e.clientX - d.x, y: d.originY + e.clientY - d.y })); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" /></marker></defs>
      <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.scale})`}>
        {layout.edges.map((e, i) => { const from = byId.get(e.source)!; const to = byId.get(e.target)!; const x1 = from.x + 105; const y1 = from.y + 86; const x2 = to.x + 105; const y2 = to.y; const mid = (y1 + y2) / 2; return <path key={`${e.source}:${e.target}:${i}`} className="graph-edge" d={`M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`} markerEnd={`url(#${marker})`}><title>{e.source} → {e.target}</title></path>; })}
        {layout.nodes.map((n) => <g key={n.id} data-graph-node="true" role="button" tabIndex={0} aria-label={`${n.label}, ${n.subtitle}`} aria-pressed={n.id === selected} className={`graph-node ${annotationTone(n.annotations)} ${n.id === selected ? 'selected' : ''}`} transform={`translate(${n.x} ${n.y})`} onClick={() => onSelect(n.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(n.id); } }}>
          <title>{n.label} · {n.subtitle}\n{n.annotations.map((a) => `${localizeAnnotation(a, lang).title} (${a.ruleId}): ${localizeAnnotation(a, lang).explanation}`).join('\n')}</title><rect width="210" height="86" rx="10" /><text x="14" y="25" className="graph-node-title">{n.label.length > 25 ? `${n.label.slice(0, 24)}…` : n.label}</text><text x="14" y="46" className="graph-node-id">{n.subtitle}</text><text x="14" y="69" className="graph-node-badge">{n.annotations.length ? `${n.annotations[0].severity} · ${localizeAnnotation(n.annotations[0], lang).title.slice(0, 24)}` : t.graphNoRulesShort}</text>
        </g>)}
      </g>
    </svg>
  </div>;
}
