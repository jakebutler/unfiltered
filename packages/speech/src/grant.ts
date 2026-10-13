/** Server-only: never export from the browser entrypoint. One admitted, bounded Deepgram short-lived token grant. */
import { z } from 'zod';
import { SpeechError, directCaptureMs, speechTokenTtlSeconds } from './contracts.js';
import type { SpeechAdmission, SpeechFetch, SpeechOutcome } from './server.js';

/** Exchanges the server-held key for a temporary token only; the browser never receives this key. */
export const deepgramGrantUrl = 'https://api.deepgram.com/v1/auth/grant';
const requestIdPattern = /^[a-zA-Z0-9-]{1,100}$/;
const grantMaxBytes = 16_000;
const grantTimeoutCapMs = 10_000;
const grantResponse = z.object({
  access_token: z.string().min(20).max(4096).regex(/^[A-Za-z0-9._-]+$/),
  expires_in: z.number().int().positive().max(3600),
}).passthrough();

export interface SpeechGrantOptions {
  deepgramApiKey: string;
  /** Must atomically charge the full stream bound before any provider request. */
  admission: SpeechAdmission;
  fetcher?: SpeechFetch;
  /** Capped at grantTimeoutCapMs so a stalled grant cannot hold the admitted lease for long. */
  timeoutMs?: number;
}
export interface SpeechGrantInput { sessionId: string; requestId: string; }

/** Reserve first, then one POST with no retry or fallback. Provider bodies never appear in errors. */
export function createSpeechGrant(options: SpeechGrantOptions) {
  if (!options.deepgramApiKey) throw new SpeechError('unavailable');
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = Math.min(options.timeoutMs ?? grantTimeoutCapMs, grantTimeoutCapMs);
  /** `recheck` runs after admission, before the provider call: authorization can change while admission waits. */
  return async (input: SpeechGrantInput, signal?: AbortSignal, recheck?: () => Promise<unknown>): Promise<{ accessToken: string; expiresIn: number }> => {
    if (!input || typeof input.requestId !== 'string' || !requestIdPattern.test(input.requestId)
        || typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 100) throw new SpeechError('invalid-request');
    if (signal?.aborted) throw new SpeechError('interrupted');
    const { sessionId, requestId } = input;
    // The token can open a stream of up to directCaptureMs, so admission charges that whole bound per grant.
    const lease = await options.admission.reserve({ sessionId, requestId, provider: 'deepgram', maxCharacters: 0, maxAudioSeconds: Math.ceil(directCaptureMs / 1000) });
    let settled = false;
    // Exactly one settlement per admitted attempt. Bookkeeping failures never change the caller's result.
    const settle = (outcome: SpeechOutcome) => {
      if (settled) return;
      settled = true;
      try { void Promise.resolve(lease.settle(outcome)).catch(() => undefined); }
      catch { /* The full stream bound remains charged. */ }
    };
    // A cancel that landed while admission was pending never reaches the provider.
    if (signal?.aborted) { settle('interrupted'); throw new SpeechError('interrupted'); }
    try { await recheck?.(); } catch (error) { settle('failed'); throw error; }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const interrupted = () => controller.abort();
    signal?.addEventListener('abort', interrupted, { once: true });
    if (signal?.aborted) controller.abort();
    let outcome: SpeechOutcome = 'unknown';
    try {
      const response = await fetcher(deepgramGrantUrl, {
        method: 'POST',
        headers: { Authorization: `Token ${options.deepgramApiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ttl_seconds: speechTokenTtlSeconds }), signal: controller.signal, redirect: 'error',
      });
      if (!response.ok) { outcome = 'failed'; void response.body?.cancel().catch(() => undefined); throw new SpeechError('unavailable'); }
      const grant = await grantBody(response);
      settle('completed');
      // The admitted stream bound stays charged; a shorter provider lifetime only narrows what the browser may use.
      return { accessToken: grant.access_token, expiresIn: Math.min(grant.expires_in, speechTokenTtlSeconds) };
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

/** Bounded read of the provider grant; anything oversized, malformed or off-contract is invalid and is never echoed. */
async function grantBody(response: Response): Promise<z.infer<typeof grantResponse>> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > grantMaxBytes)) {
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
    if (bytes > grantMaxBytes) { void reader.cancel().catch(() => undefined); throw new SpeechError('invalid-provider-response'); }
    chunks.push(next.value);
  }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  let json: unknown;
  try { json = JSON.parse(new TextDecoder().decode(all)); } catch { throw new SpeechError('invalid-provider-response'); }
  const parsed = grantResponse.safeParse(json);
  if (!parsed.success) throw new SpeechError('invalid-provider-response');
  return parsed.data;
}
