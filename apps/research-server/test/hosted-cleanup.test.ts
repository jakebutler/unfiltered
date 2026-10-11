import { expect, it, vi } from 'vitest';
import { runHostedCleanup, validateCleanupRequest } from '../src/hosted-cleanup';
import { fakeHostedAuthority } from './hosted-test-authority';
import { leaseIdentity, type CleanupClaim } from '../src/hosted-admission';
import { signGateway } from '../../../packages/research-capture/src/proof';
import type { PrivateObjectStore } from '../../../packages/research-capture/src/contracts';
const secret = 'a'.repeat(64);
async function fixture() {
  const native = fakeHostedAuthority(), lease = (await native.acquire({ kind: 'cleanup', requestId: '1'.repeat(32), owner: '2'.repeat(32) }))!;
  const claim: CleanupClaim = { mediaId: 'synthetic' as CleanupClaim['mediaId'], attempt: 0, key: 'research/synthetic/object-a0', owner: lease.owner, generation: 1, expiresAt: lease.expiresAt, operations: 4 };
  vi.mocked(native.claimCleanup).mockResolvedValue([claim]); vi.mocked(native.finishCleanup).mockImplementation(async input => input.retired);
  const store = { retire: vi.fn(async () => {}), head: vi.fn(async () => null), read: vi.fn(), putIfAbsent: vi.fn() } as unknown as PrivateObjectStore;
  return { native, lease, claim, store };
}
it('binds fixed scheduled endpoint proof to the current private cleanup identity and denies altered/replayed bodies', async () => {
  const f = await fixture(), input = leaseIdentity(f.lease), proof = await signGateway(secret, 'cleanup-tick', input), make = (body: unknown) => new Request('https://research.example.test/api/research/internal/cleanup', { method: 'POST', headers: { 'X-Research-Cleanup-At': String(proof.at), 'X-Research-Cleanup-Proof': proof.signature }, body: JSON.stringify(body) });
  expect(await validateCleanupRequest(make(input), secret, f.native)).toEqual(f.lease);
  await expect(validateCleanupRequest(make({ ...input, generation: 2 }), secret, f.native)).rejects.toThrow(); await f.native.release(input);
  await expect(validateCleanupRequest(make(input), secret, f.native)).rejects.toThrow();
});
it('completes only after exact retirement readback; unknown or nonzero retains native intent without retry', async () => {
  const f = await fixture(), signal = new AbortController().signal;
  expect(await runHostedCleanup(f.store, f.native, f.lease, signal)).toEqual({ claimed: 1, retired: 1 }); expect(f.store.retire).toHaveBeenCalledOnce(); expect(f.native.finishCleanup).toHaveBeenLastCalledWith({ ...leaseIdentity(f.lease), claim: f.claim, retired: true });
  vi.mocked(f.store.retire).mockRejectedValueOnce(new Error('synthetic unknown write')); expect(await runHostedCleanup(f.store, f.native, f.lease, signal)).toEqual({ claimed: 1, retired: 0 });
  expect(f.native.finishCleanup).toHaveBeenLastCalledWith({ ...leaseIdentity(f.lease), claim: f.claim, retired: false }); expect(f.store.putIfAbsent).not.toHaveBeenCalled();
  vi.mocked(f.store.head).mockResolvedValueOnce({ bytes: 1, mime: 'video/webm', sha256: 'a'.repeat(64) }); expect((await runHostedCleanup(f.store, f.native, f.lease, signal)).retired).toBe(0);
});
it('rejects oversized batches and expired/foreign claims before touching object storage', async () => {
  const f = await fixture(), signal = new AbortController().signal; vi.mocked(f.native.claimCleanup).mockResolvedValue(Array(11).fill(f.claim)); await expect(runHostedCleanup(f.store, f.native, f.lease, signal)).rejects.toThrow('batch');
  vi.mocked(f.native.claimCleanup).mockResolvedValue([{ ...f.claim, expiresAt: Date.now() - 1 }]); expect((await runHostedCleanup(f.store, f.native, f.lease, signal)).retired).toBe(0); expect(f.store.retire).not.toHaveBeenCalled();
});

it('stalled retirement returns unknown at the deadline but only settled original work can release its started slot', async () => {
  const { createHostedResearchHandler, HOSTED_DEPLOYMENT, HOSTED_CONVEX_SITE } = await import('../src/hosted-runtime');
  vi.useFakeTimers();
  try {
    const f = await fixture(), lease = { ...f.lease, bodyDeadlineAt: Date.now() + 1000, responseDeadlineAt: Date.now() + 1000, expiresAt: Date.now() + 46_000 }; f.native.leases.set(lease.leaseId, lease);
    const claim = { ...f.claim, expiresAt: lease.expiresAt }; vi.mocked(f.native.claimCleanup).mockResolvedValue([claim]); let settle!: () => void, entered!: () => void; const dispatchEntered = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(f.store.retire).mockImplementation(() => new Promise<void>(r => { settle = r; entered(); }));
    const origin = 'https://research.example.test', input = leaseIdentity(lease), proof = await signGateway(secret, 'cleanup-tick', input), body = JSON.stringify(input);
    const handler = createHostedResearchHandler({ mode: 'hosted', deployment: HOSTED_DEPLOYMENT, convexSite: HOSTED_CONVEX_SITE, publicOrigin: origin, gatewaySecret: secret, maxSegmentBytes: 4_000_000, maxResponseBytes: 4_000_000, cleanupMode: 'durable' }, { canonicalOrigin: origin }, { store: f.store, hostedAuthority: f.native });
    const response = handler(new Request(origin + '/api/research/internal/cleanup', { method: 'POST', headers: { Host: 'research.example.test', Origin: origin, 'Content-Length': String(body.length), 'X-Research-Cleanup-At': String(proof.at), 'X-Research-Cleanup-Proof': proof.signature }, body }));
    await dispatchEntered; await vi.advanceTimersByTimeAsync(1001);
    // Current hosting contract waits up to ten seconds for native settlement;
    // this wait cannot release an original retirement that is still pending.
    expect(f.native.release).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(10_001); expect((await response).status).toBe(409);
    expect(f.native.release).not.toHaveBeenCalled(); expect(f.native.finishCleanup).not.toHaveBeenCalled(); settle();
    for (let n = 0; n < 60; n++) await Promise.resolve(); expect(f.native.leases.size).toBe(0); expect(f.store.head).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it('selects the dedicated authority only for signed internal cleanup; public requests and foreign allocation receipts cannot spend it', async () => {
  const { createHostedResearchHandler, parseHostedConfig, HOSTED_DEPLOYMENT, HOSTED_CONVEX_SITE } = await import('../src/hosted-runtime');
  const f = await fixture(), normal = fakeHostedAuthority(), allocationId = 'ordinary-demo', cleanupAllocationId = 'retirement-demo', origin = 'https://research.example.test';
  const config = { mode: 'hosted', deployment: HOSTED_DEPLOYMENT, convexSite: HOSTED_CONVEX_SITE, publicOrigin: origin, gatewaySecret: secret, maxSegmentBytes: 4000000, maxResponseBytes: 4000000, cleanupMode: 'durable', allocationId, cleanupAllocationId };
  expect(() => parseHostedConfig({ ...config, cleanupAllocationId: allocationId }, { canonicalOrigin: origin })).toThrow();
  expect(() => parseHostedConfig({ ...config, allocationId: undefined }, { canonicalOrigin: origin })).toThrow();
  const lease = { ...f.lease, allocationId: cleanupAllocationId }; f.native.leases.set(lease.leaseId, lease);
  f.native.reserveOperation = vi.fn(async () => true); normal.reserveOperation = vi.fn(async () => true);
  const originalAcquire = normal.acquire; normal.acquire = vi.fn(async args => { const row = await originalAcquire(args); return row && { ...row, allocationId }; });
  const requestGateway = vi.fn(async () => Response.json({ ordinary: true }));
  const handler = createHostedResearchHandler(config, { canonicalOrigin: origin }, { store: f.store, hostedAuthority: normal, cleanupAuthority: f.native, requestGateway });
  const ordinary = await handler(new Request(origin + '/api/research/example', { headers: { Host: 'research.example.test', Origin: origin } })); expect(await ordinary.json()).toEqual({ ordinary: true });
  expect(normal.acquire).toHaveBeenCalledOnce(); expect(f.native.inspect).not.toHaveBeenCalled();
  const input = leaseIdentity(lease), proof = await signGateway(secret, 'cleanup-tick', input), body = JSON.stringify(input);
  const make = (signature = proof.signature) => new Request(origin + '/api/research/internal/cleanup', { method: 'POST', headers: { Host: 'research.example.test', Origin: origin, 'Content-Length': String(body.length), 'X-Research-Cleanup-At': String(proof.at), 'X-Research-Cleanup-Proof': signature }, body });
  expect((await handler(make('0'.repeat(64)))).status).toBe(409); expect(f.native.beginWork).not.toHaveBeenCalled();
  f.native.leases.set(lease.leaseId, { ...lease, allocationId }); expect((await handler(make())).status).toBe(409); expect(f.native.beginWork).not.toHaveBeenCalled();
  f.native.leases.set(lease.leaseId, lease); const cleaned = await handler(make()); expect(await cleaned.json()).toEqual({ claimed: 1, retired: 1 });
  expect(normal.inspect).toHaveBeenCalledTimes(2); expect(normal.acquire).toHaveBeenCalledOnce(); expect(f.native.acquire).toHaveBeenCalledOnce(); expect(f.native.reserveOperation).toHaveBeenCalledWith(expect.objectContaining({ kind: 'retire' }));
});
