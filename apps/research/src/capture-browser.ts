import { CAPTURE_LIMITS, digest, type MediaDescriptor, type Modality } from '../../../packages/research-capture/src/contracts';

export const CAPTURE_BUFFER_SOURCES = 6;
/** Shared across modalities. Slots account for live chunks and complete pending
 * containers, each capped at 8 MB. Hashing can add one transient 8 MB copy per
 * active upload; encoder/network internals remain browser-owned. */
export class CaptureBufferBudget {
  private sources = 0;
  acquire(): (() => void) | null {
    if (this.sources >= CAPTURE_BUFFER_SOURCES) return null;
    this.sources++; let released = false;
    return () => { if (!released) { released = true; this.sources--; } };
  }
  get retainedSources() { return this.sources; }
  get maximumBytes() { return CAPTURE_BUFFER_SOURCES * CAPTURE_LIMITS.segmentBytes; }
}

export class QueuedCaptureCancelled extends Error {}
/** Only waiting jobs are cancelled. Once dispatched, an unknown HTTP result must
 * retain the original source and use reconciliation, never automatic redispatch. */
export class CaptureUploadQueue {
  private waiting: { start: () => Promise<void>; cancel: () => void }[] = [];
  private running = false;
  send<T>(signal: AbortSignal, permitted: () => boolean, dispatch: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const remove = () => signal.removeEventListener('abort', cancel);
      const cancel = () => { this.waiting = this.waiting.filter(value => value !== job); remove(); reject(new QueuedCaptureCancelled('Recording stopped before upload dispatch')); };
      const job = {
        cancel,
        start: async () => {
          remove();
          if (signal.aborted || !permitted()) { reject(new QueuedCaptureCancelled('Recording no longer permitted')); return; }
          try { resolve(await dispatch()); } catch (error) { reject(error); }
        },
      };
      if (signal.aborted) { reject(new QueuedCaptureCancelled('Recording stopped before upload dispatch')); return; }
      signal.addEventListener('abort', cancel, { once: true }); this.waiting.push(job); this.next();
    });
  }
  private next() {
    if (this.running) return;
    const job = this.waiting.shift(); if (!job) return;
    this.running = true;
    void job.start().finally(() => { this.running = false; this.next(); });
  }
}

export type RetainedSegment = { requestId: string; descriptor: MediaDescriptor; body: Blob; id?: string; dispatched: boolean };
export type CaptureSnapshot = { phase: 'idle' | 'requesting' | 'recording' | 'saving' | 'unconfirmed'; mode: Modality | null; saved: number; message: string; pending: number };
export interface CapturePort {
  reserve(segment: RetainedSegment): Promise<{ id: string; state: string }>;
  transfer(id: string, body: Blob | null, onDispatch?: () => void): Promise<{ state: string; attempt?: number }>;
  gap(mode: Modality, reason: 'permission-denied' | 'track-ended' | 'muted' | 'upload-failed' | 'capacity' | 'unsupported', atMs: number): Promise<void>;
  changed(snapshot: CaptureSnapshot): void;
}
export interface BrowserCaptureDevices {
  stream(mode: Modality): Promise<MediaStream>;
  recorder(stream: MediaStream, options: MediaRecorderOptions): MediaRecorder;
  supports(mime: string): boolean;
}
export const captureDevices: BrowserCaptureDevices = {
  stream: mode => mode === 'screen'
    ? navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: 1280 }, frameRate: { ideal: 15 } }, audio: false })
    : navigator.mediaDevices.getUserMedia(mode === 'microphone' ? { audio: true, video: false } : { video: { width: { ideal: 1280 }, frameRate: { ideal: 15 } }, audio: false }),
  recorder: (stream, options) => new MediaRecorder(stream, options),
  supports: mime => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime),
};
export function captureMime(mode: Modality, supports: (mime: string) => boolean) {
  const types = mode === 'microphone' ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'] : ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm', 'video/mp4'];
  return types.find(supports) ?? null;
}
/** Each recorder run is stopped and retained whole. dataavailable timeslices are
 * bounded accounting only; individual timeslices are never published as sources.
 * Each modality has at most two pending containers; a shared six-slot budget
 * caps live and pending containers across simultaneous microphone/camera/screen. No automatic ambiguous retry. */
export class BrowserCapture {
  private generation = 0;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private removeTracks: (() => void)[] = [];
  private pending: RetainedSegment[] = [];
  private work: Promise<void> = Promise.resolve();
  private finishing: Promise<void> = Promise.resolve();
  private active = false;
  private retained = true;
  private sequence = 0;
  private startedAt = 0;
  private lastEnd = 0;
  private questionId = '';
  private mime = '';
  private mode: Modality | null = null;
  private saved = 0;
  private releasePending = new Map<RetainedSegment, () => void>();
  private phase: CaptureSnapshot['phase'] = 'idle';
  constructor(private port: CapturePort, private devices = captureDevices, private now = Date.now, private budget = new CaptureBufferBudget()) {}
  private notify(message = '') { this.port.changed({ phase: this.phase, mode: this.mode, saved: this.saved, pending: this.pending.length, message }); }
  private offset() { return Math.max(0, Math.min(CAPTURE_LIMITS.sessionMs, this.now() - this.startedAt)); }
  private tracksOff() {
    clearTimeout(this.timer); clearTimeout(this.deadlineTimer);
    this.removeTracks.splice(0).forEach(remove => remove());
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
  }
  async start(options: { mode: Modality; startedAt: number; deadline: number; sequence: number; lastEnd: number; questionId: string }) {
    if (this.pending.length || this.active || this.phase === 'requesting') throw new Error('Check the previous recording before starting another.');
    const generation = ++this.generation;
    Object.assign(this, { mode: options.mode, startedAt: options.startedAt, sequence: options.sequence, lastEnd: options.lastEnd, questionId: options.questionId });
    const mime = captureMime(options.mode, this.devices.supports);
    if (!mime) { await this.port.gap(options.mode, 'unsupported', this.offset()); this.notify('Recording is unavailable in this browser. Continue with text.'); return; }
    this.mime = mime; this.phase = 'requesting'; this.retained = true; this.notify('Choose what to share in your browser.');
    try {
      const stream = await this.devices.stream(options.mode);
      if (generation !== this.generation || this.now() >= options.deadline) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream; this.active = true;
      for (const track of stream.getTracks()) {
        const ended = () => { void this.port.gap(options.mode, 'track-ended', this.offset()).catch(() => undefined); void this.stop(); };
        const muted = () => { void this.port.gap(options.mode, 'muted', this.offset()).catch(() => undefined); void this.stop(); };
        track.addEventListener('ended', ended); track.addEventListener('mute', muted);
        this.removeTracks.push(() => { track.removeEventListener('ended', ended); track.removeEventListener('mute', muted); });
      }
      this.deadlineTimer = setTimeout(() => { void this.stop(); }, Math.max(0, options.deadline - this.now()));
      this.run();
    } catch {
      if (generation !== this.generation) return;
      this.phase = 'idle'; this.active = false; this.tracksOff();
      await this.port.gap(options.mode, 'permission-denied', this.offset()).catch(() => undefined);
      this.notify('Access was not granted. No device recording started; your text interview is available.');
    }
  }
  private run() {
    if (!this.active || !this.stream || !this.mode) return;
    const release = this.pending.length < 2 ? this.budget.acquire() : null;
    if (!release) { void this.port.gap(this.mode, 'capacity', this.offset()).catch(() => undefined); void this.stop(); this.notify('This recording stopped while sources finish saving. Other permitted recordings and text can continue.'); return; }
    const mode = this.mode, startMs = Math.max(this.lastEnd, this.offset()), questionId = this.questionId;
    const parts: Blob[] = []; let bytes = 0, oversized = false;
    let recorder: MediaRecorder;
    try { recorder = this.devices.recorder(this.stream, { mimeType: this.mime, videoBitsPerSecond: 500_000, audioBitsPerSecond: 64_000 }); } catch (error) { release(); throw error; }
    this.recorder = recorder;
    let finishRun: () => void = () => undefined;
    this.finishing = new Promise(resolve => {
      finishRun = resolve;
      recorder.ondataavailable = event => {
        bytes += event.data.size;
        if (bytes > CAPTURE_LIMITS.segmentBytes) { oversized = true; parts.length = 0; void this.stop(false); }
        else if (event.data.size) parts.push(event.data);
      };
      recorder.onerror = () => { oversized = true; void this.stop(false); this.notify('The browser could not record this source. Continue with text.'); };
      recorder.onstop = () => {
        clearTimeout(this.timer); this.recorder = null;
        const endMs = Math.min(CAPTURE_LIMITS.sessionMs, this.offset());
        if (oversized) void this.port.gap(mode, 'capacity', endMs).catch(() => undefined);
        if (this.retained && !oversized && parts.length && endMs > startMs) {
          const body = new Blob(parts, { type: this.mime });
          const item: RetainedSegment = { requestId: crypto.randomUUID(), body, dispatched: false, descriptor: { modality: mode, sequence: this.sequence++, startMs, endMs, bytes: body.size, sha256: '', mime: this.mime, questionId, sourceId: null } };
          this.lastEnd = endMs; this.pending.push(item); this.releasePending.set(item, release);
          this.work = this.work.then(async () => {
            if (!this.retained) return;
            item.descriptor.sha256 = await digest(new Uint8Array(await body.arrayBuffer()));
            if (this.retained && this.phase !== 'unconfirmed') await this.save(item, false);
          }).catch(() => { if (!this.retained) return; this.phase = 'unconfirmed'; this.active = false; this.tracksOff(); if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop(); this.notify('A recording result is unconfirmed. Check it before recording again.'); });
        }
        else release();
        if (this.active) { try { this.run(); } catch { this.active = false; this.tracksOff(); void this.port.gap(mode, 'unsupported', this.offset()).catch(() => undefined); this.phase = 'idle'; this.notify('This browser could not start the next recording source. Other recordings and text can continue.'); } } else if (this.phase !== 'unconfirmed') { this.phase = this.pending.length ? 'saving' : 'idle'; this.notify(); }
        resolve();
      };
    });
    try { recorder.start(1000); } catch (error) { release(); this.recorder = null; finishRun(); throw error; } // accounting chunks, combined only after onstop
    this.phase = 'recording'; this.notify();
    this.timer = setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, 15_000);
  }
  private async save(item: RetainedSegment, reconcile: boolean) {
    if (!this.retained) return;
    if (!item.id) { const receipt = await this.port.reserve(item); item.id = receipt.id; if (receipt.state === 'available') { this.ack(item); return; } }
    if (!this.retained) return;
    if (reconcile || item.dispatched) {
      const receipt = await this.port.transfer(item.id, null);
      if (receipt.state === 'available') { this.ack(item); return; }
      if (receipt.state !== 'reserved') throw new Error('Recording is still unresolved.');
      // Only the gateway's reconciled reserved attempt authorizes another PUT.
    }
    if (!this.retained) return;
    const receipt = await this.port.transfer(item.id, item.body, () => { item.dispatched = true; });
    if (receipt.state !== 'available') throw new Error('Recording receipt is unavailable.');
    this.ack(item);
  }
  private ack(item: RetainedSegment) { this.releasePending.get(item)?.(); this.releasePending.delete(item); this.pending = this.pending.filter(value => value !== item); this.saved++; this.phase = this.active ? 'recording' : this.pending.length ? 'saving' : 'idle'; this.notify('Recording source saved.'); }
  async recover() {
    if (this.active || this.phase === 'requesting') return;
    await this.finishing; await this.work;
    this.phase = 'saving'; this.notify('Checking the original recording result…');
    try { for (const item of [...this.pending]) { if (!item.descriptor.sha256) item.descriptor.sha256 = await digest(new Uint8Array(await item.body.arrayBuffer())); await this.save(item, true); } this.phase = 'idle'; this.notify('Recording sources confirmed.'); }
    catch { this.phase = 'unconfirmed'; this.notify('The recording result is still unconfirmed. Keep this tab open and check again. Your text answers can continue.'); }
  }
  /** Stops tracks synchronously before waiting for final container/receipts. */
  async stop(retain = true) {
    ++this.generation; this.active = false;
    if (!retain) { this.retained = false; this.phase = 'idle'; }
    this.tracksOff();
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    if (this.phase !== 'unconfirmed') this.phase = retain && (this.pending.length || this.recorder) ? 'saving' : 'idle';
    this.notify();
    await this.finishing; await this.work;
    if (!retain) { this.releasePending.forEach(release => release()); this.releasePending.clear(); this.pending = []; this.phase = 'idle'; }
    if (this.phase !== 'unconfirmed') { this.phase = this.pending.length ? 'saving' : 'idle'; this.notify(); }
  }
  /** A future voice consumer may borrow this microphone stream. The recorder
   * owns track lifetime; consumers must detach without stopping its tracks. */
  activeStream(): MediaStream | null { return this.stream; }
  setQuestion(questionId: string) { const changed = this.questionId !== questionId; this.questionId = questionId; if (changed && this.active && this.recorder && this.recorder.state !== 'inactive') this.recorder.stop(); }
}
