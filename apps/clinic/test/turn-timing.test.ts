import { afterEach, describe, expect, it, vi } from 'vitest';
import { newRequestId, parseServerTiming, percentile, recordTurnTiming, statOf, summarizeTurnTimings, turnRouteName, turnTimingLimit, turnTimings, type TurnTiming, RenderedTurnTracker, recordRenderedTurnTiming, renderedTurnTimings, type TurnPresentation } from '../src/turn-timing';
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
    await request('/api/clinic/adaptive-turns', { requestId: crypto.randomUUID(), expectedRevision: 0, text: 'x', channel: 'typed' }, { turnId: 'submission-id' });
    const headers = fetched[0].init.headers as Record<string, string>;
    expect(headers['X-Request-Id']).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
    const exposed = (window as unknown as { __corvoTurnTimings: TurnTiming[] }).__corvoTurnTimings;
    expect(exposed.at(-1)).toEqual({ requestId: headers['X-Request-Id'], turnId: 'submission-id', route: 'POST /api/clinic/adaptive-turns', startedAt: expect.any(String), clientMs: expect.any(Number), status: 202, serverTiming: { session: 2.5, accept: 40, total: 48.5 } });
  });

  it('sends a correlation id but records nothing for non-turn reads', async () => {
    const before = turnTimings().length;
    const fetched = stubBrowser(new Response(JSON.stringify({ revision: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await request('/api/clinic/session');
    expect((fetched[0].init.headers as Record<string, string>)['X-Request-Id']).toBeTruthy();
    expect(turnTimings()).toHaveLength(before);
  });
});


describe('submit-to-React-commit lifecycle', () => {
  const baseline: TurnPresentation = { sessionId: 'session-1', revision: 1, promptId: 'prompt-1', replyId: 'reply-1', responseReady: true, urgent: false, visible: true };
  function setup() {
    let now = 10;
    const record = vi.fn();
    const tracker = new RenderedTurnTracker(() => now, record);
    return { tracker, record, at: (value: number) => { now = value; } };
  }

  it('includes pre-request waits and parsing-to-commit time for guided turns', () => {
    const { tracker, record, at } = setup();
    const id = tracker.begin('guided', baseline);
    at(60); // A discard/status wait before sending the answer.
    tracker.commit({ ...baseline, revision: 2, promptId: 'other' });
    expect(record).not.toHaveBeenCalled();
    at(110); tracker.accept(id, 3); // Parsed response is not completion.
    expect(record).not.toHaveBeenCalled();
    at(150); tracker.commit({ ...baseline, revision: 3, promptId: 'prompt-2' });
    expect(record).toHaveBeenCalledExactlyOnceWith({ turnId: id, mode: 'guided', startedAt: expect.any(String), submitToRenderMs: 140 });
  });

  it('keeps one correlated adaptive sample through acknowledgement and finishes a streamed poll before interpret ends', () => {
    const { tracker, record, at } = setup();
    const id = tracker.begin('adaptive', baseline);
    at(100); tracker.accept(id, 2, 'operation-1');
    expect(tracker.forOperation('operation-1')).toBe(id);
    expect(tracker.forOperation('old-operation')).toBeUndefined();
    tracker.commit({ ...baseline, revision: 2, operationId: 'operation-1', responseReady: false });
    tracker.commit({ ...baseline, revision: 3, operationId: 'operation-1', responseReady: false, promptId: 'prompt-2' });
    expect(record).not.toHaveBeenCalled();
    at(900); tracker.commit({ ...baseline, revision: 4, operationId: 'operation-1', promptId: 'prompt-2', replyId: 'reply-2' });
    at(1500); tracker.commit({ ...baseline, revision: 5, operationId: 'operation-1', promptId: 'prompt-2', replyId: 'reply-2' });
    expect(record).toHaveBeenCalledExactlyOnceWith({ turnId: id, mode: 'adaptive', startedAt: expect.any(String), submitToRenderMs: 890 });
  });

  it('finishes a scoped follow-up with new displayed content under the same authored ID and no reply', () => {
    const { tracker, record, at } = setup();
    const first = { ...baseline, replyId: undefined, promptPresentation: Symbol() };
    const id = tracker.begin('adaptive', first); tracker.accept(id, 2, 'operation-1');
    // An unchanged, reconstructed prompt is still the previous presentation.
    tracker.commit({ ...first, revision: 2, operationId: 'operation-1' });
    expect(record).not.toHaveBeenCalled();
    // React memoizes a new opaque token when displayed text/purpose/choices/fields change.
    const followup = { ...first, revision: 3, operationId: 'operation-1', promptPresentation: Symbol() };
    at(250); tracker.commit({ ...followup, responseReady: false });
    expect(record).not.toHaveBeenCalled();
    at(300); tracker.commit(followup); tracker.commit(followup);
    expect(record).toHaveBeenCalledExactlyOnceWith({ turnId: id, mode: 'adaptive', startedAt: expect.any(String), submitToRenderMs: 290 });
    expect(Object.keys(record.mock.calls[0][0])).toEqual(['turnId', 'mode', 'startedAt', 'submitToRenderMs']);
  });

  it('keeps the original submission through an uncertain interpretation and manual status recovery', () => {
    const { tracker, record, at } = setup();
    const id = tracker.begin('adaptive', baseline); tracker.accept(id, 2, 'operation-1');
    tracker.commit({ ...baseline, revision: 2, operationId: 'operation-1', responseReady: false });
    // The interpretation POST is lost. Status reads, including manual reads, do
    // not start/cancel a submission or infer another turn. run() keeps this accepted sample.
    tracker.cancelUnaccepted();
    expect(tracker.forOperation('operation-1')).toBe(id);
    at(1200);
    tracker.commit({ ...baseline, revision: 4, operationId: 'operation-1', replyId: 'recovered-reply' });
    expect(record).toHaveBeenCalledExactlyOnceWith({ turnId: id, mode: 'adaptive', startedAt: expect.any(String), submitToRenderMs: 1190 });
  });

  it('finishes an urgent notice even while interpretation is pending', () => {
    const { tracker, record } = setup();
    const id = tracker.begin('adaptive', baseline); tracker.accept(id, 2, 'operation-1');
    tracker.commit({ ...baseline, revision: 2, operationId: 'operation-1', responseReady: false, urgent: true });
    expect(record).toHaveBeenCalledOnce();
  });

  it('does not finish a hidden or held old reply, and cancels replaced scopes and unmounts', () => {
    for (const replacement of [{ sessionId: 'session-2' }, { visible: false }, { operationId: 'operation-2' }]) {
      const { tracker, record } = setup();
      const id = tracker.begin('adaptive', baseline); tracker.accept(id, 2, 'operation-1');
      tracker.commit({ ...baseline, revision: 2, operationId: 'operation-1' });
      expect(record).not.toHaveBeenCalled();
      tracker.commit({ ...baseline, revision: 3, operationId: 'operation-1', ...replacement });
      tracker.commit({ ...baseline, revision: 4, operationId: 'operation-1', replyId: 'reply-2' });
      expect(record).not.toHaveBeenCalled();
    }
    const { tracker, record } = setup();
    const id = tracker.begin('guided', baseline); tracker.accept(id, 2); tracker.cancel();
    tracker.commit({ ...baseline, revision: 2, promptId: 'prompt-2' });
    expect(record).not.toHaveBeenCalled();
  });

  it('ignores late acknowledgement from a replaced submission and abandons unsent attempts', () => {
    const { tracker, record } = setup();
    const old = tracker.begin('adaptive', baseline);
    const next = tracker.begin('adaptive', baseline);
    tracker.accept(old, 2, 'old-operation'); tracker.cancelUnaccepted();
    tracker.accept(next, 3, 'new-operation');
    tracker.commit({ ...baseline, revision: 3, operationId: 'new-operation', replyId: 'reply-2' });
    expect(record).not.toHaveBeenCalled();
  });
});

describe('rendered timing buffer', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('bounds and exposes presentation samples separately from request diagnostics, without patient content', () => {
    vi.stubGlobal('window', {});
    for (let index = 0; index < turnTimingLimit + 1; index++) recordRenderedTurnTiming({ turnId: 'opaque-id', mode: 'adaptive', startedAt: '2026-10-16T00:00:00Z', submitToRenderMs: index });
    const exposed = (window as unknown as { __corvoRenderedTurnTimings: unknown[] }).__corvoRenderedTurnTimings;
    expect(exposed).toBe(renderedTurnTimings()); expect(exposed).toHaveLength(turnTimingLimit);
    expect(exposed[0]).toEqual({ turnId: 'opaque-id', mode: 'adaptive', startedAt: '2026-10-16T00:00:00Z', submitToRenderMs: 1 });
    expect(Object.keys(exposed[0] as object)).toEqual(['turnId', 'mode', 'startedAt', 'submitToRenderMs']);
  });
});
