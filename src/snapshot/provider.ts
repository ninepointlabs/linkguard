export interface Snapshot {
  /** Public archived URL (https). */
  url: string;
  /** 14-digit Wayback timestamp, YYYYMMDDhhmmss. */
  timestamp: string;
  /** Provider that produced or found the snapshot. */
  source: string;
}

export interface CreateOptions {
  /** Epoch ms after which polling stops and the capture is reported as pending. */
  deadline?: number;
}

export interface SnapshotProvider {
  readonly name: string;
  /** True when `create` can be used (e.g. credentials are present). */
  readonly canCreate: boolean;
  /** Most recent usable (2xx) snapshot, or null if none. Throws SnapshotError if the lookup itself failed. */
  lookup(url: string): Promise<Snapshot | null>;
  /** Capture a new snapshot. Throws SnapshotError on failure. */
  create(url: string, options?: CreateOptions): Promise<Snapshot>;
}

export type SnapshotErrorKind = 'rate-limited' | 'pending' | 'failed';

export class SnapshotError extends Error {
  constructor(
    readonly kind: SnapshotErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** Parse a 14-digit Wayback timestamp as UTC epoch ms. */
export function timestampToMs(ts: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(ts);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
  return Date.UTC(y!, mo! - 1, d!, h!, mi!, s!);
}
