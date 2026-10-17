import { convexTest } from 'convex-test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const route = vi.hoisted(() => ({ dispatch: vi.fn<(request: Request, store: any) => Promise<Response>>() }));
vi.mock('../src/server', () => ({ createResearchGateways: (store: any) => ({ media: (request: Request) => route.dispatch(request, store), reports: (request: Request) => route.dispatch(request, store) }) }));
import schema from '../../../convex/schema';
import { api } from '../../../convex/_generated/api';
import { signGateway } from '../../../packages/research-capture/src/proof';
import { createHostedResearchHandler, HOSTED_CONVEX_SITE, HOSTED_DEPLOYMENT } from '../src/hosted-runtime';
import { leaseIdentity, type HostedAuthority, type CleanupClaim, type HostedLease } from '../src/hosted-admission';
import { fakeHostedAuthority } from './hosted-test-authority';
import type { PrivateObjectStore } from '../../../packages/research-capture/src/contracts';
const modules = import.meta.glob('../../../convex/**/*.ts'), secret = 'a'.repeat(64), origin = 'https://research.example.test';
const config = { mode: 'hosted', deployment: HOSTED_DEPLOYMENT, convexSite: HOSTED_CONVEX_SITE, publicOrigin: origin, gatewaySecret: secret, maxSegmentBytes: 4_000_000, maxResponseBytes: 4_000_000, cleanupMode: 'durable' };
const flush = async () => { for (let n = 0; n < 100; n++) await Promise.resolve(); };
const nonce = (n: number) => n.toString(16).padStart(32, '0');
const request = () => new Request(origin + '/api/research/analysis/readiness', { headers: { Host: 'research.example.test', Origin: origin } });
const store = () => ({ head: vi.fn(async () => null), read: vi.fn(), retire: vi.fn(async () => {}), putIfAbsent: vi.fn() } as unknown as PrivateObjectStore);
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv('RESEARCH_MEDIA_GATEWAY_SECRET', secret); route.dispatch.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function nativeFixture() {
  const t = convexTest(schema, modules);
  const signed = async (operation: string, input: any) => ({ ...input, proof: await signGateway(secret, operation, input) });
  const authority: HostedAuthority = {
    acquire: async input => t.mutation(api.researchGatewayLeases.acquire, await signed('lease-acquire', input)),
    inspect: async input => t.query(api.researchGatewayLeases.inspect, await signed('lease-inspect', input)),
    beginWork: async input => t.mutation(api.researchGatewayLeases.beginWork, await signed('lease-begin', input)),
    release: async input => t.mutation(api.researchGatewayLeases.release, await signed('lease-release', input)),
    claimCleanup: async input => t.mutation(api.captureGateway.claimCleanup, await signed('cleanup-claim', input)),
    finishCleanup: async input => t.mutation(api.captureGateway.finishCleanup, await signed('cleanup-finish', input)),
  };
  const media = await t.run(async ctx => {
    const ownerId = await ctx.db.insert('users', {}), clientId = await ctx.db.insert('researchClients', { ownerId, name: 'Independent synthetic', state: 'active', revision: 0, updatedAt: Date.now() });
    const projectId = await ctx.db.insert('researchProjects', { ownerId, clientId, name: 'Independent synthetic', state: 'active', revision: 0, latestStudyVersion: 1, updatedAt: Date.now() });
    const studyId = await ctx.db.insert('researchStudies', { ownerId, clientId, projectId, version: 1, createdAt: Date.now(), definition: { title: 'Synthetic', introduction: 'Synthetic', goals: ['Observe'], script: [{ id: 'q1', question: 'Observe' }], prototypeUrl: null, repository: null } });
    const sessionId = await ctx.db.insert('researchSessions', { ownerId, clientId, projectId, studyId, state: 'partial', revision: 0, nextQuestion: 0, sourceCount: 0, consent: null, consentAt: null, createdAt: Date.now(), savedAt: Date.now(), retainUntil: Date.now() });
    const captureId = await ctx.db.insert('researchCaptures', { sessionId, ownerId, clientId, projectId, state: 'purging', startedAt: Date.now(), deadline: Date.now(), retainUntil: Date.now(), reservedBytes: 20, segmentCount: 1, consentEpoch: 1, revokedThrough: { microphone: 1, camera: 1, screen: 1, dom: 1 }, domCount: 0, domLastAt: 0, domGeneration: 0, domGenerationStart: 0, domChallengeHash: null, domOrigin: null });
    const mediaId = await ctx.db.insert('researchMedia', { captureId, sessionId, clientId, projectId, requestId: 'independent-synthetic', descriptor: { modality: 'screen', sequence: 0, startMs: 0, endMs: 1000, bytes: 20, sha256: 'a'.repeat(64), mime: 'video/webm', questionId: 'q1', sourceId: null }, state: 'delete-pending', sourceId: 'synthetic', consentEpoch: 1, objectKey: `research/${sessionId}/independent-synthetic-a0`, attempt: 0, retiredKeys: [], retryUntil: Date.now(), claimUntil: Date.now(), recordedAt: Date.now(), availableAt: null, expiresAt: Date.now(), leaseUntil: 0, deletedAt: null });
    return { mediaId, captureId };
  });
  const acquire = (n: number) => authority.acquire({ kind: 'cleanup', requestId: nonce(n), owner: nonce(n + 100) }) as Promise<HostedLease>;
  return { t, authority, media, acquire, signed };
}
async function cleanupRequest(lease: HostedLease) {
  const input = leaseIdentity(lease), proof = await signGateway(secret, 'cleanup-tick', input), body = JSON.stringify(input);
  return new Request(origin + '/api/research/internal/cleanup', { method: 'POST', headers: { Host: 'research.example.test', Origin: origin, 'Content-Length': String(body.length), 'X-Research-Cleanup-At': String(proof.at), 'X-Research-Cleanup-Proof': proof.signature }, body });
}

it('independent invariant: replaying an active signed cleanup request cannot release the first native lifetime', async () => {
  const f = await nativeFixture(), lease = await f.acquire(1), objects = store();
  const releases = vi.spyOn(f.authority, 'release');
  let settle!: () => void, entered!: () => void; const entry = new Promise<void>(resolve => { entered = resolve; });
  vi.mocked(objects.retire).mockImplementation(() => new Promise<void>(resolve => { settle = resolve; entered(); }));
  const make = () => createHostedResearchHandler(config, { canonicalOrigin: origin }, { store: objects, hostedAuthority: f.authority });
  const first = make()(await cleanupRequest(lease)); await entry;
  const replay = await make()(await cleanupRequest(lease)); expect(replay.status).toBe(409); await flush();
  await Promise.all(releases.mock.results.map(result => result.value));
  const row = await f.t.run(ctx => ctx.db.get(lease.leaseId)), successor = await f.acquire(2);
  settle(); await first; await flush();
  expect({ started: row!.workStarted, expiresAt: row!.expiresAt, successor: successor?.generation ?? null }, 'first retirement is still pending after replay').toEqual({ started: true, expiresAt: lease.expiresAt, successor: null });
});

it('independent invariant: a late dispatch response must cancel its body and await cancellation before releasing', async () => {
  const native = fakeHostedAuthority(1000), objects = store(); let deliver!: (response: Response) => void, settleCancel!: () => void;
  const cancelled = vi.fn(() => new Promise<void>(resolve => { settleCancel = resolve; }));
  route.dispatch.mockImplementation(() => new Promise<Response>(resolve => { deliver = resolve; }));
  const handler = createHostedResearchHandler(config, { canonicalOrigin: origin }, { store: objects, hostedAuthority: native });
  const first = handler(request()); await flush(); await vi.advanceTimersByTimeAsync(11_001); expect((await first).status).toBe(409);
  deliver(new Response(new ReadableStream({ cancel: cancelled }, { highWaterMark: 0 }))); await flush();
  const releaseCount = vi.mocked(native.release).mock.calls.length, cancelCount = cancelled.mock.calls.length;
  settleCancel?.(); await flush();
  expect({ cancellations: cancelCount, releases: releaseCount }, 'late body cancellation must settle before lease release').toEqual({ cancellations: 1, releases: 0 });
});

it('independent invariant: a late private-store read stream must cancel before the original read can release', async () => {
  const native = fakeHostedAuthority(1000), objects = store(); let deliver!: (body: ReadableStream<Uint8Array>) => void;
  const cancelled = vi.fn(async () => {});
  vi.mocked(objects.read).mockImplementation(() => new Promise(resolve => { deliver = resolve; }));
  route.dispatch.mockImplementation(async (_request, port) => new Response(await port.read('research/synthetic/object-a0', { start: 0, end: 0 })));
  const handler = createHostedResearchHandler(config, { canonicalOrigin: origin }, { store: objects, hostedAuthority: native });
  const first = handler(request()); await flush(); expect(objects.read).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(11_001); expect((await first).status).toBe(409); expect(native.release).not.toHaveBeenCalled();
  deliver(new ReadableStream({ cancel: cancelled }, { highWaterMark: 0 })); await flush();
  expect({ cancellations: cancelled.mock.calls.length, releases: vi.mocked(native.release).mock.calls.length }, 'late store stream must cancel before lease release').toEqual({ cancellations: 1, releases: 1 });
});

it('independent control: nominal cleanup deadline denies claim before reserved operation allowance changes', async () => {
  const f = await nativeFixture(), lease = await f.acquire(1); expect(await f.authority.beginWork(leaseIdentity(lease))).toBe(true);
  await vi.advanceTimersByTimeAsync(180_001); expect(await f.authority.claimCleanup(leaseIdentity(lease))).toEqual([]);
  expect((await f.t.run(ctx => ctx.db.get(f.media.mediaId)))!.cleanupAttempts).toBeUndefined();
});

it('independent control: an expired claim cannot complete under a new lease reusing the same owner', async () => {
  const f = await nativeFixture(), first = await f.acquire(1); await f.authority.beginWork(leaseIdentity(first));
  const [claim] = await f.authority.claimCleanup(leaseIdentity(first)); await f.authority.release(leaseIdentity(first));
  const second = (await f.authority.acquire({ kind: 'cleanup', requestId: nonce(2), owner: first.owner }))!; await f.authority.beginWork(leaseIdentity(second));
  expect(await f.authority.finishCleanup({ ...leaseIdentity(second), claim, retired: true })).toBe(false);
  expect((await f.t.run(ctx => ctx.db.get(f.media.captureId)))!.reservedBytes).toBe(20);
});

it('independent control: legacy worker cannot complete a row already bound to a hosted cleanup claim', async () => {
  const f = await nativeFixture(), lease = await f.acquire(1); await f.authority.beginWork(leaseIdentity(lease));
  const [claim] = await f.authority.claimCleanup(leaseIdentity(lease)); expect(claim).toBeDefined();
  const input = { mediaId: f.media.mediaId, attempt: 0 };
  await expect(f.t.mutation(api.captureGateway.deleted, await f.signed('deleted', input))).rejects.toThrow();
  expect((await f.t.run(ctx => ctx.db.get(f.media.mediaId)))!.state).toBe('delete-pending');
  expect((await f.t.run(ctx => ctx.db.get(f.media.captureId)))!.reservedBytes).toBe(20);
});
