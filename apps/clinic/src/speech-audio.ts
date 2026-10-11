import { speechLimits } from '../../../packages/speech/src/index';

type AudioTarget = Pick<HTMLAudioElement, 'src'>;
export interface SpeechSourceBuffer extends EventTarget { readonly updating: boolean; appendBuffer(bytes: Uint8Array<ArrayBuffer>): void; abort(): void; }
export interface SpeechMediaSource extends EventTarget { readonly readyState: string; addSourceBuffer(type: string): SpeechSourceBuffer; removeSourceBuffer(buffer: SpeechSourceBuffer): void; endOfStream(): void; }
export interface SpeechAudioEnvironment {
  /** Omitted only when MediaSource MPEG playback is unsupported. */
  createMediaSource?: () => SpeechMediaSource;
  createObjectURL: (source: Blob | SpeechMediaSource) => string;
  revokeObjectURL: (url: string) => void;
}
export function browserSpeechAudioEnvironment(): SpeechAudioEnvironment {
  const supported = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mpeg');
  return {
    ...(supported ? { createMediaSource: () => new MediaSource() } : {}),
    createObjectURL: value => URL.createObjectURL(value as Blob | MediaSource),
    revokeObjectURL: value => URL.revokeObjectURL(value),
  };
}

/** One bounded response, retained in its media buffer for explicit playback retry/replay. No network retry. */
export class SpeechAudioStream {
  readonly mode: 'streaming' | 'buffered';
  private media?: SpeechMediaSource;
  private buffer?: SpeechSourceBuffer;
  private url?: string;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private open?: Promise<void>;
  private closed = false;
  private failure?: Error;
  private consumed = false;
  private playable = false;
  private deadline: ReturnType<typeof setTimeout>;
  private listeners: (() => void)[] = [];
  private waits = new Set<(error: Error) => void>();

  constructor(private options: {
    audio: AudioTarget; signal: AbortSignal; isCurrent: () => boolean;
    onPlayable: () => void; onFailure: (error: Error) => void;
    environment?: SpeechAudioEnvironment;
  }) {
    this.environment = options.environment ?? browserSpeechAudioEnvironment();
    this.mode = this.environment.createMediaSource ? 'streaming' : 'buffered';
    this.deadline = setTimeout(() => this.fail(new Error('audio-timeout')), speechLimits.providerTimeoutMs);
    this.listen(options.signal, 'abort', () => this.dispose());
    try {
      this.assertCurrent();
      if (this.environment.createMediaSource) {
        this.media = this.environment.createMediaSource();
        this.listen(this.media, 'sourceclose', () => { if (!this.closed && options.isCurrent()) this.fail(new Error('audio-source-closed')); });
        // Install open listeners before assigning src, which can begin media attachment immediately.
        this.open = this.wait(this.media, 'sourceopen');
        void this.open.catch(() => undefined);
        this.url = this.environment.createObjectURL(this.media);
        options.audio.src = this.url;
      }
    } catch (error) { this.dispose(); throw error; }
  }
  private environment: SpeechAudioEnvironment;
  private listen(target: EventTarget, event: string, listener: EventListener) {
    target.addEventListener(event, listener);
    const remove = () => target.removeEventListener(event, listener);
    this.listeners.push(remove); return remove;
  }
  private assertCurrent() {
    if (this.failure) throw this.failure;
    if (this.closed || this.options.signal.aborted || !this.options.isCurrent()) throw new Error('audio-interrupted');
  }
  private wait(target: EventTarget, event: string, begin?: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => { target.removeEventListener(event, done); this.waits.delete(failed); };
      const done = () => { cleanup(); try { this.assertCurrent(); resolve(); } catch (error) { reject(error); } };
      const failed = (error: Error) => { cleanup(); reject(error); };
      target.addEventListener(event, done); this.waits.add(failed);
      try { this.assertCurrent(); begin?.(); } catch (error) { failed(error instanceof Error ? error : new Error('audio-unavailable')); }
    });
  }
  private fail(error: Error) {
    if (this.closed || this.failure) return;
    this.failure = error;
    for (const reject of [...this.waits]) reject(error);
    void this.reader?.cancel().catch(() => undefined);
    this.options.onFailure(error);
    this.dispose();
  }
  private readyToPlay() {
    this.assertCurrent();
    if (!this.playable) { this.playable = true; this.options.onPlayable(); }
  }
  async consume(body: ReadableStream<Uint8Array>) {
    if (this.consumed) throw new Error('audio-response-already-used');
    this.consumed = true;
    let total = 0;
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    try {
      this.assertCurrent(); this.reader = body.getReader();
      if (this.media) {
        await this.open; this.assertCurrent();
        this.buffer = this.media.addSourceBuffer('audio/mpeg');
        this.listen(this.buffer, 'error', () => this.fail(new Error('audio-decode-failed')));
        this.listen(this.buffer, 'abort', () => { if (!this.closed) this.fail(new Error('audio-append-aborted')); });
      }
      for (;;) {
        const result = await this.reader.read(); this.assertCurrent();
        if (result.done) break;
        total += result.value.byteLength;
        if (total > speechLimits.ttsBytes) throw new Error('audio-too-large');
        if (!result.value.byteLength) continue;
        // Copy only after checking the response bound. At most one append is queued.
        const chunk = new Uint8Array(result.value);
        if (this.buffer) {
          const buffer = this.buffer;
          await this.wait(buffer, 'updateend', () => buffer.appendBuffer(chunk));
          this.readyToPlay();
        } else chunks.push(chunk);
      }
      if (!total) throw new Error('empty-audio');
      this.assertCurrent();
      if (this.media) this.media.endOfStream();
      else {
        this.url = this.environment.createObjectURL(new Blob(chunks, { type: 'audio/mpeg' }));
        this.options.audio.src = this.url;
        this.readyToPlay();
      }
      clearTimeout(this.deadline);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('audio-unavailable');
      if (!this.closed && this.options.isCurrent()) this.fail(failure);
      throw failure;
    } finally {
      this.reader?.releaseLock(); this.reader = undefined;
      // MediaSource retains its appended bytes for cached retry/replay; no duplicate JS chunk cache.
      chunks.length = 0;
    }
  }
  dispose() {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.deadline);
    for (const reject of [...this.waits]) reject(new Error('audio-interrupted'));
    for (const remove of this.listeners.splice(0)) remove();
    void this.reader?.cancel().catch(() => undefined);
    if (this.buffer && this.media?.readyState === 'open') {
      try { if (this.buffer.updating) this.buffer.abort(); } catch { /* Detachment can race browser cleanup. */ }
      try { this.media.removeSourceBuffer(this.buffer); } catch { /* Detached source buffers are already released. */ }
    }
    if (this.url) { this.environment.revokeObjectURL(this.url); this.url = undefined; }
    this.buffer = undefined; this.media = undefined;
  }
}
