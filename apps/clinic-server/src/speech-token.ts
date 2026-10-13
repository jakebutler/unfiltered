import { z } from 'zod';
import { createSpeechAccess } from '../../../packages/clinic-api/src/speech-access.js';
import { AdmissionError } from '../../../packages/clinic-api/src/provider-admission.js';
import { ApiFailure } from '../../../packages/clinic-api/src/types.js';
import { SpeechError, speechTokenPath } from '../../../packages/speech/src/contracts.js';
import type { createSpeechGrant } from '../../../packages/speech/src/grant.js';

const safeMessage = 'Hands-free voice could not start. Your saved answers are unchanged. You can dictate or keep typing.';
const tokenScope = z.object({
  requestId: z.string().uuid(),
  sessionId: z.string().uuid(),
  promptId: z.string().min(1).max(300),
  expectedRevision: z.number().int().nonnegative(),
}).strict();
const budgetCodes = ['provider-busy', 'provider-session-busy', 'provider-budget-exhausted'];

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
function publicFailure(error: unknown): { code: string; status: number; retryable: boolean } {
  if (error instanceof ApiFailure) return { code: error.code, status: error.status, retryable: false };
  if (error instanceof AdmissionError) return budgetCodes.includes(error.code) ? { code: 'speech-budget', status: 429, retryable: false } : { code: 'speech-unavailable', status: 503, retryable: false };
  if (error instanceof SpeechError) {
    const status = error.code === 'invalid-request' ? 400 : error.code === 'limit' ? 413 : error.code === 'timeout' ? 504 : 503;
    return { code: error.code, status, retryable: error.code === 'unavailable' || error.code === 'timeout' };
  }
  return { code: 'speech-unavailable', status: 503, retryable: false };
}
function failure(error: unknown) {
  const { code, status, retryable } = publicFailure(error);
  return json({ error: { code, message: safeMessage, retryable } }, status);
}
/** Reads at most 2048 bytes within 5 seconds; an oversize or stalled body is never buffered. */
async function readJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader(); if (!reader) throw new ApiFailure('invalid-speech-request');
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => undefined); }, 5000);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 2048) throw new ApiFailure('request-too-large', 413); chunks.push(chunk.value); } }
  finally { clearTimeout(timer); void reader.cancel().catch(() => undefined); }
  if (timedOut || request.signal.aborted) throw new SpeechError('timeout');
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(all)); } catch { throw new ApiFailure('invalid-speech-request'); }
}

/** Hosted hands-free: mints one short-lived Deepgram token per utterance after the same authorization as capture. */
export function createSpeechTokenHandler(options: { access: ReturnType<typeof createSpeechAccess>; grant: ReturnType<typeof createSpeechGrant> }) {
  return {
    async handle(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url);
      if (url.pathname !== speechTokenPath) return undefined;
      try {
        if (request.method !== 'POST') throw new ApiFailure('method-not-allowed', 405);
        if (url.search) throw new ApiFailure('invalid-speech-request');
        if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new ApiFailure('json-required', 415);
        // Cookie and origin are checked before the body is read, as in the output route; scope is checked after parsing.
        await options.access.authenticate(request);
        const parsed = tokenScope.safeParse(await readJson(request));
        if (!parsed.success) throw new ApiFailure('invalid-speech-request');
        const { sessionId, promptId, expectedRevision, requestId } = parsed.data;
        // Authorization runs first; a refused scope never reaches the provider grant.
        await options.access.token(request, { sessionId, promptId, expectedRevision, requestId });
        const minted = await options.grant({ sessionId, requestId }, request.signal);
        return json({ accessToken: minted.accessToken, expiresIn: minted.expiresIn }, 200);
      } catch (error) { return failure(error); }
    },
  };
}
