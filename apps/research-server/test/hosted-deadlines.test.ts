import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const route = vi.hoisted(() => ({ dispatch: vi.fn<(request: Request, port: PrivateObjectStore) => Promise<Response>>() }));
vi.mock('../src/server', () => ({ createResearchGateways: (port: PrivateObjectStore) => ({ media: (request: Request) => route.dispatch(request, port), reports: (request: Request) => route.dispatch(request, port) }) }));
import { createHostedResearchHandler, HOSTED_DEPLOYMENT, HOSTED_CONVEX_SITE } from '../src/hosted-runtime';
import { fakeHostedAuthority } from './hosted-test-authority';
import type { PrivateObjectStore } from '../../../packages/research-capture/src/contracts';
const origin = 'https://research.example.test', config = { mode: 'hosted', deployment: HOSTED_DEPLOYMENT, convexSite: HOSTED_CONVEX_SITE, publicOrigin: origin, gatewaySecret: 'a'.repeat(64), maxSegmentBytes: 4_000_000, maxResponseBytes: 4_000_000, cleanupMode: 'durable' };
const store = { head: vi.fn(), read: vi.fn(), retire: vi.fn(), putIfAbsent: vi.fn() } as unknown as PrivateObjectStore;
const request = (path = '/api/research/analysis/readiness') => new Request(origin + path, { headers: { Host: 'research.example.test', Origin: origin } });
beforeEach(() => { vi.useFakeTimers(); route.dispatch.mockReset(); });
afterEach(() => vi.useRealTimers());
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
function fixture(duration = 30_000) { const native = fakeHostedAuthority(duration), make = () => createHostedResearchHandler(config, { canonicalOrigin: origin }, { store, hostedAuthority: native }); return { native, make, handler: make() }; }
it('two separate handler instances share the native global admission and release consumed/cancelled response slots', async () => {
  const f = fixture(); route.dispatch.mockImplementation(async () => Response.json({ synthetic: true }));
  const other = f.make(), responses = await Promise.all([f.handler(request()), other(request()), f.handler(request()), other(request())]);
  expect((await other(request())).status).toBe(429); expect(route.dispatch).toHaveBeenCalledTimes(4);
  await responses[0].body!.cancel(); await flush(); expect(f.native.release).toHaveBeenCalledTimes(1);
  const next = await other(request()); expect(next.status).toBe(200); await next.json(); await Promise.all(responses.slice(1).map(r => r.body!.cancel())); await flush(); expect(f.native.leases.size).toBe(0);
});
it('actively cancels stalled ingress without request.signal firing and never reaches work after incomplete body', async () => {
  const f = fixture(), cancelled = vi.fn(), afterBody = vi.fn();
  route.dispatch.mockImplementation(async request => { const reader = request.body!.getReader(); try { await reader.read(); afterBody(); return Response.json({}); } finally { await reader.cancel().catch(() => undefined); } });
  const original = new Request(origin + '/api/research/shares', { method: 'POST', headers: { Host: 'research.example.test', Origin: origin, 'Content-Length': '1' }, body: new ReadableStream({ cancel: cancelled }, { highWaterMark: 0 }), duplex: 'half' } as RequestInit);
  const response = f.handler(original); await flush(); await vi.advanceTimersByTimeAsync(8_001); const ended = await response;
  expect(ended.status).toBe(409); expect(original.signal.aborted).toBe(false); expect(cancelled).toHaveBeenCalledOnce(); expect(afterBody).not.toHaveBeenCalled(); await flush(); expect(f.native.leases.size).toBe(0);
});
it('response deadline errors idle/unconsumed streams and releases only after their known cancellation settles', async () => {
  const f = fixture(1000), cancel = vi.fn(); route.dispatch.mockImplementation(async () => new Response(new ReadableStream({ cancel }, { highWaterMark: 0 })));
  const response = await f.handler(request()); expect(response.status).toBe(200); await vi.advanceTimersByTimeAsync(1001);
  await expect(response.arrayBuffer()).rejects.toThrow('Hosted deadline'); expect(cancel).toHaveBeenCalledOnce(); await flush(); expect(f.native.leases.size).toBe(0);
  route.dispatch.mockImplementation(async () => Response.json({})); const retry = await f.make()(request()); expect(retry.status).toBe(200); await retry.body!.cancel(); await flush();
});
it('keeps unknown original work occupied across deadline/restart until its actual promise settles', async () => {
  const f = fixture(1000); let resolve!: (value: Response) => void; route.dispatch.mockImplementation(() => new Promise<Response>(r => { resolve = r; }));
  const makePost = () => new Request(origin + '/api/research/analysis', { method: 'POST', headers: { Host: 'research.example.test', Origin: origin, 'Content-Length': '1' }, body: new Uint8Array([1]) });
  const first = f.handler(makePost()); await flush(); await vi.advanceTimersByTimeAsync(11_001); expect((await first).status).toBe(409); expect(f.native.release).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(50_000); expect((await f.make()(makePost())).status).toBe(429); expect(route.dispatch).toHaveBeenCalledOnce();
  resolve(new Response(null)); await flush(); expect(f.native.leases.size).toBe(0);
  route.dispatch.mockImplementation(async () => Response.json({})); const next = await f.make()(makePost()); expect(next.status).toBe(200); await next.body!.cancel(); await flush();
});

it('oversized response cancellation holds the native slot until actual cancellation settlement', async () => {
  const f = fixture(); let settle!: () => void; const cancelled = vi.fn(() => new Promise<void>(resolve => { settle = resolve; }));
  route.dispatch.mockImplementation(async () => new Response(new ReadableStream({ cancel: cancelled }, { highWaterMark: 0 }), { headers: { 'Content-Length': '4000001' } }));
  let completed = false; const response = f.handler(request()).then(value => { completed = true; return value; });
  await flush(); expect(cancelled).toHaveBeenCalledOnce(); expect(f.native.release).not.toHaveBeenCalled(); expect(completed).toBe(false);
  settle(); expect((await response).status).toBe(413); expect(f.native.leases.size).toBe(0);
});

it('lost begin acknowledgement never authorizes this invocation to release work or dispatch', async () => {
  const f = fixture(), begin = f.native.beginWork;
  f.native.beginWork = vi.fn(async input => { await begin(input); throw new Error('synthetic lost begin acknowledgement'); });
  const post = () => new Request(origin + '/api/research/analysis', { method: 'POST', headers: { Host: 'research.example.test', Origin: origin, 'Content-Length': '1' }, body: new Uint8Array([1]) });
  expect((await f.handler(post())).status).toBe(409); await flush(); expect(f.native.release).not.toHaveBeenCalled(); expect(route.dispatch).not.toHaveBeenCalled();
  expect(f.native.started.size).toBe(1); expect((await f.make()(post())).status).toBe(429);
});
it('late private read disposal remains occupied until its delayed cancellation settles', async () => {
  const f = fixture(1000); let deliver!: (value: ReadableStream<Uint8Array>) => void, settle!: () => void;
  const cancelled = vi.fn(() => new Promise<void>(resolve => { settle = resolve; }));
  vi.mocked(store.read).mockImplementationOnce(() => new Promise(resolve => { deliver = resolve; }));
  route.dispatch.mockImplementation(async (_request, port) => new Response(await port.read('research/synthetic/object-a0', { start: 0, end: 0 })));
  const first = f.handler(request()); await flush(); await vi.advanceTimersByTimeAsync(11_001); expect((await first).status).toBe(409);
  deliver(new ReadableStream({ cancel: cancelled }, { highWaterMark: 0 })); await flush(); expect(cancelled).toHaveBeenCalledOnce(); expect(f.native.release).not.toHaveBeenCalled();
  settle(); await flush(); expect(f.native.release).toHaveBeenCalledOnce(); expect(f.native.leases.size).toBe(0);
});
it('a rejected late resource cancellation remains unknown and never becomes a successful settlement release', async () => {
  const f = fixture(1000); let deliver!: (value: Response) => void;
  const cancelled = vi.fn(async () => { throw new Error('synthetic cancellation unknown'); });
  route.dispatch.mockImplementation(() => new Promise<Response>(resolve => { deliver = resolve; }));
  const first = f.handler(request()); await flush(); await vi.advanceTimersByTimeAsync(11_001); expect((await first).status).toBe(409);
  deliver(new Response(new ReadableStream({ cancel: cancelled }, { highWaterMark: 0 }))); await flush(); expect(cancelled).toHaveBeenCalledOnce(); expect(f.native.release).not.toHaveBeenCalled(); expect(f.native.leases.size).toBe(1);
});

it('does not complete a successful body until the native release acknowledgement settles', async () => {
  const f = fixture(); let acknowledge!: (accepted: boolean) => void;
  f.native.release = vi.fn(() => new Promise<boolean>(resolve => { acknowledge = resolve; }));
  route.dispatch.mockImplementation(async () => Response.json({ saved: true }));
  const response = await f.handler(request()); let completed = false;
  const body = response.json().then(value => { completed = true; return value; });
  await flush(); expect(f.native.release).toHaveBeenCalledOnce(); expect(completed).toBe(false);
  acknowledge(true); expect(await body).toEqual({ saved: true }); expect(completed).toBe(true);
});

it('a lost release acknowledgement fails the successful body without retrying or pretending occupancy cleared', async () => {
  const f = fixture(); f.native.release = vi.fn(() => new Promise(() => {}));
  route.dispatch.mockImplementation(async () => Response.json({ saved: true }));
  const response = await f.handler(request()); const body = response.text();
  const assertion = expect(body).rejects.toThrow('Hosted release unresolved');
  await flush(); await vi.advanceTimersByTimeAsync(10_001); await assertion;
  expect(f.native.release).toHaveBeenCalledOnce(); expect(f.native.started.size).toBe(1);
});

it.each(['no-body', 'oversize', 'known-failure'])('waits for native ACK before terminal %s response', async kind => {
  const f = fixture(); let acknowledge!: (accepted: boolean) => void;
  f.native.release = vi.fn(() => new Promise<boolean>(resolve => { acknowledge = resolve; }));
  route.dispatch.mockImplementation(async () => { if (kind === 'known-failure') throw new Error('synthetic local failure'); return kind === 'no-body' ? new Response(null, { status: 204 }) : new Response('too large', { headers: { 'Content-Length': '4000001' } }); });
  let completed = false; const response = f.handler(request()).then(value => { completed = true; return value; });
  await flush(); expect(f.native.release).toHaveBeenCalledOnce(); expect(completed).toBe(false);
  acknowledge(true); expect((await response).status).toBe(kind === 'no-body' ? 204 : kind === 'oversize' ? 413 : 409);
});

it('rejected oversized-body cancellation returns unresolved and never releases its native hold', async () => {
  const f = fixture(); route.dispatch.mockImplementation(async () => new Response(new ReadableStream({ cancel: async () => { throw new Error('unknown cancellation'); } }), { headers: { 'Content-Length': '4000001' } }));
  const response = f.handler(request()); await vi.advanceTimersByTimeAsync(10_001);
  expect((await response).status).toBe(409); expect(f.native.release).not.toHaveBeenCalled(); expect(f.native.started.size).toBe(1);
});

it('response cancellation waits for an in-flight authority check and its release ACK, including concurrent stop callers', async () => {
  const f = fixture(); route.dispatch.mockImplementation(async () => Response.json({ retired: 9 }));
  const response = await f.handler(request()), reader = response.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  let inspectDone!: (value: any) => void, releaseDone!: (value: boolean) => void;
  const originalInspect = f.native.inspect;
  f.native.inspect = vi.fn(input => new Promise(resolve => { inspectDone = async value => resolve(value ?? await originalInspect(input)); }));
  f.native.release = vi.fn(() => new Promise(resolve => { releaseDone = resolve; }));
  const eof = reader.read(); await flush();
  let cancelled = false; const cancel = reader.cancel().then(() => { cancelled = true; });
  await flush(); expect(cancelled).toBe(false); expect(f.native.release).not.toHaveBeenCalled();
  inspectDone(null); await flush(); expect(f.native.release).toHaveBeenCalledOnce(); expect(cancelled).toBe(false);
  releaseDone(true); await cancel; await eof.catch(() => undefined); expect(cancelled).toBe(true);
});
it('pending authority timeout is one bounded wait and does not release or repeat work', async () => {
  const f = fixture(); route.dispatch.mockImplementation(async () => Response.json({ retired: 9 }));
  const response = await f.handler(request()), reader = response.body!.getReader(); await reader.read();
  f.native.inspect = vi.fn(() => new Promise(() => {}));
  const eof = reader.read(); await flush();
  const cancel = reader.cancel(), rejected = expect(cancel).rejects.toThrow('Hosted release unresolved');
  await vi.advanceTimersByTimeAsync(10_001); await rejected; await eof.catch(() => undefined);
  expect(f.native.release).not.toHaveBeenCalled(); expect(f.native.inspect).toHaveBeenCalledOnce(); expect(f.native.started.size).toBe(1);
});
