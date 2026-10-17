import { convexHostedAuthority, leaseIdentity, newLeaseOwner, type HostedAuthority } from './hosted-admission.js';
import type { ResearchSpeechOptions } from './research-speech.js';

/** No unallocated hosted fallback. Allocation and native ownership are established
 * before any socket upgrade/provider/body/authority work starts. */
export function createAllocatedResearchSpeechIngress(config: { deployment: string; gatewaySecret: string; allocationId: string }, injected?: HostedAuthority): NonNullable<ResearchSpeechOptions['ingress']> {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(config.allocationId)) throw new Error('Explicit speech native allocation required');
  const native = injected ?? convexHostedAuthority(config.deployment, config.gatewaySecret, config.allocationId);
  if (!native.reserveOperation) throw new Error('Allocated speech operation guard required');
  return { async reserve(requestId, kind) {
    const owner = newLeaseOwner().owner;
    const lease = await native.acquire({ kind, requestId, owner });
    if (!lease || lease.allocationId !== config.allocationId || lease.kind !== kind) throw new Error('Speech native allocation unavailable');
    const identity = leaseIdentity(lease);
    // An unknown begin acknowledgement retains ownership; never release/retry it.
    if (!await native.beginWork(identity)) throw new Error('Speech native work ownership unavailable');
    let ordinal = 0, sealed = false, reservationTail = Promise.resolve();
    return {
      expiresAt: lease.responseDeadlineAt,
      transportLease: identity,
      async authority<T>(dispatch: () => Promise<T>): Promise<T> {
        // Serialize native inspection/reservation ACKs, so simultaneous audio
        // checks/save/settlement cannot submit ordinal 2 before ordinal 1 commits.
        // Actual dispatched authority operations may still complete independently.
        const admitted = reservationTail.then(async () => {
          if (sealed || Date.now() >= lease.responseDeadlineAt) throw new Error('Speech native lease ended');
          const current = await native.inspect(identity);
          if (sealed || Date.now() >= lease.responseDeadlineAt) throw new Error('Speech native lease ended');
          if (!current || current.kind !== kind || current.allocationId !== config.allocationId || current.expiresAt !== lease.expiresAt) { sealed = true; throw new Error('Speech native lease changed'); }
          const operation = ++ordinal;
          try { if (!await native.reserveOperation!({ ...identity, ordinal: operation, kind: 'authority', readBytes: 0 })) throw new Error('Speech native operation allowance exhausted'); }
          catch (error) { sealed = true; throw error; }
          if (sealed || Date.now() >= lease.responseDeadlineAt) throw new Error('Speech native lease ended');
        });
        reservationTail = admitted.catch(() => undefined);
        await admitted;
        if (sealed || Date.now() >= lease.responseDeadlineAt) throw new Error('Speech native lease ended');
        return dispatch();
      },
      async release() { sealed = true; if (!await native.release(identity)) throw new Error('Speech native settlement unknown'); },
    };
  } };
}
