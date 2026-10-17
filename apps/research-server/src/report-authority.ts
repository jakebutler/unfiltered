import type { StudyRuntimeFacts } from '../../../packages/research-core/src/readiness';
import { ConvexHttpClient } from 'convex/browser';
import type { FunctionArgs } from 'convex/server';
import { api } from '../../../convex/_generated/api';
import { signGateway } from '../../../packages/research-capture/src/proof';

type WithoutProof<T> = Omit<T, 'proof'>;
export function reportAuthority(deployment: string, secret: string, bearer: string | null, signal?: AbortSignal, readinessFacts?: () => StudyRuntimeFacts) {
  const origin = new URL(deployment).origin;
  const transport: typeof fetch = (input, init) => {
    if (new URL(input instanceof Request ? input.url : String(input)).origin !== origin) throw new Error('Authority target changed');
    return fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : []), ...(init?.signal ? [init.signal] : [])]) });
  };
  const client = new ConvexHttpClient(deployment, { logger: false, fetch: transport }); if (bearer) client.setAuth(bearer);
  const signed = async <T>(operation: string, args: T) => { const input = { ...args, ...(['admit', 'beginDispatch'].includes(operation) && readinessFacts ? { runtime: readinessFacts() } : {}) }; return { ...input, proof: await signGateway(secret, `research:${operation}`, input) }; };
  return {
    operator: () => client.query(api.research.me, {}),
    availableReservations: async (args: WithoutProof<FunctionArgs<typeof api.researchAnalysis.availableReservations>>) => client.query(api.researchAnalysis.availableReservations, await signed('availableReservations', args)),
    admit: async (args: WithoutProof<FunctionArgs<typeof api.researchAnalysis.admit>>) => client.mutation(api.researchAnalysis.admit, await signed('admit', args)),
    material: async (args: WithoutProof<FunctionArgs<typeof api.researchAnalysis.material>>) => client.query(api.researchAnalysis.material, await signed('material', args)),
    beginDispatch: async (args: WithoutProof<FunctionArgs<typeof api.researchAnalysis.beginDispatch>>) => client.mutation(api.researchAnalysis.beginDispatch, await signed('beginDispatch', args)),
    finish: async (args: WithoutProof<FunctionArgs<typeof api.researchAnalysis.finish>>) => client.mutation(api.researchAnalysis.finish, await signed('finish', args)),
    issueShare: async (args: WithoutProof<FunctionArgs<typeof api.researchPortal.issueShare>>) => client.mutation(api.researchPortal.issueShare, await signed('issueShare', args)),
    beginUnlock: async (args: WithoutProof<FunctionArgs<typeof api.researchPortal.beginUnlock>>) => client.mutation(api.researchPortal.beginUnlock, await signed('beginUnlock', args)),
    finishUnlock: async (args: WithoutProof<FunctionArgs<typeof api.researchPortal.finishUnlock>>) => client.mutation(api.researchPortal.finishUnlock, await signed('finishUnlock', args)),
    published: async (args: WithoutProof<FunctionArgs<typeof api.researchPortal.readPublished>>) => client.query(api.researchPortal.readPublished, await signed('readPublished', args)),
    source: async (args: WithoutProof<FunctionArgs<typeof api.researchPortal.sharedSource>>) => client.query(api.researchPortal.sharedSource, await signed('sharedSource', args)),
    logout: async (args: WithoutProof<FunctionArgs<typeof api.researchPortal.logout>>) => client.mutation(api.researchPortal.logout, await signed('logout', args)),
  };
}
export type ReportAuthority = ReturnType<typeof reportAuthority>;
