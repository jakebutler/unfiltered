import { z } from 'zod';
import { createSpeechAccess, speechTranscriptionPath } from '../../../packages/clinic-api/src/speech-access.js';
import { ApiFailure } from '../../../packages/clinic-api/src/types.js';
import { SpeechError } from '../../../packages/speech/src/contracts.js';
import { speechUploadMaxBytes, type createSpeechTranscription } from '../../../packages/speech/src/transcribe.js';

const safeMessage = 'Voice could not transcribe this recording. Your saved answers are unchanged. You can keep typing.';
const uploadScope = z.object({
  sessionId: z.string().uuid(),
  promptId: z.string().min(1).max(300),
  expectedRevision: z.string().regex(/^(0|[1-9]\d{0,8})$/).transform(Number),
  requestId: z.string().uuid(),
}).strict();

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
function publicFailure(error: unknown): { code: string; status: number } {
  if (error instanceof ApiFailure) return { code: error.code, status: error.status };
  if (error instanceof SpeechError) return { code: error.code, status: error.code === 'invalid-request' ? 400 : error.code === 'limit' ? 413 : error.code === 'timeout' ? 504 : 503 };
  return { code: 'speech-unavailable', status: 503 };
}
function failure(error: unknown) {
  const { code, status } = publicFailure(error);
  return json({ error: { code, message: safeMessage, retryable: false } }, status);
}
/** Reads at most `limit` bytes; the remainder of an oversize body is never buffered. */
async function readBounded(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > limit) { void reader.cancel().catch(() => undefined); throw new ApiFailure('request-too-large', 413); }
    chunks.push(next.value);
  }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  return all;
}

/** One-shot push-to-talk transcription. Owns only the transcription path; everything else falls through. */
export function createSpeechUploadHandler(options: { access: ReturnType<typeof createSpeechAccess>; transcribe: ReturnType<typeof createSpeechTranscription> }) {
  return {
    async handle(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url);
      if (url.pathname !== speechTranscriptionPath) return undefined;
      try {
        if (request.method !== 'POST') throw new ApiFailure('method-not-allowed', 405);
        const scope = uploadScope.safeParse(Object.fromEntries(url.searchParams));
        if (!scope.success) throw new ApiFailure('invalid-speech-request');
        const mediaType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
        if (mediaType !== 'application/octet-stream') throw new ApiFailure('unsupported-media-type', 415);
        // Refuse declared oversize bodies before any authorization or body read.
        const declared = request.headers.get('content-length');
        if (declared !== null && !/^\d+$/.test(declared)) throw new ApiFailure('invalid-speech-request');
        if (declared !== null && Number(declared) > speechUploadMaxBytes) throw new ApiFailure('request-too-large', 413);
        const { sessionId, promptId, expectedRevision, requestId } = scope.data;
        await options.access.capture(request, { sessionId, promptId, expectedRevision, requestId });
        const pcm = await readBounded(request, speechUploadMaxBytes);
        const { text } = await options.transcribe({ sessionId, requestId, pcm }, request.signal);
        return json({ text }, 200);
      } catch (error) { return failure(error); }
    },
  };
}
