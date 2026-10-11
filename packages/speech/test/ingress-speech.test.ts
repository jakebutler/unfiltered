import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import WebSocket from 'ws';
import { createNodeSpeechTransport, type NodeSpeechOptions } from '../../../apps/clinic-server/src/speech.js';
import type { IngressAdmission, IngressLease } from '../../clinic-api/src/ingress-admission.js';
import { ApiFailure } from '../../clinic-api/src/types.js';

const origin = 'https://clinic.example', sessionId = crypto.randomUUID();
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(reserve: IngressAdmission['reserve']) {
  const connect = vi.fn(() => { throw new Error('provider-must-not-connect'); });
  const providerReserve = vi.fn(async () => { throw new Error('provider-must-not-reserve'); });
  const authenticate = vi.fn(async (request: Request) => { if (request.headers.get('origin') !== origin || request.headers.get('cookie') !== 'synthetic=confirmed') throw new ApiFailure('origin-denied', 403); return { sessionId }; });
  const transport = createNodeSpeechTransport({ access: { authenticate } as unknown as NodeSpeechOptions['access'], admission: { reserve: providerReserve }, ingress: { reserve }, deepgramApiKey: 'synthetic-key', elevenlabsApiKey: 'synthetic-key', connect });
  const server = createServer(); let nativeClosed = false, nativeSocket: Socket | undefined;
  server.on('connection', socket => { nativeSocket = socket; socket.once('close', () => { nativeClosed = true; }); });
  server.on('upgrade', (request, socket, head) => void transport.upgrade(request, socket, head));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanups.push(async () => { transport.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/clinic/speech/input`;
  function browser(headers = { origin, cookie: 'synthetic=confirmed' }) {
    const socket = new WebSocket(url, { headers }); socket.on('error', () => undefined);
    cleanups.push(() => socket.terminate());
    const opened = once(socket, 'open'); void opened.catch(() => undefined);
    return { socket, opened };
  }
  return { browser, connect, providerReserve, authenticate, nativeClosed: () => nativeClosed, closeNative: () => { if (!nativeSocket) throw new Error('native-socket-required'); nativeSocket.destroy(); } };
}

describe('shared speech upgrade admission placement', () => {
  it('authenticates origin/cookie before touching the shared ledger', async () => {
    const reserve = vi.fn(async () => ({ expiresAt: Date.now() + 90000, close: async () => undefined }));
    const f = await fixture(reserve), browser = f.browser({ origin: 'https://other.example', cookie: '' });
    await expect(browser.opened).rejects.toThrow();
    expect(reserve).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled(); expect(f.providerReserve).not.toHaveBeenCalled();
  });
  it.each(['ingress-socket-busy', 'ingress-outcome-unknown'])('does not upgrade or dispatch on %s', async code => {
    const reserve = vi.fn(async () => { throw new ApiFailure(code, code.endsWith('unknown') ? 503 : 429); });
    const f = await fixture(reserve), browser = f.browser();
    await expect(browser.opened).rejects.toThrow();
    // Busy is a proven pre-reservation denial, retried with the 6-step backoff (1 + 6 calls); unknown outcome is never retried.
    expect(reserve).toHaveBeenCalledTimes(code === 'ingress-socket-busy' ? 7 : 1);
    expect(f.connect).not.toHaveBeenCalled(); expect(f.providerReserve).not.toHaveBeenCalled();
  });
  it('releases shared capacity only after observed native socket closure', async () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    const close = vi.fn(async () => { expect(f.nativeClosed()).toBe(true); });
    const reserve = vi.fn(async () => ({ expiresAt: Date.now() + 90000, close }));
    f = await fixture(reserve); const browser = f.browser(); await browser.opened;
    expect(close).not.toHaveBeenCalled(); expect(reserve.mock.calls[0][0]).toMatchObject({ kind: 'speech-upgrade', sessionId });
    const ended = once(browser.socket, 'close'); browser.socket.close(); await ended;
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(f.connect).not.toHaveBeenCalled(); expect(f.providerReserve).not.toHaveBeenCalled();
  });
  it('handles close before the shared lease resolves without an upgrade or provider dispatch', async () => {
    const pending = deferred<IngressLease>(), reserve = vi.fn(() => pending.promise);
    let f: Awaited<ReturnType<typeof fixture>>;
    const close = vi.fn(async () => { expect(f.nativeClosed()).toBe(true); });
    f = await fixture(reserve); const browser = f.browser();
    await vi.waitFor(() => expect(reserve).toHaveBeenCalledOnce());
    expect(close).not.toHaveBeenCalled();
    // Browser abort alone does not prove the server observed native closure:
    // a pending upgraded socket can remain half-open until its timeout.
    // Drive the actual native close required by this admission contract.
    const ended = new Promise<void>(resolve => browser.socket.once('close', () => resolve())); f.closeNative(); await ended;
    await vi.waitFor(() => expect(f.nativeClosed()).toBe(true));
    expect(close).not.toHaveBeenCalled();
    pending.resolve({ expiresAt: Date.now() + 90000, close });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    await expect(browser.opened).rejects.toThrow(); expect(f.connect).not.toHaveBeenCalled(); expect(f.providerReserve).not.toHaveBeenCalled();
  });
  it('does not accept an expired lease and closes the native socket before releasing it', async () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    const close = vi.fn(async () => { expect(f.nativeClosed()).toBe(true); });
    f = await fixture(async () => ({ expiresAt: Date.now() - 1, close }));
    const browser = f.browser(); await expect(browser.opened).rejects.toThrow();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce()); expect(f.connect).not.toHaveBeenCalled();
  });
});
