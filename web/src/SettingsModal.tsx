import { useEffect, useState } from 'react';
import { api, getAuthToken, setAuthToken, type ServerConfig, type TestHsResult, type TestLlmResult } from './api.ts';
import { useI18n } from './i18n.tsx';
import { IconCheck, IconCross, IconHistoryServer, IconKey, IconModel, IconRefresh, IconSettings } from './Icons.tsx';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
  initialTab?: 'hs' | 'llm' | 'auth';
}

export function SettingsModal({ isOpen, onClose, onSaved, initialTab = 'hs' }: SettingsModalProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<'hs' | 'llm' | 'auth'>(initialTab);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Form states
  const [hsUrl, setHsUrl] = useState('http://localhost:18080');
  const [llmBaseUrl, setLlmBaseUrl] = useState('https://api.anthropic.com');
  const [llmApiKey, setLlmApiKey] = useState('');
  const [llmModel, setLlmModel] = useState('claude-sonnet-4-5');
  const [llmMaxTokens, setLlmMaxTokens] = useState(8192);
  const [showApiKey, setShowApiKey] = useState(false);
  const [hasServerApiKey, setHasServerApiKey] = useState(false);
  const [apiKeyPreview, setApiKeyPreview] = useState('');
  const [token, setToken] = useState(getAuthToken());

  // Test states
  const [testingHs, setTestingHs] = useState(false);
  const [hsTestResult, setHsTestResult] = useState<TestHsResult | null>(null);

  const [testingLlm, setTestingLlm] = useState(false);
  const [llmTestResult, setLlmTestResult] = useState<TestLlmResult | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setTab(initialTab);
    setError(null);
    setSuccessMsg(null);
    setHsTestResult(null);
    setLlmTestResult(null);
    setLoading(true);

    api
      .config()
      .then((cfg: ServerConfig) => {
        setHsUrl(cfg.spark.historyServerUrl || 'http://localhost:18080');
        setLlmBaseUrl(cfg.llm.baseUrl || 'https://api.anthropic.com');
        setLlmModel(cfg.llm.model || 'claude-sonnet-4-5');
        setLlmMaxTokens(cfg.llm.maxTokens || 8192);
        setHasServerApiKey(cfg.llm.hasApiKey);
        setApiKeyPreview(cfg.llm.apiKeyPreview);
        setToken(getAuthToken());
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }, [isOpen, initialTab]);

  if (!isOpen) return null;

  const handleTestHs = async () => {
    setTestingHs(true);
    setHsTestResult(null);
    setError(null);
    try {
      const res = await api.testHs(hsUrl.trim());
      setHsTestResult(res);
    } catch (err) {
      setHsTestResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTestingHs(false);
    }
  };

  const handleTestLlm = async () => {
    setTestingLlm(true);
    setLlmTestResult(null);
    setError(null);
    try {
      const res = await api.testLlm({
        baseUrl: llmBaseUrl.trim(),
        apiKey: llmApiKey.trim() || undefined,
        model: llmModel.trim(),
      });
      setLlmTestResult(res);
    } catch (err) {
      setLlmTestResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTestingLlm(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccessMsg(null);
    try {
      // Save client token locally
      setAuthToken(token.trim());

      await api.updateConfig({
        spark: { historyServerUrl: hsUrl.trim() },
        llm: {
          baseUrl: llmBaseUrl.trim(),
          apiKey: llmApiKey.trim() || undefined,
          model: llmModel.trim(),
          maxTokens: Number(llmMaxTokens),
        },
        auth: { token: token.trim() },
      });

      setSuccessMsg(t.configSaved);
      setTimeout(() => {
        onSaved();
        onClose();
      }, 600);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="settings-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <div className="settings-title-group">
            <span className="settings-icon-badge">
              <IconSettings width={18} height={18} />
            </span>
            <div>
              <h2 className="settings-title">{t.settingsTitle}</h2>
              <p className="settings-subtitle">{t.settingsSubtitle}</p>
            </div>
          </div>
          <button className="settings-close-btn" onClick={onClose} aria-label="Close">
            <IconCross width={16} height={16} />
          </button>
        </div>

        <div className="settings-tabs">
          <button
            type="button"
            className={`settings-tab-btn ${tab === 'hs' ? 'active' : ''}`}
            onClick={() => {
              setTab('hs');
              setError(null);
            }}
          >
            <IconHistoryServer width={15} height={15} />
            <span>{t.tabHs}</span>
          </button>
          <button
            type="button"
            className={`settings-tab-btn ${tab === 'llm' ? 'active' : ''}`}
            onClick={() => {
              setTab('llm');
              setError(null);
            }}
          >
            <IconModel width={15} height={15} />
            <span>{t.tabLlm}</span>
          </button>
          <button
            type="button"
            className={`settings-tab-btn ${tab === 'auth' ? 'active' : ''}`}
            onClick={() => {
              setTab('auth');
              setError(null);
            }}
          >
            <IconKey width={15} height={15} />
            <span>{t.tabAuth}</span>
          </button>
        </div>

        <div className="settings-body">
          {loading ? (
            <div className="settings-loading">
              <span className="spinner" /> Loading...
            </div>
          ) : (
            <>
              {tab === 'hs' && (
                <div className="settings-pane">
                  <div className="settings-field">
                    <label className="settings-label">{t.hsUrlLabel}</label>
                    <div className="settings-input-group">
                      <input
                        type="url"
                        className="settings-input"
                        placeholder="http://localhost:18080"
                        value={hsUrl}
                        onChange={(e) => setHsUrl(e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn btn-secondary btn-test"
                        onClick={handleTestHs}
                        disabled={testingHs || !hsUrl.trim()}
                      >
                        {testingHs ? <span className="spinner" /> : <IconRefresh width={14} height={14} />}
                        <span>{testingHs ? t.testing : t.testConnection}</span>
                      </button>
                    </div>
                    <span className="settings-help">
                      Address of your Apache Spark History Server (REST API: <code>/api/v1/applications</code>).
                      Env: <code>SPARKSLEUTH_HS_URL</code>.
                    </span>
                  </div>

                  {hsTestResult && (
                    <div className={`settings-test-box ${hsTestResult.ok ? 'success' : 'failure'}`}>
                      <div className="test-header">
                        {hsTestResult.ok ? (
                          <span className="test-badge-ok">
                            <IconCheck width={14} height={14} /> {t.hsConnected}
                          </span>
                        ) : (
                          <span className="test-badge-err">
                            <IconCross width={14} height={14} /> {t.hsFailed}
                          </span>
                        )}
                        {hsTestResult.durationMs !== undefined && (
                          <span className="test-latency">{hsTestResult.durationMs}ms</span>
                        )}
                      </div>
                      {hsTestResult.ok ? (
                        <div className="test-details">
                          {hsTestResult.version && <div>{t.sparkVersion} <strong>{hsTestResult.version}</strong></div>}
                          <div>{t.appsIndexed} <strong>{hsTestResult.appsCount ?? 0}</strong></div>
                        </div>
                      ) : (
                        <div className="test-error-msg">{hsTestResult.error}</div>
                      )}
                    </div>
                  )}

                  <div className="settings-presets">
                    <span className="presets-title">{t.commonDefaults}</span>
                    <button
                      type="button"
                      className="preset-btn"
                      onClick={() => setHsUrl('http://localhost:18080')}
                    >
                      localhost:18080
                    </button>
                    <button
                      type="button"
                      className="preset-btn"
                      onClick={() => setHsUrl('http://127.0.0.1:18080')}
                    >
                      127.0.0.1:18080
                    </button>
                  </div>
                </div>
              )}

              {tab === 'llm' && (
                <div className="settings-pane">
                  <div className="settings-field">
                    <label className="settings-label">{t.llmBaseUrlLabel}</label>
                    <input
                      type="url"
                      className="settings-input"
                      placeholder="https://api.anthropic.com"
                      value={llmBaseUrl}
                      onChange={(e) => setLlmBaseUrl(e.target.value)}
                    />
                    <span className="settings-help">
                      Anthropic Messages compatible gateway (Anthropic, OneAPI, LiteLLM). Env: <code>SPARKSLEUTH_LLM_BASE_URL</code>.
                    </span>
                  </div>

                  <div className="settings-field">
                    <label className="settings-label">
                      {t.apiKeyLabel}
                      {hasServerApiKey && !llmApiKey && (
                        <span className="key-status-badge">{t.keyConfigured} ({apiKeyPreview})</span>
                      )}
                    </label>
                    <div className="settings-input-group">
                      <input
                        type={showApiKey ? 'text' : 'password'}
                        className="settings-input"
                        placeholder={hasServerApiKey ? '••••••••' : 'sk-ant-api03-...'}
                        value={llmApiKey}
                        onChange={(e) => setLlmApiKey(e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn btn-secondary btn-toggle-key"
                        onClick={() => setShowApiKey(!showApiKey)}
                      >
                        {showApiKey ? t.hideKey : t.showKey}
                      </button>
                    </div>
                    <span className="settings-help">
                      Env: <code>SPARKSLEUTH_LLM_API_KEY</code>.
                    </span>
                  </div>

                  <div className="settings-grid-2">
                    <div className="settings-field">
                      <label className="settings-label">{t.modelIdLabel}</label>
                      <input
                        type="text"
                        className="settings-input"
                        placeholder="claude-sonnet-4-5"
                        value={llmModel}
                        onChange={(e) => setLlmModel(e.target.value)}
                      />
                    </div>
                    <div className="settings-field">
                      <label className="settings-label">{t.maxTokensLabel}</label>
                      <input
                        type="number"
                        className="settings-input"
                        min={1024}
                        max={32768}
                        step={1024}
                        value={llmMaxTokens}
                        onChange={(e) => setLlmMaxTokens(Number(e.target.value))}
                      />
                    </div>
                  </div>

                  <div className="settings-presets">
                    <span className="presets-title">{t.quickSelectModel}</span>
                    {['claude-sonnet-4-5', 'claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022', 'deepseek-chat'].map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={`preset-btn ${llmModel === m ? 'active' : ''}`}
                        onClick={() => setLlmModel(m)}
                      >
                        {m}
                      </button>
                    ))}
                  </div>

                  <div className="settings-action-row">
                    <button
                      type="button"
                      className="btn btn-secondary btn-test"
                      onClick={handleTestLlm}
                      disabled={testingLlm || (!llmApiKey.trim() && !hasServerApiKey)}
                    >
                      {testingLlm ? <span className="spinner" /> : <IconRefresh width={14} height={14} />}
                      <span>{testingLlm ? t.testingModel : t.testModelBtn}</span>
                    </button>
                  </div>

                  {llmTestResult && (
                    <div className={`settings-test-box ${llmTestResult.ok ? 'success' : 'failure'}`}>
                      <div className="test-header">
                        {llmTestResult.ok ? (
                          <span className="test-badge-ok">
                            <IconCheck width={14} height={14} /> {t.modelConnected}
                          </span>
                        ) : (
                          <span className="test-badge-err">
                            <IconCross width={14} height={14} /> {t.modelFailed}
                          </span>
                        )}
                        {llmTestResult.durationMs !== undefined && (
                          <span className="test-latency">{llmTestResult.durationMs}ms</span>
                        )}
                      </div>
                      {llmTestResult.ok ? (
                        <div className="test-details">
                          <div>Model: <strong>{llmModel}</strong></div>
                          <div>{t.modelReply} <em>{llmTestResult.reply}</em></div>
                        </div>
                      ) : (
                        <div className="test-error-msg">{llmTestResult.error}</div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {tab === 'auth' && (
                <div className="settings-pane">
                  <div className="settings-field">
                    <label className="settings-label">{t.authTokenLabel}</label>
                    <input
                      type="password"
                      className="settings-input"
                      placeholder="Optional server auth token..."
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                    />
                    <span className="settings-help">
                      {t.authTokenHelp}
                    </span>
                  </div>
                </div>
              )}
            </>
          )}

          {error && <div className="settings-alert error">{error}</div>}
          {successMsg && <div className="settings-alert success">{successMsg}</div>}
        </div>

        <div className="settings-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            {t.cancel}
          </button>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving || loading}>
            {saving ? <span className="spinner" /> : <IconCheck width={14} height={14} />}
            <span>{saving ? t.applying : t.saveAndApply}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
