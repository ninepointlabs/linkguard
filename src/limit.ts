/** Minimal counting semaphore. */
export class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // A released slot is handed straight to the next waiter, so `active` never overshoots.
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiters.push(resolve));
    else this.active++;
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/** Runs tasks with at most `globalMax` in flight overall and one in flight per key. */
export class KeyedLimiter {
  private readonly global: Semaphore;
  private readonly perKey = new Map<string, Semaphore>();

  constructor(globalMax: number) {
    this.global = new Semaphore(globalMax);
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let sem = this.perKey.get(key);
    if (!sem) {
      sem = new Semaphore(1);
      this.perKey.set(key, sem);
    }
    return sem.run(() => this.global.run(fn));
  }
}

/** Ensures successive calls to `wait()` are at least `intervalMs` apart. */
export class Pacer {
  private next = 0;

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  async wait(): Promise<void> {
    const t = this.now();
    const at = Math.max(t, this.next);
    this.next = at + this.intervalMs;
    if (at > t) await this.sleep(at - t);
  }
}
