import { z } from 'zod';
import { PRIVATE_HEADERS } from '../../../packages/research-capture/src/protected-read';
import { runInterviewTurn, type InterviewAuthority, type InterviewRuntime } from './interview';
import { convexInterviewAuthority } from './interview-authority';
const id = z.string().min(1).max(160);
const scope = z.object({ sessionId: id, promptId: id, expectedRevision: z.number().int().nonnegative(), answerSourceId: id, requestId: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/) }).strict();
/** Mounted only by explicit composition. Runtime provider is never inherited from env. */
export function researchInterviewGateway(config: { deployment: string; gatewaySecret: string; publicOrigin: string }, runtime: InterviewRuntime = {}, factory: (token: string, signal: AbortSignal) => InterviewAuthority = (token, signal) => convexInterviewAuthority(config.deployment, config.gatewaySecret, token, signal)) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url); if (url.pathname !== '/api/research/interview') return undefined;
    if (request.method !== 'POST' || url.search || url.origin !== config.publicOrigin || request.headers.get('Origin') !== config.publicOrigin) return new Response('Access unavailable', { status: 403, headers: PRIVATE_HEADERS });
    const token = request.headers.get('X-Research-Participant'); if (!token || !/^[a-f0-9]{64}$/.test(token) || request.headers.get('Content-Type') !== 'application/json') return new Response('Access unavailable', { status: 403, headers: PRIVATE_HEADERS });
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 25000), signal = AbortSignal.any([request.signal, abort.signal]);
    const reader = request.body?.getReader(); let remove = () => {};
    try {
      if (!reader) throw new Error('Missing body');
      const stop = new Promise<never>((_, reject) => { const fail = () => reject(new Error('Deadline ended')); signal.addEventListener('abort', fail, { once: true }); remove = () => signal.removeEventListener('abort', fail); if (signal.aborted) fail(); }); void stop.catch(() => undefined);
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) { const next = await Promise.race([reader.read(), stop]); if (next.done) break; size += next.value.length; if (size > 4096) throw new Error('Body exceeds bound'); chunks.push(next.value); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const input = scope.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      return Response.json(await runInterviewTurn(factory(token, signal), runtime, input, signal), { headers: PRIVATE_HEADERS });
    } catch { return Response.json({ state: 'unknown', message: 'Check saved state or continue with the script; the model call will not be repeated.' }, { status: 409, headers: PRIVATE_HEADERS }); }
    finally { clearTimeout(timeout); remove(); void reader?.cancel().catch(() => undefined); }
  };
}
