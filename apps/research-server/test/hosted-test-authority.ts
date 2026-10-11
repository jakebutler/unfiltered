import { vi } from 'vitest';
import type { HostedAuthority, HostedLease, LeaseIdentity } from '../src/hosted-admission';
/** Offline authority seam. Native admission semantics are tested independently
 * with convex-test, not inferred from this test fixture. */
export function fakeHostedAuthority(duration = 30_000) {
  const leases = new Map<string, HostedLease>(), started = new Set<string>(); let generation = 0;
  const matches = (identity: LeaseIdentity) => { const row = leases.get(identity.leaseId); return row && row.owner === identity.owner && row.requestId === identity.requestId && row.generation === identity.generation ? row : null; };
  const authority: HostedAuthority = {
    acquire: vi.fn(async args => { if (leases.size >= 4 || ['upload', 'password', 'analysis', 'cleanup'].includes(args.kind) && [...leases.values()].some(r => r.kind === args.kind)) return null;
      const id = `lease${++generation}` as HostedLease['leaseId'], row = { ...args, leaseId: id, generation, expiresAt: Date.now() + duration + 45_000, bodyDeadlineAt: Date.now() + Math.min(duration, 8_000), responseDeadlineAt: Date.now() + duration }; leases.set(id, row); return row; }),
    inspect: vi.fn(async args => { const row = matches(args); return row && row.expiresAt > Date.now() ? row : null; }),
    beginWork: vi.fn(async args => { if (!matches(args) || started.has(args.leaseId)) return false; started.add(args.leaseId); return true; }),
    release: vi.fn(async args => { if (!matches(args)) return false; leases.delete(args.leaseId); started.delete(args.leaseId); return true; }),
    claimCleanup: vi.fn(async () => []), finishCleanup: vi.fn(async () => false),
  };
  return Object.assign(authority, { leases, started });
}
