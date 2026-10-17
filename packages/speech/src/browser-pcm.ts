/** Browser-only PCM helpers. No captured samples are retained beyond the current frame. */
export const voiceCaptureLimits = { sampleRate: 16000, captureMs: 60000, frameBytes: 16384, bufferedBytes: 64000, drainMs: 5000 } as const;
export interface CaptureScope { sessionId: string; promptId: string; expectedRevision: number; requestId: string; }
export class CaptureEpoch {
  private generation = 0;
  begin() { return ++this.generation; }
  invalidate() { this.generation++; }
  current(generation: number, captured: CaptureScope, displayed?: CaptureScope) {
    return generation === this.generation && Boolean(displayed && captured.sessionId === displayed.sessionId && captured.promptId === displayed.promptId && captured.expectedRevision === displayed.expectedRevision && captured.requestId === displayed.requestId);
  }
}
/** Late permission/module results are disposed immediately after an earlier cancellation. */
export class CaptureResources {
  private closed = false;
  private cleanup: (() => void)[] = [];
  own(cleanup: () => void) { if (this.closed) { cleanup(); return false; } this.cleanup.push(cleanup); return true; }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const cleanup of this.cleanup.splice(0).reverse()) { try { cleanup(); } catch { /* Continue releasing the other browser resources. */ } }
  }
}

/** Area-weighted downsampling uses integer time ticks, including non-integral 44.1k→16k ratios. */
export class StreamingPcm16 {
  private ticks = 0;
  private weighted = 0;
  constructor(readonly inputRate: number) {
    if (!Number.isInteger(inputRate) || inputRate < 16000 || inputRate > 192000) throw new Error('unsupported-sample-rate');
  }
  encode(samples: Float32Array): Uint8Array {
    const count = Math.floor((this.ticks + samples.length * 16000) / this.inputRate);
    const bytes = new Uint8Array(count * 2), output = new DataView(bytes.buffer);
    let index = 0;
    for (const raw of samples) {
      const value = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
      let remaining = 16000;
      while (remaining) {
        const used = Math.min(remaining, this.inputRate - this.ticks);
        this.weighted += value * used; this.ticks += used; remaining -= used;
        if (this.ticks === this.inputRate) {
          const average = this.weighted / this.inputRate;
          output.setInt16(index, Math.round(average * (average < 0 ? 32768 : 32767)), true);
          index += 2; this.ticks = 0; this.weighted = 0;
        }
      }
    }
    return bytes;
  }
}
export class LocalVoiceActivity {
  private voicedMs = 0;
  feed(samples: Float32Array, sampleRate: number) {
    const rms = Math.sqrt(samples.reduce((sum, value) => sum + (Number.isFinite(value) ? value * value : 0), 0) / Math.max(1, samples.length));
    if (rms >= 0.018) this.voicedMs += samples.length / sampleRate * 1000;
    else this.voicedMs = 0;
    // Continue signaling while speech persists, including when playback starts mid-utterance.
    return this.voicedMs >= 30;
  }
}
export interface PcmSocket { readyState: number; bufferedAmount: number; send(data: string | Uint8Array): void; }
export class PcmTransport {
  private phase: 'waiting' | 'ready' | 'finished' = 'waiting';
  private bytes = 0;
  private started = 0;
  private captureMs: number = voiceCaptureLimits.captureMs;
  private encoder: StreamingPcm16;
  constructor(private socket: PcmSocket, sampleRate: number, private now = () => performance.now()) { this.encoder = new StreamingPcm16(sampleRate); }
  ready(value: { sampleRate: number; channels: number; maxCaptureMs: number }) {
    if (this.phase !== 'waiting' || value.sampleRate !== 16000 || value.channels !== 1 || !Number.isInteger(value.maxCaptureMs) || value.maxCaptureMs <= 0 || value.maxCaptureMs > voiceCaptureLimits.captureMs) throw new Error('invalid-voice-format');
    this.captureMs = value.maxCaptureMs; this.phase = 'ready'; this.started = this.now();
  }
  audio(samples: Float32Array) {
    if (this.phase !== 'ready') return;
    if (samples.length > 8192) throw new Error('voice-frame-too-large');
    const bytes = this.encoder.encode(samples), elapsed = this.now() - this.started;
    if (elapsed < 0 || elapsed > this.captureMs || this.bytes + bytes.length > Math.floor(this.captureMs * 16) * 2 || this.bytes + bytes.length > 32000 * (elapsed / 1000 + 2)) throw new Error('voice-limit');
    this.encodedAudio(bytes);
  }
  /** Fresh, bounded barge-in PCM only; never recovered audio from an old attempt. */
  encodedAudio(bytes: Uint8Array) {
    const elapsed = this.now() - this.started;
    if (this.phase !== 'ready' || !bytes.length || bytes.length % 2 || bytes.length > 64000 || elapsed < 0 || elapsed > this.captureMs || this.bytes + bytes.length > Math.floor(this.captureMs * 16) * 2 || this.bytes + bytes.length > 32000 * (elapsed / 1000 + 2)) throw new Error('voice-limit');
    for (let offset = 0; offset < bytes.length; offset += voiceCaptureLimits.frameBytes) {
      const frame = bytes.slice(offset, offset + voiceCaptureLimits.frameBytes);
      if (this.socket.readyState !== 1 || this.socket.bufferedAmount + frame.length > voiceCaptureLimits.bufferedBytes) throw new Error('voice-connection-slow');
      this.socket.send(frame); this.bytes += frame.length;
    }
  }
  finish() { if (this.phase !== 'ready') return; this.phase = 'finished'; if (this.socket.readyState === 1) this.socket.send(JSON.stringify({ type: 'finish' })); }
  interrupt() { this.phase = 'finished'; }
}
export function appendTranscript(prefix: string, transcript: string) { return transcript ? `${prefix}${prefix && !/\s$/.test(prefix) ? ' ' : ''}${transcript}` : prefix; }

/** Same-origin asset keeps AudioWorklet loading compatible with the hosted script policy. */
export const captureWorkletUrl = '/research-capture.worklet.js';
