import { afterEach, describe, expect, it, vi } from 'vitest';
import { newRequestId, parseServerTiming, percentile, recordTurnTiming, statOf, summarizeTurnTimings, turnRouteName, turnTimingLimit, turnTimings, type TurnTiming } from '../src/turn-timing';
import { request } from '../src/api';

describe('parseServerTiming', () => {
  it('parses durations and ignores descriptions and unknown parameters', () => {
    expect(parseServerTiming('session;dur=1.2, accept;dur=230.4;desc="slow path", total;dur=240')).toEqual({ session: 1.2, accept: 230.4, total: 240 });
    expect(parseServerTiming('store;desc=x;dur="7.5"')).toEqual({ store: 7.5 });
  });

  it('skips missing, negative, non-numeric, and malformed metrics', () => {
    expect(parseServerTiming(null)).toEqual({});
    expect(parseServerTiming('')).toEqual({});
    expect(parseServerTiming('a;dur=-1, b;dur=abc, c, d;dur=, 9bad;dur=3, bad name;dur=2, ok;dur=4')).toEqual({ ok: 4 });
  });
});

describe('percentile and summary (nearest rank)', () => {
  it('picks the smallest value with at least p% of samples at or below it', () => {
    const sorted = [10, 20, 30, 40];
    expect(percentile(sorted, 50)).toBe(20);
    expect(percentile(sorted, 95)).toBe(40);
    expect(percentile(sorted, 25)).toBe(10);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });

  it('computes count, p50, p95 and max for the client and server total', () => {
    const entries = Array.from({ length: 20 }, (_, index) => ({ clientMs: (index + 1) * 10, serverTiming: { total: index + 1, session: 1 } }));
    expect(summarizeTurnTimings(entries)).toEqual({
      count: 20,
      client: { count: 20, p50: 100, p95: 190, max: 200 },
      server: { count: 20, p50: 10, p95: 19, max: 20 },
    });
  });

  it('skips entries without a server total for the server stat only', () => {
    const summary = summarizeTurnTimings([{ clientMs: 50, serverTiming: {} }, { clientMs: 70, serverTiming: { total: 30 } }]);
    expect(summary.count).toBe(2);
    expect(summary.client).toEqual({ count: 2, p50: 50, p95: 70, max: 70 });
    expect(summary.server).toEqual({ count: 1, p50: 30, p95: 30, max: 30 });
  });

  it('reports null statistics when there are no samples', () => {
    expect(summarizeTurnTimings([])).toEqual({ count: 0, client: { count: 0, p50: null, p95: null, max: null }, server: { count: 0, p50: null, p95: null, max: null } });
    expect(statOf([])).toEqual({ count: 0, p50: null, p95: null, max: null });
  });
});

describe('turnRouteName', () => {
  it('classifies the three turn routes with normalized ids', () => {
    expect(turnRouteName('POST', '/api/clinic/turns')).toBe('POST /api/clinic/turns');
    expect(turnRouteName('POST', '/api/clinic/adaptive-turns')).toBe('POST /api/clinic/adaptive-turns');
    expect(turnRouteName('POST', '/api/clinic/adaptive-turns/0f8fad5b-d9cb-469f-a165-70867728950e/interpret')).toBe('POST /api/clinic/adaptive-turns/:id/interpret');
  });

  it('ignores polling reads and other routes', () => {
    expect(turnRouteName('GET', '/api/clinic/turns')).toBeUndefined();
    expect(turnRouteName('GET', '/api/clinic/adaptive-turns/0f8fad5b-d9cb-469f-a165-70867728950e')).toBeUndefined();
    expect(turnRouteName('POST', '/api/clinic/review')).toBeUndefined();
  });
});

describe('newRequestId', () => {
  it('produces ids the server accepts', () => {
    for (let index = 0; index < 20; index++) expect(newRequestId()).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
  });
});

describe('turn timing buffer', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps only the newest entries and exposes them on window', () => {
    vi.stubGlobal('window', {});
    const make = (index: number): TurnTiming => ({ requestId: `req-${String(index).padStart(6, '0')}`, route: 'POST /api/clinic/turns', startedAt: '2026-10-14T00:00:00.000Z', clientMs: index, status: 202, serverTiming: {} });
    for (let index = 0; index < turnTimingLimit + 25; index++) recordTurnTiming(make(index));
    const exposed = (window as unknown as { __corvoTurnTimings: TurnTiming[] }).__corvoTurnTimings;
    expect(exposed).toBe(turnTimings());
    expect(exposed).toHaveLength(turnTimingLimit);
    expect(exposed[0].clientMs).toBe(25);
    expect(exposed.at(-1)?.clientMs).toBe(turnTimingLimit + 24);
  });
});

describe('request()', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubBrowser(response: Response) {
    const fetched: { path: string; init: RequestInit }[] = [];
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => { fetched.push({ path, init }); return response; }));
    return fetched;
  }

  it('sends X-Request-Id and records server timing for a turn route', async () => {
    const fetched = stubBrowser(new Response(JSON.stringify({ revision: 1 }), { status: 202, headers: { 'Content-Type': 'application/json', 'Server-Timing': 'session;dur=2.5, accept;dur=40, total;dur=48.5' } }));
    await request('/api/clinic/adaptive-turns', { requestId: crypto.randomUUID(), expectedRevision: 0, text: 'x', channel: 'typed' });
    const headers = fetched[0].init.headers as Record<string, string>;
    expect(headers['X-Request-Id']).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
    const exposed = (window as unknown as { __corvoTurnTimings: TurnTiming[] }).__corvoTurnTimings;
    expect(exposed.at(-1)).toEqual({ requestId: headers['X-Request-Id'], route: 'POST /api/clinic/adaptive-turns', startedAt: expect.any(String), clientMs: expect.any(Number), status: 202, serverTiming: { session: 2.5, accept: 40, total: 48.5 } });
  });

  it('sends a correlation id but records nothing for non-turn reads', async () => {
    const before = turnTimings().length;
    const fetched = stubBrowser(new Response(JSON.stringify({ revision: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await request('/api/clinic/session');
    expect((fetched[0].init.headers as Record<string, string>)['X-Request-Id']).toBeTruthy();
    expect(turnTimings()).toHaveLength(before);
  });
});
