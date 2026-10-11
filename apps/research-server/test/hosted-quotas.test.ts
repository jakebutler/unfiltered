import { afterEach, expect, it, vi } from 'vitest';
const route = vi.hoisted(() => ({ dispatch: vi.fn<(request: Request, store: any) => Promise<Response>>() }));
vi.mock('../src/server', () => ({ createResearchGateways: (store: any) => ({ media: (request: Request) => route.dispatch(request, store), reports: (request: Request) => route.dispatch(request, store) }) }));
import { createHostedResearchHandler, HOSTED_DEPLOYMENT, HOSTED_CONVEX_SITE } from '../src/hosted-runtime';
import { fakeHostedAuthority } from './hosted-test-authority';
import type { HostedAuthority, LeaseIdentity, QuotaOperation } from '../src/hosted-admission';
import type { PrivateObjectStore } from '../../../packages/research-capture/src/contracts';
const origin = 'https://research.example.test', allocationId = 'offline-allocation';
const config = { mode: 'hosted', deployment: HOSTED_DEPLOYMENT, convexSite: HOSTED_CONVEX_SITE, publicOrigin: origin, gatewaySecret: 'a'.repeat(64), maxSegmentBytes: 4_000_000, maxResponseBytes: 4_000_000, cleanupMode: 'durable', allocationId };
const request = () => new Request(origin + '/api/research/analysis/readiness', { headers: { Host: 'research.example.test', Origin: origin } });
const store = () => ({ head: vi.fn(async () => null), read: vi.fn(), retire: vi.fn(async () => {}), putIfAbsent: vi.fn() } as unknown as PrivateObjectStore);
function quotaAuthority() {
  const base = fakeHostedAuthority(), acquire = base.acquire;
  base.acquire = vi.fn(async input => { const row = await acquire(input); if (row) row.allocationId = allocationId; return row; });
  return Object.assign(base, { reserveOperation: vi.fn<NonNullable<HostedAuthority['reserveOperation']>>(async () => true) });
}
afterEach(() => { route.dispatch.mockReset(); vi.restoreAllMocks(); });
it('default hosted native configuration without root allocation stays OFF before body/store/transport work', async () => {
  const { allocationId: _omitted, ...disabled } = config, objects = store(), network = vi.spyOn(globalThis, 'fetch');
  const handler = createHostedResearchHandler(disabled, { canonicalOrigin: origin }, { store: objects });
  expect((await handler(request())).status).toBe(503); expect(network).not.toHaveBeenCalled(); expect(route.dispatch).not.toHaveBeenCalled(); expect(objects.head).not.toHaveBeenCalled();
});
it('reserves distinct exact read ranges before dispatch, with serial operation ordinals', async () => {
  const native = quotaAuthority(), objects = store(); let run = 0;
  vi.mocked(objects.read).mockImplementation(async (_key, range) => new ReadableStream({ start(c) { c.enqueue(new Uint8Array(range.end - range.start + 1)); c.close(); } }));
  route.dispatch.mockImplementation(async (_request, port) => { const size = ++run === 1 ? 3 : 5; return new Response(await port.read('research/synthetic/owned-a0', { start: 0, end: size - 1 })); });
  const make = () => createHostedResearchHandler(config, { canonicalOrigin: origin }, { store: objects, hostedAuthority: native });
  for (const size of [3, 5]) { const response = await make()(request()); expect((await response.arrayBuffer()).byteLength).toBe(size); }
  const reserves = native.reserveOperation.mock.calls.map(([input]) => input); expect(reserves.filter(r => r.kind === 'read').map(r => r.readBytes)).toEqual([3, 5]);
  for (const leaseId of new Set(reserves.map(r => r.leaseId))) expect(reserves.filter(r => r.leaseId === leaseId).map(r => r.ordinal)).toEqual(reserves.filter(r => r.leaseId === leaseId).map((_r, i) => i + 1));
  expect(objects.read).toHaveBeenCalledTimes(2);
});
it('unknown quota acknowledgement forbids store dispatch and has no retry/refund path', async () => {
  const native = quotaAuthority(), objects = store(); let consumed = 0;
  native.reserveOperation.mockImplementation(async input => { if (input.kind === 'head') { consumed += 2; throw new Error('native acknowledgement lost after consumption'); } return true; });
  route.dispatch.mockImplementation(async (_request, port) => { await port.head('research/synthetic/owned-a0'); return Response.json({ ok: true }); });
  const response = await createHostedResearchHandler(config, { canonicalOrigin: origin }, { store: objects, hostedAuthority: native })(request());
  expect(response.status).toBe(409); expect(objects.head).not.toHaveBeenCalled(); expect(consumed).toBe(2); expect(native.reserveOperation.mock.calls.filter(([input]) => input.kind === 'head')).toHaveLength(1);
});
it('quota exhaustion cancels tiny streamed chunks without skipping current consent checks', async () => {
  const native = quotaAuthority(), objects = store(), cancelled = vi.fn(async () => {}); let checks = 0;
  native.reserveOperation.mockImplementation(async input => input.kind !== 'authority' || ++checks <= 128);
  vi.mocked(objects.read).mockResolvedValue(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1)); }, cancel: cancelled }, { highWaterMark: 0 }));
  route.dispatch.mockImplementation(async (_request, port) => new Response(await port.read('research/synthetic/owned-a0', { start: 0, end: 999 })));
  const response = await createHostedResearchHandler(config, { canonicalOrigin: origin }, { store: objects, hostedAuthority: native })(request());
  await expect(response.arrayBuffer()).rejects.toThrow(); expect(checks).toBe(129); expect(cancelled).toHaveBeenCalledOnce();
});
it('cleanup retirement cannot dispatch when aggregate operation admission is denied', async () => {
  const native = quotaAuthority(), objects = store(); native.reserveOperation.mockImplementation(async input => input.kind !== 'retire');
  route.dispatch.mockImplementation(async (_request, port) => { await port.retire('research/synthetic/owned-a0'); return Response.json({ retired: true }); });
  const response = await createHostedResearchHandler(config, { canonicalOrigin: origin }, { store: objects, hostedAuthority: native })(request());
  expect(response.status).toBe(409); expect(objects.retire).not.toHaveBeenCalled();
});
