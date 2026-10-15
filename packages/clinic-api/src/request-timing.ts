// Request correlation and phase timing for the clinic API.
// Only ids, route names, durations and status codes pass through this module. Callers must never pass
// patient text, answers, names or other PHI as a phase name, route or id.

export const requestIdPattern = /^[A-Za-z0-9._-]{8,64}$/;
const tokenPattern = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Accept a client-supplied X-Request-Id when it is well formed; otherwise mint one. */
export function requestIdFrom(header: string | null | undefined, generate: () => string = () => crypto.randomUUID()): string {
  return header && requestIdPattern.test(header) ? header : generate();
}

/** Route name with path ids collapsed, e.g. "POST /api/clinic/adaptive-turns/:id/interpret". */
export function routeName(method: string, pathname: string): string {
  return `${method} ${pathname.replace(/[a-f0-9-]{36}(?:\.v\d+)?/g, ':id').slice(0, 120)}`;
}

const round = (ms: number) => Math.max(0, Math.round(ms * 10) / 10);

export interface RequestTiming {
  /** Times a synchronous span. Repeated names accumulate. */
  measure<T>(name: string, fn: () => T): T;
  /** Times an asynchronous span. Repeated names accumulate. Spans may nest; a parent includes its children. */
  phase<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
  /** Phase durations in first-seen order, rounded to 0.1 ms. */
  phases(): Record<string, number>;
  /** Wall time since creation, in ms. */
  totalMs(): number;
}

export function createRequestTiming(now: () => number = () => performance.now()): RequestTiming {
  const started = now();
  const raw = new Map<string, number>();
  const add = (name: string, ms: number) => { if (tokenPattern.test(name)) raw.set(name, (raw.get(name) ?? 0) + Math.max(0, ms)); };
  return {
    measure<T>(name: string, fn: () => T): T {
      const start = now();
      try { return fn(); }
      finally { add(name, now() - start); }
    },
    async phase<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
      const start = now();
      try { return await fn(); }
      finally { add(name, now() - start); }
    },
    phases() { return Object.fromEntries([...raw].map(([name, ms]) => [name, round(ms)])); },
    totalMs() { return now() - started; },
  };
}

/** W3C Server-Timing value, e.g. "session;dur=1.2, accept;dur=230.4, total;dur=240.1". Total is always last. */
export function serverTimingHeader(phases: Record<string, number>, totalMs: number): string {
  const metrics = Object.entries(phases).filter(([name, ms]) => name !== 'total' && tokenPattern.test(name) && Number.isFinite(ms));
  return [...metrics, ['total', totalMs] as const].map(([name, ms]) => `${name};dur=${round(ms)}`).join(', ');
}

export interface RequestLogEntry {
  requestId: string;
  route: string;
  status: number;
  durMs: number;
  phases: Record<string, number>;
}

export function requestLogLine(entry: RequestLogEntry): string {
  return JSON.stringify({ event: 'clinic.request', requestId: entry.requestId, route: entry.route, status: entry.status, durMs: entry.durMs, phases: entry.phases });
}

/**
 * Returns a copy of the response with X-Request-Id and Server-Timing set, and emits one structured log line.
 * The copy is required because responses from some constructors have immutable headers.
 */
export function finishRequest(response: Response, input: { requestId: string; route: string; timing: RequestTiming; log?: (line: string) => void }): Response {
  const durMs = round(input.timing.totalMs());
  const phases = input.timing.phases();
  const headers = new Headers(response.headers);
  headers.set('X-Request-Id', input.requestId);
  headers.set('Server-Timing', serverTimingHeader(phases, durMs));
  (input.log ?? console.log)(requestLogLine({ requestId: input.requestId, route: input.route, status: response.status, durMs, phases }));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
