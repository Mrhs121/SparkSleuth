/** Formatting helpers shared by tools, so summaries stay consistent and compact. */

export function bytes(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return 'n/a';
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(Math.abs(n)) / Math.log(1024)), units.length - 1);
  const v = n / 1024 ** i;
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

export function duration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return 'n/a';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  if (m < 60) return `${m}m${rs.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${(m % 60).toString().padStart(2, '0')}m`;
}

export function count(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return 'n/a';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(n / 1e4).toFixed(2)}万`;
  return n.toLocaleString('en-US');
}

export function pct(v: number | undefined | null, digits = 1): string {
  if (v === undefined || v === null || Number.isNaN(v)) return 'n/a';
  return `${(v * 100).toFixed(digits)}%`;
}

export function ratio(v: number | undefined | null): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return 'n/a';
  return `${v.toFixed(v >= 10 ? 0 : 1)}x`;
}

/** Trim a string to a maximum length, keeping both ends. */
export function truncate(s: string, max = 4000): string {
  if (s.length <= max) return s;
  const head = s.slice(0, Math.floor(max * 0.7));
  const tail = s.slice(-Math.floor(max * 0.2));
  return `${head}\n... [${s.length - head.length - tail.length} chars omitted] ...\n${tail}`;
}

/** Normalise error messages so similar failures cluster together. */
export function normalizeError(msg: string): string {
  return msg
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\b\d+(\.\d+)?\b/g, '<n>')
    .replace(/application_\d+_\d+/g, '<app>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}
