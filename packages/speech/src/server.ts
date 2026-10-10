/** Server-only: never export from the browser entrypoint or place credentials in static config. */
import { SpeechError, speechLimits, type SpeechOutputRequest } from './contracts.js';

export type SpeechFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type SpeechOutcome = 'completed' | 'interrupted' | 'failed' | 'unknown';
export interface SpeechLease {
  /** Atomic admission charges the full bound before calling a provider. Never refund unknown/canceled work. */
  settle(outcome: SpeechOutcome): Promise<void> | void;
}
export interface SpeechReservation {
  sessionId: string;
  requestId: string;
  provider: 'deepgram' | 'elevenlabs';
  maxCharacters: number;
  maxAudioSeconds: number;
}
export interface SpeechAdmission {
  /** Must atomically deny duplicate IDs, exhausted account/session quota and provider concurrency. */
  reserve(request: SpeechReservation): Promise<SpeechLease>;
}

export interface AuthorizedSpeechText {
  sessionId: string;
  sourceId: string;
  revision: number;
  text: string;
}

export interface SpeechServerOptions {
  elevenlabsApiKey: string;
  admission: SpeechAdmission;
  /** Resolve only within the verified current session, after identity/origin checks. No client text. */
  authorize(request: SpeechOutputRequest): Promise<AuthorizedSpeechText>;
  fetcher?: SpeechFetch;
}

export const elevenlabsSpeechRoute = Object.freeze({
  model: 'eleven_flash_v2_5', voiceId: 'JBFqnCBsd6RMkjVDRZzb', outputFormat: 'mp3_22050_32',
});

/** One authorized, bounded attempt. No retry or fallback, and no provider body or metadata exposure. */
export function createSpeechOutput(options: SpeechServerOptions) {
  if (!options.elevenlabsApiKey) throw new SpeechError('unavailable');
  const fetcher = options.fetcher ?? fetch;
  return async (input: SpeechOutputRequest, signal?: AbortSignal): Promise<Response> => {
    if (!input || typeof input.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(input.requestId)
        || typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 100
        || typeof input.sourceId !== 'string' || !input.sourceId || input.sourceId.length > 300
        || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new SpeechError('invalid-request');
    if (signal?.aborted) throw new SpeechError('interrupted');
    const source = await options.authorize(input);
    if (source.sessionId !== input.sessionId || source.sourceId !== input.sourceId || source.revision !== input.expectedRevision)
      throw new SpeechError('not-authorized');
    if (typeof source.text !== 'string' || !source.text.trim() || source.text.length > speechLimits.ttsCharacters)
      throw new SpeechError('limit');
    const lease = await options.admission.reserve({ sessionId: source.sessionId, requestId: input.requestId,
      provider: 'elevenlabs', maxCharacters: source.text.length, maxAudioSeconds: 0 });
    const controller = new AbortController();
    let timeout = false, ended = false, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let output: ReadableStreamDefaultController<Uint8Array> | undefined;
    const release = async (outcome: SpeechOutcome) => {
      if (ended) return;
      ended = true; clearTimeout(timer); signal?.removeEventListener('abort', interrupted);
      await lease.settle(outcome);
    };
    const cancel = (error: SpeechError, outcome: SpeechOutcome) => {
      if (ended) return;
      controller.abort();
      void reader?.cancel().catch(() => undefined);
      output?.error(error);
      // Lease errors must be handled by admission's own durable reconciliation, never logged here.
      void release(outcome).catch(() => undefined);
    };
    const interrupted = () => cancel(new SpeechError('interrupted'), 'interrupted');
    const timer = setTimeout(() => { timeout = true; cancel(new SpeechError('timeout'), 'unknown'); }, speechLimits.providerTimeoutMs);
    signal?.addEventListener('abort', interrupted, { once: true });
    try {
      if (signal?.aborted) { interrupted(); throw new SpeechError('interrupted'); }
      const route = elevenlabsSpeechRoute;
      const response = await fetcher(`https://api.elevenlabs.io/v1/text-to-speech/${route.voiceId}/stream?output_format=${route.outputFormat}`, {
        method: 'POST', headers: { 'xi-api-key': options.elevenlabsApiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text: source.text, model_id: route.model }), signal: controller.signal, redirect: 'error',
      });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => undefined); throw new SpeechError(timeout ? 'timeout' : 'interrupted'); }
      if (!response.ok || !response.body || !response.headers.get('content-type')?.toLowerCase().startsWith('audio/mpeg')) {
        void response.body?.cancel().catch(() => undefined); throw new SpeechError('unavailable');
      }
      const declared = response.headers.get('content-length');
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > speechLimits.ttsBytes)) {
        void response.body.cancel().catch(() => undefined); throw new SpeechError('limit');
      }
      reader = response.body.getReader();
      let bytes = 0;
      const stream = new ReadableStream<Uint8Array>({
        start(control) { output = control; },
        async pull(control) {
          try {
            const result = await reader!.read();
            if (ended) return;
            if (result.done) {
              if (!bytes) throw new SpeechError('invalid-provider-response');
              await release('completed'); control.close(); return;
            }
            bytes += result.value.byteLength;
            if (bytes > speechLimits.ttsBytes) throw new SpeechError('limit');
            control.enqueue(result.value);
          } catch (error) {
            if (!ended) cancel(error instanceof SpeechError ? error : new SpeechError('unavailable'), 'unknown');
            else control.error(new SpeechError('unavailable'));
          }
        },
        async cancel() { controller.abort(); void reader?.cancel().catch(() => undefined); await release('interrupted'); },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    } catch (error) {
      controller.abort();
      await release(controller.signal.aborted && signal?.aborted ? 'interrupted' : 'unknown');
      if (error instanceof SpeechError) throw error;
      throw new SpeechError(timeout ? 'timeout' : signal?.aborted ? 'interrupted' : 'unavailable');
    }
  };
}
