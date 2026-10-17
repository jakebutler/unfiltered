/** Hosted push-to-talk: a WebSocket-shaped buffer that posts one recording for transcription on finish. The recording is kept until it is transcribed, discarded, or the socket closes. */
export const uploadPcmLimitBytes = 1_920_000;
const transcriptionPath = '/api/clinic/speech/transcriptions';
const unavailable = 'Voice is unavailable for this question.';

export interface UploadSocketEvent { type: string; data?: string; code?: number; reason?: string }
type UploadListener = (event: UploadSocketEvent) => void;
type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
interface UploadScope { requestId: string; sessionId: string; promptId: string; expectedRevision: number }
type Attempt = { status: 'done'; text: string } | { status: 'failed'; code: string; transient: boolean } | { status: 'aborted' };

/** Implements only the WebSocket subset used by useSpeechCapture and PcmTransport. */
export class UploadSpeechSocket {
  readyState = 0;
  readonly bufferedAmount = 0;
  binaryType = 'arraybuffer';
  private listeners = new Map<string, Set<UploadListener>>();
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private scope?: UploadScope;
  private finishing = false;
  /** Set on finish; kept after a failed or paused transcription so the patient can retry or discard it. */
  private recording?: Uint8Array<ArrayBuffer>;
  private busy = false;
  private attempts = 0;
  private controller?: AbortController;
  private fetcher: Fetcher;
  private schedule: (fn: () => void) => void;

  constructor(readonly url: string | URL, options: { fetcher?: Fetcher; schedule?: (fn: () => void) => void } = {}) {
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.schedule = options.schedule ?? (fn => { setTimeout(fn, 0); });
    this.schedule(() => this.open());
  }

  addEventListener(type: string, listener: UploadListener) {
    const set = this.listeners.get(type) ?? new Set<UploadListener>();
    set.add(listener); this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: UploadListener) { this.listeners.get(type)?.delete(listener); }

  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (this.readyState === 0) throw new Error('socket-not-open');
    if (this.readyState !== 1) return;
    if (typeof data === 'string') return this.control(data);
    const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (!this.scope || this.finishing) return;
    if (this.bytes + view.byteLength > uploadPcmLimitBytes) return this.fail('audio-too-large');
    // Copy: the capture path reuses its frame buffers.
    this.chunks.push(view.slice()); this.bytes += view.byteLength;
  }

  /** Aborts any in-flight upload, drops the kept recording, and suppresses every later event. */
  close(_code?: number, _reason?: string) {
    if (this.readyState === 3) return;
    this.readyState = 3; this.chunks = []; this.bytes = 0; this.recording = undefined; this.busy = false;
    this.controller?.abort();
    this.emit({ type: 'close' });
  }

  /** Transcribes the kept recording again after a failure or a paused attempt. */
  retry() {
    if (this.readyState !== 1 || !this.recording || !this.scope || this.busy) return;
    void this.transcribe(this.scope, this.recording);
  }

  /** Stops an in-flight transcription but keeps the recording for a later retry. */
  pause(): boolean {
    if (this.readyState !== 1 || !this.busy) return false;
    this.controller?.abort();
    this.keep('transcription-paused');
    return true;
  }

  private open() {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.emit({ type: 'open' });
  }

  private control(raw: string) {
    let value: { type?: unknown; requestId?: unknown; sessionId?: unknown; promptId?: unknown; expectedRevision?: unknown };
    try { value = JSON.parse(raw) as typeof value; } catch { return this.fail('invalid-control'); }
    if (value.type === 'start' && !this.scope) {
      if (typeof value.requestId !== 'string' || typeof value.sessionId !== 'string' || typeof value.promptId !== 'string' || !Number.isInteger(value.expectedRevision)) return this.fail('invalid-control');
      this.scope = { requestId: value.requestId, sessionId: value.sessionId, promptId: value.promptId, expectedRevision: value.expectedRevision as number };
      this.emit({ type: 'message', data: JSON.stringify({ type: 'ready', sampleRate: 16000, channels: 1, maxCaptureMs: 60000 }) });
    } else if (value.type === 'finish' && this.scope && !this.finishing) {
      this.finishing = true;
      this.begin(this.scope);
    } else this.fail('invalid-control');
  }

  private begin(scope: UploadScope) {
    const body = new Uint8Array(this.bytes);
    let offset = 0;
    for (const chunk of this.chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    this.chunks = [];
    // Nothing recorded: finish cleanly with no words instead of sending an empty clip.
    if (!body.byteLength) { this.emit({ type: 'message', data: JSON.stringify({ type: 'ended', outcome: 'completed' }) }); this.close(); return; }
    this.recording = body;
    void this.transcribe(scope, body);
  }

  /** One automatic retry for network and server failures; any other failure keeps the recording for a manual retry. */
  private async transcribe(scope: UploadScope, body: Uint8Array<ArrayBuffer>) {
    this.busy = true;
    let attempt = await this.request(scope, body);
    // Never retry after a discard or pause, including one that landed while the error body was being read.
    if (attempt.status === 'failed' && attempt.transient && this.readyState !== 3 && !this.controller?.signal.aborted) attempt = await this.request(scope, body);
    if (attempt.status === 'aborted' || this.readyState === 3) return;
    if (attempt.status === 'failed') return this.keep(attempt.code);
    this.busy = false;
    const clean = attempt.text.trim();
    if (clean) {
      this.emit({ type: 'message', data: JSON.stringify({ type: 'recognition', segment: { start: 0, duration: body.byteLength / 32000, text: clean, isFinal: true, speechFinal: true } }) });
    }
    this.emit({ type: 'message', data: JSON.stringify({ type: 'ended', outcome: 'completed' }) });
    this.close();
  }

  private async request(scope: UploadScope, body: Uint8Array<ArrayBuffer>): Promise<Attempt> {
    // Each attempt is its own provider reservation, so a retry never collides with the earlier attempt.
    const requestId = this.attempts++ ? crypto.randomUUID() : scope.requestId;
    const query = new URLSearchParams({ sessionId: scope.sessionId, promptId: scope.promptId, expectedRevision: String(scope.expectedRevision), requestId });
    const controller = new AbortController();
    this.controller = controller;
    try {
      const response = await this.fetcher(`${transcriptionPath}?${query}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { 'Content-Type': 'application/octet-stream' }, body });
      if (controller.signal.aborted) return { status: 'aborted' };
      if (!response.ok) { const code = await errorCode(response); return controller.signal.aborted ? { status: 'aborted' } : { status: 'failed', code, transient: response.status >= 500 || response.status === 429 }; }
      const text = ((await response.json()) as { text?: unknown }).text;
      return typeof text === 'string' ? { status: 'done', text } : { status: 'failed', code: 'invalid-transcription', transient: false };
    } catch {
      return controller.signal.aborted ? { status: 'aborted' } : { status: 'failed', code: 'transcription-unavailable', transient: true };
    }
  }

  /** Reports a transcription that did not finish; the socket stays open with the recording kept. */
  private keep(code: string) {
    this.busy = false;
    this.emit({ type: 'message', data: JSON.stringify({ type: 'error', code, message: unavailable, retained: true }) });
  }

  private fail(code: string) {
    if (this.readyState === 3) return;
    this.emit({ type: 'message', data: JSON.stringify({ type: 'error', code, message: unavailable }) });
    this.close();
  }

  private emit(event: UploadSocketEvent) {
    if (event.type !== 'close' && this.readyState === 3) return;
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener(event);
  }
}

async function errorCode(response: Response): Promise<string> {
  try {
    const value = (await response.json()) as { error?: { code?: unknown } };
    if (typeof value.error?.code === 'string') return value.error.code;
  } catch { /* Fall through to the status-based code. */ }
  return `http-${response.status}`;
}
