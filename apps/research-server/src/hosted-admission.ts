import { ConvexHttpClient } from 'convex/browser';
import { randomBytes } from 'node:crypto';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import { signGateway } from '../../../packages/research-capture/src/proof';
export type LeaseKind = 'operation' | 'upload' | 'read' | 'password' | 'analysis' | 'voice' | 'cleanup';
export type LeaseIdentity = { leaseId: Id<'researchGatewaySlots'>; requestId: string; owner: string; generation: number };
export type HostedLease = LeaseIdentity & { kind: LeaseKind; expiresAt: number; bodyDeadlineAt: number; responseDeadlineAt: number; allocationId?: string };
export type QuotaOperation = 'authority' | 'head' | 'read' | 'put' | 'retire';
export type CleanupClaim = { mediaId: Id<'researchMedia'>; attempt: number; key: string; owner: string; generation: number; expiresAt: number; operations: 4 };
export interface HostedAuthority {
  acquire(input: { kind: LeaseKind; requestId: string; owner: string }): Promise<HostedLease | null>;
  inspect(input: LeaseIdentity): Promise<HostedLease | null>;
  beginWork(input: LeaseIdentity): Promise<boolean>;
  release(input: LeaseIdentity): Promise<boolean>;
  claimCleanup(input: LeaseIdentity): Promise<CleanupClaim[]>;
  finishCleanup(input: LeaseIdentity & { claim: CleanupClaim; retired: boolean }): Promise<boolean>;
  reserveOperation?(input: LeaseIdentity & { ordinal: number; kind: QuotaOperation; readBytes: number }): Promise<boolean>;
}
export const leaseIdentity = (lease: HostedLease): LeaseIdentity => ({ leaseId: lease.leaseId, requestId: lease.requestId, owner: lease.owner, generation: lease.generation });
export const newLeaseOwner = () => ({ requestId: randomBytes(16).toString('hex'), owner: randomBytes(16).toString('hex') });
/** Explicit gateway secret only; each signed native call is single dispatch. */
export function convexHostedAuthority(deployment: string, secret: string, allocationId?: string): HostedAuthority {
  if (allocationId !== undefined && !/^[a-zA-Z0-9_-]{8,128}$/.test(allocationId)) throw new Error('Invalid explicit quota allocation');
  const origin = new URL(deployment).origin;
  const client = new ConvexHttpClient(deployment, { logger: false, fetch: (input, init) => {
    if (new URL(input instanceof Request ? input.url : String(input)).origin !== origin) throw new Error('Authority target changed');
    return fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  } });
  const proof = (operation: string, input: unknown) => signGateway(secret, operation, input);
  return {
    async acquire(input) {
      if (allocationId) { const allocated = { ...input, allocationId }; return client.mutation(api.researchGatewayLeases.acquireAllocated, { ...allocated, proof: await proof('lease-acquire-allocated', allocated) }); }
      return client.mutation(api.researchGatewayLeases.acquire, { ...input, proof: await proof('lease-acquire', input) });
    },
    async inspect(input) { return client.query(api.researchGatewayLeases.inspect, { ...input, proof: await proof('lease-inspect', input) }); },
    async beginWork(input) { return client.mutation(api.researchGatewayLeases.beginWork, { ...input, proof: await proof('lease-begin', input) }); },
    async release(input) { return client.mutation(api.researchGatewayLeases.release, { ...input, proof: await proof('lease-release', input) }); },
    async claimCleanup(input) { return client.mutation(api.captureGateway.claimCleanup, { ...input, proof: await proof('cleanup-claim', input) }); },
    async finishCleanup(input) { return client.mutation(api.captureGateway.finishCleanup, { ...input, proof: await proof('cleanup-finish', input) }); },
    ...(allocationId ? { async reserveOperation(input: LeaseIdentity & { ordinal: number; kind: QuotaOperation; readBytes: number }) { return client.mutation(api.researchGatewayLeases.reserveOperation, { ...input, proof: await proof('lease-reserve-operation', input) }); } } : {}),
  };
}
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Hosted deadline ended'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Hosted deadline ended')); signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => undefined);
  });
}
