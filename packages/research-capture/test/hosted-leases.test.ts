import { convexTest } from 'convex-test';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import schema from '../../../convex/schema';
import { api, internal } from '../../../convex/_generated/api';
import { signGateway, verifyGateway } from '../src/proof';
const modules = import.meta.glob('../../../convex/**/*.ts'), secret = 'offline-hosted-gateway-secret'.repeat(2);
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv('RESEARCH_MEDIA_GATEWAY_SECRET', secret); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
const nonce = (n: number) => n.toString(16).padStart(32, '0');
async function fixture() {
  const t = convexTest(schema, modules);
  const acquire = async (n: number, kind: 'operation' | 'upload' | 'read' | 'password' | 'analysis' | 'cleanup' = 'operation') => { const input = { requestId: nonce(n), owner: nonce(n + 100), kind }; return t.mutation(api.researchGatewayLeases.acquire, { ...input, proof: await signGateway(secret, 'lease-acquire', input) }); };
  const id = (lease: NonNullable<Awaited<ReturnType<typeof acquire>>>) => ({ leaseId: lease.leaseId, requestId: lease.requestId, owner: lease.owner, generation: lease.generation });
  const begin = async (lease: Parameters<typeof id>[0]) => { const input = id(lease); return t.mutation(api.researchGatewayLeases.beginWork, { ...input, proof: await signGateway(secret, 'lease-begin', input) }); };
  const release = async (input: ReturnType<typeof id>) => t.mutation(api.researchGatewayLeases.release, { ...input, proof: await signGateway(secret, 'lease-release', input) });
  return { t, acquire, id, begin, release };
}
it('serializes two independent callers to fixed global/class slots, authenticates every operation and isolates generations', async () => {
  const f = await fixture(), uploads = await Promise.all([f.acquire(1, 'upload'), f.acquire(2, 'upload')]); expect(uploads.filter(Boolean)).toHaveLength(1);
  const first = uploads.find(Boolean)!; expect(await f.acquire(3, 'analysis')).not.toBeNull(); expect(await f.acquire(4, 'analysis')).toBeNull();
  expect(await f.acquire(5)).not.toBeNull(); expect(await f.acquire(6)).not.toBeNull(); expect(await f.acquire(7)).toBeNull();
  await expect(f.t.mutation(api.researchGatewayLeases.release, { ...f.id(first), proof: await signGateway('wrong-secret'.repeat(4), 'lease-release', f.id(first)) })).rejects.toThrow();
  expect(await f.release({ ...f.id(first), owner: nonce(999) })).toBe(false); expect(await f.release(f.id(first))).toBe(true);
  const next = (await f.acquire(8, 'upload'))!; expect(next.leaseId).toBe(first.leaseId); expect(next.generation).toBeGreaterThan(first.generation); expect(await f.release(f.id(first))).toBe(false);
  expect(await f.t.run(ctx => ctx.db.query('researchGatewaySlots').take(5))).toHaveLength(4);
});
it('expiry recovers unstarted concurrency but never automatically reuses unknown started work or budget identities', async () => {
  const f = await fixture(), unknown = (await f.acquire(1, 'analysis'))!, idle = (await f.acquire(2, 'upload'))!;
  const seeded = await media(f); const frozen = await f.t.run(async ctx => {
    const m = (await ctx.db.get(seeded.mediaId))!, capture = (await ctx.db.get(m.captureId))!;
    await ctx.db.patch(m._id, { state: 'uploading', leaseUntil: Date.now() + 20_000 });
    return ctx.db.insert('researchAnalyses', { ownerId: capture.ownerId, clientId: m.clientId, projectId: m.projectId, requestId: 'consumed-request', manifestHash: 'a'.repeat(64), studyContext: '', evidence: [], state: 'unknown', revision: 1, findings: [], excerpts: [], reviewedAt: null, reservation: { id: 'consumed-root-reservation', model: 'qwen3.8-max', maxInputBytes: 64000, maxOutputTokens: 1024, expiresAt: Date.now() + 30_000, live: true }, receipt: { requestId: null, model: 'qwen3.8-max', inputHash: 'b'.repeat(64), requestBytes: 3000, maxOutputTokens: 1024, outputHash: null, frames: [], classification: 'live', errorCode: 'network' }, createdAt: Date.now(), deadline: Date.now() + 20_000 });
  });
  const before = await f.t.run(ctx => ctx.db.get(frozen));
  expect(await f.begin(unknown)).toBe(true); expect(await f.begin(unknown)).toBe(false);
  await vi.advanceTimersByTimeAsync(200_000);
  expect(await f.acquire(3, 'analysis')).toBeNull(); const recovered = (await f.acquire(4, 'upload'))!; expect(recovered.leaseId).toBe(idle.leaseId);
  expect(await f.release(f.id(unknown))).toBe(true); expect(await f.acquire(5, 'analysis')).not.toBeNull();
  expect(await f.t.run(ctx => ctx.db.get(frozen))).toEqual(before); const source = await f.t.run(ctx => ctx.db.get(seeded.mediaId)); expect(source!.state).toBe('uploading'); expect(source!.attempt).toBe(0);
});
async function media(f: Awaited<ReturnType<typeof fixture>>, writerUntil = 0) {
  return f.t.run(async ctx => {
    const ownerId = await ctx.db.insert('users', {}), clientId = await ctx.db.insert('researchClients', { ownerId, name: 'Synthetic', state: 'active', revision: 0, updatedAt: Date.now() });
    const projectId = await ctx.db.insert('researchProjects', { ownerId, clientId, name: 'Synthetic', state: 'active', revision: 0, latestStudyVersion: 1, updatedAt: Date.now() });
    const studyId = await ctx.db.insert('researchStudies', { ownerId, clientId, projectId, version: 1, createdAt: Date.now(), definition: { title: 'Synthetic', introduction: 'Synthetic only', goals: ['Observe'], script: [{ id: 'q1', question: 'Observe' }], prototypeUrl: null, repository: null } });
    const sessionId = await ctx.db.insert('researchSessions', { ownerId, clientId, projectId, studyId, state: 'partial', revision: 0, nextQuestion: 0, sourceCount: 0, consent: null, consentAt: null, createdAt: Date.now(), savedAt: Date.now(), retainUntil: Date.now() });
    const captureId = await ctx.db.insert('researchCaptures', { sessionId, ownerId, clientId, projectId, state: 'purging', startedAt: Date.now(), deadline: Date.now(), retainUntil: Date.now(), reservedBytes: 20, segmentCount: 1, consentEpoch: 1, revokedThrough: { microphone: 1, screen: 1, camera: 1, dom: 1 }, domCount: 0, domLastAt: 0, domGeneration: 0, domGenerationStart: 0, domChallengeHash: null, domOrigin: null });
    const mediaId = await ctx.db.insert('researchMedia', { captureId, sessionId, clientId, projectId, requestId: 'synthetic', descriptor: { modality: 'screen', sequence: 0, startMs: 0, endMs: 1000, bytes: 20, sha256: 'a'.repeat(64), mime: 'video/webm', questionId: 'q1', sourceId: null }, state: 'delete-pending', sourceId: 'synthetic', consentEpoch: 1, objectKey: `research/${sessionId}/synthetic-a0`, attempt: 0, retiredKeys: [], retryUntil: Date.now(), claimUntil: Date.now(), recordedAt: Date.now(), availableAt: null, expiresAt: Date.now(), leaseUntil: writerUntil, deletedAt: null });
    return { mediaId, captureId };
  });
}
const claims = async (f: Awaited<ReturnType<typeof fixture>>, input: ReturnType<typeof f.id>) => { await f.t.mutation(api.researchGatewayLeases.beginWork, { ...input, proof: await signGateway(secret, 'lease-begin', input) }); return f.t.mutation(api.captureGateway.claimCleanup, { ...input, proof: await signGateway(secret, 'cleanup-claim', input) }); };
const finish = async (f: Awaited<ReturnType<typeof fixture>>, input: any) => f.t.mutation(api.captureGateway.finishCleanup, { ...input, proof: await signGateway(secret, 'cleanup-finish', input) });
it('fences writers, duplicate batches, stale claim/attempt/key and exact conditional completion', async () => {
  const f = await fixture(), row = await media(f, Date.now() + 1000), l1 = (await f.acquire(1, 'cleanup'))!;
  expect(await claims(f, f.id(l1))).toEqual([]); await f.release(f.id(l1)); await vi.advanceTimersByTimeAsync(1001);
  const l2 = (await f.acquire(2, 'cleanup'))!, [claim] = await claims(f, f.id(l2)); expect(claim.operations).toBe(4); expect(await claims(f, f.id(l2))).toEqual([]);
  const base = { ...f.id(l2), claim, retired: true };
  expect(await finish(f, { ...base, claim: { ...claim, key: 'research/foreign/key' } })).toBe(false);
  expect(await finish(f, { ...base, claim: { ...claim, attempt: 1 } })).toBe(false);
  expect(await finish(f, base)).toBe(true); expect(await finish(f, base)).toBe(false);
  expect((await f.t.run(ctx => ctx.db.get(row.mediaId)))!.state).toBe('deleted'); expect((await f.t.run(ctx => ctx.db.get(row.captureId)))!.reservedBytes).toBe(0);
});
it('retains unknown/backoff, caps eight cleanup claims and rejects expired completion without claiming retirement', async () => {
  const f = await fixture(), row = await media(f);
  for (let n = 1; n <= 8; n++) {
    const lease = (await f.acquire(n, 'cleanup'))!, [claim] = await claims(f, f.id(lease)); expect(claim).toBeDefined();
    expect(await finish(f, { ...f.id(lease), claim, retired: false })).toBe(false); expect(await claims(f, f.id(lease))).toEqual([]); await f.release(f.id(lease)); await vi.advanceTimersByTimeAsync(2_000_000);
  }
  const last = (await f.acquire(9, 'cleanup'))!; expect(await claims(f, f.id(last))).toEqual([]); const saved = (await f.t.run(ctx => ctx.db.get(row.mediaId)))!;
  expect(saved.state).toBe('delete-pending'); expect(saved.cleanupAttempts).toBe(8); expect(saved.cleanupNextAt).toBe(Number.MAX_SAFE_INTEGER);
  expect((await f.t.run(ctx => ctx.db.get(row.captureId)))!.reservedBytes).toBe(20);
});
it('durable scheduled tick is a zero-call no-op without explicit hosted activation', async () => {
  const f = await fixture(), network = vi.spyOn(globalThis, 'fetch'); await f.t.action(internal.researchGatewayLeases.cleanupTick, {}); expect(network).not.toHaveBeenCalled(); network.mockRestore();
});

it('scheduler HTTP200 cannot release started unknown work or admit a second tick after restart/expiry', async () => {
  const f = await fixture(); vi.stubEnv('RESEARCH_HOSTED_GATEWAY_ORIGIN', 'https://corvo-research-demo.vercel.app'); vi.stubEnv('RESEARCH_HOSTED_GATEWAY_BYPASS_SECRET', 'synthetic-project-automation-secret');
  vi.stubEnv('RESEARCH_HOSTED_GATEWAY_ALLOCATION', 'offline-tick-allocation');
  await f.t.mutation(internal.researchGatewayLeases.provisionAllocation, { allocationId: 'offline-tick-allocation', expiresAt: Date.now() + 600_000, requestLimit: 10, readByteLimit: 100, storageOperationLimit: 10 });
  await media(f);
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const input = JSON.parse(init!.body as string); await f.t.run(ctx => ctx.db.patch(input.leaseId, { workStarted: true }));
    return new Response('synthetic ambiguous200');
  });
  await f.t.action(internal.researchGatewayLeases.cleanupTick, {}); expect(network).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(300_000);
  await f.t.action(internal.researchGatewayLeases.cleanupTick, {}); expect(network).toHaveBeenCalledOnce();
  expect((await f.t.run(ctx => ctx.db.query('researchGatewaySlots').take(4)))[0].workStarted).toBe(true); network.mockRestore();
});
it('claims at most ten objects and cannot complete a past-deadline claim or clear its reserved bytes', async () => {
  const f = await fixture(), row = await media(f); await f.t.run(async ctx => { const current = (await ctx.db.get(row.mediaId))!; const { _id, _creationTime, ...fields } = current; for (let n = 1; n <= 10; n++) await ctx.db.insert('researchMedia', { ...fields, requestId: `synthetic-${n}`, objectKey: `research/${fields.sessionId}/synthetic-${n}-a0` }); });
  const lease = (await f.acquire(1, 'cleanup'))!, batch = await claims(f, f.id(lease)); expect(batch).toHaveLength(10); expect(batch.reduce((n, c) => n + c.operations, 0)).toBe(40);
  await vi.advanceTimersByTimeAsync(230_000); expect(await finish(f, { ...f.id(lease), claim: batch[0], retired: true })).toBe(false);
  expect((await f.t.run(ctx => ctx.db.get(row.captureId)))!.reservedBytes).toBe(20);
});

it('requires started work and a fresh response deadline before reserving cleanup operations', async () => {
  const f = await fixture(), row = await media(f), lease = (await f.acquire(1, 'cleanup'))!, input = f.id(lease);
  expect(await f.t.mutation(api.captureGateway.claimCleanup, { ...input, proof: await signGateway(secret, 'cleanup-claim', input) })).toEqual([]);
  expect((await f.t.run(ctx => ctx.db.get(row.mediaId)))!.cleanupAttempts).toBeUndefined();
  expect(await f.begin(lease)).toBe(true); await vi.advanceTimersByTimeAsync(180_001);
  expect(await f.t.mutation(api.captureGateway.claimCleanup, { ...input, proof: await signGateway(secret, 'cleanup-claim', input) })).toEqual([]);
  expect((await f.t.run(ctx => ctx.db.get(row.mediaId)))!.cleanupAttempts).toBeUndefined();
});
it('a successor lease cannot complete an old object claim even when its owner nonce is deliberately reused', async () => {
  const f = await fixture(); await media(f); const first = (await f.acquire(1, 'cleanup'))!, [claim] = await claims(f, f.id(first)); await f.release(f.id(first));
  const input = { kind: 'cleanup' as const, requestId: nonce(999), owner: first.owner }, second = (await f.t.mutation(api.researchGatewayLeases.acquire, { ...input, proof: await signGateway(secret, 'lease-acquire', input) }))!; expect(await f.begin(second)).toBe(true);
  expect(await finish(f, { ...f.id(second), claim, retired: true })).toBe(false);
});

async function tickFixture() {
  const f = await fixture(), allocationId = 'offline-idle-cleanup';
  await f.t.mutation(internal.researchGatewayLeases.provisionAllocation, { allocationId, expiresAt: Date.now() + 86_400_000, requestLimit: 2000, readByteLimit: 200_000_000, storageOperationLimit: 25 });
  const tick = (n: number) => f.t.mutation(internal.researchGatewayLeases.acquireTick, { allocationId, requestId: nonce(n), owner: nonce(n + 100) });
  const budget = () => f.t.run(ctx => ctx.db.query('researchGatewayAllocations').withIndex('by_allocationId', q => q.eq('allocationId', allocationId)).unique());
  return { ...f, allocationId, tick, budget };
}
it('enabled empty scheduler spends no request allocation and makes no gateway fetch', async () => {
  const f = await tickFixture(); vi.stubEnv('RESEARCH_HOSTED_GATEWAY_ORIGIN', 'https://corvo-research-demo.vercel.app'); vi.stubEnv('RESEARCH_HOSTED_GATEWAY_BYPASS_SECRET', 'synthetic-project-automation-secret'); vi.stubEnv('RESEARCH_HOSTED_GATEWAY_ALLOCATION', f.allocationId);
  const network = vi.spyOn(globalThis, 'fetch');
  try { for (let n = 0; n < 3; n++) await f.t.action(internal.researchGatewayLeases.cleanupTick, {});
    expect(network).not.toHaveBeenCalled(); expect((await f.budget())!.requestsConsumed).toBe(0); expect(await f.t.run(ctx => ctx.db.query('researchGatewaySlots').take(5))).toEqual([]);
  } finally { network.mockRestore(); }
});
it('pages past ten fenced due rows without rewriting them, then binds and claims the eligible eleventh', async () => {
  const f = await tickFixture(), first = await media(f, Date.now() + 50_000);
  const rows = await f.t.run(async ctx => {
    const { _id, _creationTime, ...fields } = (await ctx.db.get(first.mediaId))!; await ctx.db.patch(_id, { cleanupNextAt: Date.now() - 100 });
    const ids = [_id]; for (let n = 1; n <= 10; n++) ids.push(await ctx.db.insert('researchMedia', { ...fields, requestId: `page-${n}`, objectKey: `research/${fields.sessionId}/page-${n}`, cleanupNextAt: Date.now() - 100 + n, leaseUntil: n === 10 ? 0 : fields.leaseUntil })); return ids;
  });
  const before = await f.t.run(ctx => Promise.all(rows.slice(0, 10).map(id => ctx.db.get(id))));
  expect(await f.tick(1)).toBeNull(); expect((await f.budget())!.requestsConsumed).toBe(0); expect((await f.budget())!.cleanupScan?.cursor).toBeTruthy();
  const lease = (await f.tick(2))!; expect(lease).not.toBeNull(); const batch = await claims(f, f.id(lease)); expect(batch.map(c => c.mediaId)).toEqual([rows[10]]);
  expect((await f.budget())!.requestsConsumed).toBe(1); expect(await f.t.run(ctx => Promise.all(rows.slice(0, 10).map(id => ctx.db.get(id))))).toEqual(before);
});
it('wraps a stable scan cutoff to find newly due work and insertions behind the cursor', async () => {
  const f = await tickFixture(), first = await media(f, Date.now() + 100_000);
  const future = await f.t.run(async ctx => {
    const { _id, _creationTime, ...fields } = (await ctx.db.get(first.mediaId))!; await ctx.db.patch(_id, { cleanupNextAt: Date.now() - 100 });
    for (let n = 1; n <= 10; n++) await ctx.db.insert('researchMedia', { ...fields, requestId: `fenced-${n}`, cleanupNextAt: Date.now() - 100 + n });
    return ctx.db.insert('researchMedia', { ...fields, requestId: 'future', cleanupNextAt: Date.now() + 1000, leaseUntil: 0 });
  });
  expect(await f.tick(1)).toBeNull();
  const inserted = await f.t.run(async ctx => { const { _id, _creationTime, ...fields } = (await ctx.db.get(first.mediaId))!; return ctx.db.insert('researchMedia', { ...fields, requestId: 'behind-cursor', cleanupNextAt: Date.now() - 1000, leaseUntil: 0 }); });
  await vi.advanceTimersByTimeAsync(1001); expect(await f.tick(2)).toBeNull(); expect((await f.budget())!.cleanupScan).toBeUndefined();
  const lease = (await f.tick(3))!, batch = await claims(f, f.id(lease)); expect(batch.map(c => c.mediaId)).toContain(inserted);
  await f.release(f.id(lease));
  const next = (await f.tick(4))!; expect((await claims(f, f.id(next))).map(c => c.mediaId)).toContain(future);
});
it('rechecks candidate lifecycle and writer fences at claim time rather than trusting the earlier idle guard', async () => {
  const f = await tickFixture(), row = await media(f), lease = (await f.tick(1))!;
  await f.t.run(ctx => ctx.db.patch(row.mediaId, { state: 'deleted', deletedAt: Date.now() })); expect(await claims(f, f.id(lease))).toEqual([]); await f.release(f.id(lease));
  const fresh = await media(f), second = (await f.tick(2))!; await f.t.run(ctx => ctx.db.patch(fresh.mediaId, { leaseUntil: Date.now() + 60_000 }));
  expect(await claims(f, f.id(second))).toEqual([]); expect((await f.t.run(ctx => ctx.db.get(fresh.mediaId)))!.cleanupAttempts).toBeUndefined();
});
it('retains unknown started cleanup across expiry without charging, moving its row or erasing its scan', async () => {
  const f = await tickFixture(), row = await media(f), lease = (await f.tick(1))!; await claims(f, f.id(lease));
  await vi.advanceTimersByTimeAsync(300_000); const before = await f.t.run(ctx => ctx.db.get(row.mediaId)), budget = await f.budget();
  expect(await f.tick(2)).toBeNull(); expect(await f.t.run(ctx => ctx.db.get(row.mediaId))).toEqual(before); expect(await f.budget()).toEqual(budget);
  expect((await f.t.run(ctx => ctx.db.get(lease.leaseId)))!.workStarted).toBe(true);
});

it('uses only header automation bypass on the pinned origin and preserves independent native cleanup signature', async () => {
  const f = await tickFixture(); await media(f);
  const origin = 'https://corvo-research-demo.vercel.app', bypass = 'synthetic-protected-project-credential';
  vi.stubEnv('RESEARCH_HOSTED_GATEWAY_ORIGIN', origin); vi.stubEnv('RESEARCH_HOSTED_GATEWAY_ALLOCATION', f.allocationId); vi.stubEnv('RESEARCH_HOSTED_GATEWAY_BYPASS_SECRET', bypass);
  const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  try {
    await f.t.action(internal.researchGatewayLeases.cleanupTick, {}); expect(network).toHaveBeenCalledOnce(); expect((await f.budget())!.requestsConsumed).toBe(1);
    const [url, init] = network.mock.calls[0];
    expect(String(url)).toBe(`${origin}/api/research/internal/cleanup`); expect(new URL(String(url)).search).toBe(''); expect(init!.redirect).toBe('error');
    const headers = new Headers(init!.headers), input = JSON.parse(init!.body as string);
    expect(headers.get('x-vercel-protection-bypass')).toBe(bypass); expect(headers.has('x-vercel-set-bypass-cookie')).toBe(false); expect(headers.has('cookie')).toBe(false);
    expect(headers.get('Origin')).toBe(origin); expect(JSON.stringify(input)).not.toContain(bypass);
    await expect(verifyGateway(secret, 'cleanup-tick', input, { at: Number(headers.get('X-Research-Cleanup-At')), signature: headers.get('X-Research-Cleanup-Proof')! })).resolves.toBeUndefined();
    const lease = (await f.t.run(ctx => ctx.db.get(input.leaseId)))!; expect(lease.kind).toBe('cleanup'); expect(lease.requestId).toBe(input.requestId); expect(lease.generation).toBe(input.generation);
  }
  finally { network.mockRestore(); }
});
it('missing/malformed bypass and alternate/redirect-like origins stop before admission even when cleanup is due', async () => {
  const f = await tickFixture(); await media(f); vi.stubEnv('RESEARCH_HOSTED_GATEWAY_ALLOCATION', f.allocationId);
  vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', 'ambient-vercel-secret-must-not-be-inherited');
  const network = vi.spyOn(globalThis, 'fetch');
  try {
    for (const [origin, bypass] of [
      ['https://corvo-research-demo.vercel.app', ''],
      ['https://corvo-research-demo.vercel.app', 'injected\r\nOther: value'],
      ['https://corvo-research-demo.vercel.app', ' leading-space'],
      ['https://corvo-research-demo.vercel.app', 'x'.repeat(4097)],
      ['https://other.vercel.app', 'synthetic-secret'],
      ['https://corvo-research-demo.vercel.app.evil.example', 'synthetic-secret'],
      ['https://corvo-research-demo.vercel.app?x=1', 'synthetic-secret'],
      ['https://corvo-research-demo.vercel.app/', 'synthetic-secret'],
    ]) { vi.stubEnv('RESEARCH_HOSTED_GATEWAY_ORIGIN', origin); vi.stubEnv('RESEARCH_HOSTED_GATEWAY_BYPASS_SECRET', bypass); await f.t.action(internal.researchGatewayLeases.cleanupTick, {}); }
    expect(network).not.toHaveBeenCalled(); expect((await f.budget())!.requestsConsumed).toBe(0); expect(await f.t.run(ctx => ctx.db.query('researchGatewaySlots').take(5))).toEqual([]);
  } finally { network.mockRestore(); }
});
