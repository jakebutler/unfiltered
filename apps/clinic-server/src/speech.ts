import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer, type RawData, type ClientOptions } from 'ws';
import { createSpeechAccess, speechInputPath, speechOutputPath, speechStartSchema } from '../../../packages/clinic-api/src/speech-access.js';
import { ApiFailure } from '../../../packages/clinic-api/src/types.js';
import { createSpeechRelay, deepgramListenUrl } from '../../../packages/speech/src/relay.js';
import type { SpeechAdmission, SpeechFetch, SpeechLease, SpeechOutcome } from '../../../packages/speech/src/server.js';
import { SpeechError, type SpeechInputEvent } from '../../../packages/speech/src/contracts.js';
import type { IngressAdmission, IngressLease } from '../../../packages/clinic-api/src/ingress-admission.js';
import { createSpeechOutputHandler } from './speech-output.js';

export interface NodeSpeechOptions {
  access: ReturnType<typeof createSpeechAccess>;
  admission: SpeechAdmission;
  deepgramApiKey: string;
  elevenlabsApiKey: string;
  /** Hosted instances inject one durable guard; local fixtures may omit it. */
  ingress?: IngressAdmission;
  fetcher?: SpeechFetch;
  /** Tests supply a local provider socket; production always uses the fixed URL and headers below. */
  connect?: (url: string, options: ClientOptions) => WebSocket;
}
const safeMessage = 'Voice could not continue. Your saved answers are unchanged. You can keep typing.';
function publicFailure(error: unknown) {
  if (error instanceof ApiFailure) return { code: error.code, status: error.status };
  return { code: error instanceof SpeechError ? error.code : 'speech-unavailable', status: 503 };
}
function failure(error: unknown) { const { code, status } = publicFailure(error); return new Response(JSON.stringify({ error: { code, message: safeMessage, retryable: false } }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }
export function nodeRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
  return new Request(`http://127.0.0.1${req.url}`, { headers });
}
const rawBytes = (data: RawData) => data instanceof ArrayBuffer ? new Uint8Array(data) : Array.isArray(data) ? new Uint8Array(Buffer.concat(data)) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

/** Native Node adapter. Hosted upgrade behavior requires separate platform qualification. */
export function createNodeSpeechTransport(options: NodeSpeechOptions) {
  if (!options.deepgramApiKey || !options.elevenlabsApiKey) throw new Error('speech-credentials-required');
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 16_384, clientTracking: true });
  const active = new Map<string, () => void>();
  const pending = new Set<Duplex>();
  const connect = options.connect ?? ((url, config) => new WebSocket(url, config));
  const output = createSpeechOutputHandler({ access: options.access, admission: options.admission, elevenlabsApiKey: options.elevenlabsApiKey, fetcher: options.fetcher });
  let closed = false;

  function attach(browser: WebSocket, request: Request, sessionId: string, sharedLease?: IngressLease) {
    let state: 'start' | 'opening' | 'streaming' | 'settling' | 'done' = 'start';
    let clientMessages = 0;
    let provider: WebSocket | undefined, lease: SpeechLease | undefined, relay: ReturnType<typeof createSpeechRelay> | undefined;
    let settlement: Promise<void> | undefined, terminateTimer: ReturnType<typeof setTimeout> | undefined;
    const handshakeTimer = setTimeout(() => end('failed'), 5000);
    // Reserve time for the forced native close before shared capacity can expire.
    const ingressLifetimeTimer = sharedLease ? setTimeout(() => end('unknown'), Math.max(0, sharedLease.expiresAt - Date.now() - 1000)) : undefined;
    let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
    // The first outcome owns the durable write, including relay/end/cancel races.
    const settle = (outcome: SpeechOutcome) => {
      if (!lease) return Promise.resolve();
      if (!settlement) { settlement = Promise.resolve().then(() => lease!.settle(outcome)); void settlement.catch(() => undefined); }
      return settlement;
    };
    const emit = (event: SpeechInputEvent) => {
      if (browser.readyState !== WebSocket.OPEN || browser.bufferedAmount > 64_000) throw new SpeechError('limit');
      browser.send(JSON.stringify(event), error => { if (error) end('unknown'); });
    };
    function detachProvider() {
      if (!provider) return;
      provider.off('open', opened); provider.off('message', providerMessage); provider.off('close', providerClosed); provider.off('unexpected-response', unexpected);
      // Retain only a temporary error sink until ws emits close after terminate.
      provider.off('error', providerFailed);
      if (provider.readyState !== WebSocket.CLOSED) { provider.on('error', ignoreError); provider.once('close', () => provider?.off('error', ignoreError)); provider.terminate(); }
    }
    function closeTerminal(outcome: SpeechOutcome, error?: unknown) {
      if (state === 'done') return;
      state = 'done';
      if (error && browser.readyState === WebSocket.OPEN) { try { emit({ type: 'error', code: publicFailure(error).code, message: safeMessage }); } catch { /* Client is unavailable. */ } }
      try { emit({ type: 'ended', outcome }); } catch { /* Client is unavailable. */ }
      browser.off('message', message); browser.off('error', browserFailed); browser.on('error', ignoreError);
      if (browser.readyState === WebSocket.OPEN) browser.close(1000, 'speech-ended');
      if (browser.readyState !== WebSocket.CLOSED) terminateTimer = setTimeout(() => browser.terminate(), 1000);
      else cleanupBrowser();
    }
    function end(outcome: SpeechOutcome, error?: unknown) {
      if (state === 'done') return;
      if (state === 'settling') { if (outcome !== 'completed') closeTerminal(outcome, error); return; }
      state = 'settling'; clearTimeout(handshakeTimer); clearTimeout(lifetimeTimer); clearTimeout(ingressLifetimeTimer);
      const acknowledgement = settle(outcome);
      relay?.interrupt(); detachProvider();
      if (outcome !== 'completed') { closeTerminal(outcome, error); return; }
      // Completed means durable capacity release was acknowledged. A lost/late acknowledgement
      // must not start a confirmation capture or change/retry the first settlement outcome.
      let timer: ReturnType<typeof setTimeout>;
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SpeechError('timeout')), 2000); });
      void Promise.race([acknowledgement, deadline]).then(
        () => { if (state === 'settling') closeTerminal('completed'); },
        () => { if (state === 'settling') closeTerminal('unknown', new SpeechError('unavailable')); },
      ).finally(() => clearTimeout(timer));
    }
    function cleanupBrowser() {
      clearTimeout(terminateTimer); browser.off('close', browserClosed); browser.off('error', ignoreError);
      if (active.get(sessionId) === cancel) active.delete(sessionId);
    }
    function ignoreError() { /* No provider error body, clinical text or key in logs. */ }
    function cancel() { end('interrupted'); }
    function browserClosed() { end('interrupted'); cleanupBrowser(); }
    function browserFailed() { end('unknown'); }
    function providerFailed() { if (relay) relay.providerFailed(); else end('unknown', new SpeechError('unavailable')); }
    function providerClosed(code: number) { if (relay) relay.providerClosed(code); else end('unknown', new SpeechError('unavailable')); }
    function unexpected(_req: unknown, response: IncomingMessage) { response.destroy(); providerFailed(); }
    function providerMessage(data: RawData, binary: boolean) {
      if (binary) { providerFailed(); return; }
      relay?.providerMessage(Buffer.from(rawBytes(data)).toString('utf8'));
    }
    let captureMs = 60_000;
    function opened() {
      if (state !== 'opening' || browser.readyState !== WebSocket.OPEN || closed || !provider || !lease) {
        end('interrupted'); provider?.terminate(); return;
      }
      state = 'streaming';
      relay = createSpeechRelay({ provider: { get bufferedAmount() { return provider!.bufferedAmount; }, send: data => provider!.send(data), close: () => { if (provider?.readyState === WebSocket.OPEN) provider.close(1000, 'speech-ended'); } },
        lease: { settle }, captureMs, emit: event => { if (event.type === 'ended') { if (state !== 'settling' && state !== 'done') end(event.outcome); } else emit(event); } });
      try { emit({ type: 'ready', sampleRate: 16000, channels: 1, maxCaptureMs: captureMs }); } catch { end('interrupted'); }
    }
    function openingPeer() {
      if (state === 'opening' && browser.readyState === WebSocket.OPEN && !closed) return true;
      // This check is only used before provider dispatch. A late lease is still fully charged,
      // but no provider request occurred, even if close() has not emitted its final event yet.
      settle('failed'); end('failed'); return false;
    }
    async function start(input: unknown) {
      const parsed = speechStartSchema.safeParse(input);
      if (!parsed.success) throw new ApiFailure('invalid-speech-request');
      const { type: _type, ...scope } = parsed.data;
      await options.access.capture(request, scope);
      if (!openingPeer()) return;
      const started = Date.now();
      clearTimeout(lifetimeTimer);
      lifetimeTimer = setTimeout(() => end('unknown'), 70_000);
      lease = await options.admission.reserve({ provider: 'deepgram', sessionId, requestId: scope.requestId, maxAudioSeconds: 60, maxCharacters: 0 });
      if (!openingPeer()) return;
      await options.access.capture(request, scope); // Recheck the actual prompt after asynchronous admission.
      if (!openingPeer()) return;
      captureMs = Math.min(60_000, 70_000 - (Date.now() - started) - 10_000);
      if (captureMs < 1000) throw new SpeechError('timeout');
      provider = connect(deepgramListenUrl, { headers: { Authorization: `Token ${options.deepgramApiKey}` }, handshakeTimeout: 5000, maxPayload: 64_000, perMessageDeflate: false, followRedirects: false });
      provider.once('open', opened); provider.on('message', providerMessage); provider.once('close', providerClosed); provider.on('error', providerFailed); provider.once('unexpected-response', unexpected);
    }
    function message(data: RawData, binary: boolean) {
      try {
        if (++clientMessages > 20_000) throw new SpeechError('limit');
        if (state === 'settling' || state === 'done') return; // Relay is sealed; already-inflight frames cannot alter completion.
        if (state === 'start') {
          if (binary || rawBytes(data).byteLength > 2048) throw new ApiFailure('invalid-speech-request');
          state = 'opening'; clearTimeout(handshakeTimer);
          // Bound auth/admission/connection work even if a downstream read never resolves.
          lifetimeTimer = setTimeout(() => end('failed'), 15_000);
          void start(JSON.parse(Buffer.from(rawBytes(data)).toString('utf8'))).catch(error => end(provider ? 'unknown' : 'failed', error));
        } else if (state === 'streaming' && relay) {
          if (binary) relay.audio(rawBytes(data));
          else { const control: unknown = JSON.parse(Buffer.from(rawBytes(data)).toString('utf8')); if (control && typeof control === 'object' && Object.keys(control).length === 1 && (control as { type?: string }).type === 'finish') relay.finish(); else throw new ApiFailure('invalid-speech-request'); }
        } else throw new ApiFailure('speech-not-ready');
      } catch (error) { end(provider ? 'unknown' : 'failed', error); }
    }
    active.set(sessionId, cancel);
    browser.on('message', message); browser.once('close', browserClosed); browser.on('error', browserFailed);
  }

  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const reject = (status = 403) => { if (!socket.destroyed) { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); socket.destroy(); } };
    if (!req.url?.startsWith('/') || req.url.length > 2000) { reject(); return; }
    const request = nodeRequest(req), url = new URL(request.url);
    if (closed || url.pathname !== speechInputPath || url.search || req.method !== 'GET' || req.headers['sec-websocket-protocol'] || req.headers.upgrade?.toLowerCase() !== 'websocket' || !req.headers.connection?.toLowerCase().split(/\s*,\s*/).includes('upgrade') || req.headers['sec-websocket-version'] !== '13' || typeof req.headers['sec-websocket-key'] !== 'string' || !/^[+/0-9A-Za-z]{22}==$/.test(req.headers['sec-websocket-key']) || pending.size >= 10 || active.size >= 10) { reject(); return; }
    pending.add(socket); const deadline = Date.now() + 5000, attemptId = crypto.randomUUID();
    const timer = setTimeout(() => reject(408), 5000);
    const available = () => !socket.destroyed && !closed && Date.now() < deadline;
    const ingressBackoff = [50, 100, 200, 400, 800, 1000]; let ingressBusy = 0;
    const waitCapacity = (delay = 50) => new Promise<void>(resolve => { const timer = setTimeout(done, Math.min(delay, Math.max(0, deadline - Date.now()))); function done() { clearTimeout(timer); socket.off('close', done); resolve(); } socket.once('close', done); });
    const onError = () => socket.destroy(), onEnd = () => socket.destroy();
    socket.on('error', onError); socket.once('end', onEnd); // Pending HTTP upgrade may receive a FIN before ws owns closure.
    let sharedLease: IngressLease | undefined, nativeClosed = false, released = false;
    const releaseClosed = () => {
      if (!nativeClosed || !sharedLease || released) return;
      released = true;
      void sharedLease.close().catch(() => undefined); // Unknown settlement keeps the capacity hold; the attempt is never refunded.
    };
    socket.once('close', () => { nativeClosed = true; releaseClosed(); });
    try {
      const identity = await options.access.authenticate(request);
      if (socket.destroyed || closed) return;
      // Busy is a proven pre-reservation denial: wait for observed native closure/CAS.
      // Never retry an admitted, unknown or rate/quota-denied attempt and never redispatch audio.
      while (available()) {
        if (active.has(identity.sessionId)) { await waitCapacity(); continue; }
        if ((await options.access.authenticate(request)).sessionId !== identity.sessionId) throw new ApiFailure('session-required', 401);
        if (!available()) { if (!socket.destroyed) reject(closed ? 503 : 408); return; }
        try { sharedLease = await options.ingress?.reserve({ kind: 'speech-upgrade', attemptId, sessionId: identity.sessionId }); releaseClosed(); break; }
        catch (error) { if (!(error instanceof ApiFailure) || error.code !== 'ingress-socket-busy' || ingressBusy >= ingressBackoff.length) throw error; await waitCapacity(ingressBackoff[ingressBusy++]); }
      }
      if (!available()) { if (!socket.destroyed) reject(closed ? 503 : 408); return; }
      releaseClosed();
      if (socket.destroyed || closed || nativeClosed) return;
      if (sharedLease && Date.now() >= sharedLease.expiresAt - 1000) { reject(503); return; }
      // Another local request can have completed authentication/admission while this one awaited CAS.
      if (active.has(identity.sessionId)) { reject(409); return; }
      wss.handleUpgrade(req, socket, head, browser => attach(browser, request, identity.sessionId, sharedLease));
    } catch (error) { reject(publicFailure(error).status); }
    finally { clearTimeout(timer); pending.delete(socket); socket.off('error', onError); socket.off('end', onEnd); }
  }

  async function handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (![speechInputPath, speechOutputPath].includes(url.pathname)) return undefined;
    if (closed) return failure(new ApiFailure('speech-unavailable', 503));
    if (url.pathname === speechOutputPath) return await output.handle(request);
    // The input path is WebSocket-only; any plain HTTP request to it is refused.
    return failure(new ApiFailure('method-not-allowed', 405));
  }
  return { handle, upgrade, close() { closed = true; for (const cancel of active.values()) cancel(); for (const socket of pending) socket.destroy(); wss.close(); } };
}
