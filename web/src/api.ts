import type { AppInfo, DreamCandidate, MemoryDoc, SessionDetail, SessionSummary } from './types.ts';
import type { Lang } from './i18n.tsx';

export function getAuthToken(): string {
  const urlParam = new URLSearchParams(window.location.search).get('token');
  if (urlParam) {
    localStorage.setItem('sparksleuth_token', urlParam);
    return urlParam;
  }
  return localStorage.getItem('sparksleuth_token') ?? '';
}

export function setAuthToken(token: string): void {
  if (token) {
    localStorage.setItem('sparksleuth_token', token);
  } else {
    localStorage.removeItem('sparksleuth_token');
  }
}

function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}`, 'x-sparksleuth-token': token } : {};
}

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed.error) msg = parsed.error;
    } catch {}
    throw new ApiError(msg || `${res.status} ${res.statusText}`, res.status);
  }
  return (await res.json()) as T;
}

export function languageBody(language: Lang): string {
  return JSON.stringify({ language });
}

async function text(res: Response): Promise<string> {
  // Never render an HTTP error body as a saved Markdown document.
  if (!res.ok) await json<never>(res);
  return res.text();
}

export interface ServerConfig {
  spark: {
    historyServerUrl: string;
  };
  llm: {
    baseUrl: string;
    model: string;
    maxTokens: number;
    hasApiKey: boolean;
    apiKeyPreview: string;
  };
  auth: {
    required: boolean;
  };
}

export interface TestHsResult {
  ok: boolean;
  version?: string;
  appsCount?: number;
  durationMs?: number;
  error?: string;
}

export interface TestLlmResult {
  ok: boolean;
  reply?: string;
  durationMs?: number;
  error?: string;
}

export const api = {
  health: () =>
    fetch('/api/health', { headers: authHeaders() }).then((r) =>
      json<{
        ok: boolean;
        historyServer: { ok: boolean; error?: string };
        model: { configured: boolean; model: string };
        authRequired?: boolean;
      }>(r),
    ),
  config: () => fetch('/api/config', { headers: authHeaders() }).then((r) => json<ServerConfig>(r)),
  updateConfig: (patch: {
    spark?: { historyServerUrl?: string };
    llm?: { baseUrl?: string; apiKey?: string; model?: string; maxTokens?: number };
    auth?: { token?: string };
  }) =>
    fetch('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify(patch),
    }).then((r) => json<ServerConfig>(r)),
  testHs: (url?: string) =>
    fetch('/api/config/test-hs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ url }),
    }).then((r) => json<TestHsResult>(r)),
  testLlm: (params: { baseUrl?: string; apiKey?: string; model?: string }) =>
    fetch('/api/config/test-llm', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify(params),
    }).then((r) => json<TestLlmResult>(r)),
  apps: () => fetch('/api/apps', { headers: authHeaders() }).then((r) => json<AppInfo[]>(r)),
  sessions: () => fetch('/api/sessions', { headers: authHeaders() }).then((r) => json<SessionSummary[]>(r)),
  session: (sid: string) => fetch(`/api/sessions/${sid}`, { headers: authHeaders() }).then((r) => json<SessionDetail>(r)),
  graph: (sid: string, appId?: string) =>
    fetch(`/api/sessions/${encodeURIComponent(sid)}/graph${appId ? `?appId=${encodeURIComponent(appId)}` : ''}`, { headers: authHeaders() }).then((r) => json<unknown>(r)),
  captureGraph: (sid: string, appId?: string) =>
    fetch(`/api/sessions/${encodeURIComponent(sid)}/graph`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify({ appId }),
    }).then((r) => json<unknown>(r)),
  create: (message: string, appId?: string, language?: Lang) =>
    fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ message, appId, language }),
    }).then((r) => json<{ sid: string }>(r)),
  send: (sid: string, message: string, language?: Lang) =>
    fetch(`/api/sessions/${sid}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ message, language }),
    }).then((r) => json<{ ok: boolean }>(r)),
  cancel: (sid: string) => fetch(`/api/sessions/${sid}/cancel`, { method: 'POST', headers: authHeaders() }).then((r) => json(r)),
  finish: (sid: string, language: Lang) => fetch(`/api/sessions/${encodeURIComponent(sid)}/finish`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: languageBody(language),
  }).then((r) => json(r)),
  report: (sid: string, file: string, signal?: AbortSignal) =>
    fetch(`/api/sessions/${encodeURIComponent(sid)}/reports/${encodeURIComponent(file)}`, { headers: authHeaders(), signal }).then(text),
  memory: (keyword?: string, signal?: AbortSignal) =>
    fetch(`/api/memory${keyword ? `?${new URLSearchParams({ keyword })}` : ''}`, { headers: authHeaders(), signal })
      .then((r) => json<Array<MemoryDoc & { desc?: string }>>(r))
      .then((docs) => docs.map((doc) => ({ ...doc, description: doc.description ?? doc.desc ?? '' }))),
  memoryDoc: (sid: string, signal?: AbortSignal) =>
    fetch(`/api/memory/${encodeURIComponent(sid)}`, { headers: authHeaders(), signal }).then(text),
  experience: (signal?: AbortSignal) =>
    fetch('/api/memory/experience', { headers: authHeaders(), signal }).then((r) => json<{ items: string[] }>(r)),
  dream: (language: Lang) => fetch('/api/memory/dream', {
    method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: languageBody(language),
  }).then((r) => json<{ candidates: number }>(r)),
  dreamCandidates: (signal?: AbortSignal) =>
    fetch('/api/memory/dream/candidates', { headers: authHeaders(), signal }).then((r) => json<DreamCandidate[]>(r)),
  reviewDream: (id: number, action: 'approve' | 'reject') =>
    fetch(`/api/memory/dream/candidates/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ action }),
    }).then((r) => json(r)),
};
