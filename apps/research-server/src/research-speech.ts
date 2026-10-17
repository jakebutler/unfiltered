import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { createHash } from 'node:crypto';
import WebSocket, { WebSocketServer, type ClientOptions, type RawData } from 'ws';
import { researchSpeechPaths, type ResearchSpeechAuthority, type ResearchSpeechScope, type ResearchSpeechTransportLease } from '../../../packages/research-core/src/speech-contract.js';
import { SpeechError, validScope, type SpeechInputEvent, type SpeechOutputRequest } from '../../../packages/speech/src/contracts.js';
import { createVoiceDraft, reduceVoiceDraft } from '../../../packages/speech/src/turn.js';
import { createSpeechRelay, deepgramListenUrl } from '../../../packages/speech/src/relay.js';
import { createSpeechOutput, elevenlabsSpeechRoute, type SpeechFetch, type SpeechLease, type SpeechOutcome } from '../../../packages/speech/src/server.js';

export interface ResearchSpeechIngressLease {
  expiresAt: number;
  transportLease?: ResearchSpeechTransportLease;
  /** Reserve one durable native authority-operation allowance before dispatch. */
  authority<T>(dispatch: () => Promise<T>): Promise<T>;
  release(): Promise<void>;
}
export interface ResearchSpeechOptions {
  /** Absent/false is disabled, regardless of credentials. */
  enabled?: boolean;
  origin: string;
  /** Exact raw listener Host when a local facade is used; never forwarded Host. */
  listenerHost?: string;
  authority: ResearchSpeechAuthority;
  deepgramApiKey?: string;
  elevenlabsApiKey?: string;
  fetcher?: SpeechFetch;
  connect?: (url: string, options: ClientOptions) => WebSocket;
  /** Hosted waitUntil injection, registered when a peer attaches. Local callers
   * may omit it; the bounded promise is retention, never a settlement receipt. */
  retainTerminal?: (promise: Promise<void>) => void;
  /** Trusted private logger; never receives provider payloads or error strings. */
  onUpstreamDiagnostic?: (diagnostic: SpeechUpstreamDiagnostic | SpeechAdmissionDiagnostic | SpeechStreamingDiagnostic | SpeechTerminalDiagnostic) => void;
  /** Durable hosted kind=voice lease. release is called only after all started
   * native/provider/save/settlement work has stopped; unknown work keeps its hold. */
  ingress?: { reserve(requestId: string, kind: 'voice' | 'operation'): Promise<ResearchSpeechIngressLease> };
}
export interface SpeechUpstreamDiagnostic {
  event: 'research-stt-pre-ready';
  phase: 'unexpected-response' | 'socket-error' | 'socket-timeout' | 'closed-before-ready' | 'opening-deadline';
  attemptId: string;
  elapsedMs: number;
  httpStatus: number | null;
  closeCode: number | null;
}
export interface SpeechAdmissionDiagnostic {
  event: 'research-tts-admission-failure';
  phase: 'authorize' | 'output' | 'reserve' | 'fresh-output';
  elapsedMs: number;
}
export interface SpeechStreamingDiagnostic {
  event: 'research-stt-post-ready';
  phase: 'ready' | 'first-batch' | 'provider-close' | 'provider-error' | 'input-rejected';
  reason: 'ready' | 'forwarded' | 'stale-authority' | 'authority-rejected' | 'capture-ended' | 'relay-rejected' | 'upstream-close' | 'local-stop' | 'upstream-error' | 'ingress-queue-limit' | 'invalid-control' | 'input-frame-limit';
  attemptId: string;
  elapsedMs: number;
  checkElapsedMs: number | null;
  forwardedPcmBytes: number;
  bufferedInputBytes: number;
  inputFrameCount: number;
  recognitionObserved: boolean;
  closeCode: number | null;
}
export interface SpeechTerminalDiagnostic {
  event: 'research-stt-terminal';
  phase: 'save-started' | 'save-acknowledged' | 'save-rejected' | 'save-wait-expired' | 'settlement-started' | 'settlement-acknowledged' | 'settlement-rejected' | 'authority-drained' | 'release-started' | 'release-acknowledged' | 'release-rejected' | 'release-wait-expired' | 'terminal-retention-expired';
  reason: 'progress' | 'admission' | 'native-save' | 'native-settlement' | 'native-release' | 'bounded-wait';
  attemptId: string;
  elapsedMs: number;
  pendingAuthorityWork: number;
  browserInputStopped: boolean;
  providerClosed: boolean;
  authoritySettled: boolean;
  saveUnknown: boolean;
  leaseReleaseAcknowledged: boolean;
  nonemptyRecognitionObserved: boolean;
}
// Qualification is bound to effective public provider defaults, never credentials.
const readinessConfiguration = createHash('sha256').update(JSON.stringify({
  implementation: 'research-speech-post-ready-v1', deepgramListenUrl,
  elevenlabs: elevenlabsSpeechRoute, maxCaptureMs: 60_000, staleAuthorityMs: 1000,
})).digest('hex');
const safeMessage = 'Voice is unavailable. Your words remain here; continue typing or check the original attempt.';
const failure = (status = 503) => new Response(JSON.stringify({ error: safeMessage }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
const rawBytes = (data: RawData) => data instanceof ArrayBuffer ? new Uint8Array(data) : Array.isArray(data) ? new Uint8Array(Buffer.concat(data)) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
const capability = (token: unknown): token is string => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);
function start(value: unknown): { token: string; scope: ResearchSpeechScope } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SpeechError('invalid-request');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 6 || input.type !== 'start' || !capability(input.token)) throw new SpeechError('invalid-request');
  const scope = { requestId: input.requestId, sessionId: input.sessionId, promptId: input.promptId, expectedRevision: input.expectedRevision } as ResearchSpeechScope;
  if (!validScope(scope)) throw new SpeechError('invalid-request');
  return { token: input.token, scope };
}

/** Explicit composition seam. This installs no listener and never loads credentials.
 * Host must route upgrades here and stream handle() bodies with disconnect abort. */
export function createResearchSpeechTransport(options: ResearchSpeechOptions) {
  const enabled = options.enabled === true;
  if (new URL(options.origin).origin !== options.origin) throw new Error('canonical-speech-origin-required');
  if (enabled && (!options.deepgramApiKey || !options.elevenlabsApiKey || !options.ingress)) throw new Error('explicit-speech-credentials-and-durable-ingress-required');
  const wss = enabled ? new WebSocketServer({ noServer: true, maxPayload: 16_384, perMessageDeflate: false }) : undefined;
  const peers = new Set<WebSocket>(), active = new Map<string, WebSocket>(), pending = new Set<Duplex>();
  const stopPeers = new Map<WebSocket, () => void>();
  let closed = false;
  const expectedHost = options.listenerHost ?? new URL(options.origin).host;
  async function ingressLease(kind: 'voice' | 'operation') {
    if (!options.ingress) throw new SpeechError('unavailable');
    let expired = false, timer: ReturnType<typeof setTimeout> | undefined;
    const pendingLease = options.ingress.reserve(crypto.randomUUID().replaceAll('-', ''), kind);
    void pendingLease.then(lease => { if (expired) void lease.release().catch(() => undefined); }, () => {});
    try { return await Promise.race([pendingLease, new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; reject(new SpeechError('timeout')); }, 5000); })]); }
    finally { clearTimeout(timer); }
  }
  function attach(browser: WebSocket, ingress: ResearchSpeechIngressLease) {
    peers.add(browser);
    let phase: 'start' | 'opening' | 'streaming' | 'ending' | 'done' = 'start';
    let binding: ReturnType<typeof start> | undefined, provider: WebSocket | undefined;
    let lease: SpeechLease | undefined, relay: ReturnType<typeof createSpeechRelay> | undefined;
    let draft: ReturnType<typeof createVoiceDraft> | undefined;
    let queued = 0, messages = 0, draining = false, finishQueued = false;
    let frames: { bytes: Uint8Array; binary: boolean }[] = [];
    let batchTimer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let browserInputStopped = false, providerClosed = true, authoritySettled = false, released = false, settlementStarted = false, saveUnknown = false;
    let leaseReleaseAcknowledged = false, settlementNativeDispatched = false;
    let leaseReleaseRejected = false, terminalEndFinished = false, terminalRetained = true;
    let resolveTerminal!: () => void;
    const terminalRetention = new Promise<void>(resolve => { resolveTerminal = resolve; });
    // Existing lease lifetime plus the 5s save and 10s terminal ACK waits. A
    // retention timeout ends platform waiting only; it cannot release native work.
    const terminalRetentionTimer = setTimeout(() => {
      diagnoseTerminal('terminal-retention-expired', 'bounded-wait');
      terminalRetained = false; resolveTerminal();
    }, Math.max(1, ingress.expiresAt - Date.now()) + 15_000);
    const finishTerminalRetention = () => {
      if (!terminalRetained || !terminalEndFinished || !providerClosed || authorityWork.size || released && !leaseReleaseAcknowledged && !leaseReleaseRejected) return;
      terminalRetained = false; clearTimeout(terminalRetentionTimer); resolveTerminal();
    };
    let transcriptSave: Promise<unknown> | undefined;
    let upstreamStarted = 0, upstreamReady = false, diagnosed = false;
    let readyAt = 0, forwardedPcmBytes = 0, recognitionObserved = false, nonemptyRecognitionObserved = false;
    const streamingPhases = new Set<SpeechStreamingDiagnostic['phase']>();
    const diagnoseStreaming = (phase: SpeechStreamingDiagnostic['phase'], reason: SpeechStreamingDiagnostic['reason'], checkElapsedMs: number | null = null, closeCode?: number) => {
      if (!binding || !upstreamReady || streamingPhases.has(phase)) return;
      streamingPhases.add(phase); // At most five fixed, payload-free events per attempt.
      const diagnostic: SpeechStreamingDiagnostic = { event: 'research-stt-post-ready', phase, reason, attemptId: binding.scope.requestId,
        elapsedMs: Math.max(0, Math.min(70_000, Date.now() - readyAt)), checkElapsedMs: checkElapsedMs === null ? null : Math.max(0, Math.min(70_000, checkElapsedMs)),
        forwardedPcmBytes, bufferedInputBytes: Math.max(0, Math.min(100_000, queued)), inputFrameCount: Math.min(20_001, messages), recognitionObserved, closeCode: Number.isSafeInteger(closeCode) && closeCode! >= 1000 && closeCode! <= 4999 ? closeCode! : null };
      try { options.onUpstreamDiagnostic?.(diagnostic); } catch { /* logger cannot alter settlement */ }
    };
    const diagnose = (phase: SpeechUpstreamDiagnostic['phase'], httpStatus?: number, closeCode?: number) => {
      if (!binding || upstreamReady || diagnosed || !upstreamStarted) return;
      diagnosed = true;
      const diagnostic: SpeechUpstreamDiagnostic = { event: 'research-stt-pre-ready', phase, attemptId: binding.scope.requestId, elapsedMs: Math.max(0, Math.min(70_000, Date.now() - upstreamStarted)), httpStatus: Number.isSafeInteger(httpStatus) && httpStatus! >= 100 && httpStatus! <= 599 ? httpStatus! : null, closeCode: Number.isSafeInteger(closeCode) && closeCode! >= 1000 && closeCode! <= 4999 ? closeCode! : null };
      try { options.onUpstreamDiagnostic?.(diagnostic); } catch { /* logger cannot alter settlement */ }
    };
    let resolveRelease!: () => void, rejectRelease!: (error: Error) => void;
    const releaseAcknowledged = new Promise<void>((resolve, reject) => { resolveRelease = resolve; rejectRelease = reject; });
    void releaseAcknowledged.catch(() => undefined);
    const authorityWork = new Set<Promise<unknown>>();
    const terminalPhases = new Set<SpeechTerminalDiagnostic['phase']>();
    const diagnoseTerminal = (phase: SpeechTerminalDiagnostic['phase'], reason: SpeechTerminalDiagnostic['reason'] = 'progress') => {
      if (!binding || !upstreamReady || terminalPhases.has(phase)) return;
      terminalPhases.add(phase); // Thirteen fixed phases maximum; no thrown values or transcript payloads.
      const diagnostic: SpeechTerminalDiagnostic = { event: 'research-stt-terminal', phase, reason, attemptId: binding.scope.requestId,
        elapsedMs: Math.max(0, Math.min(225_000, Date.now() - readyAt)), pendingAuthorityWork: Math.min(128, authorityWork.size),
        browserInputStopped, providerClosed, authoritySettled, saveUnknown, leaseReleaseAcknowledged, nonemptyRecognitionObserved };
      try { options.onUpstreamDiagnostic?.(diagnostic); } catch { /* logging cannot change terminal ownership */ }
    };
    const releaseIngress = () => {
      if (!browserInputStopped || !providerClosed || !authoritySettled || authorityWork.size) { finishTerminalRetention(); return; }
      diagnoseTerminal('authority-drained');
      if (saveUnknown || released) { finishTerminalRetention(); return; }
      released = true; diagnoseTerminal('release-started');
      void ingress.release().then(() => { leaseReleaseAcknowledged = true; diagnoseTerminal('release-acknowledged'); resolveRelease(); finishTerminalRetention(); }, () => { leaseReleaseRejected = true; diagnoseTerminal('release-rejected', 'native-release'); rejectRelease(new SpeechError('unavailable')); finishTerminalRetention(); });
    };
    const work = <T>(promise: Promise<T>): Promise<T> => {
      authorityWork.add(promise);
      const settled = () => { authorityWork.delete(promise); releaseIngress(); };
      void promise.then(settled, settled); return promise;
    };
    const ingressTimer = setTimeout(() => { void end('unknown'); }, Math.max(1, ingress.expiresAt - Date.now() - 1000));
    const handshake = setTimeout(() => { void end('failed'); }, 5000);
    const emit = (event: SpeechInputEvent | Record<string, unknown>) => {
      if (browser.readyState !== WebSocket.OPEN || browser.bufferedAmount > 64_000) throw new SpeechError('limit');
      browser.send(JSON.stringify(event), error => { if (error) void end('unknown'); });
    };
    const sink = () => {};
    function release() {
      clearTimeout(handshake); clearTimeout(deadline); clearTimeout(ingressTimer); clearTimeout(batchTimer); frames = [];
      if (provider) {
        provider.removeAllListeners('message'); provider.removeAllListeners('open'); provider.removeAllListeners('unexpected-response'); provider.removeAllListeners('error');
        provider.on('error', sink); provider.once('close', () => provider?.off('error', sink));
        if (provider.readyState !== WebSocket.CLOSED) provider.terminate();
      }
      browser.off('message', received);
      if (binding && active.get(binding.scope.sessionId) === browser) active.delete(binding.scope.sessionId);
      peers.delete(browser); stopPeers.delete(browser);
    }
    async function end(outcome: SpeechOutcome, error = false) {
      if (phase === 'ending' || phase === 'done') return;
      phase = 'ending'; clearTimeout(handshake); clearTimeout(deadline);
      relay?.interrupt();
      if (provider && provider.readyState !== WebSocket.CLOSED) provider.terminate();
      // Reserve remains charged if authority/save settlement fails. Only transcript
      // readback may recover this attempt; reconnect never repeats captured audio.
      try {
        let transcriptReceipt;
        if (binding && draft) {
          draft = reduceVoiceDraft(draft, { type: 'interrupt' });
          if (draft.text.trim()) {
            // A rejected acknowledgement cannot prove whether the remote write
            // committed. Latch before work() drops the promise, including late
            // rejection after the finite browser wait.
            let saveNativeDispatched = false;
            const save = work(ingress.authority(() => { saveNativeDispatched = true; return options.authority.transcript(binding!.token, binding!.scope, draft!.text, outcome); }).then(receipt => { diagnoseTerminal('save-acknowledged'); return receipt; }, error => { saveUnknown = true; diagnoseTerminal('save-rejected', saveNativeDispatched ? 'native-save' : 'admission'); throw error; }));
            diagnoseTerminal('save-started');
            transcriptSave = save;
            let timer: ReturnType<typeof setTimeout> | undefined;
            try { transcriptReceipt = await Promise.race([save, new Promise<never>((_, reject) => { timer = setTimeout(() => { diagnoseTerminal('save-wait-expired', 'bounded-wait'); reject(new SpeechError('timeout')); }, 5000); })]); }
            finally { clearTimeout(timer); }
          }
        }
        // Stop accepting browser work before releasing the native transport.
        // Keep the socket alive until a known provider/save/release ACK so a
        // serverless platform cannot freeze that work at the terminal frame.
        phase = 'done'; release(); browserInputStopped = true;
        settlementStarted = true;
        const settlement = work(Promise.resolve().then(() => lease?.settle(outcome)));
        diagnoseTerminal('settlement-started');
        void settlement.then(() => { authoritySettled = true; diagnoseTerminal('settlement-acknowledged'); releaseIngress(); }, () => { diagnoseTerminal('settlement-rejected', settlementNativeDispatched ? 'native-settlement' : 'admission'); });
        releaseIngress();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([releaseAcknowledged, new Promise<never>((_, reject) => { timer = setTimeout(() => { diagnoseTerminal('release-wait-expired', 'bounded-wait'); reject(new SpeechError('timeout')); }, 10_000); })]); }
        finally { clearTimeout(timer); }
        if (browser.readyState === WebSocket.OPEN) {
          if (error) emit({ type: 'error', code: 'unavailable', message: safeMessage });
          emit({ type: 'ended', outcome, ...(transcriptReceipt ? { transcriptReceipt } : {}) });
        }
      } catch {
        if (browser.readyState === WebSocket.OPEN) { try { emit({ type: 'ended', outcome: 'unknown' }); } catch {} }
      } finally {
        // Never keep the browser waiting indefinitely for a persistence receipt.
        // The ingress claim stays occupied until the outstanding authority work
        // actually settles, including an unknown transcript-write acknowledgement.
        // Save/settlement failure is still an occupied native unknown. No retry
        // or timer releases it; late tracked work may supply its own known ACK.
        if (!settlementStarted) {
          phase = 'done'; release(); browserInputStopped = true;
          settlementStarted = true;
          const settlement = work(Promise.resolve(transcriptSave).then(() => lease?.settle(outcome), () => lease?.settle('unknown')));
          diagnoseTerminal('settlement-started');
          void settlement.then(() => { authoritySettled = true; diagnoseTerminal('settlement-acknowledged'); releaseIngress(); }, () => { diagnoseTerminal('settlement-rejected', settlementNativeDispatched ? 'native-settlement' : 'admission'); });
          releaseIngress();
        }
        if (browser.readyState === WebSocket.OPEN) browser.close(1000, 'research-speech-ended');
        const timer = setTimeout(() => { if (browser.readyState !== WebSocket.CLOSED) browser.terminate(); }, 1000);
        browser.once('close', () => clearTimeout(timer));
        terminalEndFinished = true; finishTerminalRetention();
      }
    }
    async function begin(value: unknown) {
      binding = start(value); const { token, scope } = binding;
      await work(ingress.authority(() => options.authority.authorize(token, scope, 'deepgram')));
      if (phase !== 'opening' || browser.readyState !== WebSocket.OPEN || closed) return;
      if (active.has(scope.sessionId)) throw new SpeechError('duplicate-attempt');
      active.set(scope.sessionId, browser);
      const begun = Date.now();
      deadline = setTimeout(() => { diagnose('opening-deadline'); void end('unknown'); }, 70_000);
      lease = await work(ingress.authority(() => options.authority.reserve(token, scope, { provider: 'deepgram', sessionId: scope.sessionId, requestId: scope.requestId, maxAudioSeconds: 60, maxCharacters: 0, ...(ingress.transportLease ? { transportLease: ingress.transportLease } : {}) })));
      const reserved = lease; lease = { settle: outcome => ingress.authority(async () => { settlementNativeDispatched = true; await reserved.settle(outcome); }) };
      if (phase !== 'opening' || browser.readyState !== WebSocket.OPEN || closed) { try { await work(Promise.resolve().then(() => lease!.settle('failed'))); } catch { authoritySettled = false; } return; }
      await work(ingress.authority(() => options.authority.inspect(token, scope, 'deepgram')));
      if (phase !== 'opening' || browser.readyState !== WebSocket.OPEN || closed) { void end('failed'); return; }
      const captureMs = Math.min(60_000, 60_000 - (Date.now() - begun));
      if (captureMs < 1000) throw new SpeechError('timeout');
      draft = createVoiceDraft(scope);
      upstreamStarted = Date.now();
      provider = (options.connect ?? ((url, config) => new WebSocket(url, config)))(deepgramListenUrl, { headers: { Authorization: `Token ${options.deepgramApiKey}` }, handshakeTimeout: 5000, maxPayload: 64_000, perMessageDeflate: false, followRedirects: false });
      providerClosed = false;
      provider.once('close', () => { providerClosed = true; releaseIngress(); });
      provider.on('error', error => { diagnose((error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 'socket-timeout' : 'socket-error'); diagnoseStreaming('provider-error', 'upstream-error'); void end('unknown', true); });
      provider.on('unexpected-response', (_request, response: IncomingMessage) => { diagnose('unexpected-response', response.statusCode); response.destroy(); void end('unknown', true); });
      provider.on('close', code => { diagnose('closed-before-ready', undefined, code); diagnoseStreaming('provider-close', phase === 'ending' || phase === 'done' ? 'local-stop' : 'upstream-close', null, code); if (relay) relay.providerClosed(code); else void end('unknown'); });
      provider.on('message', (data, binary) => { if (binary) { void end('unknown'); return; } relay?.providerMessage(Buffer.from(rawBytes(data)).toString('utf8')); });
      provider.once('open', () => {
        if (phase !== 'opening' || closed || browser.readyState !== WebSocket.OPEN) { void end('interrupted'); provider?.terminate(); return; }
        upstreamReady = true; readyAt = Date.now(); phase = 'streaming'; diagnoseStreaming('ready', 'ready');
        relay = createSpeechRelay({ captureMs, provider: { get bufferedAmount() { return provider!.bufferedAmount; }, send: data => provider!.send(data), close: () => { if (provider!.readyState === WebSocket.OPEN) provider!.close(1000, 'finished'); } }, lease: { settle: () => {} }, emit: event => {
          if (event.type === 'ended') { void end(event.outcome); return; }
          if (event.type === 'recognition' && draft) { recognitionObserved = true; nonemptyRecognitionObserved ||= Boolean(event.segment.text.trim()); draft = reduceVoiceDraft(draft, { type: 'recognition', generation: draft.generation, segment: event.segment }); }
          try { emit(event); } catch { void end('unknown'); }
        } });
        try { emit({ type: 'ready', sampleRate: 16000, channels: 1, maxCaptureMs: captureMs }); } catch { void end('unknown'); }
      });
    }
    function received(data: RawData, binary: boolean) {
      let reason: SpeechStreamingDiagnostic['reason'] = 'input-frame-limit';
      try {
        if (++messages > 20_000) throw new SpeechError('limit');
        const bytes = rawBytes(data);
        if (phase === 'start') {
          if (binary || bytes.length > 2048) throw new SpeechError('invalid-request');
          phase = 'opening'; clearTimeout(handshake);
          void work(begin(JSON.parse(Buffer.from(bytes).toString('utf8')))).catch(() => end(provider ? 'unknown' : 'failed', true)); return;
        }
        reason = 'invalid-control'; if (phase !== 'streaming' || !binding || !relay || finishQueued) throw new SpeechError('invalid-request');
        queued += bytes.length; reason = 'ingress-queue-limit'; if (queued > 64_000) throw new SpeechError('limit');
        reason = 'invalid-control';
        if (!binary) { const control = JSON.parse(Buffer.from(bytes).toString('utf8')); if (!control || Object.keys(control).length !== 1 || control.type !== 'finish') throw new SpeechError('invalid-request'); finishQueued = true; }
        frames.push({ bytes, binary });
        // At most one durable authorization per one-second PCM batch, plus an
        // explicit finish check. Drain a full second of PCM immediately so the
        // initial prelude cannot spend another second filling the hard queue cap.
        // No cached auth is used to dispatch a batch.
        // Remote revocation exposure is up to this cadence; browser pause closes
        // immediately. A slow (>1s) auth result never forwards queued samples.
        if (!draining && (batchTimer === undefined || finishQueued || queued >= 32_000)) { clearTimeout(batchTimer); batchTimer = setTimeout(() => { void drain(); }, finishQueued || queued >= 32_000 ? 0 : 1000); }
      } catch { diagnoseStreaming('input-rejected', reason); void end(provider ? 'unknown' : 'failed', true); }
    }
    async function drain() {
      batchTimer = undefined;
      if (draining || phase !== 'streaming' || !binding || !relay || !frames.length) return;
      draining = true; const batch = frames; frames = []; const begun = Date.now();
      let reason: SpeechStreamingDiagnostic['reason'] = 'authority-rejected';
      try {
        await work(ingress.authority(() => options.authority.inspect(binding!.token, binding!.scope, 'deepgram')));
        if (phase !== 'streaming') { diagnoseStreaming('first-batch', 'capture-ended', Date.now() - begun); return; }
        reason = 'stale-authority'; if (Date.now() - begun > 1000) throw new SpeechError('timeout');
        reason = 'relay-rejected';
        for (const frame of batch) { if (frame.binary) { relay.audio(frame.bytes); forwardedPcmBytes += frame.bytes.length; } else relay.finish(); }
        diagnoseStreaming('first-batch', 'forwarded', Date.now() - begun);
      } catch { diagnoseStreaming('first-batch', reason, Date.now() - begun); void end('unknown', true); }
      finally { queued -= batch.reduce((sum, frame) => sum + frame.bytes.length, 0); draining = false; if (frames.length && phase === 'streaming') batchTimer = setTimeout(() => { void drain(); }, finishQueued || queued >= 32_000 ? 0 : 1000); }
    }
    stopPeers.set(browser, () => { void end('interrupted'); browser.terminate(); });
    browser.on('message', received); browser.on('error', () => { void end('unknown'); });
    browser.once('close', () => { browserInputStopped = true; releaseIngress(); void end('interrupted'); });
    // Register while still in the upgrade invocation context, before it returns.
    // end() may begin much later, including after browser disconnect.
    try { options.retainTerminal?.(terminalRetention); }
    catch { void end('failed'); browser.terminate(); }
  }
  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const reject = (code: number) => { socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); socket.destroy(); };
    // Capability stays in the first bounded frame; the pre-auth socket can live
    // only five seconds and cannot open a provider or receive captured PCM.
    if (!enabled || closed) { reject(503); return; }
    if (req.url !== researchSpeechPaths.input || req.headers.host !== expectedHost || req.method !== 'GET' || req.headers.origin !== options.origin || req.headers['sec-websocket-protocol'] || req.headers.upgrade?.toLowerCase() !== 'websocket' || peers.size + pending.size >= 4) { reject(403); return; }
    pending.add(socket);
    const timer = setTimeout(() => { if (!socket.destroyed) reject(408); }, 5000);
    try {
      const ingress = await ingressLease('voice');
      if (socket.destroyed || closed || Date.now() >= ingress.expiresAt - 1000) { void ingress.release().catch(() => undefined); return; }
      let attached = false;
      try { wss!.handleUpgrade(req, socket, head, browser => { attached = true; attach(browser, ingress); }); }
      catch (error) { if (!attached) void ingress.release().catch(() => undefined); throw error; }
      if (!attached) { socket.once('close', () => { void ingress.release().catch(() => undefined); }); if (socket.destroyed) void ingress.release().catch(() => undefined); }
    } catch { if (!socket.destroyed) reject(503); }
    finally { clearTimeout(timer); pending.delete(socket); }
  }
  async function handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (!(Object.values(researchSpeechPaths) as string[]).includes(url.pathname) || url.pathname === researchSpeechPaths.input) return undefined;
    const sameOriginGet = request.method === 'GET' && request.headers.get('Origin') === null && request.headers.get('Sec-Fetch-Site') === 'same-origin' && (() => { try { return new URL(request.headers.get('Referer') ?? '').origin === options.origin; } catch { return false; } })();
    if (closed || url.origin !== options.origin || request.headers.get('Host') !== expectedHost || url.search || !sameOriginGet && request.headers.get('Origin') !== options.origin) return failure(403);
    const token = request.headers.get('X-Research-Participant'); if (!capability(token)) return failure(403);
    let ingress: ResearchSpeechIngressLease;
    try { ingress = await ingressLease(url.pathname === researchSpeechPaths.output ? 'voice' : 'operation'); }
    catch { return failure(); }
    const controller = new AbortController(), pendingWork = new Set<Promise<unknown>>();
    let done = false, released = false, unknownCancellation = false;
    let resolveRelease!: () => void, rejectRelease!: (error: Error) => void;
    const releaseAcknowledged = new Promise<void>((resolve, reject) => { resolveRelease = resolve; rejectRelease = reject; });
    void releaseAcknowledged.catch(() => undefined);
    const release = () => { if (done && !pendingWork.size && !unknownCancellation && !released) {
      released = true; void ingress.release().then(resolveRelease, () => rejectRelease(new SpeechError('unavailable')));
    } };
    const track = <T>(promise: Promise<T>): Promise<T> => {
      pendingWork.add(promise);
      void promise.then(value => {
        // A late response after timeout still owns native provider/body work.
        if ((done || controller.signal.aborted) && value instanceof Response && value.body) cancel(() => value.body!.cancel());
        pendingWork.delete(promise); release();
      }, () => { pendingWork.delete(promise); release(); });
      return promise;
    };
    const cancel = (operation: () => Promise<unknown>) => {
      try { const pending = operation().catch(error => { unknownCancellation = true; throw error; }); track(pending); void pending.catch(() => undefined); }
      catch { unknownCancellation = true; }
    };
    const run = async <T>(operation: () => Promise<T>): Promise<T> => {
      if (controller.signal.aborted) throw new SpeechError('timeout');
      const pending = track(Promise.resolve().then(operation));
      return new Promise<T>((resolve, reject) => {
        const abort = () => reject(new SpeechError('timeout')); controller.signal.addEventListener('abort', abort, { once: true });
        if (controller.signal.aborted) abort();
        void pending.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort)).catch(() => undefined);
      });
    };
    const finish = () => { if (done) return; done = true; clearTimeout(deadline); request.signal.removeEventListener('abort', interrupted); controller.abort(); release(); };
    let settlementWait: Promise<void> | undefined;
    const settle = () => {
      finish();
      return settlementWait ??= (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([releaseAcknowledged, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SpeechError('timeout')), 10_000); })]); }
        finally { clearTimeout(timer); }
      })();
    };
    const settleKnown = async () => {
      finish(); for (let n = 0; n < 3; n++) await Promise.resolve();
      if (!pendingWork.size && !unknownCancellation) await settle();
    };
    const interrupted = () => controller.abort();
    request.signal.addEventListener('abort', interrupted, { once: true }); if (request.signal.aborted) controller.abort();
    const deadline = setTimeout(() => controller.abort(), Math.max(1, Math.min(ingress.expiresAt - Date.now() - 1000, url.pathname === researchSpeechPaths.output ? 35_000 : 10_000)));
    let admissionPhase: SpeechAdmissionDiagnostic['phase'] | undefined, admissionStarted = 0, outputReads = 0;
    try {
      if (url.pathname === researchSpeechPaths.status && request.method === 'GET') {
        const status = await run(() => ingress.authority(() => options.authority.status(token)));
        await settle(); return new Response(JSON.stringify({ enabled: enabled && status.enabled, ...(status.continuous === true ? { continuous: true, grantName: status.grantName } : {}) }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
      }
      if (request.method !== 'POST' || !request.headers.get('Content-Type')?.startsWith('application/json')) { await settleKnown(); return failure(405); }
      const reader = request.body?.getReader(); if (!reader) { await settleKnown(); return failure(400); }
      let bytes = 0; const chunks: Uint8Array[] = [];
      // Race stalled read and cancellation, not merely a timer that calls cancel.
      const bodyTimer = setTimeout(() => controller.abort(), 5000);
      try { for (;;) { const item = await run(() => reader.read()); if (item.done) break; bytes += item.value.length; if (bytes > 2048) throw new SpeechError('limit'); chunks.push(item.value); } }
      finally { clearTimeout(bodyTimer); cancel(() => reader.cancel()); }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as SpeechOutputRequest;
      if (!input || Object.keys(input).length !== (url.pathname === researchSpeechPaths.barrier ? 5 : 4)) throw new SpeechError('invalid-request');
      if (url.pathname === researchSpeechPaths.barrier) {
        const { provider, ...scope } = input as unknown as ResearchSpeechScope & { provider: 'deepgram' | 'elevenlabs' };
        if (!validScope(scope) || !['deepgram', 'elevenlabs'].includes(provider) || !options.authority.terminalBarrier) throw new SpeechError('invalid-request');
        let settled = false;
        for (let check = 0; check < 10; check++) {
          const terminal = await run(() => ingress.authority(() => options.authority.terminalBarrier!(token, scope, provider)));
          if (terminal.state === 'completed' && !terminal.active && terminal.transportSettled) { settled = true; break; }
          if (['unknown', 'interrupted', 'failed'].includes(terminal.state)) throw new SpeechError('unavailable');
          await run(() => new Promise<void>(resolve => setTimeout(resolve, 250)));
        }
        if (!settled) throw new SpeechError('timeout');
        await settle(); return new Response(JSON.stringify({ transportSettled: true }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
      }
      if (url.pathname === researchSpeechPaths.commit) {
        const scope = input as unknown as ResearchSpeechScope;
        if (!validScope(scope) || !options.authority.terminalBarrier || !options.authority.commitSpoken) throw new SpeechError('invalid-request');
        let settled = false;
        for (let check = 0; check < 10; check++) {
          const terminal = await run(() => ingress.authority(() => options.authority.terminalBarrier!(token, scope)));
          if (terminal.state === 'completed' && !terminal.active && terminal.rawSaved && terminal.transportSettled) { settled = true; break; }
          if (['unknown', 'interrupted', 'failed'].includes(terminal.state)) throw new SpeechError('unavailable');
          await run(() => new Promise<void>(resolve => setTimeout(resolve, 250)));
        }
        if (!settled) throw new SpeechError('timeout');
        const accepted = await run(() => ingress.authority(() => options.authority.commitSpoken!(token, scope)));
        await settle(); return new Response(JSON.stringify(accepted), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
      }
      if (url.pathname === researchSpeechPaths.receipt) {
        if (!validScope(input as unknown as ResearchSpeechScope)) throw new SpeechError('invalid-request');
        const saved = await run(() => ingress.authority(() => options.authority.receipt(token, input as unknown as ResearchSpeechScope)));
        await settle(); return new Response(JSON.stringify(saved), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
      }
      if (!enabled) { await settleKnown(); return failure(); }
      const scope = { sessionId: input.sessionId, promptId: input.sourceId, expectedRevision: input.expectedRevision, requestId: input.requestId };
      admissionStarted = Date.now(); admissionPhase = 'authorize';
      await run(() => ingress.authority(() => options.authority.authorize(token, scope, 'elevenlabs')));
      const trackedFetch: SpeechFetch = async (input, init) => {
        admissionPhase = undefined;
        const response = await run(() => (options.fetcher ?? fetch)(input, init));
        if (!response.body) return response;
        const reader = response.body.getReader();
        return new Response(new ReadableStream<Uint8Array>({
          async pull(target) { try { const item = await run(() => reader.read()); if (item.done) target.close(); else target.enqueue(item.value); } catch { cancel(() => reader.cancel()); target.error(new SpeechError('unavailable')); } },
          cancel() { cancel(() => reader.cancel()); },
        }, { highWaterMark: 0 }), { status: response.status, headers: response.headers });
      };
      const response = await run(() => createSpeechOutput({ elevenlabsApiKey: options.elevenlabsApiKey!, fetcher: trackedFetch, authorize: value => { admissionPhase = outputReads++ === 0 ? 'output' : 'fresh-output'; return run(() => ingress.authority(() => options.authority.output(token, value))); }, admission: { reserve: async reservation => {
        admissionPhase = 'reserve';
        const providerLease = await run(() => ingress.authority(() => options.authority.reserve(token, scope, { ...reservation, ...(ingress.transportLease ? { transportLease: ingress.transportLease } : {}) })));
        return { settle: outcome => track(ingress.authority(async () => { await providerLease.settle(outcome); }).catch(error => { unknownCancellation = true; throw error; })) };
      } } })(input, controller.signal));
      admissionPhase = undefined;
      const upstream = response.body!.getReader(); let ended = false, total = 0, nextAuthorization = 0, output: ReadableStreamDefaultController<Uint8Array>;
      const stop = async (error?: Error) => { if (ended) return; ended = true; controller.signal.removeEventListener('abort', abortStream); cancel(() => upstream.cancel()); try { if (error) { await settleKnown(); output.error(error); } else await settle(); } catch { output.error(new SpeechError('unavailable')); } };
      const abortStream = () => { void stop(new SpeechError('interrupted'))?.catch(() => undefined); };
      const stream = new ReadableStream<Uint8Array>({
        start(target) { output = target; controller.signal.addEventListener('abort', abortStream, { once: true }); if (controller.signal.aborted) abortStream(); },
        async pull(target) { try {
          if (Date.now() >= nextAuthorization) {
            const begun = Date.now(); await run(() => ingress.authority(() => options.authority.inspect(token, scope, 'elevenlabs')));
            if (Date.now() - begun > 1000) throw new SpeechError('timeout');
            nextAuthorization = begun + 1000;
          }
          const item = await run(() => upstream.read()); if (ended) return;
          if (item.done) { await stop(); target.close(); }
          else { total += item.value.length; if (total > 600_000) throw new SpeechError('limit'); target.enqueue(item.value); }
        } catch { if (!ended) stop(new SpeechError('not-authorized')); else target.error(new SpeechError('unavailable')); } },
        cancel() { return stop(); },
      }, { highWaterMark: 0 });
      return new Response(stream, { headers: response.headers });
    } catch {
      if (admissionPhase) { try { options.onUpstreamDiagnostic?.({ event: 'research-tts-admission-failure', phase: admissionPhase, elapsedMs: Math.max(0, Math.min(35_000, Date.now() - admissionStarted)) }); } catch { /* Diagnostics cannot affect settlement. */ } }
      try { await settleKnown(); } catch { /* Failed release stays unresolved. */ } return failure();
    }
  }
  return { handle, upgrade, readinessEnabled() { return enabled && !closed; }, readinessConfiguration() { return readinessConfiguration; }, close() { closed = true; for (const socket of pending) socket.destroy(); for (const stop of [...stopPeers.values()]) stop(); wss?.close(); } };
}
