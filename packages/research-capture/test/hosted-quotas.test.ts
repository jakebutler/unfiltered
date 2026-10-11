import { convexTest } from 'convex-test';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import schema from '../../../convex/schema';
import { api, internal } from '../../../convex/_generated/api';
import { signGateway } from '../src/proof';
const modules = import.meta.glob('../../../convex/**/*.ts'), secret = 'offline-quota-root-secret'.repeat(3), allocationId = 'offline-prospective-demo';
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv('RESEARCH_MEDIA_GATEWAY_SECRET', secret); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
const nonce = (n: number) => n.toString(16).padStart(32, '0');
async function fixture(limits = { requestLimit: 10, readByteLimit: 1000, storageOperationLimit: 20 }) {
  const t = convexTest(schema, modules), config = { allocationId, expiresAt: Date.now() + 600_000, ...limits };
  await t.mutation(internal.researchGatewayLeases.provisionAllocation, config);
  const signed = async (operation: string, input: any) => ({ ...input, proof: await signGateway(secret, operation, input) });
  const acquire = (n: number) => { const input = { allocationId, kind: 'operation' as const, requestId: nonce(n), owner: nonce(n + 100) }; return signed('lease-acquire-allocated', input).then(args => t.mutation(api.researchGatewayLeases.acquireAllocated, args)); };
  const identity = (lease: NonNullable<Awaited<ReturnType<typeof acquire>>>) => ({ leaseId: lease.leaseId, requestId: lease.requestId, owner: lease.owner, generation: lease.generation });
  const begin = async (lease: Parameters<typeof identity>[0]) => t.mutation(api.researchGatewayLeases.beginWork, await signed('lease-begin', identity(lease)));
  const release = async (lease: Parameters<typeof identity>[0]) => t.mutation(api.researchGatewayLeases.release, await signed('lease-release', identity(lease)));
  const reserve = async (lease: Parameters<typeof identity>[0], ordinal: number, kind: 'read' | 'head' | 'put' | 'retire' | 'authority', readBytes = 0) => t.mutation(api.researchGatewayLeases.reserveOperation, await signed('lease-reserve-operation', { ...identity(lease), ordinal, kind, readBytes }));
  const allocation = () => t.run(ctx => ctx.db.query('researchGatewayAllocations').withIndex('by_allocationId', q => q.eq('allocationId', allocationId)).unique());
  return { t, config, acquire, begin, release, reserve, allocation, signed, identity };
}
it('fails missing/expired finite allocation and rejects public arbitrary ceilings or root reset', async () => {
  const f = await fixture();
  const input = { allocationId: 'missing-allocation', kind: 'read' as const, requestId: nonce(1), owner: nonce(100) };
  expect(await f.t.mutation(api.researchGatewayLeases.acquireAllocated, await f.signed('lease-acquire-allocated', input))).toBeNull();
  await expect(f.t.mutation(internal.researchGatewayLeases.provisionAllocation, f.config)).rejects.toThrow('immutable');
  await expect(f.t.mutation(api.researchGatewayLeases.acquireAllocated, { ...await f.signed('lease-acquire-allocated', input), requestLimit: 100000 } as any)).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(600_001); expect(await f.acquire(2)).toBeNull(); expect((await f.allocation())!.requestsConsumed).toBe(0);
});
it('hosted activation rejects legacy unallocated acquisition even with a valid signature', async () => {
  const f = await fixture(); vi.stubEnv('CONVEX_SITE_URL', 'https://elegant-crane-662.convex.site');
  const input = { kind: 'operation' as const, requestId: nonce(1), owner: nonce(101) };
  expect(await f.t.mutation(api.researchGatewayLeases.acquire, await f.signed('lease-acquire', input))).toBeNull();
  expect(await f.acquire(2)).not.toBeNull();
});
it('atomically consumes the last request across callers, with no refund after release or restart/expiry', async () => {
  const f = await fixture({ requestLimit: 1, readByteLimit: 100, storageOperationLimit: 10 });
  const raced = await Promise.all([f.acquire(1), f.acquire(2)]); expect(raced.filter(Boolean)).toHaveLength(1); const lease = raced.find(Boolean)!;
  expect(await f.acquire(lease.requestId === nonce(1) ? 1 : 2)).toEqual(lease); expect((await f.allocation())!.requestsConsumed).toBe(1);
  await f.release(lease); await vi.advanceTimersByTimeAsync(200_000); expect(await f.acquire(3)).toBeNull(); expect((await f.allocation())!.requestsConsumed).toBe(1);
});
it('atomically fences the final storage units and ordinal replay, without resetting on successor leases', async () => {
  const f = await fixture({ requestLimit: 10, readByteLimit: 100, storageOperationLimit: 2 });
  const a = (await f.acquire(1))!, b = (await f.acquire(2))!; await f.begin(a); await f.begin(b);
  const results = await Promise.all([f.reserve(a, 1, 'head'), f.reserve(b, 1, 'head')]); expect(results.filter(Boolean)).toHaveLength(1);
  const winner = results[0] ? a : b; expect(await f.reserve(winner, 1, 'head')).toBe(false); expect((await f.allocation())!.storageOperationsConsumed).toBe(2);
  await f.release(a); await f.release(b); const successor = (await f.acquire(3))!; await f.begin(successor); expect(await f.reserve(successor, 1, 'head')).toBe(false);
});
it('charges exact range allowances plus bounded probes; changed scope, invalid bytes and exhausted reads cannot dispatch', async () => {
  const f = await fixture({ requestLimit: 10, readByteLimit: 8, storageOperationLimit: 20 }), lease = (await f.acquire(1))!; await f.begin(lease);
  expect(await f.reserve(lease, 1, 'read', 4)).toBe(true); expect(await f.reserve(lease, 2, 'read', 2)).toBe(true);
  expect((await f.allocation())!.readBytesConsumed).toBe(8); expect(await f.reserve(lease, 3, 'read', 1)).toBe(false);
  expect(await f.reserve(lease, 3, 'head', -1)).toBe(false); expect(await f.reserve(lease, 3, 'read', 4_000_001)).toBe(false);
  const changed = { ...f.identity(lease), owner: nonce(999), ordinal: 3, kind: 'authority', readBytes: 0 };
  expect(await f.t.mutation(api.researchGatewayLeases.reserveOperation, await f.signed('lease-reserve-operation', changed))).toBe(false);
});
it('lost reservation acknowledgement remains consumed and cannot authorize a second attempt', async () => {
  const f = await fixture(), lease = (await f.acquire(1))!; await f.begin(lease);
  const lost = async () => { expect(await f.reserve(lease, 1, 'put')).toBe(true); throw new Error('acknowledgement lost'); };
  await expect(lost()).rejects.toThrow('lost'); expect(await f.reserve(lease, 1, 'put')).toBe(false);
  await f.release(lease); expect((await f.allocation())!.storageOperationsConsumed).toBe(3); expect((await f.allocation())!.readBytesConsumed).toBe(1);
});
it('bounds authority checks and keeps cleanup retirement subject to aggregate allowance', async () => {
  const f = await fixture({ requestLimit: 10, readByteLimit: 100, storageOperationLimit: 2 }), lease = (await f.acquire(1))!; await f.begin(lease);
  for (let n = 1; n <= 128; n++) expect(await f.reserve(lease, n, 'authority')).toBe(true);
  expect(await f.reserve(lease, 129, 'authority')).toBe(false); expect(await f.reserve(lease, 129, 'retire')).toBe(false);
  expect((await f.allocation())!.storageOperationsConsumed).toBe(0);
});
