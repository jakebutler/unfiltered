import { convexTest } from 'convex-test';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { makeFunctionReference } from 'convex/server';
import schema from '../../../convex/schema';
import { api, internal } from '../../../convex/_generated/api';
import { hashCapability } from '../../../convex/access';
import { resolveEvidence } from '../../../convex/reportAccess';
import { signGateway } from '../../research-capture/src/proof';
import { saveTranscript, settle as settleMutation } from '../../../convex/researchSpeech';
const modules = import.meta.glob('../../../convex/**/*.ts');
const secret = 'c'.repeat(64), token = 'a'.repeat(64);
const consent = { version: 'research-consent-1' as const, storage: true, analysis: true, microphone: true, camera: false, screen: false, shareTranscript: true, shareAudio: false, shareCamera: false, shareScreen: false, retainApprovedExcerpts: false };
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv('RESEARCH_MEDIA_GATEWAY_SECRET', secret); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function fixture(interview = false) {
  const t = convexTest(schema, modules);
  const ownerId = await t.run(async ctx => { const id = await ctx.db.insert('users', { email: 'synthetic@corvo.example' }); await ctx.db.insert('researchOperators', { userId: id, role: 'operator', name: 'Operator', active: true }); return id; });
  const authId = await t.run(ctx => ctx.db.insert('authSessions', { userId: ownerId, expirationTime: Date.now() + 3600000 })), op = t.withIdentity({ subject: `${ownerId}|${authId}` });
  const clientId = await op.mutation(api.research.createClient, { name: 'Synthetic' }), projectId = await op.mutation(api.research.createProject, { clientId, name: 'Continuous voice' });
  await op.mutation(api.research.saveStudy, { clientId, projectId, expectedRevision: 0, definition: { title: 'Checkout', introduction: 'Synthetic', goals: ['Observe delivery'], script: [{ id: 'q1', question: 'What did you expect?' }, { id: 'q2', question: 'What happened?' }], prototypeUrl: null, repository: null } });
  const invite = await op.mutation(internal.invitations.issue, { clientId, projectId, studyVersion: 1, requestId: 'spoken-invite', tokenHash: await hashCapability(token) });
  if (interview) await t.mutation(internal.researchInterview.provision, { enabled: true, allocatedCalls: 6, maxSessionCalls: 6, model: 'qwen3.8-max', maxInputBytes: 64000, maxOutputTokens: 128, expiresAt: Date.now() + 600000 });
  await t.mutation(api.participant.agree, { token, expectedRevision: 0, consent });
  // Preserve the actual legacy fixture's disabled/consumed shape in this isolated DB.
  const legacyId = await t.run(ctx => ctx.db.insert('researchSpeechPolicy', { name: 'demo', enabled: false, qualification: 'root-reviewed-synthetic-speech', allocatedSeconds: 120, allocatedCharacters: 400, chargedSeconds: 60, chargedCharacters: 35, maxSessionSeconds: 120, maxSessionCharacters: 200 }));
  const studyId = (await t.run(ctx => ctx.db.get(invite.sessionId)))!.studyId;
  const grantArgs = { name: 'synthetic-study-grant', studyId, enabled: true, allocatedSeconds: 360, allocatedCharacters: 2400, maxSessionSeconds: 360, maxSessionCharacters: 2400, expiresAt: Date.now() + 600000 };
  const grantId = await t.mutation(internal.researchSpeechGrants.provision, grantArgs);
  await t.mutation(internal.researchGatewayLeases.provisionAllocation, { allocationId: 'synthetic-voice-ingress', expiresAt: Date.now() + 600000, requestLimit: 100, readByteLimit: 1, storageOperationLimit: 1 });
  const scope = { sessionId: invite.sessionId, promptId: 'q1', expectedRevision: 1, requestId: 'spoken-attempt-one' };
  let ordinal = 0;
  const speech = async (name: string, args: any, read = false) => { const input = { ...args, proof: await signGateway(secret, `speech:${name}`, args) }; return read ? t.query(makeFunctionReference<'query'>(`researchSpeech:${name}`), input) : t.mutation(makeFunctionReference<'mutation'>(`researchSpeech:${name}`), input); };
  const native = async (name: string, operation: string, args: any) => t.mutation(makeFunctionReference<'mutation'>(`researchGatewayLeases:${name}`), { ...args, proof: await signGateway(secret, operation, args) });
  async function lease() {
    const row = await native('acquireAllocated', 'lease-acquire-allocated', { allocationId: 'synthetic-voice-ingress', kind: 'voice', requestId: (++ordinal).toString(16).padStart(32, '0'), owner: 'd'.repeat(32) });
    const identity = { leaseId: row.leaseId, requestId: row.requestId, owner: row.owner, generation: row.generation };
    expect(await native('beginWork', 'lease-begin', identity)).toBe(true); return identity;
  }
  const reserve = async (next = scope, provider = 'deepgram') => { const identity = await lease(); await speech('reserve', { token, scope: next, provider, maxAudioSeconds: provider === 'deepgram' ? 60 : 0, maxCharacters: provider === 'deepgram' ? 0 : 20, transportLease: identity }); return identity; };
  const release = (identity: Awaited<ReturnType<typeof lease>>) => native('release', 'lease-release', identity);
  const save = (next = scope, text = 'Delivery cost was unclear.') => speech('saveTranscript', { token, scope: next, text, outcome: 'completed' });
  const settle = (next = scope, outcome = 'completed', provider = 'deepgram') => speech('settle', { sessionId: next.sessionId, requestId: next.requestId, provider, outcome });
  const commit = (next = scope) => speech('commitSpoken', { token, scope: next });
  const snapshot = () => t.query(api.participant.reviewSnapshot, { token });
  const confirm = async () => { const s = await snapshot(); return t.mutation(api.participant.confirmFinalReview, { token, expectedRevision: s.revision, answerGeneration: s.answerGeneration, manifestHash: s.manifestHash, requestId: 'review-synthetic-1' }); };
  async function evidence(sourceId: string) {
    return t.run(async ctx => { const row = await ctx.db.query('researchSources').withIndex('by_sessionId_and_sourceId', q => q.eq('sessionId', scope.sessionId).eq('sourceId', sourceId)).unique(); return resolveEvidence(ctx, { ownerId, clientId, projectId }, { sessionId: scope.sessionId, id: String(row!._id), kind: 'self-report', start: 0, end: row!.text.length }); });
  }
  const spoken = async () => { const identity = await reserve(); const raw = await save(); await settle(); await release(identity); return { raw, committed: await commit(), identity }; };
  return { t, op, native, lease, clientId, projectId, scope, speech, reserve, release, save, settle, commit, snapshot, confirm, evidence, spoken, grantId, grantArgs, legacyId, invite };
}

const recovery = makeFunctionReference<'mutation'>('researchSpeechRecovery:fenceStoppedAttempt');
const evidence = 'e'.repeat(64), allocationId = 'synthetic-voice-ingress';
async function recoveryFixture() {
  const f = await fixture(), identity = await f.reserve();
  const input = { sessionId: f.scope.sessionId, requestId: f.scope.requestId, provider: 'deepgram' as const, expectedState: 'reserved' as const, transportLease: identity, allocationId, providerCloseEvidenceSha256: evidence };
  const disable = () => f.t.mutation(internal.researchSpeechGrants.disable, { name: f.grantArgs.name });
  const rows = () => f.t.run(async ctx => ({ attempt: (await ctx.db.query('researchSpeechAttempts').withIndex('by_sessionId_and_requestId', q => q.eq('sessionId', f.scope.sessionId).eq('requestId', f.scope.requestId)).unique())!, slot: (await ctx.db.get(identity.leaseId))!, grant: (await ctx.db.get(f.grantId))!, budget: (await ctx.db.query('researchSpeechGrantBudgets').withIndex('by_grantId_and_sessionId', q => q.eq('grantId', f.grantId).eq('sessionId', f.scope.sessionId)).unique())!, sources: await ctx.db.query('researchSources').withIndex('by_sessionId_and_sequence', q => q.eq('sessionId', f.scope.sessionId)).collect() }));
  return { ...f, identity, input, disable, rows, fence: (patch = {}) => f.t.mutation(recovery, { ...input, ...patch }) };
}
test('exact atomic recovery preserves full charges and committed raw text; stale authority and writes remain fenced after successor admission', async () => {
  const f = await recoveryFixture(), raw = await f.save(); await f.disable();
  // Real admitted authority counters survive recovery unchanged.
  expect(await f.native('reserveOperation', 'lease-reserve-operation', { ...f.identity, ordinal: 1, kind: 'authority', readBytes: 0 })).toBe(true);
  const before = await f.rows(), result = await f.fence(), after = await f.rows();
  expect(result).toMatchObject({ state: 'unknown', active: false, rawSourceId: raw.rawSourceId, acceptedSourceId: null, fencedGeneration: f.identity.generation + 1 });
  expect(after.grant).toEqual(before.grant); expect(after.budget).toEqual(before.budget); expect(after.sources).toEqual(before.sources);
  expect(after.attempt).toMatchObject({ reservedSeconds: 60, reservedCharacters: 0, rawSourceId: raw.rawSourceId, transportFence: { previousState: 'reserved', evidenceSha256: evidence, allocationId, observedGeneration: f.identity.generation + 1 }, active: false, state: 'unknown' });
  expect(after.attempt.occupancyRelease).toBeUndefined();
  expect(after.slot).toEqual({ ...before.slot, generation: f.identity.generation + 1, expiresAt: 0, workStarted: false });
  expect(await f.speech('readTranscript', { token, scope: f.scope }, true)).toEqual(raw);
  expect(await f.speech('terminalBarrier', { token, scope: f.scope }, true)).toMatchObject({ state: 'unknown', active: false, rawSaved: true, transportSettled: false });
  await expect(f.save()).rejects.toThrow(); await expect(f.settle()).rejects.toThrow(); await expect(f.commit()).rejects.toThrow();
  await expect(f.speech('inspect', { token, scope: f.scope, provider: 'deepgram' }, true)).rejects.toThrow();
  await expect(f.t.mutation(api.participant.answer, { token, expectedRevision: 1, requestId: 'late-manual-accept', questionId: 'q1', text: raw.text, channel: 'confirmed-transcript', speechAttemptId: f.scope.requestId })).rejects.toThrow();
  for (const [name, operation, extra] of [['beginWork', 'lease-begin', {}], ['reserveOperation', 'lease-reserve-operation', { ordinal: 2, kind: 'authority', readBytes: 0 }], ['release', 'lease-release', {}]] as const) expect(await f.native(name, operation, { ...f.identity, ...extra })).toBe(false);
  // A successor must have a distinct prospective grant and exact started lease.
  const nextGrant = await f.t.mutation(internal.researchSpeechGrants.provision, { ...f.grantArgs, name: 'synthetic-successor-grant' });
  const next = { ...f.scope, requestId: 'successor-attempt' }, nextIdentity = await f.reserve(next);
  expect(nextIdentity.generation).toBeGreaterThan(result.fencedGeneration);
  const successorBefore = await f.t.run(ctx => ctx.db.get(nextIdentity.leaseId));
  expect(await f.fence()).toEqual(result); expect(await f.t.run(ctx => ctx.db.get(nextIdentity.leaseId))).toEqual(successorBefore);
  await expect(f.save()).rejects.toThrow(); await expect(f.settle()).rejects.toThrow(); await expect(f.commit()).rejects.toThrow();
  expect((await f.rows()).attempt).toEqual(after.attempt);
  expect(await f.t.run(ctx => ctx.db.get(nextGrant))).toMatchObject({ chargedSeconds: 60 });
  expect((await f.rows()).grant.chargedSeconds).toBe(60);
});
test('mismatched owner/generation/lease request/attempt/state/allocation/evidence and enabled grant reject atomically; exact replay is immutable', async () => {
  const f = await recoveryFixture(); const before = await f.rows();
  await expect(f.fence()).rejects.toThrow(); expect(await f.rows()).toEqual(before); await f.disable();
  const disabled = await f.rows();
  for (const patch of [
    { transportLease: { ...f.identity, owner: 'f'.repeat(32) } }, { transportLease: { ...f.identity, generation: f.identity.generation + 1 } }, { transportLease: { ...f.identity, requestId: 'f'.repeat(32) } },
    { requestId: 'wrong-attempt' }, { expectedState: 'completed' }, { allocationId: 'wrong-allocation' }, { providerCloseEvidenceSha256: 'bad' },
  ]) { await expect(f.fence(patch)).rejects.toThrow(); expect(await f.rows()).toEqual(disabled); }
  const result = await f.fence(), fenced = await f.rows(); expect(await f.fence()).toEqual(result); expect(await f.rows()).toEqual(fenced);
  for (const patch of [{ expectedState: 'unknown' }, { allocationId: 'wrong-allocation' }, { providerCloseEvidenceSha256: 'f'.repeat(64) }]) { await expect(f.fence(patch)).rejects.toThrow(); expect(await f.rows()).toEqual(fenced); }
});
test('already committed accepted IDs, sources and known provider completion survive fencing without admitting a new acceptance', async () => {
  const f = await recoveryFixture(), raw = await f.save(); await f.settle(); await f.release(f.identity); const accepted = await f.commit(); await f.disable();
  const before = await f.rows(); await f.fence({ expectedState: 'completed' }); const after = await f.rows();
  expect(after.attempt).toMatchObject({ state: 'completed', active: false, rawSourceId: raw.rawSourceId, acceptedSourceId: accepted.answerSourceId, acceptedRevision: accepted.acceptedRevision });
  expect(after.sources).toEqual(before.sources); expect(after.grant).toEqual(before.grant); expect(after.budget).toEqual(before.budget);
  await expect(f.commit()).rejects.toThrow();
  // Final review and human corrections operate on preserved accepted sources.
  expect((await f.snapshot()).answers).toMatchObject([{ sourceId: accepted.answerSourceId, text: raw.text }]); await f.confirm();
  expect((await f.snapshot()).reviewedCurrent).toBe(true);
});
test('generation drift alone rejects hosted save/settle at commit; missing hosted identity cannot select legacy local policy', async () => {
  const f = await recoveryFixture(); await f.t.run(ctx => ctx.db.patch(f.identity.leaseId, { generation: f.identity.generation + 1 }));
  await expect(f.save()).rejects.toThrow(); await expect(f.settle()).rejects.toThrow();
  await f.t.run(async ctx => { const a = await ctx.db.query('researchSpeechAttempts').withIndex('by_sessionId_and_requestId', q => q.eq('sessionId', f.scope.sessionId).eq('requestId', f.scope.requestId)).unique(); await ctx.db.patch(a!._id, { transportLease: undefined, grantId: undefined }); });
  vi.stubEnv('CONVEX_SITE_URL', 'https://synthetic.convex.site');
  await expect(f.save()).rejects.toThrow(); await expect(f.settle()).rejects.toThrow();
});

test('pre-fence save and settle proposals read the exact voice row; simulated OCC conflict retries reject after fence', async () => {
  // convex-test serializes transactions and does not simulate Convex OCC. Run
  // actual mutation handlers in rolled-back pre-fence proposals, inspect their
  // read set, then execute the actual retry against committed fencing state.
  for (const name of ['saveTranscript', 'settle'] as const) {
    const f = await recoveryFixture(), before = await f.rows(), reads = new Set<string>();
    const args = name === 'saveTranscript' ? { token, scope: f.scope, text: 'Synthetic pre-fence transcript.', outcome: 'completed' as const } : { sessionId: f.scope.sessionId, requestId: f.scope.requestId, provider: 'deepgram' as const, outcome: 'completed' as const };
    const input = { ...args, proof: await signGateway(secret, `speech:${name}`, args) };
    await expect(f.t.run(async ctx => {
      const db = new Proxy(ctx.db, { get(target, key) {
        const member = Reflect.get(target, key);
        return key === 'get' ? async (id: any) => { reads.add(String(id)); return target.get(id); } : typeof member === 'function' ? member.bind(target) : member;
      } });
      if (name === 'saveTranscript') await saveTranscript._handler({ ...ctx, db }, input as Parameters<typeof saveTranscript._handler>[1]);
      else await settleMutation._handler({ ...ctx, db }, input as Parameters<typeof settleMutation._handler>[1]);
      throw new Error('Discard pre-fence proposal to simulate OCC conflict');
    })).rejects.toThrow('Discard pre-fence proposal');
    expect(reads.has(String(f.identity.leaseId))).toBe(true); expect(await f.rows()).toEqual(before);
    await f.disable(); await f.fence();
    await expect(f.speech(name, args)).rejects.toThrow();
    expect((await f.rows()).sources).toEqual(before.sources);
    expect((await f.rows()).attempt).toMatchObject({ state: 'unknown', active: false, rawSourceId: null, acceptedSourceId: null });
  }
});
test('settlement committed before fence requires a refreshed exact state; stale reserved expectation cannot overwrite the known outcome', async () => {
  const f = await recoveryFixture(); await f.settle(f.scope, 'failed'); await f.disable(); const before = await f.rows();
  await expect(f.fence()).rejects.toThrow(); expect(await f.rows()).toEqual(before);
  expect(await f.fence({ expectedState: 'failed' })).toMatchObject({ state: 'failed', active: false });
  expect((await f.rows()).grant).toEqual(before.grant); expect((await f.rows()).budget).toEqual(before.budget);
});
