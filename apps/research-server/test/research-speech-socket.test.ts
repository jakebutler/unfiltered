import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type WebSocket from 'ws';
import { createResearchSpeechTransport } from '../src/research-speech';
import type { ResearchSpeechAuthority } from '../../../packages/research-core/src/speech-contract';

// Native ws event/termination port fakes: no listener or provider is started.
const state = vi.hoisted(() => ({ browser: undefined as any }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class Ws extends EventEmitter {
    static OPEN = 1; static CLOSED = 3; static CONNECTING = 0;
    readyState = 1; bufferedAmount = 0; sent: (string | Uint8Array)[] = [];
    send(value: string | Uint8Array, callback?: (error?: Error) => void) { this.sent.push(value); callback?.(); }
    close() { this.readyState = 3; queueMicrotask(() => this.emit('close', 1000)); }
    terminate() { this.close(); }
  }
  class Server { constructor(_options: unknown) {} handleUpgrade(_req: unknown, _socket: unknown, _head: unknown, attach: (browser: Ws) => void) { state.browser = new Ws(); attach(state.browser); } close() {} }
  return { default: Ws, WebSocketServer: Server };
});
class Provider extends EventEmitter {
  readyState = 0; bufferedAmount = 0; sent: (string | Uint8Array)[] = [];
  send(value: string | Uint8Array) { this.sent.push(value); }
  close() { this.readyState = 3; queueMicrotask(() => this.emit('close', 1000)); }
  terminate() { this.close(); }
}
beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers());
async function fixture(open = true, retainTerminal?: (promise: Promise<void>) => void) {
  const origin = 'https://research.example', token = 'a'.repeat(64), provider = new Provider();
  const diagnostics = vi.fn();
  const release = vi.fn(async () => {}), settle = vi.fn(async () => {}), nativeOperations = vi.fn(async <T>(dispatch: () => Promise<T>) => dispatch());
  const authority: ResearchSpeechAuthority = {
    status: vi.fn(async () => ({ enabled: true })), authorize: vi.fn(async () => {}), reserve: vi.fn(async () => ({ settle })), inspect: vi.fn(async () => {}), output: vi.fn(), receipt: vi.fn(),
    transcript: vi.fn(async (_token, scope, text) => ({ attemptId: scope.requestId, rawSourceId: 'session:1', text, promptId: scope.promptId, expectedRevision: scope.expectedRevision })),
  };
  const transport = createResearchSpeechTransport({ enabled: true, origin, authority, retainTerminal, deepgramApiKey: 'test-only', elevenlabsApiKey: 'test-only', connect: () => provider as unknown as WebSocket, onUpstreamDiagnostic: diagnostics, ingress: { reserve: async () => ({ expiresAt: Date.now() + 180_000, authority: nativeOperations, release }) } });
  const socket = { destroyed: false, end: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
  await transport.upgrade({ url: '/api/research/speech/input', method: 'GET', headers: { host: 'research.example', origin, upgrade: 'websocket' } } as IncomingMessage, socket, Buffer.alloc(0));
  const browser = state.browser;
  const scope = { sessionId: 'session-001', promptId: 'q1', expectedRevision: 1, requestId: 'speech-attempt-001' };
  browser.emit('message', Buffer.from(JSON.stringify({ type: 'start', token, ...scope })), false);
  await vi.advanceTimersByTimeAsync(0); if (open) { provider.readyState = 1; provider.emit('open'); }
  const events = () => browser.sent.filter((value: unknown) => typeof value === 'string').map((value: string) => JSON.parse(value));
  return { transport, browser, provider, authority, release, settle, nativeOperations, scope, events, diagnostics };
}
test('60s input batches stay below128 authority operations and preserve ordered PCM', async () => {
  const f = await fixture(); expect(f.events()[0].type).toBe('ready');
  // 59 one-second batches plus explicit finish; actual 60-second browser envelope
  // finishes before the hard limit rather than sneaking in a late 60th frame.
  for (let second = 0; second < 59; second++) {
    for (let frame = 0; frame < 16; frame++) f.browser.emit('message', Buffer.alloc(2000, second), true);
    await vi.advanceTimersByTimeAsync(1000);
  }
  f.browser.emit('message', Buffer.from('{"type":"finish"}'), false); await vi.advanceTimersByTimeAsync(0);
  expect(f.authority.inspect.mock.calls.length).toBeLessThanOrEqual(61);
  expect(f.nativeOperations.mock.calls.length).toBeLessThan(128);
  expect(f.provider.sent.filter(value => value instanceof Uint8Array)).toHaveLength(59 * 16);
  expect(f.provider.sent.at(-1)).toBe('{"type":"CloseStream"}');
  f.provider.emit('close', 1000); await vi.advanceTimersByTimeAsync(0);
  expect(f.settle).toHaveBeenCalledWith('completed'); expect(f.release).toHaveBeenCalledOnce(); f.transport.close();
});
test('revoked current check discards buffered PCM and never forwards it', async () => {
  const f = await fixture(); vi.mocked(f.authority.inspect).mockRejectedValue(new Error('SENSITIVE secret-shaped upstream URL payload'));
  f.browser.emit('message', Buffer.alloc(2000), true); await vi.advanceTimersByTimeAsync(1000);
  expect(f.provider.sent).toEqual([]); expect(f.settle).toHaveBeenCalledWith('unknown');
  expect(f.diagnostics).toHaveBeenCalledWith(expect.objectContaining({ event: 'research-stt-post-ready', phase: 'first-batch', reason: 'authority-rejected', checkElapsedMs: 0, forwardedPcmBytes: 0 }));
  expect(JSON.stringify(f.diagnostics.mock.calls)).not.toContain('SENSITIVE'); f.transport.close();
});
test('stale authorization result cannot forward a buffered batch', async () => {
  const f = await fixture(); let resolve!: () => void;
  vi.mocked(f.authority.inspect).mockImplementation(() => new Promise<void>(done => { resolve = done; }));
  f.browser.emit('message', Buffer.alloc(2000), true); await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(1001); resolve(); await vi.advanceTimersByTimeAsync(0);
  expect(f.provider.sent).toEqual([]); expect(f.settle).toHaveBeenCalledWith('unknown');
  expect(f.diagnostics).toHaveBeenCalledWith(expect.objectContaining({ event: 'research-stt-post-ready', phase: 'first-batch', reason: 'stale-authority', checkElapsedMs: 1001, forwardedPcmBytes: 0 })); f.transport.close();
});
test('explicit finish drains final recognition and saves raw once before ending', async () => {
  const f = await fixture(); f.browser.emit('message', Buffer.from('{"type":"finish"}'), false); await vi.advanceTimersByTimeAsync(0);
  f.provider.emit('message', Buffer.from(JSON.stringify({ type: 'Results', channel: { alternatives: [{ transcript: 'I expected an email receipt' }] }, start: 0, duration: 1, is_final: true, speech_final: true })), false);
  f.provider.emit('close', 1000); await vi.advanceTimersByTimeAsync(0);
  expect(f.authority.transcript).toHaveBeenCalledOnce(); expect(f.events().at(-1)).toMatchObject({ type: 'ended', outcome: 'completed', transcriptReceipt: { rawSourceId: 'session:1', text: 'I expected an email receipt' } });
  expect(f.provider.listenerCount('message')).toBe(0); expect(f.release).toHaveBeenCalledOnce(); f.transport.close();
});
test('browser close cannot release ingress while native provider settlement is pending', async () => {
  const f = await fixture(); let resolve!: () => void; f.settle.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
  f.browser.close(); await vi.advanceTimersByTimeAsync(0); expect(f.release).not.toHaveBeenCalled();
  resolve(); await vi.advanceTimersByTimeAsync(0); expect(f.release).toHaveBeenCalledOnce(); f.transport.close();
});

test.each(['admission', 'native-settlement'])('terminal %s failure is visible and never releases an unknown hold', async reason => {
  const f = await fixture();
  const error = Object.defineProperty({}, 'message', { get() { throw new Error('SENSITIVE getter must not run'); } });
  if (reason === 'admission') f.nativeOperations.mockRejectedValueOnce(error);
  else f.settle.mockRejectedValueOnce(error);
  f.browser.close(); await vi.advanceTimersByTimeAsync(0);
  expect(f.diagnostics).toHaveBeenCalledWith(expect.objectContaining({ event: 'research-stt-terminal', phase: 'settlement-rejected', reason, providerClosed: true, authoritySettled: false, leaseReleaseAcknowledged: false }));
  if (reason === 'admission') expect(f.settle).not.toHaveBeenCalled();
  else expect(f.settle).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(10_001);
  expect(f.diagnostics).toHaveBeenCalledWith(expect.objectContaining({ event: 'research-stt-terminal', phase: 'release-wait-expired', reason: 'bounded-wait' }));
  expect(f.release).not.toHaveBeenCalled(); expect(JSON.stringify(f.diagnostics.mock.calls)).not.toContain('SENSITIVE');
  f.transport.close();
});

test('terminal release ACK reports positive drain only after settlement and native release ACKs', async () => {
  const f = await fixture(); let settle!: () => void, release!: () => void;
  f.settle.mockImplementation(() => new Promise<void>(resolve => { settle = resolve; }));
  f.release.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  f.browser.close(); await vi.advanceTimersByTimeAsync(0);
  expect(f.diagnostics).toHaveBeenCalledWith(expect.objectContaining({ phase: 'settlement-started', pendingAuthorityWork: 1 }));
  expect(f.diagnostics.mock.calls.some(([row]) => row.phase === 'authority-drained')).toBe(false);
  settle(); await vi.advanceTimersByTimeAsync(0);
  expect(f.diagnostics).toHaveBeenCalledWith(expect.objectContaining({ phase: 'authority-drained', browserInputStopped: true, providerClosed: true, authoritySettled: true, pendingAuthorityWork: 0, saveUnknown: false, leaseReleaseAcknowledged: false }));
  expect(f.diagnostics.mock.calls.some(([row]) => row.phase === 'release-acknowledged')).toBe(false);
  release(); await vi.advanceTimersByTimeAsync(0);
  expect(f.diagnostics).toHaveBeenCalledWith(expect.objectContaining({ phase: 'release-acknowledged', pendingAuthorityWork: 0, leaseReleaseAcknowledged: true }));
  f.transport.close();
});

test('empty recognition cannot be mistaken for nonempty transcript in terminal evidence', async () => {
  const f = await fixture();
  f.provider.emit('message', Buffer.from(JSON.stringify({ type: 'Results', channel: { alternatives: [{ transcript: '' }] }, start: 0, duration: 1, is_final: true, speech_final: true })), false);
  f.browser.close(); await vi.advanceTimersByTimeAsync(0);
  expect(f.authority.transcript).not.toHaveBeenCalled();
  expect(f.diagnostics).toHaveBeenCalledWith(expect.objectContaining({ event: 'research-stt-terminal', phase: 'release-acknowledged', nonemptyRecognitionObserved: false }));
  expect(f.diagnostics.mock.calls.filter(([row]) => row.phase === 'release-acknowledged')).toHaveLength(1);
  f.transport.close();
});

test('rejected transcript ACK logs uncertainty and never emits a release ACK', async () => {
  const f = await fixture(); f.authority.transcript.mockRejectedValueOnce(new Error('SENSITIVE transcript write'));
  f.provider.emit('message', Buffer.from(JSON.stringify({ type: 'Results', channel: { alternatives: [{ transcript: 'SENSITIVE source words' }] }, start: 0, duration: 1, is_final: true, speech_final: true })), false);
  f.browser.close(); await vi.advanceTimersByTimeAsync(0);
  expect(f.diagnostics).toHaveBeenCalledWith(expect.objectContaining({ event: 'research-stt-terminal', phase: 'save-rejected', reason: 'native-save', saveUnknown: true, nonemptyRecognitionObserved: true }));
  expect(f.diagnostics.mock.calls.some(([row]) => row.phase === 'release-acknowledged')).toBe(false);
  expect(f.release).not.toHaveBeenCalled(); expect(JSON.stringify(f.diagnostics.mock.calls)).not.toContain('SENSITIVE'); f.transport.close();
});

test('rejected native release ACK is distinct from timeout and never claims release', async () => {
  const f = await fixture(); f.release.mockRejectedValueOnce(new Error('SENSITIVE native release ACK'));
  f.browser.close(); await vi.advanceTimersByTimeAsync(0);
  expect(f.diagnostics).toHaveBeenCalledWith(expect.objectContaining({ event: 'research-stt-terminal', phase: 'release-rejected', reason: 'native-release', providerClosed: true, pendingAuthorityWork: 0, authoritySettled: true, leaseReleaseAcknowledged: false }));
  expect(f.diagnostics.mock.calls.some(([row]) => row.phase === 'release-acknowledged' || row.phase === 'release-wait-expired')).toBe(false);
  expect(f.release).toHaveBeenCalledOnce(); expect(JSON.stringify(f.diagnostics.mock.calls)).not.toContain('SENSITIVE'); f.transport.close();
});
test('transport shutdown immediately closes borrowed native sockets before pending settlement', async () => {
  const f = await fixture(); let resolve!: () => void; f.settle.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
  f.transport.close(); expect(f.browser.readyState).toBe(3); expect(f.provider.readyState).toBe(3);
  await vi.advanceTimersByTimeAsync(0); expect(f.release).not.toHaveBeenCalled();
  resolve(); await vi.advanceTimersByTimeAsync(0); expect(f.release).toHaveBeenCalledOnce();
});

test('terminal WS event and server close wait for the known native release acknowledgement', async () => {
  const f = await fixture(); let acknowledge!: () => void;
  f.release.mockImplementation(() => new Promise<void>(resolve => { acknowledge = resolve; }));
  f.browser.emit('message', Buffer.from('{"type":"finish"}'), false); await vi.advanceTimersByTimeAsync(0);
  f.provider.emit('close', 1000); await vi.advanceTimersByTimeAsync(0);
  expect(f.release).toHaveBeenCalledOnce(); expect(f.browser.readyState).toBe(1);
  expect(f.events().some(event => event.type === 'ended')).toBe(false);
  acknowledge(); await vi.advanceTimersByTimeAsync(0);
  expect(f.events().at(-1)).toMatchObject({ type: 'ended', outcome: 'completed' }); expect(f.browser.readyState).toBe(3);
  f.transport.close();
});

test.each(['rejected', 'late-rejected', 'late-acknowledged'])('transcript save %s retains unknowns without replay', async kind => {
  const f = await fixture(); let acknowledge!: (value: unknown) => void, reject!: (reason: Error) => void;
  f.authority.transcript.mockImplementation(() => new Promise((resolve, fail) => { acknowledge = resolve; reject = fail; }));
  f.provider.emit('message', Buffer.from(JSON.stringify({ type: 'Results', channel: { alternatives: [{ transcript: 'Delivery cost was hidden' }] }, start: 0, duration: 1, is_final: true, speech_final: true })), false);
  f.browser.emit('message', Buffer.from('{"type":"finish"}'), false); await vi.advanceTimersByTimeAsync(0);
  f.provider.emit('close', 1000); await vi.advanceTimersByTimeAsync(0);
  if (kind === 'rejected') reject(new Error('write acknowledgement unknown'));
  else { await vi.advanceTimersByTimeAsync(5001); expect(f.events().at(-1)).toMatchObject({ type: 'ended', outcome: 'unknown' }); expect(f.release).not.toHaveBeenCalled(); if (kind === 'late-rejected') reject(new Error('late unknown write')); else acknowledge({ rawSourceId: 'session:1' }); }
  await vi.advanceTimersByTimeAsync(0);
  expect(f.authority.transcript).toHaveBeenCalledOnce();
  if (kind === 'late-acknowledged') { expect(f.settle).toHaveBeenCalledWith('completed'); expect(f.release).toHaveBeenCalledOnce(); }
  else { expect(f.settle).toHaveBeenCalledWith('unknown'); expect(f.release).not.toHaveBeenCalled(); }
  f.transport.close();
});


test.each(['http', 'socket', 'timeout', 'close'])('pre-ready %s diagnostic retains only allowlisted metadata and never retries', async kind => {
  const f = await fixture(false);
  await vi.advanceTimersByTimeAsync(20);
  if (kind === 'http') f.provider.emit('unexpected-response', { headers: { Authorization: 'SENSITIVE' } }, { statusCode: 401, headers: { 'secret-header': 'SENSITIVE' }, body: 'SENSITIVE', destroy: vi.fn() });
  else if (kind === 'close') f.provider.emit('close', 1006, Buffer.from('SENSITIVE'));
  else f.provider.emit('error', Object.assign(new Error('SENSITIVE secret URL and header'), { code: kind === 'timeout' ? 'ETIMEDOUT' : 'SENSITIVE' }));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.diagnostics).toHaveBeenCalledOnce();
  const diagnostic = f.diagnostics.mock.calls[0][0];
  expect(diagnostic).toEqual({ event: 'research-stt-pre-ready', attemptId: f.scope.requestId, elapsedMs: 20, phase: kind === 'http' ? 'unexpected-response' : kind === 'close' ? 'closed-before-ready' : kind === 'timeout' ? 'socket-timeout' : 'socket-error', httpStatus: kind === 'http' ? 401 : null, closeCode: kind === 'close' ? 1006 : null });
  expect(JSON.stringify(diagnostic)).not.toContain('SENSITIVE');
  expect(f.authority.reserve).toHaveBeenCalledOnce(); expect(f.settle).toHaveBeenCalledWith('unknown');
  f.transport.close();
});
test('post-ready provider close produces no misleading pre-ready diagnostic', async () => {
  const f = await fixture(); f.provider.emit('close', 1006); await vi.advanceTimersByTimeAsync(0);
  expect(f.diagnostics.mock.calls.some(([event]) => event.event === 'research-stt-pre-ready')).toBe(false);
  expect(f.diagnostics).toHaveBeenCalledWith(expect.objectContaining({ event: 'research-stt-post-ready', phase: 'provider-close', reason: 'upstream-close', closeCode: 1006, recognitionObserved: false, forwardedPcmBytes: 0 }));
  expect(f.authority.transcript).not.toHaveBeenCalled(); expect(f.settle).toHaveBeenCalledWith('unknown'); f.transport.close();
});
test('successful first PCM batch emits one bounded count-only diagnostic', async () => {
  const f = await fixture();
  f.browser.emit('message', Buffer.alloc(2000), true); await vi.advanceTimersByTimeAsync(1000);
  f.browser.emit('message', Buffer.alloc(2000), true); await vi.advanceTimersByTimeAsync(1000);
  expect(f.provider.sent).toHaveLength(2);
  const rows = f.diagnostics.mock.calls.map(([row]) => row).filter(row => row.phase === 'first-batch');
  expect(rows).toEqual([{ event: 'research-stt-post-ready', phase: 'first-batch', reason: 'forwarded', attemptId: f.scope.requestId, elapsedMs: 1000, checkElapsedMs: 0, forwardedPcmBytes: 2000, bufferedInputBytes: 2000, inputFrameCount: 2, recognitionObserved: false, closeCode: null }]);
  f.transport.close();
});
test('64KB pending batch plus arriving frames reports queue limit without forwarding or weakening the stale gate', async () => {
  const f = await fixture(); let resolve!: () => void;
  vi.mocked(f.authority.inspect).mockImplementation(() => new Promise<void>(done => { resolve = done; }));
  f.browser.emit('message', Buffer.alloc(32_000), true); await vi.advanceTimersByTimeAsync(1000);
  f.browser.emit('message', Buffer.alloc(32_000), true); f.browser.emit('message', Buffer.alloc(2000), true);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.diagnostics).toHaveBeenCalledWith(expect.objectContaining({ phase: 'input-rejected', reason: 'ingress-queue-limit', bufferedInputBytes: 66_000, inputFrameCount: 4, forwardedPcmBytes: 0 }));
  expect(f.release).not.toHaveBeenCalled(); expect(f.provider.sent).toEqual([]);
  resolve(); await vi.advanceTimersByTimeAsync(0);
  expect(f.settle).toHaveBeenCalledWith('unknown'); expect(f.release).toHaveBeenCalledOnce(); expect(f.provider.sent).toEqual([]); f.transport.close();
});
test('invalid browser control logs a fixed reason without arbitrary client text', async () => {
  const f = await fixture(); f.browser.emit('message', Buffer.from('{"type":"SENSITIVE"}'), false); await vi.advanceTimersByTimeAsync(0);
  expect(f.diagnostics).toHaveBeenCalledWith(expect.objectContaining({ phase: 'input-rejected', reason: 'invalid-control', forwardedPcmBytes: 0 }));
  expect(JSON.stringify(f.diagnostics.mock.calls)).not.toContain('SENSITIVE'); expect(f.settle).toHaveBeenCalledWith('unknown'); f.transport.close();
});
test('a diagnostic callback exception cannot prevent forwarding or alter settlement', async () => {
  const f = await fixture(); f.diagnostics.mockImplementation(() => { throw new Error('private diagnostic sink failure'); });
  f.browser.emit('message', Buffer.alloc(2000), true); await vi.advanceTimersByTimeAsync(1000);
  expect(f.provider.sent).toHaveLength(1); f.transport.close(); await vi.advanceTimersByTimeAsync(0); expect(f.release).toHaveBeenCalledOnce();
});

test('one-second prelude drains early through 124ms fresh authorization while ongoing PCM stays ordered', async () => {
  const f = await fixture();
  vi.mocked(f.authority.inspect).mockImplementation(() => new Promise<void>(resolve => setTimeout(resolve, 124)));
  const input = Array.from({ length: 16 }, () => Buffer.alloc(2000, 7));
  for (const pcm of input) f.browser.emit('message', pcm, true); await vi.advanceTimersByTimeAsync(0);
  expect(f.authority.inspect).toHaveBeenCalledTimes(2); // Opening proof plus this uncached batch proof.
  expect(f.provider.sent).toEqual([]);
  for (let frame = 0; frame < 16; frame++) {
    await vi.advanceTimersByTimeAsync(62.5);
    const pcm = Buffer.alloc(2000, frame); input.push(pcm); f.browser.emit('message', pcm, true);
  }
  await vi.advanceTimersByTimeAsync(1124);
  const forwarded = f.provider.sent.filter(value => value instanceof Uint8Array);
  expect(forwarded).toHaveLength(input.length);
  expect(Buffer.concat(forwarded)).toEqual(Buffer.concat(input));
  expect(f.authority.inspect).toHaveBeenCalledTimes(3);
  expect(f.diagnostics).toHaveBeenCalledWith(expect.objectContaining({ phase: 'first-batch', reason: 'forwarded', checkElapsedMs: 124, forwardedPcmBytes: 32_000 }));
  expect(f.diagnostics.mock.calls.some(([row]) => row.reason === 'ingress-queue-limit')).toBe(false);
  f.transport.close(); await vi.advanceTimersByTimeAsync(0);
});
test('a full prelude still waits for fresh authorization and discards PCM if that proof is revoked', async () => {
  const f = await fixture();
  vi.mocked(f.authority.inspect).mockImplementation(() => new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('revoked')), 124)));
  for (let frame = 0; frame < 16; frame++) f.browser.emit('message', Buffer.alloc(2000), true); await vi.advanceTimersByTimeAsync(0);
  f.browser.emit('message', Buffer.alloc(2000), true); await vi.advanceTimersByTimeAsync(124);
  expect(f.provider.sent).toEqual([]); expect(f.settle).toHaveBeenCalledWith('unknown');
  expect(f.diagnostics).toHaveBeenCalledWith(expect.objectContaining({ phase: 'first-batch', reason: 'authority-rejected', checkElapsedMs: 124, forwardedPcmBytes: 0 }));
  f.transport.close(); await vi.advanceTimersByTimeAsync(0);
});

test('host retention registers peer terminal work before upgrade completion and covers late disconnect settlement and release ACK', async () => {
  const retained: Promise<void>[] = [], f = await fixture(true, p => retained.push(p));
  expect(retained).toHaveLength(1); let finished = false; void retained[0].then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(1000); expect(finished).toBe(false); // upgrade already resolved
  let settle!: () => void, release!: () => void;
  f.settle.mockImplementation(() => new Promise<void>(resolve => { settle = resolve; }));
  f.release.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  f.browser.close(); await vi.advanceTimersByTimeAsync(0); expect(finished).toBe(false); expect(f.release).not.toHaveBeenCalled();
  settle(); await vi.advanceTimersByTimeAsync(0); expect(finished).toBe(false); expect(f.release).toHaveBeenCalledOnce();
  release(); await vi.advanceTimersByTimeAsync(0); expect(finished).toBe(true); expect(f.diagnostics).toHaveBeenCalledWith(expect.objectContaining({ phase: 'release-acknowledged', leaseReleaseAcknowledged: true })); f.transport.close();
});
test('retention waits for late admitted authority work after client timeout and never invents release on an ambiguous save', async () => {
  const retained: Promise<void>[] = [], f = await fixture(true, p => retained.push(p)); let finished = false; void retained[0].then(() => { finished = true; });
  f.provider.emit('message', Buffer.from(JSON.stringify({ type: 'Results', channel: { alternatives: [{ transcript: 'Synthetic saved text' }] }, start: 0, duration: 1, is_final: true, speech_final: true })), false);
  let reject!: (e: Error) => void; vi.mocked(f.authority.transcript).mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  f.browser.close(); await vi.advanceTimersByTimeAsync(5001); expect(finished).toBe(false); expect(f.release).not.toHaveBeenCalled();
  reject(new Error('unknown remote save ACK')); await vi.advanceTimersByTimeAsync(0);
  expect(finished).toBe(true); expect(f.release).not.toHaveBeenCalled();
  expect(f.diagnostics).toHaveBeenCalledWith(expect.objectContaining({ phase: 'save-rejected', saveUnknown: true, leaseReleaseAcknowledged: false })); f.transport.close();
});
test('bounded platform retention timeout leaves hung work and native occupancy unknown', async () => {
  const retained: Promise<void>[] = [], f = await fixture(true, p => retained.push(p)); let finished = false; void retained[0].then(() => { finished = true; });
  f.settle.mockImplementation(() => new Promise<void>(() => {})); f.browser.close(); await vi.advanceTimersByTimeAsync(195001);
  expect(finished).toBe(true); expect(f.release).not.toHaveBeenCalled(); expect(f.diagnostics).toHaveBeenCalledWith(expect.objectContaining({ phase: 'terminal-retention-expired', reason: 'bounded-wait', pendingAuthorityWork: 1, authoritySettled: false, leaseReleaseAcknowledged: false })); f.transport.close();
});
test('failed host retention registration cannot admit a provider attempt', async () => {
  const f = await fixture(true, () => { throw new Error('platform hook unavailable'); }); await vi.advanceTimersByTimeAsync(0);
  expect(f.authority.reserve).not.toHaveBeenCalled(); expect(f.events().some(e => e.type === 'ready')).toBe(false); f.transport.close();
});

test('peer retention registration stays in the upgrade async context across ingress acquisition; later end needs no context lookup', async () => {
  const context = new AsyncLocalStorage<string>(), retained: Promise<void>[] = [];
  const f = await context.run('synthetic-upgrade-context', () => fixture(true, promise => { expect(context.getStore()).toBe('synthetic-upgrade-context'); retained.push(promise); }));
  expect(context.getStore()).toBeUndefined(); expect(retained).toHaveLength(1);
  let finished = false; void retained[0].then(() => { finished = true; });
  f.browser.close(); await vi.advanceTimersByTimeAsync(0); expect(finished).toBe(true); expect(f.release).toHaveBeenCalledOnce(); expect(retained).toHaveLength(1); f.transport.close();
});
