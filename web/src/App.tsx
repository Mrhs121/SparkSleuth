import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import { api } from './api.ts';
import type { AppInfo, DreamCandidate, Finding, MemoryDoc, RemEvent, SessionSummary } from './types.ts';

/* ------------------------------------------------------------------ *
 * Event stream -> chat items
 * ------------------------------------------------------------------ */

type Item =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; thinking: string }
  | { kind: 'tool'; id: string; skill: string; tool: string; input: unknown; summary?: string; isError?: boolean; artifact?: string }
  | { kind: 'purpose'; purpose: string; target?: string; desc: string }
  | { kind: 'finding'; stage: string; finding: string; tools: string[] }
  | { kind: 'report'; title: string; path: string }
  | { kind: 'error'; message: string }
  | { kind: 'note'; text: string };

function applyEvent(items: Item[], e: RemEvent): Item[] {
  switch (e.type) {
    case 'user_message':
      return [...items, { kind: 'user', text: String(e.text ?? '') }];
    case 'text_delta':
    case 'text': {
      const text = String(e.text ?? '');
      if (!text) return items;
      const last = items[items.length - 1];
      if (last?.kind === 'assistant') {
        return [...items.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...items, { kind: 'assistant', text, thinking: '' }];
    }
    case 'thinking':
    case 'thinking_delta': {
      const text = String(e.text ?? '');
      const last = items[items.length - 1];
      if (last?.kind === 'assistant') {
        return [...items.slice(0, -1), { ...last, thinking: last.thinking + text }];
      }
      return [...items, { kind: 'assistant', text: '', thinking: text }];
    }
    case 'tool_use':
      return [
        ...items,
        {
          kind: 'tool',
          id: String(e.id),
          skill: String(e.skill ?? ''),
          tool: String(e.tool ?? ''),
          input: e.input,
        },
      ];
    case 'tool_result': {
      const idx = items.findIndex((i) => i.kind === 'tool' && i.id === String(e.id));
      if (idx < 0) return items;
      const tool = items[idx] as Extract<Item, { kind: 'tool' }>;
      const updated: Item = {
        ...tool,
        summary: String(e.summary ?? ''),
        isError: Boolean(e.isError),
        artifact: e.artifact ? String(e.artifact) : undefined,
      };
      return [...items.slice(0, idx), updated, ...items.slice(idx + 1)];
    }
    case 'purpose':
      return [...items, { kind: 'purpose', purpose: String(e.purpose ?? ''), target: e.target as string, desc: String(e.desc ?? '') }];
    case 'finding':
      return [...items, { kind: 'finding', stage: String(e.stage ?? ''), finding: String(e.finding ?? ''), tools: (e.tools as string[]) ?? [] }];
    case 'report':
      return [...items, { kind: 'report', title: String(e.title ?? 'Report'), path: String(e.path ?? '') }];
    case 'error':
      return [...items, { kind: 'error', message: String(e.message ?? 'Unknown error') }];
    case 'done':
      return items;
    default:
      return items;
  }
}

/* ------------------------------------------------------------------ */

const STATUS_LABEL: Record<string, string> = {
  created: 'new',
  running: 'running',
  waiting: 'ready',
  finalizing: 'summarising',
  closed: 'closed',
  failed: 'failed',
  cancelled: 'stopped',
};

export function App() {
  const [view, setView] = useState<'chat' | 'memory'>('chat');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sid, setSid] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [reports, setReports] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [health, setHealth] = useState<{ ok: boolean; historyServer: { ok: boolean; error?: string }; model: { configured: boolean } } | null>(null);
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ input: number; output: number }>({ input: 0, output: 0 });

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await api.sessions());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refreshSessions();
    api.health().then(setHealth).catch(() => setHealth(null));
    api.apps().then(setApps).catch(() => setApps([]));
  }, [refreshSessions]);

  // Live event stream for the selected session.
  useEffect(() => {
    if (!sid) return;
    setItems([]);
    setFindings([]);
    setUsage({ input: 0, output: 0 });

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/sessions/${sid}`);

    ws.onmessage = (msg) => {
      const e = JSON.parse(msg.data as string) as RemEvent;
      if (e.type === 'finding') {
        setFindings((prev) => [...prev, { stage: String(e.stage), tools: (e.tools as string[]) ?? [], finding: String(e.finding), ts: e.ts }]);
      }
      if (e.type === 'usage' && e.usage) {
        const u = e.usage as { input: number; output: number };
        setUsage(u);
      }
      if (e.type === 'done') setRunning(false);
      if (e.type === 'error' || e.type === 'cancelled') setRunning(false);
      if (e.type === 'report') {
        void api.session(sid).then((d) => setReports(d.reports)).catch(() => {});
      }
      setItems((prev) => applyEvent(prev, e));
    };

    api
      .session(sid)
      .then((d) => {
        setReports(d.reports);
        setFindings(d.findings);
        setRunning(d.running);
        setStatus(d.session.status);
      })
      .catch(() => {});

    return () => ws.close();
  }, [sid]);

  const activeSession = sessions.find((s) => s.sid === sid);

  useEffect(() => {
    if (!activeSession) return;
    setRunning(activeSession.running || activeSession.status === 'running');
    setStatus(activeSession.status);
  }, [activeSession]);

  const onStart = async (message: string, appId?: string) => {
    setError(null);
    try {
      const { sid: newSid } = await api.create(message, appId);
      setSid(newSid);
      setRunning(true);
      await refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onSend = async (message: string) => {
    if (!sid) return onStart(message);
    setError(null);
    try {
      await api.send(sid, message);
      setRunning(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onCancel = async () => {
    if (!sid) return;
    await api.cancel(sid).catch(() => {});
    setRunning(false);
    await refreshSessions();
  };

  const onFinish = async () => {
    if (!sid) return;
    setStatus('finalizing');
    await api.finish(sid).catch((err) => setError(err instanceof Error ? err.message : String(err)));
    await refreshSessions();
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">S</span>
          <div>
            <div className="brand-name">SparkSleuth</div>
            <div className="brand-sub">Spark diagnostics</div>
          </div>
        </div>

        <button
          className="new-session"
          onClick={() => {
            setSid(null);
            setItems([]);
            setFindings([]);
            setReports([]);
            setView('chat');
          }}
        >
          + New investigation
        </button>

        <div className="session-list">
          {sessions.map((s) => (
            <button
              key={s.sid}
              className={`session ${s.sid === sid ? 'active' : ''}`}
              onClick={() => {
                setSid(s.sid);
                setView('chat');
              }}
            >
              <div className="session-title">{s.title || 'Untitled'}</div>
              <div className="session-meta">
                <span className={`dot ${s.running ? 'live' : s.status}`} />
                {STATUS_LABEL[s.status] ?? s.status}
                {s.purpose ? ` · ${s.purpose.split(':')[0]}` : ''}
              </div>
            </button>
          ))}
          {sessions.length === 0 && <div className="empty-small">No investigations yet.</div>}
        </div>

        <div className="sidebar-footer">
          <button className={`ghost ${view === 'memory' ? 'active' : ''}`} onClick={() => setView('memory')}>
            Memory
          </button>
          {health && (
            <div className="health" title={health.historyServer.error ?? ''}>
              <span className={`dot ${health.historyServer.ok ? 'waiting' : 'failed'}`} />
              History Server {health.historyServer.ok ? 'up' : 'unreachable'}
              {!health.model.configured && <div className="warn">Model key not configured</div>}
            </div>
          )}
        </div>
      </aside>

      {view === 'memory' ? (
        <MemoryView onBack={() => setView('chat')} />
      ) : (
        <main className="main">
          {!sid ? (
            <Composer apps={apps} onSend={onStart} running={false} large />
          ) : (
            <>
              <header className="topbar">
                <div>
                  <div className="topbar-title">{activeSession?.title ?? 'Investigation'}</div>
                  <div className="topbar-meta">
                    {status && <span className={`pill ${status}`}>{STATUS_LABEL[status] ?? status}</span>}
                    {running && <span className="pill live">live</span>}
                    <span className="mono">{sid.slice(0, 8)}</span>
                  </div>
                </div>
                <div className="topbar-actions">
                  {running ? (
                    <button className="ghost" onClick={onCancel}>
                      Stop
                    </button>
                  ) : (
                    <button className="ghost" onClick={onFinish}>
                      Close &amp; remember
                    </button>
                  )}
                </div>
              </header>

              <ChatStream items={items} running={running} />

              <Composer apps={apps} onSend={onSend} running={running} />
            </>
          )}
          {error && <div className="error-bar">{error}</div>}
        </main>
      )}

      {view === 'chat' && (
        <aside className="inspector">
          <InspectorTabs sid={sid} findings={findings} reports={reports} usage={usage} />
        </aside>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ChatStream({ items, running }: { items: Item[]; running: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [items.length, running]);

  if (!items.length) {
    return (
      <div className="empty-state">
        <h1>What should we look at?</h1>
        <p>
          Give me an application id, or describe the symptom. I will work through the History Server evidence — overview,
          stages, plan, data — and write up what is actually wrong.
        </p>
        <div className="hints">
          <span>“application_1700000000000_0042 is taking 3 hours instead of 30 minutes”</span>
          <span>“why did last night's ETL fail?”</span>
          <span>“which stage is eating the time in application_…?”</span>
        </div>
      </div>
    );
  }

  return (
    <div className="stream">
      {items.map((item, i) => (
        <ItemView key={i} item={item} />
      ))}
      {running && (
        <div className="working">
          <span className="spinner" /> investigating…
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case 'user':
      return <div className="bubble user">{item.text}</div>;
    case 'assistant':
      return (
        <div className="assistant">
          {item.thinking && (
            <details className="thinking">
              <summary>reasoning</summary>
              <div>{item.thinking}</div>
            </details>
          )}
          {item.text && <Markdown text={item.text} />}
        </div>
      );
    case 'tool':
      return <ToolCard item={item} />;
    case 'purpose':
      return (
        <div className="purpose">
          <span className="tag">{item.purpose}</span>
          {item.target && <span className="mono">{item.target}</span>}
          <span>{item.desc}</span>
        </div>
      );
    case 'finding':
      return (
        <div className="finding">
          <div className="finding-head">
            <span className="chev">★</span>
            {item.stage}
          </div>
          <div className="finding-body">{item.finding}</div>
        </div>
      );
    case 'report':
      return (
        <div className="report-card">
          <span className="report-icon">▤</span>
          <div>
            <div className="report-title">{item.title}</div>
            <div className="report-path">{item.path.split('/').pop()}</div>
          </div>
        </div>
      );
    case 'error':
      return <div className="bubble error">{item.message}</div>;
    default:
      return null;
  }
}

function ToolCard({ item }: { item: Extract<Item, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const pending = item.summary === undefined;
  return (
    <div className={`tool-card ${item.isError ? 'failed' : ''} ${pending ? 'pending' : ''}`}>
      <button className="tool-head" onClick={() => setOpen((o) => !o)}>
        <span className="tool-chev">{open ? '▾' : '▸'}</span>
        <span className="tool-name">
          {item.skill}.{item.tool}
        </span>
        <span className="tool-hint">{pending ? 'running…' : item.isError ? 'error' : compactInput(item.input)}</span>
      </button>
      {open && (
        <div className="tool-body">
          <div className="tool-section">input</div>
          <pre>{JSON.stringify(item.input, null, 2)}</pre>
          {item.summary && (
            <>
              <div className="tool-section">result</div>
              <pre>{item.summary}</pre>
            </>
          )}
          {item.artifact && <div className="tool-artifact">artifact: {item.artifact}</div>}
        </div>
      )}
      {!open && item.summary && !item.isError && <div className="tool-summary">{firstLines(item.summary, 2)}</div>}
    </div>
  );
}

function InspectorTabs({
  sid,
  findings,
  reports,
  usage,
}: {
  sid: string | null;
  findings: Finding[];
  reports: string[];
  usage: { input: number; output: number };
}) {
  const [tab, setTab] = useState<'timeline' | 'report' | 'usage'>('timeline');
  const [reportFile, setReportFile] = useState<string | null>(null);
  const [reportText, setReportText] = useState('');

  useEffect(() => {
    setReportFile(reports[0] ?? null);
  }, [reports.join(',')]);

  useEffect(() => {
    if (!sid || !reportFile) {
      setReportText('');
      return;
    }
    api.report(sid, reportFile).then(setReportText).catch(() => setReportText(''));
  }, [sid, reportFile]);

  return (
    <>
      <div className="tabs">
        <button className={tab === 'timeline' ? 'active' : ''} onClick={() => setTab('timeline')}>
          Timeline
        </button>
        <button className={tab === 'report' ? 'active' : ''} onClick={() => setTab('report')}>
          Report
        </button>
        <button className={tab === 'usage' ? 'active' : ''} onClick={() => setTab('usage')}>
          Usage
        </button>
      </div>

      <div className="inspector-body">
        {tab === 'timeline' && (
          <>
            {findings.length === 0 && <div className="empty-small">Milestones will appear here as the investigation progresses.</div>}
            <ol className="timeline">
              {findings.map((f, i) => (
                <li key={i}>
                  <div className="tl-stage">{f.stage}</div>
                  <div className="tl-finding">{f.finding}</div>
                  {f.tools.length > 0 && <div className="tl-tools">{f.tools.join(' · ')}</div>}
                </li>
              ))}
            </ol>
          </>
        )}

        {tab === 'report' && (
          <>
            {reports.length === 0 && <div className="empty-small">No report yet. The assistant writes one at the end of an investigation.</div>}
            {reports.length > 1 && (
              <select className="report-select" value={reportFile ?? ''} onChange={(e) => setReportFile(e.target.value)}>
                {reports.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            )}
            {reportText && (
              <div className="report-body">
                <Markdown text={reportText} />
              </div>
            )}
          </>
        )}

        {tab === 'usage' && (
          <div className="usage">
            <div className="usage-row">
              <span>input tokens</span>
              <strong>{usage.input.toLocaleString()}</strong>
            </div>
            <div className="usage-row">
              <span>output tokens</span>
              <strong>{usage.output.toLocaleString()}</strong>
            </div>
            <div className="usage-row">
              <span>total</span>
              <strong>{(usage.input + usage.output).toLocaleString()}</strong>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function Composer({
  apps,
  onSend,
  running,
  large,
}: {
  apps: AppInfo[];
  onSend: (message: string, appId?: string) => void;
  running: boolean;
  large?: boolean;
}) {
  const [text, setText] = useState('');
  const [appId, setAppId] = useState('');

  const submit = () => {
    const value = text.trim();
    if (!value || running) return;
    onSend(value, appId || undefined);
    setText('');
  };

  return (
    <div className={`composer ${large ? 'large' : ''}`}>
      {large && (
        <div className="composer-app">
          <select value={appId} onChange={(e) => setAppId(e.target.value)}>
            <option value="">Pick an application (optional)</option>
            {apps.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id} — {a.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="composer-box">
        <textarea
          value={text}
          placeholder={running ? 'Working — press Stop to interrupt' : 'Ask about an application, or describe the symptom…'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={large ? 3 : 2}
        />
        <button className="send" onClick={submit} disabled={running || !text.trim()}>
          {running ? '…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

function MemoryView({ onBack }: { onBack: () => void }) {
  const [docs, setDocs] = useState<MemoryDoc[]>([]);
  const [keyword, setKeyword] = useState('');
  const [docText, setDocText] = useState('');
  const [docSid, setDocSid] = useState<string | null>(null);
  const [experience, setExperience] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<DreamCandidate[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [d, e, c] = await Promise.all([api.memory(keyword || undefined), api.experience(), api.dreamCandidates()]);
    setDocs(d);
    setExperience(e.items);
    setCandidates(c);
  }, [keyword]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="main memory-page">
      <header className="topbar">
        <div>
          <div className="topbar-title">Memory</div>
          <div className="topbar-meta">What previous investigations concluded, and what a human approved.</div>
        </div>
        <div className="topbar-actions">
          <button
            className="ghost"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await api.dream().catch(() => {});
              await load();
              setBusy(false);
            }}
          >
            {busy ? 'Reflecting…' : 'Run dream'}
          </button>
          <button className="ghost" onClick={onBack}>
            Back
          </button>
        </div>
      </header>

      <div className="memory-grid">
        <section>
          <h3>Past investigations</h3>
          <input
            className="search"
            placeholder="Search titles, tags, descriptions"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <div className="doc-list">
            {docs.map((d) => (
              <button
                key={d.sid}
                className={`doc ${docSid === d.sid ? 'active' : ''}`}
                onClick={async () => {
                  setDocSid(d.sid);
                  setDocText(await api.memoryDoc(d.sid).catch(() => ''));
                }}
              >
                <div className="doc-title">{d.title}</div>
                <div className="doc-desc">{d.description}</div>
                <div className="doc-meta">
                  {d.date.slice(0, 10)} · {d.tags.join(', ')}
                </div>
              </button>
            ))}
            {docs.length === 0 && <div className="empty-small">Nothing remembered yet.</div>}
          </div>
        </section>

        <section>
          <h3>{docSid ? 'Write-up' : 'Lessons under review'}</h3>
          {docSid ? (
            <div className="report-body">
              <Markdown text={docText} />
            </div>
          ) : (
            <>
              <div className="candidate-list">
                {candidates.filter((c) => c.status === 'pending').map((c) => (
                  <div key={c.id} className="candidate">
                    <div>{c.content}</div>
                    <div className="candidate-actions">
                      <button
                        onClick={async () => {
                          await api.reviewDream(c.id, 'approve');
                          await load();
                        }}
                      >
                        Approve
                      </button>
                      <button
                        className="ghost"
                        onClick={async () => {
                          await api.reviewDream(c.id, 'reject');
                          await load();
                        }}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
                {candidates.filter((c) => c.status === 'pending').length === 0 && (
                  <div className="empty-small">No lessons waiting for review.</div>
                )}
              </div>

              <h3 className="spaced">Approved lessons</h3>
              <ul className="experience">
                {experience.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
                {experience.length === 0 && <div className="empty-small">None yet. Approve a candidate to promote it.</div>}
              </ul>
            </>
          )}
        </section>
      </div>
    </main>
  );
}

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => marked.parse(text, { async: false }) as string, [text]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function compactInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const entries = Object.entries(input as Record<string, unknown>).slice(0, 2);
  return entries.map(([k, v]) => `${k}=${String(v).slice(0, 24)}`).join(' ');
}

function firstLines(text: string, n: number): string {
  return text.split('\n').filter(Boolean).slice(0, n).join(' · ').slice(0, 160);
}
