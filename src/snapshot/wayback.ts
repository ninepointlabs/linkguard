import type { FetchFn } from '../checker.js';
import { parseRetryAfter } from '../checker.js';
import { Pacer } from '../limit.js';
import { SnapshotError, type CreateOptions, type Snapshot, type SnapshotProvider } from './provider.js';

export interface WaybackOptions {
  fetch: FetchFn;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  userAgent: string;
  accessKey?: string;
  secretKey?: string;
  /** Minimum gap between availability lookups. */
  lookupIntervalMs?: number;
  /** Minimum gap between capture submissions (6/min by default). */
  submitIntervalMs?: number;
  pollIntervalMs?: number;
  maxPolls?: number;
  lookupRetries?: number;
}

const AVAILABLE_URL = 'https://archive.org/wayback/available';
const SAVE_URL = 'https://web.archive.org/save';
const TIMEOUT_MS = 30_000;

interface AvailableResponse {
  archived_snapshots?: {
    closest?: { status?: string; available?: boolean; url?: string; timestamp?: string };
  };
}

interface SaveResponse {
  job_id?: string;
  status?: string;
  status_ext?: string;
  message?: string;
}

interface StatusResponse extends SaveResponse {
  timestamp?: string;
  original_url?: string;
}

export function waybackUrl(timestamp: string, originalUrl: string): string {
  return `https://web.archive.org/web/${timestamp}/${originalUrl}`;
}

function toHttps(url: string): string {
  return url.replace(/^http:\/\/(web\.)?archive\.org\//i, (_m, web: string | undefined) => `https://${web ?? ''}archive.org/`);
}

function describe(body: SaveResponse): string {
  return [body.status_ext, body.message].filter(Boolean).join(': ') || 'no job_id in response';
}

export class WaybackProvider implements SnapshotProvider {
  readonly name = 'wayback';
  readonly canCreate: boolean;
  private readonly o: Required<Omit<WaybackOptions, 'accessKey' | 'secretKey'>>;
  private readonly auth: string | null;
  private readonly lookupPacer: Pacer;
  private readonly submitPacer: Pacer;

  constructor(options: WaybackOptions) {
    this.o = {
      now: Date.now,
      lookupIntervalMs: 1_000,
      submitIntervalMs: 10_000,
      pollIntervalMs: 15_000,
      maxPolls: 20,
      lookupRetries: 2,
      ...options,
    };
    this.auth = options.accessKey && options.secretKey ? `LOW ${options.accessKey}:${options.secretKey}` : null;
    this.canCreate = this.auth !== null;
    this.lookupPacer = new Pacer(this.o.lookupIntervalMs, this.o.now, this.o.sleep);
    this.submitPacer = new Pacer(this.o.submitIntervalMs, this.o.now, this.o.sleep);
  }

  async lookup(url: string): Promise<Snapshot | null> {
    const endpoint = `${AVAILABLE_URL}?url=${encodeURIComponent(url)}`;
    for (let attempt = 0; ; attempt++) {
      await this.lookupPacer.wait();
      let res: Response;
      try {
        res = await this.o.fetch(endpoint, {
          headers: { 'User-Agent': this.o.userAgent, Accept: 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        if (attempt < this.o.lookupRetries) {
          await this.o.sleep(2_000 * 2 ** attempt);
          continue;
        }
        throw new SnapshotError('failed', `availability lookup failed: ${(err as Error).message}`);
      }
      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel().catch(() => undefined);
        if (attempt < this.o.lookupRetries) {
          await this.o.sleep(parseRetryAfter(res.headers.get('retry-after'), this.o.now()) ?? 2_000 * 2 ** attempt);
          continue;
        }
        throw new SnapshotError(res.status === 429 ? 'rate-limited' : 'failed', `availability lookup: HTTP ${res.status}`);
      }
      if (!res.ok) throw new SnapshotError('failed', `availability lookup: HTTP ${res.status}`);
      let body: AvailableResponse;
      try {
        body = (await res.json()) as AvailableResponse;
      } catch {
        throw new SnapshotError('failed', 'availability lookup: invalid JSON');
      }
      const closest = body.archived_snapshots?.closest;
      if (!closest?.url || !closest.timestamp || !closest.available || !String(closest.status ?? '').startsWith('2')) {
        return null;
      }
      return { url: toHttps(closest.url), timestamp: closest.timestamp, source: this.name };
    }
  }

  private headers(): Record<string, string> {
    return { Accept: 'application/json', Authorization: this.auth!, 'User-Agent': this.o.userAgent };
  }

  async create(url: string, options: CreateOptions = {}): Promise<Snapshot> {
    if (!this.auth) throw new SnapshotError('failed', 'no Internet Archive keys configured (lookup-only mode)');
    await this.submitPacer.wait();
    let res: Response;
    try {
      res = await this.o.fetch(SAVE_URL, {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ url, skip_first_archive: '1' }).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new SnapshotError('failed', `capture request failed: ${(err as Error).message}`);
    }
    if (res.status === 429) {
      await res.body?.cancel().catch(() => undefined);
      throw new SnapshotError('rate-limited', 'capture rate limited (HTTP 429)');
    }
    const body = (await res.json().catch(() => ({}))) as SaveResponse;
    if (!res.ok) throw new SnapshotError('failed', `capture: HTTP ${res.status} ${describe(body)}`.trim());
    if (!body.job_id) throw new SnapshotError('failed', `capture refused: ${describe(body)}`);
    return this.poll(body.job_id, options.deadline);
  }

  private async poll(jobId: string, deadline?: number): Promise<Snapshot> {
    for (let i = 0; i < this.o.maxPolls; i++) {
      if (deadline !== undefined && this.o.now() + this.o.pollIntervalMs > deadline) {
        throw new SnapshotError('pending', `capture still pending at time budget (job ${jobId})`);
      }
      await this.o.sleep(this.o.pollIntervalMs);
      let res: Response;
      try {
        res = await this.o.fetch(`${SAVE_URL}/status/${encodeURIComponent(jobId)}`, {
          headers: this.headers(),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        continue; // transient; try again next poll
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        continue;
      }
      const body = (await res.json().catch(() => ({}))) as StatusResponse;
      if (body.status === 'pending') continue;
      if (body.status === 'success' && body.timestamp && body.original_url) {
        return { url: waybackUrl(body.timestamp, body.original_url), timestamp: body.timestamp, source: this.name };
      }
      throw new SnapshotError('failed', `capture failed: ${describe(body)}`);
    }
    throw new SnapshotError('pending', `capture still pending after ${this.o.maxPolls} polls (job ${jobId})`);
  }
}
