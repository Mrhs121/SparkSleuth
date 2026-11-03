export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 300)}`);
    this.name = 'HttpError';
  }
}

export interface HttpOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  retries?: number;
}

/**
 * JSON GET with timeout, abort support and bounded retries on 429/5xx.
 * Kept dependency free on purpose: skills should not need an HTTP library.
 */
export async function httpJson<T>(url: string, opts: HttpOptions = {}): Promise<T> {
  const { timeoutMs = 30_000, signal, headers = {}, retries = 2 } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json', ...headers },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          lastErr = new HttpError(res.status, url, body);
          await sleep(backoff(attempt));
          continue;
        }
        throw new HttpError(res.status, url, body);
      }
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      const retryable = !(err instanceof HttpError) || err.status === 429 || err.status >= 500;
      if (!retryable || attempt >= retries || signal?.aborted) break;
      await sleep(backoff(attempt));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function backoff(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 4000) + Math.random() * 200;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
