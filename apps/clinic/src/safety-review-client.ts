export interface SafetyReviewResult { state: 'pending' | 'reviewed'; escalated: boolean }
export interface SafetyReviewPorts {
  post(signalId: string): Promise<SafetyReviewResult>;
  escalated(): void;
  schedule?(ms: number, fn: () => void): unknown;
  cancel?(timer: unknown): void;
}

/** Retry delays after the first attempt: pending or thrown requests get three retries, then stop silently. */
const retryDelays = [3000, 6000, 12000];

/** Background tier-2 reviews. Each signal is requested at most once at a time and never again once finished or abandoned. */
export class SafetyReviewQueue {
  private readonly active = new Set<string>();
  private readonly done = new Set<string>();
  private readonly notified = new Set<string>();
  private readonly timers = new Map<string, unknown>();
  private readonly schedule: (ms: number, fn: () => void) => unknown;
  private readonly cancel: (timer: unknown) => void;
  private disposed = false;

  constructor(private readonly ports: SafetyReviewPorts) {
    this.schedule = ports.schedule ?? ((ms, fn) => globalThis.setTimeout(fn, ms));
    this.cancel = ports.cancel ?? (timer => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  sync(pendingSignalIds: string[]) {
    if (this.disposed) return;
    for (const signalId of pendingSignalIds) {
      if (this.active.has(signalId) || this.done.has(signalId)) continue;
      this.active.add(signalId);
      this.attempt(signalId, 0);
    }
  }

  dispose() {
    this.disposed = true;
    for (const timer of this.timers.values()) this.cancel(timer);
    this.timers.clear();
    this.active.clear();
  }

  private attempt(signalId: string, retries: number) {
    // The executor runs synchronously, so a synchronous throw from post becomes a rejection like any other failure.
    new Promise<SafetyReviewResult>(resolve => resolve(this.ports.post(signalId))).then(
      result => this.settle(signalId, retries, result),
      () => this.retry(signalId, retries),
    );
  }

  private settle(signalId: string, retries: number, result: SafetyReviewResult) {
    if (this.disposed) return;
    if (result.escalated && !this.notified.has(signalId)) {
      this.notified.add(signalId);
      this.ports.escalated();
    }
    if (result.state === 'reviewed') this.finish(signalId);
    else this.retry(signalId, retries);
  }

  private retry(signalId: string, retries: number) {
    if (this.disposed) return;
    if (retries >= retryDelays.length) { this.finish(signalId); return; }
    const timer = this.schedule(retryDelays[retries], () => {
      this.timers.delete(signalId);
      if (!this.disposed) this.attempt(signalId, retries + 1);
    });
    this.timers.set(signalId, timer);
  }

  private finish(signalId: string) {
    this.active.delete(signalId);
    this.done.add(signalId);
  }
}
