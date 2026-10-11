import type { PrivateObjectStore } from '../../../packages/research-capture/src/contracts';
import { verifyGateway } from '../../../packages/research-capture/src/proof';
import { abortable, leaseIdentity, type HostedAuthority, type HostedLease } from './hosted-admission';
/** Used only by the fixed signed scheduled endpoint, never the local timer. */
export async function validateCleanupRequest(request: Request, secret: string, authority: HostedAuthority): Promise<HostedLease> {
  const input = await request.json();
  if (!input || Object.keys(input).sort().join(',') !== 'generation,leaseId,owner,requestId' || typeof input.leaseId !== 'string' || !/^[a-f0-9]{32}$/.test(input.owner) || !/^[a-f0-9]{32}$/.test(input.requestId) || !Number.isSafeInteger(input.generation) || input.generation < 1) throw new Error('Cleanup unavailable');
  await verifyGateway(secret, 'cleanup-tick', input, { at: Number(request.headers.get('X-Research-Cleanup-At')), signature: request.headers.get('X-Research-Cleanup-Proof') ?? '' });
  const lease = await authority.inspect(input); if (!lease || lease.kind !== 'cleanup') throw new Error('Cleanup unavailable'); return lease;
}
export async function runHostedCleanup(store: PrivateObjectStore, authority: HostedAuthority, lease: HostedLease, signal: AbortSignal) {
  const identity = leaseIdentity(lease), claims = await abortable(authority.claimCleanup(identity), signal);
  if (claims.length > 10) throw new Error('Cleanup batch exceeds envelope');
  let retired = 0;
  for (const claim of claims) {
    if (signal.aborted || claim.owner !== lease.owner || claim.expiresAt > lease.expiresAt || claim.expiresAt <= Date.now() || claim.operations !== 4) break;
    let verified = false;
    try {
      if (!await abortable(authority.inspect(identity), signal)) throw new Error('Cleanup lease ended');
      await abortable(store.retire(claim.key), signal); // Exact tombstone HEAD is part of store.retire.
      if (await abortable(store.head(claim.key), signal) !== null) throw new Error('Retirement remains unresolved');
      verified = true;
    } catch { /* Unknown is never completion. No upload or retirement retry here. */ }
    if (!signal.aborted && await abortable(authority.finishCleanup({ ...identity, claim, retired: verified }), signal)) retired++;
  }
  return { claimed: claims.length, retired };
}
