import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import { api, getAuthToken, type ServerConfig } from './api.ts';
import { useI18n } from './i18n.tsx';
import type { AppInfo, DreamCandidate, Finding, MemoryDoc, RemEvent, SessionSummary } from './types.ts';
import {
  IconAlert,
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconCopy,
  IconCross,
  IconDocument,
  IconFlame,
  IconHistoryServer,
  IconMemory,
  IconModel,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSend,
  IconSettings,
  IconSpark,
  IconStop,
  IconTerminal,
  IconTimeline,
  LogoIcon,
  LogoFull,
} from './Icons.tsx';
import { AppSelect } from './AppSelect.tsx';
import { SettingsModal } from './SettingsModal.tsx';

/* ------------------------------------------------------------------ *
 * Event stream -> chat items
 * ------------------------------------------------------------------ */

export type Item =
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
    case 'cancelled':
      return [...items, { kind: 'note', text: 'Investigation stopped by user.' }];
    case 'done':
      return items;
    default:
      return items;
  }
}

export function App() {
  const { lang, setLang, t } = useI18n();
  const [view, setView] = useState<'chat' | 'memory'>('chat');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sid, setSid] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [reports, setReports] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [health, setHealth] = useState<{
    ok: boolean;
    historyServer: { ok: boolean; error?: string };
    model: { configured: boolean; model: string };
    authRequired?: boolean;
  } | null>(null);
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [loadingApps, setLoadingApps] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ input: number; output: number }>({ input: 0, output: 0 });
  const [wsStatus, setWsStatus] = useState<'connected' | 'connecting' | 'reconnecting' | 'disconnected'>('disconnected');

  // Resizable inspector panel width state
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    const saved = localStorage.getItem('sparksleuth_inspector_width');
    return saved ? Math.max(320, Math.min(800, Number(saved))) : 420;
  });
  const [isResizing, setIsResizing] = useState(false);

  // Settings modal
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'hs' | 'llm' | 'auth'>('hs');

  const getStatusLabel = useCallback((st: string) => {
    switch (st) {
      case 'created': return t.status_created;
      case 'running': return t.status_running;
      case 'waiting': return t.status_waiting;
      case 'finalizing': return t.status_finalizing;
      case 'closed': return t.status_closed;
      case 'failed': return t.status_failed;
      case 'cancelled': return t.status_cancelled;
      default: return st;
    }
  }, [t]);

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await api.sessions());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('401') || msg.includes('unauthorized')) {
        setSettingsTab('auth');
        setShowSettingsModal(true);
      }
      setError(msg);
    }
  }, []);

  const refreshHealthAndApps = useCallback(async () => {
    try {
      const h = await api.health();
      setHealth(h);
      if (h.authRequired && !getAuthToken()) {
        setSettingsTab('auth');
        setShowSettingsModal(true);
      }
    } catch {
      setHealth(null);
    }

    setLoadingApps(true);
    try {
      const fetchedApps = await api.apps();
      setApps(fetchedApps);
    } catch {
      setApps([]);
    } finally {
      setLoadingApps(false);
    }
  }, []);

  useEffect(() => {
    void refreshSessions();
    void refreshHealthAndApps();
  }, [refreshSessions, refreshHealthAndApps]);

  // Live event stream for the selected session with automatic reconnection
  useEffect(() => {
    if (!sid) return;

    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let reconnectAttempts = 0;

    const connect = () => {
      if (disposed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const token = getAuthToken();
      const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : '';
      setWsStatus('connecting');

      ws = new WebSocket(`${proto}://${location.host}/ws/sessions/${sid}${tokenQuery}`);

      ws.onopen = () => {
        if (disposed) {
          ws?.close();
          return;
        }
        setWsStatus('connected');
        reconnectAttempts = 0;
      };

      let replaying = true;
      let replayItems: Item[] = [];
      let replayFindings: Finding[] = [];

      ws.onmessage = (msg) => {
        try {
          const e = JSON.parse(msg.data as string) as RemEvent;
          if (e.type === 'replay_complete') {
            replaying = false;
            setItems(replayItems);
            setFindings(replayFindings);
            return;
          }

          if (replaying) {
            if (e.type === 'finding') {
              replayFindings = [
                ...replayFindings,
                { stage: String(e.stage), tools: (e.tools as string[]) ?? [], finding: String(e.finding), ts: e.ts },
              ];
            }
            if (e.type === 'usage' && e.usage) {
              setUsage(e.usage as { input: number; output: number });
            }
            replayItems = applyEvent(replayItems, e);
          } else {
            if (e.type === 'finding') {
              setFindings((prev) => [
                ...prev,
                { stage: String(e.stage), tools: (e.tools as string[]) ?? [], finding: String(e.finding), ts: e.ts },
              ]);
            }
            if (e.type === 'usage' && e.usage) {
              setUsage(e.usage as { input: number; output: number });
            }
            if (e.type === 'done' || e.type === 'error' || e.type === 'cancelled') {
              setRunning(false);
              void refreshSessions();
            }
            if (e.type === 'report') {
              void api.session(sid).then((d) => setReports(d.reports)).catch(() => {});
            }
            setItems((prev) => applyEvent(prev, e));
          }
        } catch {}
      };

      ws.onclose = () => {
        if (disposed) return;
        setWsStatus('reconnecting');
        const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts), 10000);
        reconnectAttempts++;
        reconnectTimeout = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    setItems([]);
    setFindings([]);
    setUsage({ input: 0, output: 0 });

    api
      .session(sid)
      .then((d) => {
        setReports(d.reports);
        setFindings(d.findings);
        setRunning(d.running);
        setStatus(d.session.status);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('401') || msg.includes('unauthorized')) {
          setSettingsTab('auth');
          setShowSettingsModal(true);
        }
      });

    connect();

    return () => {
      disposed = true;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) ws.close();
      setWsStatus('disconnected');
    };
  }, [sid, refreshSessions]);

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
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('401') || msg.includes('unauthorized')) {
        setSettingsTab('auth');
        setShowSettingsModal(true);
      }
      setError(msg);
    }
  };

  const onSend = async (message: string) => {
    if (!sid) return onStart(message);
    setError(null);
    try {
      await api.send(sid, message);
      setRunning(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('401') || msg.includes('unauthorized')) {
        setSettingsTab('auth');
        setShowSettingsModal(true);
      }
      setError(msg);
    }
  };

  const onCancel = async () => {
    if (!sid) return;
    await api.cancel(sid).catch(() => {});
    setRunning(false);
    setStatus('cancelled');
    await refreshSessions();
  };

  const onFinish = async () => {
    if (!sid || status === 'closed' || status === 'finalizing') return;
    setStatus('finalizing');
    try {
      await api.finish(sid);
      setStatus('closed');
      await refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refreshSessions();
    }
  };

  // Splitter drag handler
  const startResizing = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);

    const onMouseMove = (moveEvent: MouseEvent) => {
      const newWidth = window.innerWidth - moveEvent.clientX;
      const clamped = Math.max(320, Math.min(Math.floor(window.innerWidth * 0.6), newWidth));
      setInspectorWidth(clamped);
      localStorage.setItem('sparksleuth_inspector_width', String(clamped));
    };

    const onMouseUp = () => {
      setIsResizing(false);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, []);

  const isClosed = status === 'closed';

  return (
    <div
      className={`app ${isResizing ? 'is-resizing' : ''}`}
      style={{
        gridTemplateColumns:
          view === 'memory' || !sid
            ? '270px minmax(0, 1fr)'
            : `270px minmax(0, 1fr) 8px ${inspectorWidth}px`,
      }}
    >
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" title="SparkSleuth">
            <LogoIcon width={24} height={24} />
          </span>
          <div className="brand-info">
            <div className="brand-name">{t.brandName}</div>
            <div className="brand-sub">{t.brandSub}</div>
          </div>
        </div>

        <button
          type="button"
          className="new-session"
          onClick={() => {
            setSid(null);
            setItems([]);
            setFindings([]);
            setReports([]);
            setStatus('');
            setView('chat');
          }}
        >
          <IconPlus width={15} height={15} />
          <span>{t.newInvestigation}</span>
          <span className="key-hint">{t.keyHint}</span>
        </button>

        <div className="session-list-section">
          <div className="section-label">{t.pastInvestigations}</div>
          <div className="session-list">
            {sessions.map((s) => (
              <button
                key={s.sid}
                type="button"
                className={`session ${s.sid === sid ? 'active' : ''}`}
                onClick={() => {
                  setSid(s.sid);
                  setView('chat');
                }}
              >
                <div className="session-title">{s.title || 'Untitled Session'}</div>
                <div className="session-meta">
                  <span className={`dot ${s.running ? 'running live-pulse' : s.status}`} />
                  <span className="status-text">{getStatusLabel(s.status)}</span>
                  {s.purpose ? <span className="purpose-pill">{s.purpose.split(':')[0]}</span> : null}
                </div>
              </button>
            ))}
            {sessions.length === 0 && <div className="empty-small">{t.noInvestigations}</div>}
          </div>
        </div>

        <div className="sidebar-footer">
          {health && (
            <div
              className="health-card clickable"
              onClick={() => {
                setSettingsTab(health.historyServer.ok ? 'llm' : 'hs');
                setShowSettingsModal(true);
              }}
              title="Click to configure Spark History Server and LLM parameters"
            >
              <div className="health-row">
                <span className={`dot ${health.historyServer.ok ? 'running' : 'failed'}`} />
                <span className="health-name">
                  {health.historyServer.ok ? t.historyServerConnected : t.historyServerOffline}
                </span>
                <span className="health-badge-edit">{t.edit}</span>
              </div>
              {!health.model.configured ? (
                <div className="health-warn">
                  <IconAlert width={12} height={12} />
                  <span>{t.modelKeyMissing}</span>
                </div>
              ) : (
                <div className="health-model-info">
                  <IconModel width={11} height={11} />
                  <span>{health.model.model}</span>
                </div>
              )}
            </div>
          )}

          <div className="footer-nav">
            <button
              type="button"
              className={`nav-btn ${view === 'memory' ? 'active' : ''}`}
              onClick={() => setView('memory')}
            >
              <IconMemory width={15} height={15} />
              <span>{t.memory}</span>
            </button>
            <button
              type="button"
              className="nav-btn ghost-settings"
              onClick={() => {
                setSettingsTab('hs');
                setShowSettingsModal(true);
              }}
            >
              <IconSettings width={15} height={15} />
              <span>{t.settings}</span>
            </button>
          </div>
        </div>
      </aside>

      {view === 'memory' ? (
        <MemoryView onBack={() => setView('chat')} />
      ) : (
        <main className="main">
          {!sid ? (
            <HeroLauncher
              apps={apps}
              loadingApps={loadingApps}
              onRefreshApps={refreshHealthAndApps}
              onOpenSettings={() => {
                setSettingsTab('hs');
                setShowSettingsModal(true);
              }}
              onStart={onStart}
              historyServerOk={Boolean(health?.historyServer.ok)}
              modelConfigured={Boolean(health?.model.configured)}
            />
          ) : (
            <>
              <header className="topbar">
                <div className="topbar-info">
                  <div className="topbar-title">{activeSession?.title ?? 'Investigation'}</div>
                  <div className="topbar-meta">
                    {status && <span className={`pill ${status}`}>{getStatusLabel(status)}</span>}
                    {running && <span className="pill live">{t.status_running}</span>}
                    {wsStatus === 'reconnecting' && <span className="pill warn">Reconnecting</span>}
                    <span className="mono session-id">{sid.slice(0, 8)}</span>
                  </div>
                </div>
                <div className="topbar-actions">
                  {/* Language switch button */}
                  <button
                    type="button"
                    className="btn btn-secondary btn-lang"
                    onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
                    title={t.langTitle}
                  >
                    {t.langToggle}
                  </button>

                  <button
                    type="button"
                    className="btn btn-secondary btn-icon-only"
                    onClick={() => {
                      setSettingsTab('hs');
                      setShowSettingsModal(true);
                    }}
                    title={t.settingsTooltip}
                  >
                    <IconSettings width={15} height={15} />
                  </button>

                  {running ? (
                    <button type="button" className="btn btn-danger" onClick={onCancel}>
                      <IconStop width={14} height={14} />
                      <span>{t.stopInvestigation}</span>
                    </button>
                  ) : !isClosed ? (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={onFinish}
                      disabled={status === 'finalizing'}
                    >
                      <IconCheck width={14} height={14} />
                      <span>{status === 'finalizing' ? t.archiving : t.closeAndRemember}</span>
                    </button>
                  ) : (
                    <span className="closed-badge">{t.archivedBadge}</span>
                  )}
                </div>
              </header>

              <ChatStream items={items} running={running} />

              <Composer
                onSend={onSend}
                running={running}
                disabled={isClosed}
                disabledPlaceholder={t.composerDisabledPlaceholder}
              />
            </>
          )}
          {error && (
            <div className="error-bar">
              <IconAlert width={15} height={15} />
              <span className="error-text">{error}</span>
              <button type="button" className="error-close" onClick={() => setError(null)}>
                <IconCross width={14} height={14} />
              </button>
            </div>
          )}
        </main>
      )}

      {/* The inspector and resizer ONLY render when in chat view AND sid is present */}
      {view === 'chat' && sid && (
        <>
          <div
            className="resizer-handle"
            onMouseDown={startResizing}
            onDoubleClick={() => {
              setInspectorWidth(420);
              localStorage.setItem('sparksleuth_inspector_width', '420');
            }}
            title={t.resizerTooltip}
          >
            <div className="resizer-knob" />
          </div>
          <aside className="inspector" style={{ width: inspectorWidth }}>
            <InspectorTabs sid={sid} findings={findings} reports={reports} usage={usage} />
          </aside>
        </>
      )}

      <SettingsModal
        isOpen={showSettingsModal}
        initialTab={settingsTab}
        onClose={() => setShowSettingsModal(false)}
        onSaved={() => {
          void refreshSessions();
          void refreshHealthAndApps();
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Hero Launcher (Clean, purposeful start screen)
 * ------------------------------------------------------------------ */

function HeroLauncher({
  apps,
  loadingApps,
  onRefreshApps,
  onOpenSettings,
  onStart,
  historyServerOk,
  modelConfigured,
}: {
  apps: AppInfo[];
  loadingApps: boolean;
  onRefreshApps: () => void;
  onOpenSettings: () => void;
  onStart: (message: string, appId?: string) => void;
  historyServerOk: boolean;
  modelConfigured: boolean;
}) {
  const { lang, setLang, t } = useI18n();
  const [selectedAppId, setSelectedAppId] = useState('');
  const [prompt, setPrompt] = useState('');

  const handleSubmit = (overridePrompt?: string) => {
    const text = (overridePrompt ?? prompt).trim();
    if (!text) return;
    onStart(text, selectedAppId || undefined);
  };

  const templates = [
    {
      title: t.pb_skew_title,
      desc: t.pb_skew_desc,
      query: t.pb_skew_query,
    },
    {
      title: t.pb_bottleneck_title,
      desc: t.pb_bottleneck_desc,
      query: t.pb_bottleneck_query,
    },
    {
      title: t.pb_memory_title,
      desc: t.pb_memory_desc,
      query: t.pb_memory_query,
    },
    {
      title: t.pb_plan_title,
      desc: t.pb_plan_desc,
      query: t.pb_plan_query,
    },
  ];

  return (
    <div className="hero-launcher">
      {/* Top right language switch bar on hero */}
      <div className="hero-topbar-actions">
        <button
          type="button"
          className="btn btn-secondary btn-lang"
          onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
          title={t.langTitle}
        >
          {t.langToggle}
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-icon-only"
          onClick={onOpenSettings}
          title={t.settings}
        >
          <IconSettings width={15} height={15} />
        </button>
      </div>

      <div className="hero-header">
        <div className="hero-logo-banner">
          <LogoIcon width={52} height={52} />
        </div>
        <div className="hero-brand-pill">
          <LogoIcon width={14} height={14} />
          <span>{t.heroTag}</span>
        </div>
        <h1 className="hero-title">{t.heroTitle}</h1>
        <p className="hero-subtitle">{t.heroSubtitle}</p>
      </div>

      <div className="hero-card">
        {/* Application Selector */}
        <div className="hero-section">
          <div className="hero-section-head">
            <span className="hero-section-title">
              <IconHistoryServer width={15} height={15} />
              <span>{t.targetApp}</span>
            </span>
            <div className="hero-section-actions">
              <span className={`status-indicator ${historyServerOk ? 'online' : 'offline'}`}>
                {historyServerOk ? t.historyServerConnected : t.historyServerOffline}
              </span>
              <button
                type="button"
                className="btn-icon-link"
                onClick={onRefreshApps}
                disabled={loadingApps}
                title={t.refreshApps}
              >
                <IconRefresh width={13} height={13} className={loadingApps ? 'spinning' : ''} />
              </button>
              <button type="button" className="btn-text-link" onClick={onOpenSettings}>
                {t.configure}
              </button>
            </div>
          </div>

          <AppSelect
            apps={apps}
            selectedId={selectedAppId}
            onSelect={setSelectedAppId}
            loading={loadingApps}
            onRefresh={onRefreshApps}
          />
        </div>

        {/* Diagnostic Templates */}
        <div className="hero-section">
          <div className="hero-section-head">
            <span className="hero-section-title">{t.diagnosticPlaybooks}</span>
          </div>
          <div className="template-grid">
            {templates.map((tItem, idx) => (
              <button
                key={idx}
                type="button"
                className="template-card"
                onClick={() => {
                  setPrompt(tItem.query);
                }}
              >
                <div className="template-title">{tItem.title}</div>
                <div className="template-desc">{tItem.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Input Composer */}
        <div className="hero-composer">
          <textarea
            className="hero-textarea"
            rows={3}
            placeholder={
              selectedAppId
                ? t.composerPlaceholderApp(selectedAppId)
                : t.composerPlaceholderGeneral
            }
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
          <div className="hero-composer-footer">
            <span className="shortcut-hint">{t.shortcutHintHero}</span>
            <button
              type="button"
              className="btn btn-primary btn-submit-hero"
              onClick={() => handleSubmit()}
              disabled={!prompt.trim()}
            >
              <IconSend width={14} height={14} />
              <span>{t.startInvestigation}</span>
            </button>
          </div>
        </div>
      </div>

      {!modelConfigured && (
        <div className="hero-warning-banner" onClick={onOpenSettings}>
          <IconAlert width={16} height={16} />
          <span>{t.missingKeyBanner}</span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

type StreamEntry =
  | { type: 'single'; item: Item }
  | { type: 'tool_group'; tools: Extract<Item, { kind: 'tool' }>[] };

function ChatStream({ items, running }: { items: Item[]; running: boolean }) {
  const { t } = useI18n();
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [items.length, running]);

  // Group consecutive tools together into a clean, collapsible ToolGroupView
  const entries: StreamEntry[] = useMemo(() => {
    const result: StreamEntry[] = [];
    let currentTools: Extract<Item, { kind: 'tool' }>[] = [];

    for (const item of items) {
      if (item.kind === 'tool') {
        currentTools.push(item);
      } else {
        if (currentTools.length > 0) {
          result.push({ type: 'tool_group', tools: currentTools });
          currentTools = [];
        }
        result.push({ type: 'single', item });
      }
    }

    if (currentTools.length > 0) {
      result.push({ type: 'tool_group', tools: currentTools });
    }

    return result;
  }, [items]);

  if (!items.length) {
    return (
      <div className="empty-state">
        <div className="empty-icon-wrap">
          <IconSearch width={32} height={32} />
        </div>
        <h1>{t.emptyInitTitle}</h1>
        <p>{t.emptyInitDesc}</p>
      </div>
    );
  }

  return (
    <div className="stream">
      {entries.map((entry, idx) => {
        if (entry.type === 'tool_group') {
          return <ToolGroupView key={`tg-${idx}`} tools={entry.tools} />;
        }
        return <ItemView key={`it-${idx}`} item={entry.item} />;
      })}
      {running && (
        <div className="working">
          <span className="spinner" /> {t.analyzingSpinner}
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case 'user':
      return <UserMessageView text={item.text} />;
    case 'assistant':
      return (
        <div className="assistant">
          {item.thinking && <ReasoningView text={item.thinking} />}
          {item.text && <Markdown text={item.text} />}
        </div>
      );
    case 'tool':
      return <ToolCard item={item} />;
    case 'purpose':
      return <PurposeCard purpose={item.purpose} target={item.target} desc={item.desc} />;
    case 'finding':
      return <FindingCard stage={item.stage} finding={item.finding} tools={item.tools} />;
    case 'report':
      return (
        <div className="report-card">
          <span className="report-icon-wrap">
            <IconDocument width={20} height={20} />
          </span>
          <div className="report-info">
            <div className="report-title">{item.title}</div>
            <div className="report-path">{item.path.split('/').pop()}</div>
          </div>
        </div>
      );
    case 'note':
      return <div className="note-card">{item.text}</div>;
    case 'error':
      return <div className="bubble error">{item.message}</div>;
    default:
      return null;
  }
}

function UserMessageView({ text }: { text: string }) {
  const match = text.match(/^Spark application:\s*([^\n]+)\n\n?([\s\S]*)$/);
  if (match) {
    const appId = match[1].trim();
    const prompt = match[2].trim();
    return (
      <div className="bubble user">
        <div className="user-app-badge">
          <IconHistoryServer width={13} height={13} />
          <span className="app-id-label">{appId}</span>
        </div>
        {prompt && <div className="user-text">{prompt}</div>}
      </div>
    );
  }
  return <div className="bubble user">{text}</div>;
}

function ReasoningView({ text }: { text: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const lines = text.trim().split('\n').filter(Boolean);
  const firstLine = lines[0] ? (lines[0].length > 90 ? `${lines[0].slice(0, 90)}…` : lines[0]) : '';

  return (
    <div className={`reasoning-card ${open ? 'open' : ''}`}>
      <button type="button" className="reasoning-header" onClick={() => setOpen((o) => !o)}>
        <span className="reasoning-badge">
          <IconTerminal width={13} height={13} />
          <span>{t.reasoningTrace}</span>
        </span>
        <span className="reasoning-preview">{!open && firstLine}</span>
        <span className="reasoning-toggle">
          {open ? <IconChevronUp width={13} height={13} /> : <IconChevronDown width={13} height={13} />}
          <span>{open ? t.hide : t.linesCount(lines.length)}</span>
        </span>
      </button>
      {open && (
        <div className="reasoning-body">
          <pre>{text}</pre>
        </div>
      )}
    </div>
  );
}

function PurposeCard({ purpose, target, desc }: { purpose: string; target?: string; desc: string }) {
  return (
    <div className="purpose-card">
      <div className="purpose-header">
        <span className="purpose-type-pill">{purpose.replace('_', ' ')}</span>
        {target && <span className="purpose-target-mono">{target}</span>}
      </div>
      <div className="purpose-desc">{desc}</div>
    </div>
  );
}

function FindingCard({ stage, finding, tools }: { stage: string; finding: string; tools?: string[] }) {
  return (
    <div className="finding-card">
      <div className="finding-header">
        <span className="finding-stage-badge">
          <IconFlame width={12} height={12} />
          <span>{stage}</span>
        </span>
        {tools && tools.length > 0 && (
          <div className="finding-tools">
            {tools.map((tItem, idx) => (
              <span key={idx} className="finding-tool-pill">
                {tItem}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="finding-body">{finding}</div>
    </div>
  );
}

/**
 * Group of consecutive tool calls executed together.
 */
function ToolGroupView({ tools }: { tools: Extract<Item, { kind: 'tool' }>[] }) {
  const { t } = useI18n();
  if (tools.length === 1 && tools[0]) {
    return <ToolCard item={tools[0]} />;
  }

  const [open, setOpen] = useState(false);
  const anyPending = tools.some((tl) => tl.summary === undefined);
  const anyError = tools.some((tl) => tl.isError);

  return (
    <div className={`tool-group-card ${anyError ? 'has-error' : ''} ${anyPending ? 'pending' : 'done'}`}>
      <button type="button" className="tool-group-head" onClick={() => setOpen((o) => !o)}>
        <span className="tool-group-icon">
          {anyPending ? (
            <span className="tool-spinner" />
          ) : anyError ? (
            <IconCross width={12} height={12} />
          ) : (
            <IconCheck width={12} height={12} />
          )}
        </span>

        <span className="tool-group-title">
          {anyPending ? t.executingTools(tools.length) : t.completedTools(tools.length)}
        </span>

        <div className="tool-chips-preview">
          {tools.slice(0, 3).map((tl, i) => (
            <span key={i} className="tool-chip-tag mono">
              {tl.tool}
            </span>
          ))}
          {tools.length > 3 && <span className="tool-chip-more">+{tools.length - 3}</span>}
        </div>

        <span className="tool-group-toggle">
          {open ? <IconChevronUp width={13} height={13} /> : <IconChevronDown width={13} height={13} />}
          <span>{open ? t.hide : t.callsCount(tools.length)}</span>
        </span>
      </button>

      {open && (
        <div className="tool-group-body">
          {tools.map((tool, idx) => (
            <ToolCard key={tool.id || idx} item={tool} nested />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolCard({ item, nested }: { item: Extract<Item, { kind: 'tool' }>; nested?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const pending = item.summary === undefined;
  const isErr = Boolean(item.isError);

  return (
    <div className={`tool-card ${nested ? 'nested' : ''} ${isErr ? 'failed' : ''} ${pending ? 'pending' : 'done'}`}>
      <button type="button" className="tool-head" onClick={() => setOpen((o) => !o)}>
        <span className="tool-status-dot">
          {pending ? (
            <span className="tool-spinner" />
          ) : isErr ? (
            <IconCross width={11} height={11} />
          ) : (
            <IconCheck width={11} height={11} />
          )}
        </span>
        <span className="tool-skill-tag">{item.skill}</span>
        <span className="tool-name-text mono">{item.tool}</span>
        <span className="tool-hint">{pending ? '...' : isErr ? 'error' : compactInput(item.input)}</span>
        <span className="tool-chev">
          {open ? <IconChevronUp width={12} height={12} /> : <IconChevronDown width={12} height={12} />}
        </span>
      </button>

      {!open && item.summary && !isErr && (
        <div className="tool-summary">{firstLines(item.summary, 2)}</div>
      )}

      {open && (
        <div className="tool-body">
          <div className="tool-section-label">{t.inputParams}</div>
          <pre>{JSON.stringify(item.input, null, 2)}</pre>
          {item.summary && (
            <>
              <div className="tool-section-label">{t.execSummary}</div>
              <pre>{item.summary}</pre>
            </>
          )}
          {item.artifact && (
            <div className="tool-artifact-box">
              <span className="art-label">{t.savedArtifact}</span>
              <code>{item.artifact}</code>
            </div>
          )}
        </div>
      )}
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
  const { t } = useI18n();
  const [tab, setTab] = useState<'timeline' | 'report' | 'usage'>('timeline');
  const [reportFile, setReportFile] = useState<string | null>(null);
  const [reportText, setReportText] = useState('');
  const [copied, setCopied] = useState(false);

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

  const copyReport = () => {
    if (!reportText) return;
    navigator.clipboard.writeText(reportText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <>
      <div className="tabs">
        <button
          type="button"
          className={tab === 'timeline' ? 'active' : ''}
          onClick={() => setTab('timeline')}
        >
          <IconTimeline width={14} height={14} />
          <span>{t.tabTimeline}</span>
          {findings.length > 0 && <span className="tab-count">{findings.length}</span>}
        </button>
        <button
          type="button"
          className={tab === 'report' ? 'active' : ''}
          onClick={() => setTab('report')}
        >
          <IconDocument width={14} height={14} />
          <span>{t.tabReport}</span>
          {reports.length > 0 && <span className="tab-count">{reports.length}</span>}
        </button>
        <button
          type="button"
          className={tab === 'usage' ? 'active' : ''}
          onClick={() => setTab('usage')}
        >
          <IconModel width={14} height={14} />
          <span>{t.tabTokens}</span>
        </button>
      </div>

      <div className="inspector-body">
        {tab === 'timeline' && (
          <>
            {findings.length === 0 && (
              <div className="empty-small">{t.noFindings}</div>
            )}
            <ol className="timeline">
              {findings.map((f, i) => (
                <li key={i} className="timeline-item">
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
            {reports.length === 0 && (
              <div className="empty-small">{t.noReport}</div>
            )}
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
              <div className="report-container">
                <div className="report-toolbar">
                  <span className="report-file-name">{reportFile}</span>
                  <button type="button" className="copy-btn" onClick={copyReport}>
                    {copied ? <IconCheck width={13} height={13} /> : <IconCopy width={13} height={13} />}
                    <span>{copied ? t.copiedReport : t.copyReport}</span>
                  </button>
                </div>
                <div className="report-body">
                  <Markdown text={reportText} />
                </div>
              </div>
            )}
          </>
        )}

        {tab === 'usage' && (
          <div className="usage-container">
            <div className="usage-card">
              <div className="usage-header">{t.tokenConsumption}</div>
              <div className="usage-metric-row">
                <span className="label">{t.promptTokens}</span>
                <span className="val">{usage.input.toLocaleString()}</span>
              </div>
              <div className="usage-metric-row">
                <span className="label">{t.completionTokens}</span>
                <span className="val">{usage.output.toLocaleString()}</span>
              </div>
              <div className="usage-divider" />
              <div className="usage-metric-row total">
                <span className="label">{t.totalTokens}</span>
                <span className="val">{(usage.input + usage.output).toLocaleString()}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function Composer({
  onSend,
  running,
  disabled,
  disabledPlaceholder,
}: {
  onSend: (message: string) => void;
  running: boolean;
  disabled?: boolean;
  disabledPlaceholder?: string;
}) {
  const { t } = useI18n();
  const [text, setText] = useState('');

  const submit = () => {
    const value = text.trim();
    if (!value || running || disabled) return;
    onSend(value);
    setText('');
  };

  return (
    <div className="composer">
      <div className={`composer-box ${disabled ? 'disabled' : ''}`}>
        <textarea
          value={text}
          disabled={disabled}
          placeholder={
            disabled
              ? disabledPlaceholder ?? t.composerDisabledPlaceholder
              : running
              ? t.investigating
              : t.composerSessionPlaceholder
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
        />
        <div className="composer-footer">
          <span className="shortcut-hint">{t.shortcutHintChat}</span>
          <button
            type="button"
            className="send-btn"
            onClick={submit}
            disabled={disabled || running || !text.trim()}
          >
            {running ? <span className="send-spinner" /> : <IconSend width={13} height={13} />}
            <span>{running ? t.investigating : t.send}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Memory View (With clear Sub-Tabs & Return to Learnings button)
 * ------------------------------------------------------------------ */

function MemoryView({ onBack }: { onBack: () => void }) {
  const { lang, setLang, t } = useI18n();
  const [docs, setDocs] = useState<MemoryDoc[]>([]);
  const [keyword, setKeyword] = useState('');
  const [docText, setDocText] = useState('');
  const [docSid, setDocSid] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'learnings' | 'doc'>('learnings');
  const [experience, setExperience] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<DreamCandidate[]>([]);
  const [busy, setBusy] = useState(false);

  const selectedDoc = docs.find((d) => d.sid === docSid);

  const load = useCallback(async () => {
    const [d, e, c] = await Promise.all([
      api.memory(keyword || undefined).catch(() => []),
      api.experience().catch(() => ({ items: [] })),
      api.dreamCandidates().catch(() => []),
    ]);
    setDocs(d);
    setExperience(e.items);
    setCandidates(c);
  }, [keyword]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSelectDoc = async (caseSid: string) => {
    setDocSid(caseSid);
    setActiveTab('doc');
    const text = await api.memoryDoc(caseSid).catch(() => '');
    setDocText(text);
  };

  const handleBackToLearnings = () => {
    setActiveTab('learnings');
  };

  const pendingCount = candidates.filter((c) => c.status === 'pending').length;

  return (
    <main className="main memory-page">
      <header className="topbar">
        <div>
          <div className="topbar-title">{t.memoryTitle}</div>
          <div className="topbar-meta">{t.memorySubtitle}</div>
        </div>
        <div className="topbar-actions">
          {/* Language Switch Button */}
          <button
            type="button"
            className="btn btn-secondary btn-lang"
            onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
            title={t.langTitle}
          >
            {t.langToggle}
          </button>

          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await api.dream().catch(() => {});
              await load();
              setBusy(false);
            }}
          >
            {busy ? <span className="spinner" /> : <IconRefresh width={14} height={14} />}
            <span>{busy ? t.reflecting : t.runDream}</span>
          </button>

          <button type="button" className="btn btn-primary" onClick={onBack}>
            {t.backToChat}
          </button>
        </div>
      </header>

      <div className="memory-grid">
        {/* Left Column: Past Cases */}
        <section className="memory-col">
          <div className="memory-col-header">
            <h3>{t.pastCases}</h3>
            {docSid && (
              <button
                type="button"
                className="btn-show-rules-link"
                onClick={() => {
                  setDocSid(null);
                  setActiveTab('learnings');
                }}
              >
                {t.backToLearningsBtn}
              </button>
            )}
          </div>

          <div className="search-wrap">
            <IconSearch width={14} height={14} />
            <input
              className="search-box"
              placeholder={t.searchCasesPlaceholder}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>

          <div className="doc-list">
            {docs.map((d) => (
              <button
                key={d.sid}
                type="button"
                className={`doc-card ${docSid === d.sid && activeTab === 'doc' ? 'active' : ''}`}
                onClick={() => handleSelectDoc(d.sid)}
              >
                <div className="doc-title">{d.title}</div>
                <div className="doc-desc">{d.description}</div>
                <div className="doc-meta">
                  <span>{d.date.slice(0, 10)}</span>
                  {d.tags.length > 0 && <span className="doc-tags">{d.tags.join(', ')}</span>}
                </div>
              </button>
            ))}
            {docs.length === 0 && <div className="empty-small">{t.noCasesMatched}</div>}
          </div>
        </section>

        {/* Right Column: Tabbed View (Learnings vs Investigation Document) */}
        <section className="memory-col memory-col-content">
          <div className="memory-content-tabs">
            <button
              type="button"
              className={`memory-tab-pill ${activeTab === 'learnings' ? 'active' : ''}`}
              onClick={handleBackToLearnings}
            >
              <span>{t.tabLearnings}</span>
              {pendingCount > 0 && <span className="memory-count-badge">{pendingCount}</span>}
            </button>

            {docSid && (
              <button
                type="button"
                className={`memory-tab-pill ${activeTab === 'doc' ? 'active' : ''}`}
                onClick={() => setActiveTab('doc')}
              >
                <IconDocument width={13} height={13} />
                <span>{selectedDoc ? selectedDoc.title.slice(0, 24) : t.tabDoc}</span>
              </button>
            )}
          </div>

          {activeTab === 'doc' && docSid ? (
            <div className="doc-report-wrapper">
              <div className="doc-back-bar">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={handleBackToLearnings}
                >
                  {t.backToLearningsBtn}
                </button>
                <span className="doc-report-name">{selectedDoc?.title}</span>
              </div>
              <div className="report-body">
                <Markdown text={docText} />
              </div>
            </div>
          ) : (
            <div className="learnings-wrapper">
              <h3 className="section-subhead">{t.candidateTitle}</h3>
              <div className="candidate-list">
                {candidates
                  .filter((c) => c.status === 'pending')
                  .map((c) => (
                    <div key={c.id} className="candidate-card">
                      <div className="candidate-content">{c.content}</div>
                      <div className="candidate-actions">
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={async () => {
                            await api.reviewDream(c.id, 'approve');
                            await load();
                          }}
                        >
                          {t.approveRule}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={async () => {
                            await api.reviewDream(c.id, 'reject');
                            await load();
                          }}
                        >
                          {t.rejectRule}
                        </button>
                      </div>
                    </div>
                  ))}
                {pendingCount === 0 && (
                  <div className="empty-small">{t.noCandidates}</div>
                )}
              </div>

              <h3 className="section-subhead spaced">{t.approvedTitle}</h3>
              <ul className="experience-list">
                {experience.map((eItem, i) => (
                  <li key={i}>{eItem}</li>
                ))}
                {experience.length === 0 && (
                  <div className="empty-small">{t.noApprovedRules}</div>
                )}
              </ul>
            </div>
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
  const entries = Object.entries(input as Record<string, unknown>).slice(0, 3);
  return entries.map(([k, v]) => `${k}=${String(v).slice(0, 24)}`).join('  ');
}

function firstLines(text: string, n: number): string {
  return text.split('\n').filter(Boolean).slice(0, n).join(' · ').slice(0, 160);
}
