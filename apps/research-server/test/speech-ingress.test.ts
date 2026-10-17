import { expect, test, vi } from 'vitest';
import { createAllocatedResearchSpeechIngress } from '../src/speech-ingress';
import type { HostedAuthority, HostedLease } from '../src/hosted-admission';

function fixture() {
  const lease = { leaseId: 'lease-001', requestId: 'request-001', owner: 'owner-001', generation: 1, kind: 'voice', expiresAt: Date.now() + 225_000, bodyDeadlineAt: Date.now() + 180_000, responseDeadlineAt: Date.now() + 180_000, allocationId: 'allocated-speech-001' } as HostedLease;
  const native: HostedAuthority = { acquire: vi.fn(async () => lease), inspect: vi.fn(async () => lease), beginWork: vi.fn(async () => true), release: vi.fn(async () => true), reserveOperation: vi.fn(async () => true), claimCleanup: vi.fn(), finishCleanup: vi.fn() };
  const ingress = createAllocatedResearchSpeechIngress({ deployment: 'https://elegant-crane-662.convex.cloud', gatewaySecret: 'c'.repeat(64), allocationId: lease.allocationId! }, native);
  return { native, lease, ingress };
}
test('allocated native ownership precedes every prospectively reserved authority dispatch', async () => {
  const f = fixture(), lease = await f.ingress.reserve('request-001', 'voice'), dispatch = vi.fn(async () => 'saved');
  expect(await lease.authority(dispatch)).toBe('saved'); expect(f.native.beginWork).toHaveBeenCalledOnce();
  expect(vi.mocked(f.native.beginWork).mock.invocationCallOrder[0]).toBeLessThan(dispatch.mock.invocationCallOrder[0]);
  expect(f.native.reserveOperation).toHaveBeenCalledWith(expect.objectContaining({ ordinal: 1, kind: 'authority', readBytes: 0 }));
  await lease.authority(dispatch); expect(f.native.reserveOperation).toHaveBeenLastCalledWith(expect.objectContaining({ ordinal: 2 }));
});
test('unallocated admission and unknown begin never dispatch or release possibly owned work', async () => {
  const f = fixture(); vi.mocked(f.native.acquire).mockResolvedValue({ ...f.lease, allocationId: undefined });
  await expect(f.ingress.reserve('request-001', 'voice')).rejects.toThrow('allocation'); expect(f.native.beginWork).not.toHaveBeenCalled();
  vi.mocked(f.native.acquire).mockResolvedValue(f.lease); vi.mocked(f.native.beginWork).mockRejectedValue(new Error('unknown'));
  await expect(f.ingress.reserve('request-002', 'voice')).rejects.toThrow('unknown'); expect(f.native.release).not.toHaveBeenCalled();
});
test('quota denial seals the lease and rejects subsequent authority work without retry', async () => {
  const f = fixture(), lease = await f.ingress.reserve('request-001', 'voice'), dispatch = vi.fn(async () => {});
  vi.mocked(f.native.reserveOperation!).mockResolvedValue(false);
  await expect(lease.authority(dispatch)).rejects.toThrow('exhausted'); await expect(lease.authority(dispatch)).rejects.toThrow('ended');
  expect(dispatch).not.toHaveBeenCalled(); expect(f.native.reserveOperation).toHaveBeenCalledOnce();
});
test('concurrent work cannot reverse native reservation acknowledgements or ordinals', async () => {
  const f = fixture(), lease = await f.ingress.reserve('request-001', 'voice');
  let first!: (allowed: boolean) => void;
  vi.mocked(f.native.reserveOperation!).mockImplementationOnce(() => new Promise(resolve => { first = resolve; }));
  const one = vi.fn(async () => 'one'), two = vi.fn(async () => 'two');
  const pendingOne = lease.authority(one), pendingTwo = lease.authority(two);
  await vi.waitFor(() => expect(f.native.reserveOperation).toHaveBeenCalledOnce());
  expect(one).not.toHaveBeenCalled(); expect(two).not.toHaveBeenCalled();
  first(true); expect(await Promise.all([pendingOne, pendingTwo])).toEqual(['one', 'two']);
  expect(vi.mocked(f.native.reserveOperation!).mock.calls.map(([request]) => request.ordinal)).toEqual([1, 2]);
});
test('a pending failed quota reservation seals already queued work before dispatch', async () => {
  const f = fixture(), lease = await f.ingress.reserve('request-001', 'voice'); let deny!: (allowed: boolean) => void;
  vi.mocked(f.native.reserveOperation!).mockImplementationOnce(() => new Promise(resolve => { deny = resolve; }));
  const dispatch = vi.fn(async () => {});
  const one = lease.authority(dispatch), two = lease.authority(dispatch); const observed = Promise.allSettled([one, two]);
  await vi.waitFor(() => expect(f.native.reserveOperation).toHaveBeenCalledOnce()); deny(false);
  expect((await observed).map(result => result.status)).toEqual(['rejected', 'rejected']); expect(dispatch).not.toHaveBeenCalled(); expect(f.native.reserveOperation).toHaveBeenCalledOnce();
});
