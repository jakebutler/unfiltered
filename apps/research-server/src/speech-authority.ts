import type { StudyRuntimeFacts } from '../../../packages/research-core/src/readiness.js';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference, type DefaultFunctionArgs } from 'convex/server';
import { signGateway } from '../../../packages/research-capture/src/proof.js';
import type { ResearchSpeechAuthority, ResearchTranscriptReceipt } from '../../../packages/research-core/src/speech-contract.js';
import type { AuthorizedSpeechText } from '../../../packages/speech/src/server.js';

/** Server-only authenticated authority. Each mutation dispatches once; readback
 * is explicit and never reconnects STT, regenerates TTS or rewrites raw words. */
export function convexResearchSpeechAuthority(deployment: string, secret: string, options: { readinessFacts?: () => StudyRuntimeFacts; signal?: AbortSignal; timeoutMs?: number; beforeDispatch?: (operation: string) => Promise<void> } = {}): ResearchSpeechAuthority {
  if (secret.length < 32) throw new Error('Research speech gateway is not configured');
  const origin = new URL(deployment).origin, timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new Error('Invalid speech authority timeout');
  const transport: typeof fetch = (input, init) => {
    if (new URL(input instanceof Request ? input.url : String(input)).origin !== origin) throw new Error('Speech authority target changed');
    const signals = [AbortSignal.timeout(timeoutMs), options.signal, init?.signal].filter((signal): signal is AbortSignal => !!signal);
    return fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any(signals) });
  };
  const client = () => new ConvexHttpClient(deployment, { logger: false, fetch: transport });
  async function read<T>(name: string, input: DefaultFunctionArgs): Promise<T> {
    await options.beforeDispatch?.(name);
    if (['status', 'authorize', 'reserve'].includes(name) && options.readinessFacts) input = { ...input, runtime: options.readinessFacts() };
    const args = { ...input, proof: await signGateway(secret, `speech:${name}`, input) };
    return client().query(makeFunctionReference<'query', DefaultFunctionArgs, T>(`researchSpeech:${name}`), args);
  }
  async function write<T>(name: string, input: DefaultFunctionArgs): Promise<T> {
    await options.beforeDispatch?.(name);
    if (['status', 'authorize', 'reserve'].includes(name) && options.readinessFacts) input = { ...input, runtime: options.readinessFacts() };
    const args = { ...input, proof: await signGateway(secret, `speech:${name}`, input) };
    return client().mutation(makeFunctionReference<'mutation', DefaultFunctionArgs, T>(`researchSpeech:${name}`), args);
  }
  return {
    terminalBarrier: (token, scope, provider) => read('terminalBarrier', { token, scope, ...(provider ? { provider } : {}) }),
    commitSpoken: (token, scope) => write('commitSpoken', { token, scope }),
    status: token => read<{ enabled: boolean; continuous?: boolean; grantName?: string }>('status', { token }),
    authorize: async (token, scope, provider) => { await read<null>('authorize', { token, scope, provider }); },
    inspect: async (token, scope, provider) => { await read<null>('inspect', { token, scope, provider }); },
    reserve: async (token, scope, reservation) => {
      if (reservation.requestId !== scope.requestId || reservation.sessionId !== scope.sessionId) throw new Error('Speech reservation scope differs');
      await write<null>('reserve', { token, scope, provider: reservation.provider, maxAudioSeconds: reservation.maxAudioSeconds, maxCharacters: reservation.maxCharacters, ...(reservation.transportLease ? { transportLease: reservation.transportLease } : {}) });
      return { settle: async outcome => { await write<null>('settle', { sessionId: scope.sessionId, requestId: scope.requestId, provider: reservation.provider, outcome }); } };
    },
    transcript: (token, scope, text, outcome) => write<ResearchTranscriptReceipt>('saveTranscript', { token, scope, text, outcome }),
    receipt: (token, scope) => read<ResearchTranscriptReceipt | null>('readTranscript', { token, scope }),
    output: (token, input) => read<AuthorizedSpeechText>('output', { token, input }),
  };
}
