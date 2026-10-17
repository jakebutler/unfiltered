import type { StudyRuntimeFacts } from '../../research-core/src/readiness';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import { signGateway } from './proof';
import type { CaptureAuthority } from './gateway';

/** Server-only: never bundle the gateway HMAC secret or this factory into the app. */
export function convexCaptureAuthority(deployment: string, secret: string, options: { readinessFacts?: () => StudyRuntimeFacts; signal?: AbortSignal; timeoutMs?: number } = {}): CaptureAuthority {
  if (secret.length < 32) throw new Error('Media gateway is not configured');
  const timeoutMs = options.timeoutMs ?? 10_000, origin = new URL(deployment).origin;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new Error('Invalid authority timeout');
  const transport: typeof fetch = (input, init) => {
    if (new URL(input instanceof Request ? input.url : String(input)).origin !== origin) throw new Error('Authority target changed');
    const signals = [AbortSignal.timeout(timeoutMs), options.signal, init?.signal].filter((signal): signal is AbortSignal => !!signal);
    // Each operation is dispatched once. A timeout preserves its unknown outcome;
    // callers must reconcile persisted state rather than replaying a mutation.
    return fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any(signals) });
  };
  const client = () => new ConvexHttpClient(deployment, { logger: false, fetch: transport });
  return {
    async claim(token, id, attempt) { const input = { token, mediaId: id as Id<'researchMedia'>, attempt, ...(options.readinessFacts ? { runtime: options.readinessFacts() } : {}) }; return client().mutation(api.captureGateway.claim, { ...input, proof: await signGateway(secret, 'claim', input) }); },
    async inspect(token, id) { const input = { token, mediaId: id as Id<'researchMedia'> }; return client().query(api.captureGateway.inspect, { ...input, proof: await signGateway(secret, 'inspect', input) }); },
    async beginRetry(token, id, attempt) { const input = { token, mediaId: id as Id<'researchMedia'>, attempt }; return client().mutation(api.captureGateway.beginRetry, { ...input, proof: await signGateway(secret, 'beginRetry', input) }); },
    async activateRetry(token, id, attempt, retiredKey) { const input = { token, mediaId: id as Id<'researchMedia'>, attempt, retiredKey }; return client().mutation(api.captureGateway.activateRetry, { ...input, proof: await signGateway(secret, 'activateRetry', input) }); },
    async finalize(id, attempt, stored) { const input = { mediaId: id as Id<'researchMedia'>, attempt, ...stored }; return client().mutation(api.captureGateway.finalize, { ...input, proof: await signGateway(secret, 'finalize', input) }); },
    async read(bearer, scope) {
      const input = { mediaId: scope.id as Id<'researchMedia'>, clientId: scope.clientId as Id<'researchClients'>, projectId: scope.projectId as Id<'researchProjects'>, sessionId: scope.sessionId as Id<'researchSessions'> }, connection = client();
      connection.setAuth(bearer);
      return connection.query(api.captureGateway.read, { ...input, proof: await signGateway(secret, 'read', input) });
    },
    async cleanup() { return client().query(api.captureGateway.cleanup, { proof: await signGateway(secret, 'cleanup', {}) }); },
    async deleted(id, attempt) { const input = { mediaId: id as Id<'researchMedia'>, attempt }; await client().mutation(api.captureGateway.deleted, { ...input, proof: await signGateway(secret, 'deleted', input) }); },
  };
}
