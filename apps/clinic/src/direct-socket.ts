/** Hosted hands-free: a WebSocket-shaped client that opens Deepgram live directly with a short-lived token, reproducing the relay's event semantics in the browser. */
import { deepgramDirectListenUrl, directCaptureMs, SpeechError, speechTokenPath, validScope, type SpeechInputEvent, type SpeechTurnScope } from '../../../packages/speech/src/contracts';
import { parseDeepgramMessage } from '../../../packages/speech/src/turn';

const tokenTimeoutMs = 10_000;
const providerOpenTimeoutMs = 10_000;
const keepaliveMs = 5_000;
const flushMs = 5_000;
const providerMessageLimit = 600;
const providerByteLimit = 2_000_000;
const fallbackMessage = 'Hands-free voice could not connect.';
const unavailable = 'Voice is unavailable for this question.';
const tokenPattern = /^[A-Za-z0-9._-]+$/;
const codePattern = /^[a-z0-9-]{1,80}$/;

export interface ProviderEvent { data?: unknown; code?: number }
/** Minimal browser WebSocket surface used for the Deepgram connection. */
export interface ProviderSocket {
  readyState: number;
  readonly bufferedAmount: number;
  binaryType: string;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: ProviderEvent) => void): void;
  removeEventListener(type: string, listener: (event: ProviderEvent) => void): void;
}
export interface DirectSocketEvent { type: string; data?: string; code?: number; reason?: string }
type Listener = (event: DirectSocketEvent) => void;
type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
type Phase = 'idle' | 'requesting' | 'connecting' | 'ready' | 'finishing' | 'closed';
type TimerName = 'token' | 'open' | 'keepalive' | 'flush';
type DirectMessage = SpeechInputEvent | { type: 'error'; code: string; message: string; fallback: true };

export interface DirectSpeechSocketOptions {
  fetcher?: Fetcher;
  connect?: (url: string, protocols: string[]) => ProviderSocket;
  schedule?: (fn: () => void) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Implements only the WebSocket subset used by useSpeechCapture and PcmTransport. The URL argument is kept for shape compatibility; the provider URL is always deepgramDirectListenUrl. */
export class DirectSpeechSocket {
  readyState = 0;
  binaryType = 'arraybuffer';
  private listeners = new Map<string, Set<Listener>>();
  private phase: Phase = 'idle';
  private provider?: ProviderSocket;
  private controller?: AbortController;
  private timers: Partial<Record<TimerName, unknown>> = {};
  private providerMessages = 0;
  private providerBytes = 0;
  private fetcher: Fetcher;
  private connect: (url: string, protocols: string[]) => ProviderSocket;
  private schedule: (fn: () => void) => void;
  private setTimer: (fn: () => void, ms: number) => unknown;
  private clearTimer: (handle: unknown) => void;

  private readonly onOpen = () => this.providerOpened();
  private readonly onMessage = (event: ProviderEvent) => this.providerMessage(event);
  private readonly onClose = (event: ProviderEvent) => this.providerDown(event.code);
  private readonly onError = () => this.providerDown(undefined);

  constructor(readonly url: string | URL, options: DirectSpeechSocketOptions = {}) {
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.connect = options.connect ?? ((url, protocols) => new WebSocket(url, protocols) as unknown as ProviderSocket);
    this.schedule = options.schedule ?? (fn => { setTimeout(fn, 0); });
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as number));
    this.schedule(() => this.open());
  }

  get bufferedAmount(): number {
    return this.readyState === 3 ? 0 : this.provider?.bufferedAmount ?? 0;
  }

  addEventListener(type: string, listener: Listener) {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener); this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener) { this.listeners.get(type)?.delete(listener); }

  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (this.readyState === 0) throw new Error('socket-not-open');
    if (this.readyState !== 1) return;
    if (typeof data === 'string') return this.control(data);
    // Audio before ready is dropped, as is audio after finish; only forwarded frames arm the keepalive.
    if (this.phase !== 'ready' || !this.provider || this.provider.readyState !== 1) return;
    const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    // Copy: the capture path reuses its frame buffers.
    const frame = view.slice();
    try { this.provider.send(frame); }
    catch { this.lost(); return; }
    this.armKeepalive();
  }

  /** Aborts any token request, closes the provider, and suppresses every later event. */
  close(_code?: number, _reason?: string) {
    if (this.readyState === 3) return;
    this.phase = 'closed'; this.readyState = 3;
    for (const name of Object.keys(this.timers) as TimerName[]) this.disarm(name);
    this.controller?.abort();
    const provider = this.provider;
    this.provider = undefined;
    if (provider) {
      provider.removeEventListener('open', this.onOpen);
      provider.removeEventListener('message', this.onMessage);
      provider.removeEventListener('close', this.onClose);
      provider.removeEventListener('error', this.onError);
      try { provider.close(1000, 'speech-ended'); } catch { /* The provider is already gone. */ }
    }
    this.emit({ type: 'close' });
  }

  private open() {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.emit({ type: 'open' });
  }

  private control(raw: string) {
    let value: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('not-object');
      value = parsed as Record<string, unknown>;
    } catch { return this.fail('invalid-control'); }
    if (value.type === 'start' && this.phase === 'idle') {
      const scope = { requestId: value.requestId, sessionId: value.sessionId, promptId: value.promptId, expectedRevision: value.expectedRevision } as SpeechTurnScope;
      if (!validScope(scope)) return this.fail('invalid-control');
      this.phase = 'requesting';
      void this.requestToken(scope);
    } else if (value.type === 'finish' && this.phase === 'ready') this.finish();
    else if (value.type === 'finish' && (this.phase === 'requesting' || this.phase === 'connecting')) this.fail('not-ready');
    else this.fail('invalid-control');
  }

  /** The token is kept in this function only; no event or error carries it. */
  private async requestToken(scope: SpeechTurnScope) {
    const controller = new AbortController();
    this.controller = controller;
    this.arm('token', tokenTimeoutMs, () => this.fallback('token-timeout'));
    let token: string;
    try {
      const response = await this.fetcher(speechTokenPath, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: scope.requestId, sessionId: scope.sessionId, promptId: scope.promptId, expectedRevision: scope.expectedRevision }),
      });
      if (this.phase !== 'requesting') return;
      // A refusal (paused, buttons-only, over budget, stale) is not a connection problem, so it never switches to push-to-talk.
      if (!response.ok) { const code = await responseCode(response); return response.status >= 500 ? this.fallback(code) : this.fail(code); }
      const body = (await response.json()) as { accessToken?: unknown };
      if (this.phase !== 'requesting') return;
      if (!validToken(body.accessToken)) return this.fallback('invalid-token');
      token = body.accessToken;
    } catch {
      if (this.phase === 'requesting') this.fallback('token-unavailable');
      return;
    } finally {
      this.disarm('token');
    }
    this.phase = 'connecting';
    this.openProvider(token);
  }

  private openProvider(token: string) {
    let provider: ProviderSocket;
    try { provider = this.connect(deepgramDirectListenUrl, ['bearer', token]); }
    catch { return this.fallback('provider-unavailable'); }
    this.provider = provider;
    provider.binaryType = 'arraybuffer';
    provider.addEventListener('open', this.onOpen);
    provider.addEventListener('message', this.onMessage);
    provider.addEventListener('close', this.onClose);
    provider.addEventListener('error', this.onError);
    this.arm('open', providerOpenTimeoutMs, () => this.fallback('provider-timeout'));
  }

  private providerOpened() {
    if (this.phase !== 'connecting') return;
    this.disarm('open');
    this.phase = 'ready';
    this.message({ type: 'ready', sampleRate: 16000, channels: 1, maxCaptureMs: directCaptureMs });
    this.armKeepalive();
  }

  private providerMessage(event: ProviderEvent) {
    if (this.phase === 'closed') return;
    let parsed: ReturnType<typeof parseDeepgramMessage>;
    try {
      if (typeof event.data !== 'string') throw new SpeechError('invalid-provider-response');
      this.providerMessages++;
      this.providerBytes += new TextEncoder().encode(event.data).byteLength;
      if (this.providerMessages > providerMessageLimit || this.providerBytes > providerByteLimit) throw new SpeechError('limit');
      parsed = parseDeepgramMessage(event.data);
    } catch (error) {
      // Provider detail is never forwarded; only the normalized code is.
      return this.fail(error instanceof SpeechError ? error.code : 'invalid-provider-response');
    }
    if (parsed === 'speech-started') this.message({ type: 'speech-started' });
    else if (parsed) this.message({ type: 'recognition', segment: parsed });
  }

  /** A provider close or error. Clean 1000 closes after finish complete; drops mid-stream are interruptions. */
  private providerDown(code: number | undefined) {
    if (this.phase === 'closed') return;
    if (this.phase === 'finishing') return this.end(code === 1000 ? 'completed' : 'unknown');
    if (this.phase === 'ready') return this.end('interrupted');
    this.fallback('provider-closed');
  }

  private finish() {
    this.phase = 'finishing';
    this.disarm('keepalive');
    this.arm('flush', flushMs, () => this.end('unknown'));
    try { this.provider?.send(JSON.stringify({ type: 'CloseStream' })); }
    catch { this.lost(); }
  }

  private armKeepalive() { this.arm('keepalive', keepaliveMs, () => this.keepalive()); }

  /** Deepgram closes idle sockets after about ten seconds; a KeepAlive every five idle seconds prevents that. */
  private keepalive() {
    if (this.phase !== 'ready' || this.provider?.readyState !== 1) return;
    try { this.provider.send(JSON.stringify({ type: 'KeepAlive' })); }
    catch { this.lost(); return; }
    this.armKeepalive();
  }

  /** Transport failure: unknown while finishing, interrupted during live capture. */
  private lost() { this.end(this.phase === 'finishing' ? 'unknown' : 'interrupted'); }

  private end(outcome: 'completed' | 'interrupted' | 'unknown') {
    if (this.phase === 'closed') return;
    this.message({ type: 'ended', outcome });
    this.close();
  }

  /** Setup failures before ready: the hook shows its fallback message. */
  private fallback(code: string) {
    if (this.phase === 'closed') return;
    this.message({ type: 'error', code, message: fallbackMessage, fallback: true });
    this.close();
  }

  private fail(code: string) {
    if (this.phase === 'closed') return;
    this.message({ type: 'error', code, message: unavailable });
    this.close();
  }

  private arm(name: TimerName, ms: number, fn: () => void) {
    this.disarm(name);
    this.timers[name] = this.setTimer(() => { delete this.timers[name]; fn(); }, ms);
  }

  private disarm(name: TimerName) {
    const handle = this.timers[name];
    if (handle === undefined) return;
    delete this.timers[name];
    this.clearTimer(handle);
  }

  private message(value: DirectMessage) { this.emit({ type: 'message', data: JSON.stringify(value) }); }

  private emit(event: DirectSocketEvent) {
    if (event.type !== 'close' && this.readyState === 3) return;
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener(event);
  }
}

function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && tokenPattern.test(value);
}

async function responseCode(response: Response): Promise<string> {
  try {
    const value = (await response.json()) as { error?: { code?: unknown } };
    const code = value.error?.code;
    if (typeof code === 'string' && codePattern.test(code)) return code;
  } catch { /* Fall through to the status-based code. */ }
  return `http-${response.status}`;
}
