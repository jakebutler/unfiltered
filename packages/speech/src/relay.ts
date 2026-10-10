/** Server-only WebSocket relay. Node/Worker entrypoints own upgrade/auth and native socket APIs. */
import { SpeechError, speechLimits } from './contracts.js';
import { parseDeepgramMessage, type RecognitionSegment } from './turn.js';
import type { SpeechLease, SpeechOutcome } from './server.js';

/** Fixed raw format makes duration enforceable from bytes. Browser must resample its actual input rate. */
export const deepgramListenUrl = 'wss://api.deepgram.com/v1/listen?model=nova-3&language=en-US&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&endpointing=500&vad_events=true&punctuate=true';
export const pcmBytesPerSecond = 32_000;
export interface SpeechSocketPort {
  bufferedAmount: number;
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
}
export type RelayEvent =
  | { type: 'recognition'; segment: RecognitionSegment }
  | { type: 'speech-started' }
  | { type: 'ended'; outcome: SpeechOutcome };

/** Construct only after authenticated admission and successful provider open. No static browser secrets. */
export function createSpeechRelay(options: {
  provider: SpeechSocketPort;
  lease: SpeechLease;
  /** Host sends only these normalized events to the authorized browser; must not buffer unboundedly. */
  emit(event: RelayEvent): void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const started = now();
  let bytes = 0, messages = 0, providerBytes = 0, stopped = false, finishing = false;
  let idle: ReturnType<typeof setTimeout>, flush: ReturnType<typeof setTimeout> | undefined;
  const hard = setTimeout(() => stop('interrupted'), speechLimits.captureMs + 5_000);
  function stop(outcome: SpeechOutcome) {
    if (stopped) return;
    stopped = true; clearTimeout(hard); clearTimeout(idle); clearTimeout(flush);
    try { options.provider.close(1000, 'speech-ended'); } catch { /* The retained reservation covers an unknown remote outcome. */ }
    try { options.emit({ type: 'ended', outcome }); } catch { /* A disconnected client cannot receive the final status. */ }
    try { void Promise.resolve(options.lease.settle(outcome)).catch(() => undefined); }
    catch { /* Admission retains the reservation for reconciliation on settlement failure. */ }
  }
  function resetIdle() { clearTimeout(idle); idle = setTimeout(() => stop('interrupted'), 10_000); }
  resetIdle();
  return {
    /** Accept only raw mono PCM16 frames, never browser-supplied provider control messages. */
    audio(frame: Uint8Array) {
      if (stopped || finishing) throw new SpeechError('interrupted');
      const elapsed = now() - started;
      if (!(frame instanceof Uint8Array) || !frame.byteLength || frame.byteLength % 2 !== 0 || frame.byteLength > 16_384
          || elapsed < 0 || elapsed > speechLimits.captureMs
          || bytes + frame.byteLength > pcmBytesPerSecond * speechLimits.captureMs / 1_000
          || bytes + frame.byteLength > pcmBytesPerSecond * (elapsed / 1_000 + 2)
          || options.provider.bufferedAmount > 64_000) { stop('interrupted'); throw new SpeechError('limit'); }
      bytes += frame.byteLength; resetIdle();
      try { options.provider.send(frame); } catch { stop('unknown'); throw new SpeechError('unavailable'); }
    },
    /** User explicitly finished; wait up to five seconds for the final provider result and close. */
    finish() {
      if (stopped || finishing) return;
      finishing = true; clearTimeout(idle);
      try { options.provider.send(JSON.stringify({ type: 'CloseStream' })); }
      catch { stop('unknown'); return; }
      flush = setTimeout(() => stop('unknown'), 5_000);
    },
    providerMessage(message: string) {
      if (stopped) return;
      try {
        providerBytes += new TextEncoder().encode(message).byteLength;
        if (++messages > 600 || providerBytes > 2_000_000) throw new SpeechError('limit');
        const parsed = parseDeepgramMessage(message);
        if (parsed === 'speech-started') options.emit({ type: 'speech-started' });
        else if (parsed) options.emit({ type: 'recognition', segment: parsed });
      } catch { stop('unknown'); }
    },
    /** A clean provider close after explicit finish completes transcription, never saves an app turn. */
    providerClosed(code: number) { stop(finishing && code === 1000 ? 'completed' : 'unknown'); },
    interrupt() { stop('interrupted'); },
    providerFailed() { stop('unknown'); },
  };
}
