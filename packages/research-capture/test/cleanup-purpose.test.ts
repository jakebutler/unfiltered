import { convexTest } from 'convex-test';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import schema from '../../../convex/schema';
import { api, internal } from '../../../convex/_generated/api';
import { hashCapability } from '../../../convex/access';
import { signGateway } from '../src/proof';
import { cleanupAdmissionReady } from '../../../convex/cleanupAdmission';
const modules = import.meta.glob('../../../convex/**/*.ts'), secret = 'offline-cleanup-purpose-secret'.repeat(3), cleanupId = 'offline-retirement-only', interactiveId = 'offline-interactive';
const day = 86_400_000, nonce = (n: number) => n.toString(16).padStart(32, '0');
const consent = { version: 'research-consent-1' as const, storage: true, analysis: true, microphone: true, camera: false, screen: false, dom: false, shareTranscript: false, shareAudio: false, shareCamera: false, shareScreen: false, retainApprovedExcerpts: false };
const descriptor = { modality: 'microphone' as const, sequence: 0, startMs: 0, endMs: 1000, bytes: 20, sha256: 'a'.repeat(64), mime: 'audio/webm', questionId: 'q1', sourceId: null };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-10T00:00:00Z')); vi.stubEnv('RESEARCH_MEDIA_GATEWAY_SECRET', secret); vi.stubEnv('RESEARCH_HOSTED_CLEANUP_ALLOCATION', cleanupId); vi.stubEnv('RESEARCH_CAPTURE_LIMITS_JSON', JSON.stringify({ segments: 3 })); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function fixture() {
  const t = convexTest(schema, modules), now = Date.now();
  const cleanupRow = await t.mutation(internal.researchGatewayLeases.provisionAllocation, { allocationId: cleanupId, purpose: 'cleanup', expiresAt: now + 33 * day, requestLimit: 24, storageOperationLimit: 120, readByteLimit: 48 });
  await t.mutation(internal.researchGatewayLeases.provisionAllocation, { allocationId: interactiveId, expiresAt: now + 7 * day, requestLimit: 100, storageOperationLimit: 100, readByteLimit: 100 });
  const token = '1'.repeat(64), tokenHash = await hashCapability(token);
  const scope = await t.run(async ctx => {
    const ownerId = await ctx.db.insert('users', {}), clientId = await ctx.db.insert('researchClients', { ownerId, name: 'Synthetic', state: 'active', revision: 0, updatedAt: now });
    const projectId = await ctx.db.insert('researchProjects', { ownerId, clientId, name: 'Synthetic', state: 'active', revision: 0, latestStudyVersion: 1, updatedAt: now });
    const studyId = await ctx.db.insert('researchStudies', { ownerId, clientId, projectId, version: 1, createdAt: now, definition: { title: 'Synthetic', introduction: 'Synthetic only', goals: ['Observe'], script: [{ id: 'q1', question: 'Observe' }], prototypeUrl: null, repository: null } });
    const sessionId = await ctx.db.insert('researchSessions', { ownerId, clientId, projectId, studyId, state: 'active', revision: 1, nextQuestion: 0, sourceCount: 0, consent, consentAt: now, createdAt: now, savedAt: now, retainUntil: now + 30 * day });
    await ctx.db.insert('researchInvitations', { ownerId, clientId, projectId, studyId, sessionId, requestId: 'synthetic-invite', tokenHash, expiresAt: now + 7 * day, revokedAt: null });
    return { sessionId };
  });
  const signed = async <T extends object>(operation: string, args: T) => ({ ...args, proof: await signGateway(secret, operation, args) });
  const acquire = async (n: number, kind: 'operation' | 'read' | 'voice' | 'upload' | 'analysis' | 'password' | 'cleanup' = 'cleanup', allocationId = cleanupId) => t.mutation(api.researchGatewayLeases.acquireAllocated, await signed('lease-acquire-allocated', { kind, allocationId, requestId: nonce(n), owner: nonce(n + 100) }));
  const tick = (n: number, allocationId = cleanupId) => t.mutation(internal.researchGatewayLeases.acquireTick, { allocationId, requestId: nonce(n), owner: nonce(n + 100) });
  const identity = (lease: NonNullable<Awaited<ReturnType<typeof acquire>>>) => ({ leaseId: lease.leaseId, requestId: lease.requestId, owner: lease.owner, generation: lease.generation });
  const begin = async (lease: Parameters<typeof identity>[0]) => t.mutation(api.researchGatewayLeases.beginWork, await signed('lease-begin', identity(lease)));
  const claim = async (lease: Parameters<typeof identity>[0]) => t.mutation(api.captureGateway.claimCleanup, await signed('cleanup-claim', identity(lease)));
  const allocation = () => t.run(ctx => ctx.db.get(cleanupRow));
  return { t, scope, token, cleanupRow, signed, acquire, tick, identity, begin, claim, allocation, now };
}
async function due(f: Awaited<ReturnType<typeof fixture>>) {
  const capture = await f.t.mutation(api.capture.start, { token: f.token }), media = await f.t.mutation(api.capture.reserve, { token: f.token, requestId: 'synthetic-segment', descriptor });
  await f.t.run(ctx => ctx.db.patch(media.id, { state: 'delete-pending', cleanupNextAt: Date.now(), leaseUntil: 0 }));
  return { capture, media };
}
it('33-day grants require explicit cleanup purpose; default/legacy grants retain the 30-day cap and cannot reset', async () => {
  const f = await fixture(), args = { allocationId: 'new-longer-grant', expiresAt: Date.now() + 33 * day, requestLimit: 24, storageOperationLimit: 120, readByteLimit: 48 };
  await expect(f.t.mutation(internal.researchGatewayLeases.provisionAllocation, args)).rejects.toThrow('finite');
  await expect(f.t.mutation(internal.researchGatewayLeases.provisionAllocation, { ...args, purpose: 'interactive' })).rejects.toThrow('finite');
  await expect(f.t.mutation(internal.researchGatewayLeases.provisionAllocation, { ...args, allocationId: cleanupId, purpose: 'cleanup' })).rejects.toThrow('immutable');
  expect(await f.allocation()).toMatchObject({ purpose: 'cleanup', cleanupReservedMedia: 0, requestsConsumed: 0 });
});
it('empty cron and AWS-style signed cleanup admission spend zero; every interactive lease kind is denied', async () => {
  const f = await fixture();
  vi.stubEnv('RESEARCH_HOSTED_GATEWAY_ORIGIN', 'https://corvo-research-demo.vercel.app'); vi.stubEnv('RESEARCH_HOSTED_GATEWAY_BYPASS_SECRET', 'synthetic-platform-access');
  const network = vi.spyOn(globalThis, 'fetch');
  try { for (let n = 0; n < 3; n++) await f.t.action(internal.researchGatewayLeases.cleanupTick, {}); expect(network).not.toHaveBeenCalled(); } finally { network.mockRestore(); }
  for (let n = 1; n <= 3; n++) { expect(await f.tick(n)).toBeNull(); expect(await f.acquire(n + 10)).toBeNull(); }
  for (const kind of ['operation', 'upload', 'read', 'password', 'analysis', 'voice'] as const) expect(await f.acquire(30, kind)).toBeNull();
  const forged = (await f.acquire(40, 'read', interactiveId))!; await f.t.run(ctx => ctx.db.patch(forged.leaseId, { allocationId: cleanupId }));
  expect(await f.begin(forged)).toBe(false);
  await f.t.run(ctx => ctx.db.patch(forged.leaseId, { workStarted: true }));
  expect(await f.t.mutation(api.researchGatewayLeases.reserveOperation, await f.signed('lease-reserve-operation', { ...f.identity(forged), ordinal: 1, kind: 'head', readBytes: 0 }))).toBe(false);
  expect(await f.allocation()).toMatchObject({ requestsConsumed: 0, readBytesConsumed: 0, storageOperationsConsumed: 0 });
});
it('capture atomically reserves all three cleanup rows and rejects insufficient horizon, capacity, exhaustion and a fourth media row', async () => {
  const f = await fixture();
  await f.t.run(ctx => ctx.db.patch(f.cleanupRow, { expiresAt: f.now + 31 * day }));
  await expect(f.t.mutation(api.capture.start, { token: f.token })).rejects.toThrow('cleanup');
  await f.t.run(ctx => ctx.db.patch(f.cleanupRow, { expiresAt: f.now + 33 * day, storageOperationLimit: 119 }));
  await expect(f.t.mutation(api.capture.start, { token: f.token })).rejects.toThrow('cleanup');
  await f.t.run(ctx => ctx.db.patch(f.cleanupRow, { storageOperationLimit: 120 }));
  await f.t.mutation(api.capture.start, { token: f.token });
  expect(await f.allocation()).toMatchObject({ cleanupReservedMedia: 3, requestsConsumed: 0 });
  expect(await f.t.run(ctx => cleanupAdmissionReady(ctx, f.now + 30 * day, 1))).toBe(false);
  for (let n = 0; n < 3; n++) await f.t.mutation(api.capture.reserve, { token: f.token, requestId: `synthetic-segment-${n}`, descriptor: { ...descriptor, sequence: n, startMs: n * 1000, endMs: (n + 1) * 1000 } });
  await expect(f.t.mutation(api.capture.reserve, { token: f.token, requestId: 'synthetic-fourth', descriptor: { ...descriptor, sequence: 3, startMs: 3000, endMs: 4000 } })).rejects.toThrow('cleanup');
  await f.t.run(ctx => ctx.db.patch(f.cleanupRow, { requestsConsumed: 24 }));
  await expect(f.t.mutation(api.capture.start, { token: f.token })).rejects.toThrow('cleanup');
});
it('retirement stays authorized beyond participant and interactive expiry without admitting patient reads or provider work', async () => {
  const f = await fixture(), row = await due(f); vi.setSystemTime(f.now + 30 * day + 1);
  await expect(f.t.query(api.capture.status, { token: f.token })).rejects.toThrow('Access');
  expect(await f.acquire(1, 'operation', interactiveId)).toBeNull(); expect(await f.acquire(2, 'analysis')).toBeNull();
  const lease = (await f.tick(3))!; expect(lease.allocationId).toBe(cleanupId); expect(await f.begin(lease)).toBe(true);
  const [claim] = await f.claim(lease); expect(claim.mediaId).toBe(row.media.id);
  const reserve = async (ordinal: number, kind: 'head' | 'retire' | 'put' | 'read', readBytes = 0) => f.t.mutation(api.researchGatewayLeases.reserveOperation, await f.signed('lease-reserve-operation', { ...f.identity(lease), ordinal, kind, readBytes }));
  expect(await reserve(1, 'put')).toBe(false); expect(await reserve(1, 'read', 20)).toBe(false);
  expect(await reserve(1, 'retire')).toBe(true); expect(await reserve(2, 'head')).toBe(true);
  expect(await f.allocation()).toMatchObject({ requestsConsumed: 1, storageOperationsConsumed: 5, readBytesConsumed: 2 });
  expect(await f.t.mutation(api.captureGateway.finishCleanup, await f.signed('cleanup-finish', { ...f.identity(lease), claim, retired: true }))).toBe(true);
  expect((await f.t.run(ctx => ctx.db.get(row.media.id)))!.state).toBe('deleted');
});
it('unknown started retirement remains held across expiry and exhausted authority never fabricates a deletion receipt', async () => {
  const f = await fixture(), row = await due(f), lease = (await f.tick(1))!; expect(await f.begin(lease)).toBe(true); const [claim] = await f.claim(lease);
  vi.setSystemTime(f.now + day); expect(await f.tick(2)).toBeNull(); expect(await f.acquire(3)).toBeNull();
  expect(await f.allocation()).toMatchObject({ requestsConsumed: 1 });
  expect(await f.t.mutation(api.captureGateway.finishCleanup, await f.signed('cleanup-finish', { ...f.identity(lease), claim, retired: true }))).toBe(false);
  expect((await f.t.run(ctx => ctx.db.get(row.media.id)))!.state).toBe('delete-pending');
  await f.t.run(async ctx => { await ctx.db.patch(lease.leaseId, { workStarted: false, expiresAt: 0 }); await ctx.db.patch(f.cleanupRow, { requestsConsumed: 24 }); });
  expect(await f.tick(4)).toBeNull(); expect((await f.t.run(ctx => ctx.db.get(row.capture.captureId)))!.reservedBytes).toBe(20);
});
it('a normal allocation cannot spend or claim a capture reserved to a cleanup purpose allocation', async () => {
  const f = await fixture(); await due(f); expect(await f.tick(1, interactiveId)).toBeNull();
  const lease = (await f.acquire(2, 'cleanup', interactiveId))!; expect(await f.begin(lease)).toBe(true); expect(await f.claim(lease)).toEqual([]);
});

it('a hosted allocation alone cannot admit new captures without a dedicated cleanup binding', async () => {
  const f = await fixture(); vi.stubEnv('RESEARCH_HOSTED_CLEANUP_ALLOCATION', ''); vi.stubEnv('RESEARCH_HOSTED_GATEWAY_ALLOCATION', interactiveId);
  await expect(f.t.mutation(api.capture.start, { token: f.token })).rejects.toThrow('cleanup');
  expect(await f.t.run(ctx => ctx.db.query('researchCaptures').take(1))).toEqual([]);
});

it('legacy enumeration/completion cannot bypass a bound row before its first claim; unbound historical rows remain supported', async () => {
  const f = await fixture(), row = await due(f), bound = (await f.t.run(ctx => ctx.db.get(row.media.id)))!;
  expect(bound.cleanupGeneration).toBeUndefined();
  expect(await f.t.query(api.captureGateway.cleanup, { proof: await signGateway(secret, 'cleanup', {}) })).toEqual([]);
  await expect(f.t.mutation(api.captureGateway.deleted, await f.signed('deleted', { mediaId: row.media.id, attempt: 0 }))).rejects.toThrow('Access');
  expect(await f.t.run(ctx => ctx.db.get(row.media.id))).toEqual(bound);
  expect((await f.t.run(ctx => ctx.db.get(row.capture.captureId)))!.reservedBytes).toBe(20);
  const historicalId = await f.t.run(async ctx => {
    const { _id: _sessionId, _creationTime: _sessionTime, ...session } = (await ctx.db.get(f.scope.sessionId))!;
    const sessionId = await ctx.db.insert('researchSessions', session);
    const { _id: _captureId, _creationTime: _captureTime, cleanupAllocationId: _allocation, cleanupMediaLimit: _limit, ...capture } = (await ctx.db.get(row.capture.captureId))!;
    const captureId = await ctx.db.insert('researchCaptures', { ...capture, sessionId });
    const { _id: _mediaId, _creationTime: _mediaTime, ...media } = bound;
    return ctx.db.insert('researchMedia', { ...media, sessionId, captureId, requestId: 'historical-segment', objectKey: `research/${sessionId}/historical-a0` });
  });
  expect(await f.t.query(api.captureGateway.cleanup, { proof: await signGateway(secret, 'cleanup', {}) })).toEqual([expect.objectContaining({ id: historicalId })]);
  await f.t.mutation(api.captureGateway.deleted, await f.signed('deleted', { mediaId: historicalId, attempt: 0 }));
  expect((await f.t.run(ctx => ctx.db.get(historicalId)))!.state).toBe('deleted');
  expect((await f.t.run(ctx => ctx.db.get(row.media.id)))!.state).toBe('delete-pending');
  expect(await f.allocation()).toMatchObject({ requestsConsumed: 0, storageOperationsConsumed: 0, readBytesConsumed: 0, cleanupReservedMedia: 3 });
});
