export type LinkStatus = 'ok' | 'moved' | 'dead' | 'blocked';

export interface CheckResult {
  status: LinkStatus;
  /** Final HTTP status, if any response was received. */
  httpStatus?: number;
  /** Final URL after redirects (only when it differs from the input). */
  finalUrl?: string;
  detail: string;
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface CheckerOptions {
  fetch: FetchFn;
  sleep: (ms: number) => Promise<void>;
  userAgent: string;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  maxRedirects?: number;
  /** Longest Retry-After we are willing to wait; longer means give up as `blocked`. */
  maxRetryAfterMs?: number;
}

const BLOCKED_STATUSES = new Set([401, 403, 999]);
const HEAD_FALLBACK_STATUSES = new Set([403, 405, 501]);
const DEAD_STATUSES = new Set([404, 410]);
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL']);

class TooManyRedirects extends Error {}

interface HttpOutcome {
  status: number;
  finalUrl: string;
  retryAfter: string | null;
}

function errorCode(err: unknown): string {
  const e = err as { name?: string; code?: string; cause?: { code?: string; name?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || e?.cause?.name === 'TimeoutError') return 'TIMEOUT';
  return e?.cause?.code ?? e?.code ?? 'NETWORK_ERROR';
}

/** Parse Retry-After (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

function samePlace(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const path = (u: URL) => u.pathname.replace(/\/+$/, '') || '/';
    return x.hostname.toLowerCase() === y.hostname.toLowerCase() && path(x) === path(y);
  } catch {
    return a === b;
  }
}

export class LinkChecker {
  private readonly o: Required<CheckerOptions>;

  constructor(options: CheckerOptions) {
    this.o = {
      timeoutMs: 10_000,
      retries: 2,
      backoffMs: 1_000,
      maxRedirects: 5,
      maxRetryAfterMs: 60_000,
      ...options,
    };
  }

  private async request(url: string, method: 'HEAD' | 'GET'): Promise<HttpOutcome> {
    let current = url;
    for (let hop = 0; ; hop++) {
      const res = await this.o.fetch(current, {
        method,
        redirect: 'manual',
        headers: { 'User-Agent': this.o.userAgent, Accept: '*/*' },
        signal: AbortSignal.timeout(this.o.timeoutMs),
      });
      // We only need the status line; release the connection.
      await res.body?.cancel().catch(() => undefined);
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        if (hop >= this.o.maxRedirects) throw new TooManyRedirects(`more than ${this.o.maxRedirects} redirects`);
        current = new URL(location, current).toString();
        continue;
      }
      return { status: res.status, finalUrl: current, retryAfter: res.headers.get('retry-after') };
    }
  }

  private async attempt(url: string): Promise<HttpOutcome> {
    const head = await this.request(url, 'HEAD');
    // Many servers mishandle HEAD; confirm with GET before trusting a refusal or a 404/410.
    if (HEAD_FALLBACK_STATUSES.has(head.status) || DEAD_STATUSES.has(head.status)) {
      return this.request(url, 'GET');
    }
    return head;
  }

  async check(url: string): Promise<CheckResult> {
    let last: CheckResult = { status: 'dead', detail: 'not checked' };
    for (let attempt = 0; attempt <= this.o.retries; attempt++) {
      let waitMs = this.o.backoffMs * 2 ** attempt;
      let retryable = false;
      try {
        const r = await this.attempt(url);
        const moved = !samePlace(url, r.finalUrl);
        const base = { httpStatus: r.status, ...(r.finalUrl !== url ? { finalUrl: r.finalUrl } : {}) };
        if (r.status >= 200 && r.status < 400) {
          return moved
            ? { status: 'moved', ...base, detail: `redirects to ${r.finalUrl}` }
            : { status: 'ok', ...base, detail: `HTTP ${r.status}` };
        }
        if (DEAD_STATUSES.has(r.status)) return { status: 'dead', ...base, detail: `HTTP ${r.status}` };
        if (r.status === 429) {
          const after = parseRetryAfter(r.retryAfter);
          last = { status: 'blocked', ...base, detail: 'rate limited (HTTP 429)' };
          if (after !== null && after > this.o.maxRetryAfterMs) {
            return { ...last, detail: `rate limited (HTTP 429, Retry-After ${Math.round(after / 1000)}s)` };
          }
          if (after !== null) waitMs = after;
          retryable = true;
        } else if (BLOCKED_STATUSES.has(r.status)) {
          return { status: 'blocked', ...base, detail: `HTTP ${r.status} (likely bot protection)` };
        } else if (r.status >= 500 && r.status <= 599) {
          last = { status: 'dead', ...base, detail: `HTTP ${r.status}` };
          retryable = true;
        } else {
          // Other 4xx and non-standard codes: the server answered but refused us; not proof the page is gone.
          return { status: 'blocked', ...base, detail: `HTTP ${r.status}` };
        }
      } catch (err) {
        if (err instanceof TooManyRedirects) return { status: 'blocked', detail: err.message };
        const code = errorCode(err);
        const detail = code === 'TIMEOUT' ? 'timeout' : DNS_CODES.has(code) ? `DNS failure (${code})` : `network error (${code})`;
        last = { status: 'dead', detail };
        retryable = true;
      }
      if (!retryable || attempt === this.o.retries) break;
      await this.o.sleep(waitMs);
    }
    return { ...last, detail: `${last.detail} after ${this.o.retries + 1} attempts` };
  }
}
