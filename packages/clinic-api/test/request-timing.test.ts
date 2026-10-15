import { describe, expect, it } from 'vitest';
import { createRequestTiming, finishRequest, requestIdFrom, requestLogLine, routeName, serverTimingHeader } from '../src/request-timing.js';

const fixedId = () => 'generated-id-0001';

describe('requestIdFrom', () => {
  it.each(['abcdefgh', 'req.2026-10-13_A-1', 'a'.repeat(64)])('accepts a well-formed incoming id %s', id => {
    expect(requestIdFrom(id, fixedId)).toBe(id);
  });

  it.each([null, undefined, '', 'short', 'a'.repeat(65), 'has space id', 'semi;colon-id', 'new\nline-id'])('replaces an unusable incoming id %j', id => {
    expect(requestIdFrom(id, fixedId)).toBe('generated-id-0001');
  });

  it('mints a UUID when no generator is supplied', () => {
    expect(requestIdFrom(null)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe('routeName', () => {
  it('collapses path ids so logs group by route', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(routeName('POST', `/api/clinic/adaptive-turns/${id}/interpret`)).toBe('POST /api/clinic/adaptive-turns/:id/interpret');
    expect(routeName('POST', `/api/staff/handoffs/${id}.v2/actions`)).toBe('POST /api/staff/handoffs/:id/actions');
  });

  it('leaves static routes unchanged and bounds the length', () => {
    expect(routeName('POST', '/api/clinic/turns')).toBe('POST /api/clinic/turns');
    expect(routeName('GET', `/${'x'.repeat(300)}`)).toBe(`GET /${'x'.repeat(119)}`);
  });
});

describe('createRequestTiming', () => {
  it('accumulates repeated phases in first-seen order and rounds to 0.1 ms', async () => {
    let now = 0;
    const timing = createRequestTiming(() => now);
    await timing.phase('session', async () => { now += 12.34; });
    timing.measure('dialogue', () => { now += 5; });
    await timing.phase('store', () => { now += 1; });
    await timing.phase('store', () => { now += 2.04; });
    now += 100;
    expect(timing.phases()).toEqual({ session: 12.3, dialogue: 5, store: 3 });
    expect(timing.totalMs()).toBeCloseTo(120.38, 6);
  });

  it('records a span even when it throws, and the error still propagates', async () => {
    let now = 0;
    const timing = createRequestTiming(() => now);
    await expect(timing.phase('safety', async () => { now += 7; throw new Error('synthetic'); })).rejects.toThrow('synthetic');
    expect(() => timing.measure('dialogue', () => { now += 2; throw new Error('sync'); })).toThrow('sync');
    expect(timing.phases()).toEqual({ safety: 7, dialogue: 2 });
  });

  it('ignores names that are not valid Server-Timing tokens', () => {
    const timing = createRequestTiming(() => 0);
    timing.measure('bad name;x', () => undefined);
    timing.measure('9starts-with-digit', () => undefined);
    expect(timing.phases()).toEqual({});
  });

  it('clamps negative spans to zero', () => {
    // Clock readings: construction, span start, span end (end is earlier than start).
    const readings = [0, 10, 4];
    const timing = createRequestTiming(() => readings.shift() ?? 0);
    timing.measure('store', () => undefined);
    expect(timing.phases()).toEqual({ store: 0 });
  });
});

describe('serverTimingHeader', () => {
  it('lists phases in order with total last', () => {
    expect(serverTimingHeader({ session: 1.25, accept: 230.4, store: 5 }, 240.123)).toBe('session;dur=1.3, accept;dur=230.4, store;dur=5, total;dur=240.1');
  });

  it('drops an incoming total and invalid metrics so total appears exactly once', () => {
    expect(serverTimingHeader({ total: 999, 'bad name': 3, interpret: Number.NaN, safety: 4 }, 50)).toBe('safety;dur=4, total;dur=50');
  });
});

describe('requestLogLine', () => {
  it('emits only the documented fields as one JSON object', () => {
    const line = requestLogLine({ requestId: 'req-12345678', route: 'POST /api/clinic/turns', status: 202, durMs: 12.5, phases: { session: 3, store: 4 } });
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({ event: 'clinic.request', requestId: 'req-12345678', route: 'POST /api/clinic/turns', status: 202, durMs: 12.5, phases: { session: 3, store: 4 } });
  });
});

describe('finishRequest', () => {
  it('sets correlation and timing headers, keeps status and body, and logs one line', async () => {
    let now = 0;
    const timing = createRequestTiming(() => now);
    await timing.phase('session', () => { now += 4; });
    now += 6;
    const lines: string[] = [];
    const original = new Response(JSON.stringify({ ok: true }), { status: 201, headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'a=b; Path=/' } });
    const response = finishRequest(original, { requestId: 'req-12345678', route: 'POST /api/clinic/turns', timing, log: line => lines.push(line) });
    expect(response.status).toBe(201);
    expect(response.headers.get('X-Request-Id')).toBe('req-12345678');
    expect(response.headers.get('Server-Timing')).toBe('session;dur=4, total;dur=10');
    expect(response.headers.get('Set-Cookie')).toBe('a=b; Path=/');
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(await response.json()).toEqual({ ok: true });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ event: 'clinic.request', requestId: 'req-12345678', route: 'POST /api/clinic/turns', status: 201, durMs: 10, phases: { session: 4 } });
  });

  it('works for responses whose headers are immutable', async () => {
    const immutable = Response.redirect('https://example.invalid/', 302);
    const response = finishRequest(immutable, { requestId: 'req-12345678', route: 'GET /x', timing: createRequestTiming(() => 0), log: () => undefined });
    expect(response.status).toBe(302);
    expect(response.headers.get('X-Request-Id')).toBe('req-12345678');
  });
});
