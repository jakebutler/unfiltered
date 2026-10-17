import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { createNodeSpeechTransport, type NodeSpeechOptions } from '../../../apps/clinic-server/src/speech.js';
import { nodeHttpHandler } from '../../../apps/clinic-server/src/http.js';
import { ApiFailure } from '../../clinic-api/src/types.js';
import { deepgramListenUrl } from '../src/relay.js';
import type { SpeechInputEvent } from '../src/contracts.js';

const origin = 'http://127.0.0.1:5173', sessionId = crypto.randomUUID();
const start = () => ({ type: 'start', sessionId, requestId: crypto.randomUUID(), promptId: 'Q01:reason', expectedRevision: 1 });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(ingress?: NodeSpeechOptions['ingress']) {
  const provider = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(provider, 'listening');
  const port = (provider.address() as { port: number }).port;
  const settle = vi.fn<() => void | Promise<void>>(), reserve = vi.fn(async () => ({ settle })), capture = vi.fn(async () => ({ sessionId, promptId: 'Q01:reason', revision: 1 }));
  const authenticate = vi.fn(async (request: Request) => { if (request.headers.get('origin') !== origin) throw new ApiFailure('origin-denied', 403); if (request.headers.get('cookie') !== 'test=confirmed') throw new ApiFailure('session-required', 401); return { sessionId }; });
  const output = vi.fn(async () => ({ sessionId, sourceId: 'Q01:reason', revision: 1, text: 'What would help you today?' }));
  const connect = vi.fn((url, options) => { expect(url).toBe(deepgramListenUrl); return new WebSocket(`ws://127.0.0.1:${port}`, options); });
  const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } }));
  const transport = createNodeSpeechTransport({ access: { authenticate, capture, output } as unknown as NodeSpeechOptions['access'], admission: { reserve }, deepgramApiKey: 'test-deepgram-key', elevenlabsApiKey: 'test-eleven-key', connect, fetcher, ingress });
  const nativeClosed = vi.fn();
  const server = createServer(nodeHttpHandler(async request => await transport.handle(request) ?? new Response('', { status: 404 }))); server.on('upgrade', (req, socket, head) => void transport.upgrade(req, socket, head));
  server.on('connection', socket => socket.once('close', nativeClosed));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/clinic/speech/input`;
  const browsers: WebSocket[] = [], upstream: WebSocket[] = [], upstreamMessages: { data: Buffer; binary: boolean }[] = [];
  provider.on('connection', socket => { upstream.push(socket); socket.on('message', (data, binary) => { const value = Buffer.from(data as Buffer); upstreamMessages.push({ data: value, binary }); if (!binary && value.toString() === '{"type":"CloseStream"}') { socket.send(JSON.stringify({ type: 'Results', start: 0, duration: 1, is_final: true, speech_final: true, channel: { alternatives: [{ transcript: 'No allergies.' }] } })); socket.close(1000); } }); });
  async function browser(headers = { origin, cookie: 'test=confirmed' }, suffix = '') {
    const socket = new WebSocket(url + suffix, { headers }); browsers.push(socket);
    const events: SpeechInputEvent[] = []; socket.on('message', raw => { events.push(JSON.parse(raw.toString())); }); socket.on('error', () => undefined);
    await once(socket, 'open'); return { socket, events };
  }
  cleanups.push(async () => { for (const socket of browsers) socket.terminate(); transport.close(); for (const socket of provider.clients) socket.terminate(); server.closeAllConnections(); await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => provider.close(() => resolve()))]); });
  return { nativeClosed, transport, browser, upstream, upstreamMessages, reserve, settle, capture, connect, fetcher, output, authenticate, httpUrl: url.replace('ws:', 'http:').replace('/input', '/output') };
}
describe('native Node speech transport using local fake provider', () => {
  it('authenticates before upgrade and does no provider work for denied origin, cookie or query', async () => {
    const f = await fixture();
    await expect(f.browser({ origin: 'https://other.example', cookie: 'test=confirmed' })).rejects.toThrow();
    await expect(f.browser({ origin, cookie: '' })).rejects.toThrow();
    await expect(f.browser(undefined, '?provider=other')).rejects.toThrow();
    expect(f.reserve).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled();
  });
  it('sends ready only after scope/admission and upstream open, pins auth, flushes final results and closes', async () => {
    const f = await fixture(), { socket, events } = await f.browser(); socket.send(JSON.stringify(start()));
    await vi.waitFor(() => expect(events[0]?.type).toBe('ready'));
    expect(f.capture).toHaveBeenCalledTimes(2); expect(f.reserve).toHaveBeenCalledOnce();
    expect(f.connect.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Token test-deepgram-key' }, maxPayload: 64000, handshakeTimeout: 5000, followRedirects: false, perMessageDeflate: false });
    socket.send(new Uint8Array(3200)); socket.send(JSON.stringify({ type: 'finish' }));
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: 'ended', outcome: 'completed' }));
    expect(events.some(event => event.type === 'recognition' && event.segment.text === 'No allergies.')).toBe(true);
    expect(f.upstreamMessages[0].binary).toBe(true); expect(f.upstreamMessages).toHaveLength(2);
    expect(f.settle).toHaveBeenCalledExactlyOnceWith('completed');
    await vi.waitFor(() => expect(socket.readyState).toBe(WebSocket.CLOSED));
  });
  it('rejects overlapping conversation sockets before a second admission', async () => {
    const f = await fixture(); await f.browser(); await expect(f.browser()).rejects.toThrow(); expect(f.reserve).not.toHaveBeenCalled();
  }, 10000);
  it('waits for durable completion before clean ended and admits one next capture after closure', async () => {
    const f = await fixture(); let acknowledge!: () => void;
    f.settle.mockImplementationOnce(() => new Promise<void>(resolve => { acknowledge = resolve; }));
    const first = await f.browser(); first.socket.send(JSON.stringify(start()));
    await vi.waitFor(() => expect(first.events[0]?.type).toBe('ready'));
    first.socket.send(JSON.stringify({ type: 'finish' }));
    await vi.waitFor(() => expect(f.settle).toHaveBeenCalledOnce());
    expect(first.events.some(event => event.type === 'ended')).toBe(false);
    first.socket.send(new Uint8Array(3200)); first.socket.send(JSON.stringify({ type: 'finish' }));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(first.events.some(event => event.type === 'ended')).toBe(false); // Already-inflight frames cannot flip completion.
    const nextSocket = f.browser(); acknowledge();
    const next = await nextSocket; next.socket.send(JSON.stringify(start()));
    await vi.waitFor(() => expect(next.events[0]?.type).toBe('ready'));
    expect(first.events.at(-1)).toEqual({ type: 'ended', outcome: 'completed' });
    expect(f.reserve).toHaveBeenCalledTimes(2); expect(f.connect).toHaveBeenCalledTimes(2);
    expect(f.settle).toHaveBeenCalledExactlyOnceWith('completed');
  });
  it.each(['reject', 'hang', 'cancel'] as const)('never sends late clean ended or repeats settlement after acknowledgement %s', async mode => {
    const f = await fixture(); let acknowledge!: () => void, fail!: () => void;
    f.settle.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { acknowledge = resolve; fail = () => reject(new Error('private failure')); }));
    const first = await f.browser(); first.socket.send(JSON.stringify(start()));
    await vi.waitFor(() => expect(first.events[0]?.type).toBe('ready'));
    first.socket.send(JSON.stringify({ type: 'finish' })); await vi.waitFor(() => expect(f.settle).toHaveBeenCalledOnce());
    if (mode === 'reject') fail(); else if (mode === 'cancel') first.socket.close();
    await vi.waitFor(() => expect(first.socket.readyState).toBe(WebSocket.CLOSED), { timeout: 3500 });
    acknowledge(); await Promise.resolve();
    expect(first.events).not.toContainEqual({ type: 'ended', outcome: 'completed' });
    if (mode !== 'cancel') expect(first.events.at(-1)).toEqual({ type: 'ended', outcome: 'unknown' });
    expect(f.settle).toHaveBeenCalledExactlyOnceWith('completed'); expect(f.connect).toHaveBeenCalledOnce();
  });
  it('polls only proven ingress busy with immutable attempt and waits for actual native close acknowledgement', async () => {
    let occupied = false, release!: () => void;
    const close = vi.fn(() => new Promise<void>(resolve => { release = () => { occupied = false; resolve(); }; }));
    const reserve = vi.fn(async (_input: unknown) => { if (occupied) throw new ApiFailure('ingress-socket-busy', 429, true); occupied = true; return { expiresAt: Date.now() + 90000, close }; });
    const f = await fixture({ reserve }), first = await f.browser(); first.socket.send(JSON.stringify(start()));
    await vi.waitFor(() => expect(first.events[0]?.type).toBe('ready')); first.socket.send(JSON.stringify({ type: 'finish' }));
    await vi.waitFor(() => expect(first.events.at(-1)).toEqual({ type: 'ended', outcome: 'completed' }));
    const nextSocket = f.browser(); await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(reserve.mock.calls.length).toBeGreaterThan(2));
    expect(f.reserve).toHaveBeenCalledOnce(); expect(f.connect).toHaveBeenCalledOnce();
    release(); const next = await nextSocket; next.socket.send(JSON.stringify(start()));
    await vi.waitFor(() => expect(next.events[0]?.type).toBe('ready'));
    const attempts = reserve.mock.calls.slice(1).map(([input]) => (input as { attemptId: string }).attemptId);
    expect(new Set(attempts).size).toBe(1); expect(f.reserve).toHaveBeenCalledTimes(2); expect(f.connect).toHaveBeenCalledTimes(2);
  });
  it('bounds persistent proven ingress busy to seven checks and one immutable uncharged attempt', async () => {
    const reserve = vi.fn(async (_input: unknown) => { throw new ApiFailure('ingress-socket-busy', 429, true); });
    const f = await fixture({ reserve }); await expect(f.browser()).rejects.toThrow();
    expect(reserve).toHaveBeenCalledTimes(7);
    expect(new Set(reserve.mock.calls.map(([input]) => (input as { attemptId: string }).attemptId)).size).toBe(1);
    expect(f.reserve).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled();
  });
  it('closes a late successful ingress lease once when the native socket closed during reservation', async () => {
    let acquire!: (lease: { expiresAt: number; close(): Promise<void> }) => void;
    const reserve = vi.fn(() => new Promise<{ expiresAt: number; close(): Promise<void> }>(resolve => { acquire = resolve; }));
    const close = vi.fn(async () => undefined), f = await fixture({ reserve });
    const socket = new WebSocket(f.httpUrl.replace('http:', 'ws:').replace('/output', '/input'), { headers: { origin, cookie: 'test=confirmed' } });
    socket.on('error', () => undefined); await vi.waitFor(() => expect(reserve).toHaveBeenCalledOnce());
    const nativeClose = new Promise<void>(resolve => socket.once('close', () => resolve())); socket.terminate(); await nativeClose; await vi.waitFor(() => expect(f.nativeClosed).toHaveBeenCalledOnce());
    acquire({ expiresAt: Date.now() + 90000, close });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(f.reserve).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled();
  });
  it('aborts a disconnected busy upgrade before reservation, authentication or provider replay', async () => {
    const reserve = vi.fn(async () => { throw new ApiFailure('ingress-socket-busy', 429, true); });
    const f = await fixture({ reserve });
    const socket = new WebSocket(f.httpUrl.replace('http:', 'ws:').replace('/output', '/input'), { headers: { origin, cookie: 'test=confirmed' } });
    socket.on('error', () => undefined);
    await vi.waitFor(() => expect(reserve).toHaveBeenCalled()); const nativeClose = new Promise<void>(resolve => socket.once('close', () => resolve())); socket.terminate(); await nativeClose;
    await vi.waitFor(() => expect(f.nativeClosed).toHaveBeenCalledOnce());
    const calls = reserve.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(reserve).toHaveBeenCalledTimes(calls); expect(f.reserve).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled();
  });
  it.each(['ingress-outcome-unknown', 'ingress-attempt-already-reserved', 'ingress-rate-limited'])('does not retry %s or dispatch any provider', async code => {
    const reserve = vi.fn(async () => { throw new ApiFailure(code, 503); });
    const f = await fixture({ reserve }); await expect(f.browser()).rejects.toThrow();
    expect(reserve).toHaveBeenCalledOnce(); expect(f.reserve).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled();
  });
  it('rejects frames larger than native maxPayload and closes upstream on disconnect', async () => {
    const f = await fixture(), { socket, events } = await f.browser(); socket.send(JSON.stringify(start()));
    await vi.waitFor(() => expect(events[0]?.type).toBe('ready')); socket.send(new Uint8Array(16386));
    await vi.waitFor(() => expect(socket.readyState).toBe(WebSocket.CLOSED));
    await vi.waitFor(() => expect(f.upstream[0].readyState).toBe(WebSocket.CLOSED));
    expect(f.upstreamMessages).toHaveLength(0); expect(f.settle).toHaveBeenCalledOnce();
  });
  it('does not dispatch after failed admission or a stale second scope check', async () => {
    const f = await fixture(); f.capture.mockRejectedValueOnce(new ApiFailure('stale-session', 409));
    const { socket, events } = await f.browser(); socket.send(JSON.stringify(start()));
    await vi.waitFor(() => expect(events[0]).toMatchObject({ type: 'error', code: 'stale-session' }));
    expect(f.connect).not.toHaveBeenCalled(); expect(f.reserve).not.toHaveBeenCalled();
  });
  it('rechecks prompt after durable admission and charges that bound without connecting if it changed', async () => {
    const f = await fixture(); f.capture.mockResolvedValueOnce({ sessionId, promptId: 'Q01:reason', revision: 1 }).mockRejectedValueOnce(new ApiFailure('stale-session', 409));
    const { socket, events } = await f.browser(); socket.send(JSON.stringify(start()));
    await vi.waitFor(() => expect(events[0]).toMatchObject({ type: 'error', code: 'stale-session' }));
    expect(f.reserve).toHaveBeenCalledOnce(); expect(f.connect).not.toHaveBeenCalled(); expect(f.settle).toHaveBeenCalledExactlyOnceWith('failed');
  });
  it.each([1, 2])('does not dispatch when the browser closes during scope check %i', async check => {
    const f = await fixture(), scope = { sessionId, promptId: 'Q01:reason', revision: 1 };
    let resolveScope!: (value: typeof scope) => void;
    const pendingScope = new Promise<typeof scope>(resolve => { resolveScope = resolve; });
    if (check === 2) f.capture.mockResolvedValueOnce(scope);
    f.capture.mockImplementationOnce(() => pendingScope);
    const { socket } = await f.browser(); socket.send(JSON.stringify(start()));
    await vi.waitFor(() => expect(f.capture).toHaveBeenCalledTimes(check));
    socket.close(); await once(socket, 'close');
    resolveScope(scope); await pendingScope; await Promise.resolve();
    expect(f.reserve).toHaveBeenCalledTimes(check - 1);
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.settle).toHaveBeenCalledTimes(check - 1);
  });
  it('never opens provider after admission rejects', async () => {
    const f = await fixture(); f.reserve.mockRejectedValueOnce(new Error('sensitive internal admission error'));
    const { socket, events } = await f.browser(); socket.send(JSON.stringify(start()));
    await vi.waitFor(() => expect(events[0]).toMatchObject({ type: 'error', code: 'speech-unavailable' }));
    expect(JSON.stringify(events)).not.toContain('sensitive'); expect(f.connect).not.toHaveBeenCalled();
  });
  it('rejects PCM before ready and never passes arbitrary provider controls through', async () => {
    const f = await fixture(), { socket, events } = await f.browser(); socket.send(new Uint8Array(3200));
    await vi.waitFor(() => expect(events[0]?.type).toBe('error')); expect(f.connect).not.toHaveBeenCalled();
  });
  it('streams the authorized POST and rejects arbitrary text before provider fetch', async () => {
    const f = await fixture(); const input = { sessionId, requestId: crypto.randomUUID(), sourceId: 'Q01:reason', expectedRevision: 1 };
    const post = (body: unknown, signal?: AbortSignal) => new Request(`${origin}/api/clinic/speech/output`, { method: 'POST', headers: { origin, cookie: 'test=confirmed', 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    const denied = await f.transport.handle(post({ ...input, text: 'arbitrary' })); expect(denied?.status).toBe(400); expect(f.fetcher).not.toHaveBeenCalled();
    const response = await f.transport.handle(post(input)); expect(new Uint8Array(await response!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(f.output).toHaveBeenCalledTimes(2); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it('forwards the first chunk over native HTTP before completion and aborts provider on client disconnect', async () => {
    const f = await fixture(), canceled = vi.fn();
    f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); }, cancel: canceled }), { headers: { 'content-type': 'audio/mpeg' } }));
    const abort = new AbortController();
    const response = await fetch(f.httpUrl, { method: 'POST', headers: { origin, cookie: 'test=confirmed', 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, requestId: crypto.randomUUID(), sourceId: 'Q01:reason', expectedRevision: 1 }), signal: abort.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader(); expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]));
    abort.abort(); await vi.waitFor(() => expect(canceled).toHaveBeenCalledOnce());
    expect(f.settle).toHaveBeenCalledExactlyOnceWith('interrupted'); expect(f.fetcher).toHaveBeenCalledOnce();
  });
});
