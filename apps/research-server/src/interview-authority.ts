import type { StudyRuntimeFacts } from '../../../packages/research-core/src/readiness';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference, type DefaultFunctionArgs } from 'convex/server';
import { signGateway } from '../../../packages/research-capture/src/proof';
import type { InterviewAuthority } from './interview';
/** Capability stays runtime-only. Signed operations use exact pinned deployment and no automatic retry. */
export function convexInterviewAuthority(deployment: string, secret: string, token: string, signal?: AbortSignal, readinessFacts?: () => StudyRuntimeFacts): InterviewAuthority {
  const origin = new URL(deployment).origin;
  const client = new ConvexHttpClient(deployment, { logger: false, fetch: (input, init) => {
    if (new URL(input instanceof Request ? input.url : String(input)).origin !== origin) throw new Error('Interview authority target changed');
    return fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : []), ...(init?.signal ? [init.signal] : [])]) });
  } });
  const call = async <T>(name: string, input: DefaultFunctionArgs, read = false): Promise<T> => {
    const value = { token, ...input, ...(['admit', 'begin'].includes(name) && readinessFacts ? { runtime: readinessFacts() } : {}) }, args = { ...value, proof: await signGateway(secret, `interview:${name}`, value) };
    return read ? client.query(makeFunctionReference<'query', DefaultFunctionArgs, T>(`researchInterview:${name}`), args) : client.mutation(makeFunctionReference<'mutation', DefaultFunctionArgs, T>(`researchInterview:${name}`), args);
  };
  return { inspect: scope => call('inspect', { scope }, true), admit: (scope, contextHash) => call('admit', { scope, contextHash }), begin: (scope, attemptId, contextHash, prepared) => call('begin', { scope, attemptId, contextHash, prepared }), finish: (scope, attemptId, contextHash, result) => call('finish', { scope, attemptId, contextHash, result }), advance: (scope, contextHash, decision) => call('advance', { scope, contextHash, decision }) };
}
