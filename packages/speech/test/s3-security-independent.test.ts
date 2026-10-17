import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { createSpeechOutput, type SpeechLease } from '../src/server.js';
import { createNodeSpeechTransport, type NodeSpeechOptions } from '../../../apps/clinic-server/src/speech.js';
import { nodeHttpHandler } from '../../../apps/clinic-server/src/http.js';

const input = { sessionId: 'session-a', sourceId: 'prompt-a', expectedRevision: 3, requestId: 'audio-1' };
const source = { sessionId: 'session-a', sourceId: 'prompt-a', revision: 3, text: 'What would help you prepare for this visit?' };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function setup(settle = vi.fn(async () => undefined)) {
  const reserve = vi.fn(async (): Promise<SpeechLease> => ({ settle }));
  const authorize = vi.fn(async () => source);
  const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } }));
  return { settle, reserve, authorize, fetcher, speak: createSpeechOutput({ elevenlabsApiKey: 'test-only', admission: { reserve }, authorize, fetcher }) };
}

describe('independent S3 failure and cancellation review', () => {
  it('does not call TTS when the browser disconnects during durable admission', async () => {
    const f = setup(), admission = deferred<SpeechLease>(), abort = new AbortController();
    f.reserve.mockImplementationOnce(() => admission.promise);
    const speaking = f.speak(input, abort.signal);
    await vi.waitFor(() => expect(f.reserve).toHaveBeenCalledOnce());
    abort.abort(); admission.resolve({ settle: f.settle });
    await expect(speaking).rejects.toThrow('interrupted');
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.settle).toHaveBeenCalledExactlyOnceWith('interrupted');
  });

  it('refuses expired admission before TTS dispatch and retains the full reservation', async () => {
    vi.useFakeTimers(); const f = setup();
    f.reserve.mockImplementationOnce(async () => { vi.setSystemTime(Date.now() + 35_001); return { settle: f.settle }; });
    await expect(f.speak(input)).rejects.toThrow('timeout');
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.settle).toHaveBeenCalledExactlyOnceWith('failed');
  });

  it('keeps successful TTS bytes usable after the durable settlement acknowledgement is lost', async () => {
    const f = setup(vi.fn(async () => { throw new Error('bookkeeping acknowledgement lost'); }));
    const response = await f.speak(input);
    await expect(response.arrayBuffer()).resolves.toEqual(new Uint8Array([1, 2, 3]).buffer);
    expect(f.settle).toHaveBeenCalledExactlyOnceWith('completed'); expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it('does not hold completed audio open indefinitely while durable settlement is unresolved', async () => {
    vi.useFakeTimers();
    const settlement = deferred<void>();
    const f = setup(vi.fn(() => settlement.promise));
    const response = await f.speak(input);
    let completed = false;
    const body = response.arrayBuffer().then(value => { completed = true; return value; });
    await vi.advanceTimersByTimeAsync(30_001);
    const completedBeforeSettlement = completed;
    // Always release the fake to leave no intentionally hanging test work behind.
    settlement.resolve(undefined); await body;
    expect(completedBeforeSettlement).toBe(true);
    expect(f.settle).toHaveBeenCalledExactlyOnceWith('completed'); expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it('does not open STT after a closed browser receives a late admission result', async () => {
    const admission = deferred<SpeechLease>(), settle = vi.fn(async () => undefined);
    const reserve = vi.fn(() => admission.promise), sessionId = crypto.randomUUID();
    const authenticate = vi.fn(async () => ({ sessionId }));
    const capture = vi.fn(async () => ({ sessionId, promptId: 'Q01:reason', revision: 1 }));
    const connect = vi.fn(() => { throw Error('provider must not be opened'); });
    const transport = createNodeSpeechTransport({ access: { authenticate, capture, output: vi.fn() } as unknown as NodeSpeechOptions['access'], admission: { reserve }, deepgramApiKey: 'synthetic', elevenlabsApiKey: 'synthetic', connect });
    const server = createServer(nodeHttpHandler(async request => await transport.handle(request) ?? new Response('', { status: 404 })));
    server.on('upgrade', (request, socket, head) => void transport.upgrade(request, socket, head));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/api/clinic/speech/input`);
    socket.on('error', () => undefined);
    cleanups.push(async () => { socket.terminate(); transport.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'start', requestId: crypto.randomUUID(), sessionId, promptId: 'Q01:reason', expectedRevision: 1 }));
    await vi.waitFor(() => expect(reserve).toHaveBeenCalledOnce());
    socket.close(); await once(socket, 'close'); admission.resolve({ settle });
    await vi.waitFor(() => expect(settle).toHaveBeenCalledExactlyOnceWith('failed'));
    expect(connect).not.toHaveBeenCalled(); expect(capture).toHaveBeenCalledOnce();
  });
});
