import { convexTest } from 'convex-test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import schema from '../../../convex/schema';
import { api, internal } from '../../../convex/_generated/api';
import { signGateway } from '../src/proof';
const modules = import.meta.glob('../../../convex/**/*.ts');
const secret = 'independent-offline-quota-review'.repeat(3), allocationId = 'independent-allocation';
const nonce = (n: number) => n.toString(16).padStart(32, '0');
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv('RESEARCH_MEDIA_GATEWAY_SECRET', secret); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function fixture(expiry = 600_000, storageOperationLimit = 100, readByteLimit = 1000) {
  const t = convexTest(schema, modules);
  await t.mutation(internal.researchGatewayLeases.provisionAllocation, { allocationId, expiresAt: Date.now() + expiry, requestLimit: 10, storageOperationLimit, readByteLimit });
  const signed = async (operation: string, input: any) => ({ ...input, proof: await signGateway(secret, operation, input) });
  const acquire = async (n: number) => t.mutation(api.researchGatewayLeases.acquireAllocated, await signed('lease-acquire-allocated', { allocationId, kind: 'operation', requestId: nonce(n), owner: nonce(100 + n) }));
  type Lease = NonNullable<Awaited<ReturnType<typeof acquire>>>;
  const identity = (lease: Lease) => ({ leaseId: lease.leaseId, requestId: lease.requestId, owner: lease.owner, generation: lease.generation });
  const begin = async (lease: Lease) => t.mutation(api.researchGatewayLeases.beginWork, await signed('lease-begin', identity(lease)));
  const release = async (lease: Lease) => t.mutation(api.researchGatewayLeases.release, await signed('lease-release', identity(lease)));
  const reserve = async (lease: Lease, ordinal: number, kind: 'head' | 'read' | 'put' | 'retire' | 'authority', readBytes = 0) => t.mutation(api.researchGatewayLeases.reserveOperation, await signed('lease-reserve-operation', { ...identity(lease), ordinal, kind, readBytes }));
  const allocation = () => t.run(ctx => ctx.db.query('researchGatewayAllocations').withIndex('by_allocationId', q => q.eq('allocationId', allocationId)).unique());
  return { t, acquire, begin, release, reserve, allocation };
}
it('independent: allocation expiry denies more operations without releasing begun work or refunding prior allowance', async () => {
  const f = await fixture(1000), lease = (await f.acquire(1))!;
  expect(await f.begin(lease)).toBe(true); expect(await f.reserve(lease, 1, 'read', 9)).toBe(true);
  await vi.advanceTimersByTimeAsync(1001);
  expect(await f.reserve(lease, 2, 'head')).toBe(false); expect(await f.acquire(2)).toBeNull();
  const row = await f.t.run(ctx => ctx.db.get(lease.leaseId)); expect(row!.workStarted).toBe(true);
  expect(await f.release(lease)).toBe(true);
  expect(await f.allocation()).toMatchObject({ requestsConsumed: 1, readBytesConsumed: 10, storageOperationsConsumed: 2 });
});
it('independent: successor generation rejects old reservations and changed replay kind after a consumed ordinal', async () => {
  const f = await fixture(), first = (await f.acquire(1))!; await f.begin(first);
  expect(await f.reserve(first, 1, 'put')).toBe(true); expect(await f.reserve(first, 1, 'read', 10)).toBe(false);
  await f.release(first); const next = (await f.acquire(2))!; await f.begin(next);
  expect(next.leaseId).toBe(first.leaseId); expect(next.generation).toBe(first.generation + 1);
  expect(await f.reserve(first, 2, 'retire')).toBe(false); expect(await f.release(first)).toBe(false);
  expect(await f.reserve(next, 1, 'head')).toBe(true);
  expect(await f.allocation()).toMatchObject({ requestsConsumed: 2, readBytesConsumed: 2, storageOperationsConsumed: 5 });
});
it('independent: retirement and independent verification reserve all five possible wire operations and probe bytes', async () => {
  const f = await fixture(600_000, 5, 2), lease = (await f.acquire(1))!; await f.begin(lease);
  expect(await f.reserve(lease, 1, 'retire')).toBe(true); expect(await f.reserve(lease, 2, 'head')).toBe(true);
  expect(await f.reserve(lease, 3, 'authority')).toBe(true); expect(await f.reserve(lease, 4, 'head')).toBe(false);
  await f.release(lease);
  expect(await f.allocation()).toMatchObject({ requestsConsumed: 1, readBytesConsumed: 2, storageOperationsConsumed: 5 });
});
it('independent: per-lease storage ceiling cannot borrow additional remaining aggregate units', async () => {
  const f = await fixture(), lease = (await f.acquire(1))!; await f.begin(lease);
  for (let ordinal = 1; ordinal <= 21; ordinal++) expect(await f.reserve(lease, ordinal, 'put')).toBe(true);
  expect(await f.reserve(lease, 22, 'head')).toBe(false); expect(await f.reserve(lease, 22, 'authority')).toBe(true);
  expect(await f.allocation()).toMatchObject({ readBytesConsumed: 21, storageOperationsConsumed: 63 });
});
