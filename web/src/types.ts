export interface SessionSummary {
  sid: string;
  title: string;
  status: string;
  purpose: string | null;
  createdAt: number;
  updatedAt: number;
  usage: { input: number; output: number };
  running: boolean;
}

export interface RemEvent {
  type: string;
  ts: number;
  [key: string]: unknown;
}

export interface Finding {
  stage: string;
  tools: string[];
  finding: string;
  ts: number;
}

export interface SessionDetail {
  session: { sid: string; title: string; status: string; purpose: string | null; createdAt: number };
  events: RemEvent[];
  findings: Finding[];
  reports: string[];
  running: boolean;
}

export interface AppInfo {
  id: string;
  name: string;
  completed: boolean;
  startTime?: string;
  durationMs?: number;
  user?: string;
}

export interface MemoryDoc {
  sid: string;
  title: string;
  description: string;
  tags: string[];
  date: string;
}

export interface DreamCandidate {
  id: number;
  date: string;
  content: string;
  status: 'pending' | 'approved' | 'rejected';
}
