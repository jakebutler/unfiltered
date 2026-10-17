import { createSpeechAccess, speechOutputPath, speechOutputSchema } from '../../../packages/clinic-api/src/speech-access.js';
import { ApiFailure } from '../../../packages/clinic-api/src/types.js';
import { SpeechError } from '../../../packages/speech/src/contracts.js';
import { createSpeechOutput, type SpeechAdmission, type SpeechFetch } from '../../../packages/speech/src/server.js';

const safeMessage = 'Voice could not continue. Your saved answers are unchanged. You can keep typing.';
function publicFailure(error: unknown) {
  if (error instanceof ApiFailure) return { code: error.code, status: error.status };
  return { code: error instanceof SpeechError ? error.code : 'speech-unavailable', status: 503 };
}
function failure(error: unknown) {
  const { code, status } = publicFailure(error);
  return new Response(JSON.stringify({ error: { code, message: safeMessage, retryable: false } }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export interface SpeechOutputHandlerOptions {
  access: ReturnType<typeof createSpeechAccess>;
  admission: SpeechAdmission;
  elevenlabsApiKey: string;
  fetcher?: SpeechFetch;
}

/** Read-aloud over plain POST, so hosted deployments without WebSocket upgrades can still speak. Owns only the output path. */
export function createSpeechOutputHandler(options: SpeechOutputHandlerOptions) {
  return {
    async handle(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url);
      if (url.pathname !== speechOutputPath) return undefined;
      try {
        if (request.method !== 'POST' || url.search) throw new ApiFailure('method-not-allowed', 405);
        await options.access.authenticate(request);
        if (!request.headers.get('content-type')?.startsWith('application/json')) throw new ApiFailure('json-required', 415);
        const reader = request.body?.getReader(); if (!reader) throw new ApiFailure('invalid-speech-request');
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => undefined); }, 5000);
        let body = '', bytes = 0;
        try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 2048) throw new ApiFailure('request-too-large', 413); body += new TextDecoder().decode(chunk.value); } }
        finally { clearTimeout(timer); void reader.cancel().catch(() => undefined); }
        if (timedOut || request.signal.aborted) throw new SpeechError('timeout');
        let input: unknown; try { input = JSON.parse(body); } catch { throw new ApiFailure('invalid-speech-request'); }
        const parsed = speechOutputSchema.safeParse(input); if (!parsed.success) throw new ApiFailure('invalid-speech-request');
        return await createSpeechOutput({ elevenlabsApiKey: options.elevenlabsApiKey, admission: options.admission, authorize: value => options.access.output(request, value), fetcher: options.fetcher })(parsed.data, request.signal);
      } catch (error) { return failure(error); }
    },
  };
}
