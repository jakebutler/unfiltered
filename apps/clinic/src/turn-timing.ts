// Client-side turn latency: request correlation ids, Server-Timing parsing, a bounded buffer exposed as
// window.__corvoTurnTimings, and a pure summarizer. Only ids, route names, durations and status codes are stored.
// Never store request or response bodies here.

export const turnTimingLimit = 200;
const tokenPattern = /^[A-Za-z][A-Za-z0-9_-]*$/;

export interface TurnTiming {
  requestId: string;
  /** Client submission shared by accept/interpret requests, when available. */
  turnId?: string;
  /** Server route name, e.g. "POST /api/clinic/adaptive-turns/:id/interpret". */
  route: string;
  startedAt: string;
  /** Wall time from send to fully parsed response (or failure), in ms. */
  clientMs: number;
  /** HTTP status, or 0 when no response arrived. */
  status: number;
  /** Parsed Server-Timing metrics in ms, keyed by metric name. `total` is the server's own wall time. */
  serverTiming: Record<string, number>;
}

export interface Stat { count: number; p50: number | null; p95: number | null; max: number | null }
export interface TurnTimingSummary { count: number; client: Stat; server: Stat }

export function newRequestId(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // randomUUID requires a secure context; getRandomValues does not. 32 hex characters match requestIdPattern.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Route name for requests whose latency we keep, or undefined for every other request. */
export function turnRouteName(method: string, path: string): string | undefined {
  if (method !== 'POST') return undefined;
  if (path === '/api/clinic/turns') return 'POST /api/clinic/turns';
  if (path === '/api/clinic/adaptive-turns') return 'POST /api/clinic/adaptive-turns';
  if (/^\/api\/clinic\/adaptive-turns\/[a-f0-9-]{36}\/interpret$/.test(path)) return 'POST /api/clinic/adaptive-turns/:id/interpret';
  return undefined;
}

/** Parses a W3C Server-Timing value such as "session;dur=1.2, total;dur=240.1". Invalid metrics are skipped. */
export function parseServerTiming(value: string | null | undefined): Record<string, number> {
  const metrics: Record<string, number> = {};
  if (!value) return metrics;
  for (const metric of value.split(',')) {
    const [name = '', ...params] = metric.split(';').map(part => part.trim());
    if (!tokenPattern.test(name)) continue;
    const duration = params.find(param => param.startsWith('dur='))?.slice(4).replace(/^"(.*)"$/, '$1');
    if (duration === undefined || !/^\d+(\.\d+)?$/.test(duration)) continue;
    metrics[name] = Number(duration);
  }
  return metrics;
}

/** Nearest-rank percentile over a sample: the smallest value with at least p% of samples at or below it. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

export function statOf(values: readonly number[]): Stat {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted.length ? sorted[sorted.length - 1] : null };
}

/** Summary over client wall time and the server's `total` metric. Entries without a server total are skipped for `server`. */
export function summarizeTurnTimings(entries: readonly Pick<TurnTiming, 'clientMs' | 'serverTiming'>[]): TurnTimingSummary {
  const serverTotals = entries.map(entry => entry.serverTiming.total).filter((ms): ms is number => typeof ms === 'number');
  return { count: entries.length, client: statOf(entries.map(entry => entry.clientMs)), server: statOf(serverTotals) };
}

// Bounded buffer: the newest `turnTimingLimit` entries, oldest dropped first.
const timings: TurnTiming[] = [];
export function recordTurnTiming(entry: TurnTiming): void {
  timings.push(entry);
  if (timings.length > turnTimingLimit) timings.splice(0, timings.length - turnTimingLimit);
  if (typeof window !== 'undefined') (window as Window & { __corvoTurnTimings?: TurnTiming[] }).__corvoTurnTimings = timings;
}

export function turnTimings(): readonly TurnTiming[] { return timings; }

export interface RenderedTurnTiming {
  turnId: string;
  mode: 'guided' | 'adaptive';
  startedAt: string;
  /** Submit handler entry through the React commit that displays the response. */
  submitToRenderMs: number;
}
const renderedTimings: RenderedTurnTiming[] = [];
export function recordRenderedTurnTiming(entry: RenderedTurnTiming): void {
  renderedTimings.push(entry);
  if (renderedTimings.length > turnTimingLimit) renderedTimings.splice(0, renderedTimings.length - turnTimingLimit);
  if (typeof window !== 'undefined') (window as Window & { __corvoRenderedTurnTimings?: RenderedTurnTiming[] }).__corvoRenderedTurnTimings = renderedTimings;
}
export function renderedTurnTimings(): readonly RenderedTurnTiming[] { return renderedTimings; }

/** Only opaque identifiers and presentation flags enter the lifecycle; never patient words. */
export interface TurnPresentation {
  sessionId: string;
  revision: number;
  promptId?: string;
  /** Opaque React identity for displayed prompt content; never emitted in samples. */
  promptPresentation?: symbol;
  replyId?: string;
  operationId?: string;
  responseReady: boolean;
  urgent: boolean;
  visible: boolean;
}

/** One submission survives accept, interpret and polling, and can complete only at a React commit. */
export class RenderedTurnTracker {
  private pending?: {
    sample: Omit<RenderedTurnTiming, 'submitToRenderMs'>; started: number;
    baseline: TurnPresentation; acceptedRevision?: number; operationId?: string;
  };
  constructor(private now = () => performance.now(), private record = recordRenderedTurnTiming) {}
  begin(mode: RenderedTurnTiming['mode'], baseline: TurnPresentation): string {
    const turnId = newRequestId();
    this.pending = { sample: { turnId, mode, startedAt: new Date().toISOString() }, started: this.now(), baseline };
    return turnId;
  }
  get turnId(): string | undefined { return this.pending?.sample.turnId; }
  forOperation(operationId: string): string | undefined {
    return this.pending?.operationId === operationId ? this.turnId : undefined;
  }
  accept(turnId: string, revision: number, operationId?: string): void {
    if (this.turnId !== turnId) return;
    this.pending!.acceptedRevision = revision;
    this.pending!.operationId = operationId;
  }
  cancel(): void { this.pending = undefined; }
  cancelUnaccepted(): void { if (this.pending?.acceptedRevision === undefined) this.cancel(); }
  commit(view: TurnPresentation): void {
    const pending = this.pending;
    if (!pending) return;
    if (view.sessionId !== pending.baseline.sessionId || !view.visible) { this.cancel(); return; }
    if (pending.acceptedRevision === undefined || view.revision < pending.acceptedRevision) return;
    if (pending.operationId && pending.operationId !== view.operationId) { this.cancel(); return; }
    if (!view.urgent && (!view.responseReady || (pending.sample.mode === 'adaptive' && view.promptId === pending.baseline.promptId && view.promptPresentation === pending.baseline.promptPresentation && view.replyId === pending.baseline.replyId))) return;
    this.cancel();
    this.record({ ...pending.sample, submitToRenderMs: Math.round((this.now() - pending.started) * 10) / 10 });
  }
}
