// Request correlation and phase timing for the clinic API.
// Only ids, route names, durations and status codes pass through this module. Callers must never pass
// patient text, answers, names or other PHI as a phase name, route or id.

// Only opaque random IDs are accepted; token syntax alone also admits patient-looking text.
export const requestIdPattern = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const tokenPattern = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Accept a client-supplied X-Request-Id when it is well formed; otherwise mint one. */
export function requestIdFrom(header: string | null | undefined, generate: () => string = () => crypto.randomUUID()): string {
  return header && requestIdPattern.test(header) ? header : generate();
}

// Fixed templates keep arbitrary URL segments out of logs, including failed requests.
const staticRoutes = new Set([
  '/api/clinic/config', '/api/clinic/sessions', '/api/clinic/session', '/api/clinic/confirm-identity',
  '/api/clinic/reject-identity', '/api/clinic/leave', '/api/clinic/adaptive-turns',
  '/api/clinic/conversation-mode', '/api/clinic/turns', '/api/clinic/topics', '/api/clinic/safety-reviews',
  '/api/clinic/review', '/api/clinic/confirm', '/api/clinic/retry-delivery', '/api/clinic/receipt',
  '/api/staff/login', '/api/staff/logout', '/api/staff/me', '/api/staff/queue', '/api/staff/safety',
  '/api/clinic/staff/invitations', '/api/clinic/invitations/redeem',
]);
const dynamicRoutes: readonly [RegExp, string][] = [
  [/^\/api\/clinic\/adaptive-turns\/[^/]+$/, '/api/clinic/adaptive-turns/:id'],
  [/^\/api\/clinic\/adaptive-turns\/[^/]+\/interpret$/, '/api/clinic/adaptive-turns/:id/interpret'],
  [/^\/api\/clinic\/adaptive-turns\/[^/]+\/discard$/, '/api/clinic/adaptive-turns/:id/discard'],
  [/^\/api\/staff\/safety\/[^/]+$/, '/api/staff/safety/:id'],
  [/^\/api\/staff\/safety\/[^/]+\/actions$/, '/api/staff/safety/:id/actions'],
  [/^\/api\/staff\/handoffs\/[^/]+$/, '/api/staff/handoffs/:id'],
  [/^\/api\/staff\/handoffs\/[^/]+\/actions$/, '/api/staff/handoffs/:id/actions'],
  [/^\/api\/staff\/handoffs\/[^/]+\/resume$/, '/api/staff/handoffs/:id/resume'],
];

/** Only authored route templates and fixed method labels can enter request logs. */
export function routeName(method: string, pathname: string): string {
  const safeMethod = ['GET', 'POST', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'].includes(method) ? method : 'OTHER';
  const route = staticRoutes.has(pathname) ? pathname : dynamicRoutes.find(([pattern]) => pattern.test(pathname))?.[1] ?? '/unmatched';
  return `${safeMethod} ${route}`;
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
  const separator = entry.route.indexOf(' ');
  const route = routeName(entry.route.slice(0, separator), entry.route.slice(separator + 1));
  return JSON.stringify({ event: 'clinic.request', requestId: requestIdFrom(entry.requestId), route, status: entry.status, durMs: entry.durMs, phases: entry.phases });
}

/**
 * Returns a copy of the response with X-Request-Id and Server-Timing set, and emits one structured log line.
 * The copy is required because responses from some constructors have immutable headers.
 */
export function finishRequest(response: Response, input: { requestId: string; route: string; timing: RequestTiming; log?: (line: string) => void }): Response {
  const requestId = requestIdFrom(input.requestId);
  const durMs = round(input.timing.totalMs());
  const phases = input.timing.phases();
  const headers = new Headers(response.headers);
  headers.set('X-Request-Id', requestId);
  headers.set('Server-Timing', serverTimingHeader(phases, durMs));
  (input.log ?? console.log)(requestLogLine({ requestId, route: input.route, status: response.status, durMs, phases }));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
