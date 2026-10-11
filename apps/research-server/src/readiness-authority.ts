import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { signGateway } from '../../../packages/research-capture/src/proof';
import type { StudyReadinessCommand, StudyReadinessReceipt, StudyReadinessReceiptReadback, StudyReadinessScope, StudyReadinessSnapshot, StudyRuntimeFacts } from '../../../packages/research-core/src/readiness';
import type { Selection } from '../../../packages/research-core/src/analysis';
import type { AnalysisReservation } from './analysis';
export type ReadinessAnalysisInput = { scope: StudyReadinessScope; requestId: string; selections: Selection[] };
export interface ReadinessAuthority {
  snapshot(scope: StudyReadinessScope, runtime: StudyRuntimeFacts): Promise<StudyReadinessSnapshot>;
  command(command: StudyReadinessCommand, runtime: StudyRuntimeFacts): Promise<StudyReadinessReceipt>;
  receipt(command: StudyReadinessCommand, runtime: StudyRuntimeFacts): Promise<StudyReadinessReceiptReadback>;
  prepareAnalysis(input: ReadinessAnalysisInput, runtime: StudyRuntimeFacts): Promise<AnalysisReservation>;
  readPreparedAnalysis(input: ReadinessAnalysisInput): Promise<AnalysisReservation>;
}
/** Each mutation is dispatched once. Receipt reads are separate and never redispatch. */
export function boundedReadinessClient(deployment: string, bearer: string, signal: AbortSignal): ConvexHttpClient {
  const origin = new URL(deployment).origin;
  const transport: typeof fetch = (input, init) => {
    if (new URL(input instanceof Request ? input.url : String(input)).origin !== origin) throw new Error('Readiness authority target changed');
    return (async () => {
      const response = await fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000), ...(init?.signal ? [init.signal] : [])]) });
      if (!response.body) return response;
      const maximum = 131_072, declared = response.headers.get('Content-Length');
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) { void response.body.cancel().catch(() => undefined); throw new Error('Readiness authority response exceeds bound'); }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > maximum) throw new Error('Readiness authority response exceeds bound'); chunks.push(next.value); } }
      finally { void reader.cancel().catch(() => undefined); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
    })();
  };
  const client = new ConvexHttpClient(deployment, { logger: false, fetch: transport }); client.setAuth(bearer); return client;
}
export function readinessAuthority(deployment: string, secret: string, bearer: string, signal: AbortSignal): ReadinessAuthority {
  const client = boundedReadinessClient(deployment, bearer, signal);
  const read = async <T>(module: string, name: string, input: Record<string, unknown>) => client.query(makeFunctionReference<'query'>(`${module}:${name}`), { ...input, proof: await signGateway(secret, `readiness:${name === 'readPrepared' ? 'readPreparedAnalysis' : name}`, input) }) as Promise<T>;
  const write = async <T>(module: string, name: string, input: Record<string, unknown>) => client.mutation(makeFunctionReference<'mutation'>(`${module}:${name}`), { ...input, proof: await signGateway(secret, `readiness:${name === 'prepare' ? 'prepareAnalysis' : name}`, input) }) as Promise<T>;
  return {
    snapshot: (scope, runtime) => read('researchReadiness', 'snapshot', { scope, runtime }),
    command: (command, runtime) => write('researchReadiness', 'command', { command, runtime }),
    receipt: (command, runtime) => read('researchReadiness', 'receipt', { command, runtime }),
    prepareAnalysis: (input, runtime) => write('researchStudyAnalysis', 'prepare', { ...input, runtime }),
    readPreparedAnalysis: input => read('researchStudyAnalysis', 'readPrepared', input),
  };
}
