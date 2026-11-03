import type { AppInfo, DreamCandidate, MemoryDoc, SessionDetail, SessionSummary } from './types.ts';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => fetch('/api/health').then((r) => json<{ ok: boolean; historyServer: { ok: boolean; error?: string }; model: { configured: boolean; model: string } }>(r)),
  apps: () => fetch('/api/apps').then((r) => json<AppInfo[]>(r)),
  sessions: () => fetch('/api/sessions').then((r) => json<SessionSummary[]>(r)),
  session: (sid: string) => fetch(`/api/sessions/${sid}`).then((r) => json<SessionDetail>(r)),
  create: (message: string, appId?: string) =>
    fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, appId }),
    }).then((r) => json<{ sid: string }>(r)),
  send: (sid: string, message: string) =>
    fetch(`/api/sessions/${sid}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    }).then((r) => json<{ ok: boolean }>(r)),
  cancel: (sid: string) => fetch(`/api/sessions/${sid}/cancel`, { method: 'POST' }).then((r) => json(r)),
  finish: (sid: string) => fetch(`/api/sessions/${sid}/finish`, { method: 'POST' }).then((r) => json(r)),
  report: (sid: string, file: string) => fetch(`/api/sessions/${sid}/reports/${file}`).then((r) => r.text()),
  memory: (keyword?: string) =>
    fetch(`/api/memory${keyword ? `?keyword=${encodeURIComponent(keyword)}` : ''}`).then((r) => json<MemoryDoc[]>(r)),
  memoryDoc: (sid: string) => fetch(`/api/memory/${sid}`).then((r) => r.text()),
  experience: () => fetch('/api/memory/experience').then((r) => json<{ items: string[] }>(r)),
  dream: () => fetch('/api/memory/dream', { method: 'POST' }).then((r) => json<{ candidates: number }>(r)),
  dreamCandidates: () => fetch('/api/memory/dream/candidates').then((r) => json<DreamCandidate[]>(r)),
  reviewDream: (id: number, action: 'approve' | 'reject') =>
    fetch(`/api/memory/dream/candidates/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    }).then((r) => json(r)),
};
