/** Server-only: never export from the browser entrypoint. One admitted, bounded Deepgram REST transcription. */
import { z } from 'zod';
import { SpeechError, speechLimits } from './contracts.js';
import type { SpeechAdmission, SpeechFetch, SpeechOutcome } from './server.js';

/** Pinned model and raw PCM format. Raw bytes are described by the URL query, not by a container header. */
export const deepgramTranscribeUrl = 'https://api.deepgram.com/v1/listen?model=nova-3-medical&language=en-US&encoding=linear16&sample_rate=16000&channels=1&punctuate=true&smart_format=true';
/** 60 seconds of 16 kHz mono signed 16-bit PCM. */
export const speechUploadMaxBytes = 1_920_000;
const bytesPerAudioSecond = 32_000;
const requestIdPattern = /^[a-zA-Z0-9-]{1,100}$/;
const deepgramResponse = z.object({ results: z.object({ channels: z.array(z.object({ alternatives: z.array(z.object({ transcript: z.string().optional() }).passthrough()).optional() }).passthrough()).optional() }).passthrough().optional() }).passthrough();

export interface SpeechTranscriptionOptions {
  deepgramApiKey: string;
  /** Must atomically charge the full audio bound before any provider request. */
  admission: SpeechAdmission;
  fetcher?: SpeechFetch;
  /** Capped at speechLimits.providerTimeoutMs so the admitted lease outlives the attempt. */
  timeoutMs?: number;
}
export interface SpeechTranscriptionInput { sessionId: string; requestId: string; pcm: Uint8Array<ArrayBuffer>; }

/** Reserve first, then one POST with no retry or fallback. Provider bodies never appear in errors. */
export function createSpeechTranscription(options: SpeechTranscriptionOptions) {
  if (!options.deepgramApiKey) throw new SpeechError('unavailable');
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = Math.min(options.timeoutMs ?? speechLimits.providerTimeoutMs, speechLimits.providerTimeoutMs);
  return async (input: SpeechTranscriptionInput, signal?: AbortSignal): Promise<{ text: string }> => {
    if (!input || typeof input.requestId !== 'string' || !requestIdPattern.test(input.requestId)
        || typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 100
        || !(input.pcm instanceof Uint8Array) || input.pcm.byteLength === 0 || input.pcm.byteLength % 2 !== 0) throw new SpeechError('invalid-request');
    if (input.pcm.byteLength > speechUploadMaxBytes) throw new SpeechError('limit');
    if (signal?.aborted) throw new SpeechError('interrupted');
    const { sessionId, requestId, pcm } = input;
    const lease = await options.admission.reserve({ sessionId, requestId, provider: 'deepgram', maxCharacters: 0, maxAudioSeconds: Math.ceil(pcm.byteLength / bytesPerAudioSecond) });
    let settled = false;
    // Exactly one settlement per admitted attempt. Bookkeeping failures never change the caller's result.
    const settle = (outcome: SpeechOutcome) => {
      if (settled) return;
      settled = true;
      try { void Promise.resolve(lease.settle(outcome)).catch(() => undefined); }
      catch { /* The full audio bound remains charged. */ }
    };
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const interrupted = () => controller.abort();
    signal?.addEventListener('abort', interrupted, { once: true });
    let outcome: SpeechOutcome = 'unknown';
    try {
      const response = await fetcher(deepgramTranscribeUrl, {
        method: 'POST',
        // application/octet-stream: the URL declares encoding=linear16 at 16 kHz mono, so no container header is needed.
        headers: { Authorization: `Token ${options.deepgramApiKey}`, 'Content-Type': 'application/octet-stream', Accept: 'application/json' },
        body: pcm, signal: controller.signal, redirect: 'error',
      });
      if (!response.ok) { outcome = 'failed'; void response.body?.cancel().catch(() => undefined); throw new SpeechError('unavailable'); }
      const text = await transcriptText(response);
      settle('completed');
      return { text };
    } catch (error) {
      if (controller.signal.aborted) {
        outcome = timedOut ? 'unknown' : 'interrupted';
        settle(outcome);
        throw new SpeechError(timedOut ? 'timeout' : 'interrupted');
      }
      settle(outcome);
      throw error instanceof SpeechError ? error : new SpeechError('unavailable');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', interrupted);
    }
  };
}

/** Bounded read of the provider body; anything oversized, malformed or off-contract is invalid and is never echoed. */
async function transcriptText(response: Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > speechLimits.providerMessageBytes)) {
    void response.body?.cancel().catch(() => undefined);
    throw new SpeechError('invalid-provider-response');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new SpeechError('invalid-provider-response');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > speechLimits.providerMessageBytes) { void reader.cancel().catch(() => undefined); throw new SpeechError('invalid-provider-response'); }
    chunks.push(next.value);
  }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  let json: unknown;
  try { json = JSON.parse(new TextDecoder().decode(all)); } catch { throw new SpeechError('invalid-provider-response'); }
  const parsed = deepgramResponse.safeParse(json);
  if (!parsed.success) throw new SpeechError('invalid-provider-response');
  const transcript = parsed.data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
  if (transcript.length > speechLimits.transcriptCharacters) throw new SpeechError('invalid-provider-response');
  return transcript.trim();
}
