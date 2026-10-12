/** Hosted push-to-talk: a WebSocket-shaped buffer that posts one recording for transcription on finish. */
export const uploadPcmLimitBytes = 1_920_000;
const transcriptionPath = '/api/clinic/speech/transcriptions';
const unavailable = 'Voice is unavailable for this question.';

export interface UploadSocketEvent { type: string; data?: string; code?: number; reason?: string }
type UploadListener = (event: UploadSocketEvent) => void;
type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
interface UploadScope { requestId: string; sessionId: string; promptId: string; expectedRevision: number }

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

  /** Aborts any in-flight upload and suppresses every later event. */
  close(_code?: number, _reason?: string) {
    if (this.readyState === 3) return;
    this.readyState = 3; this.chunks = []; this.bytes = 0;
    this.controller?.abort();
    this.emit({ type: 'close' });
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
      void this.upload(this.scope);
    } else this.fail('invalid-control');
  }

  private async upload(scope: UploadScope) {
    // Nothing recorded: finish cleanly with no words instead of sending an empty clip.
    if (!this.bytes) { this.emit({ type: 'message', data: JSON.stringify({ type: 'ended', outcome: 'completed' }) }); this.close(); return; }
    const body = new Uint8Array(this.bytes);
    let offset = 0;
    for (const chunk of this.chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    this.chunks = [];
    const query = new URLSearchParams({ sessionId: scope.sessionId, promptId: scope.promptId, expectedRevision: String(scope.expectedRevision), requestId: scope.requestId });
    const controller = new AbortController();
    this.controller = controller;
    let text: unknown;
    try {
      const response = await this.fetcher(`${transcriptionPath}?${query}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { 'Content-Type': 'application/octet-stream' }, body });
      if (this.readyState === 3) return;
      if (!response.ok) return this.fail(await errorCode(response));
      text = ((await response.json()) as { text?: unknown }).text;
    } catch {
      this.fail('transcription-unavailable');
      return;
    }
    if (this.readyState === 3) return;
    if (typeof text !== 'string') return this.fail('invalid-transcription');
    const clean = text.trim();
    if (clean) {
      this.emit({ type: 'message', data: JSON.stringify({ type: 'recognition', segment: { start: 0, duration: body.byteLength / 32000, text: clean, isFinal: true, speechFinal: true } }) });
    }
    this.emit({ type: 'message', data: JSON.stringify({ type: 'ended', outcome: 'completed' }) });
    this.close();
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
