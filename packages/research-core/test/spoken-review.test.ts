import { convexTest } from 'convex-test';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { makeFunctionReference } from 'convex/server';
import schema from '../../../convex/schema';
import { api, internal } from '../../../convex/_generated/api';
import { hashCapability } from '../../../convex/access';
import { resolveEvidence } from '../../../convex/reportAccess';
import { signGateway } from '../../research-capture/src/proof';
import { RESEARCH_LIMITS } from '../src/limits';
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
  return { t, op, clientId, projectId, scope, speech, reserve, release, save, settle, commit, snapshot, confirm, evidence, spoken, grantId, grantArgs, legacyId, invite };
}
test('automatic spoken commit waits for native transport release, persists unreviewed provenance once and replays original receipt after progression', async () => {
  const f = await fixture(), identity = await f.reserve(), raw = await f.save(); await f.settle();
  expect(await f.speech('terminalBarrier', { token, scope: f.scope }, true)).toMatchObject({ state: 'completed', active: false, rawSaved: true, transportSettled: false });
  await expect(f.commit()).rejects.toThrow('settle');
  await f.release(identity); const committed = await f.commit(); expect(await f.commit()).toEqual(committed);
  const s = await f.snapshot(); expect(s.answers).toMatchObject([{ sourceId: committed.answerSourceId, channel: 'spoken-answer', text: raw.text }]);
  expect(s.answerGeneration).toBe(1); expect(s.reviewedCurrent).toBe(false);
  expect((await f.t.query(api.participant.resume, { token })).question?.id).toBe('q2');
  await expect(f.evidence(raw.rawSourceId)).rejects.toThrow(); await expect(f.evidence(committed.answerSourceId)).rejects.toThrow();
  const inventory = { clientId: f.clientId, projectId: f.projectId, sessionId: f.scope.sessionId, kind: 'self-report' as const, paginationOpts: { numItems: 25, cursor: null } };
  expect((await f.op.query(api.researchAnalysis.inventory, inventory)).page).toEqual([]);
  await f.confirm(); expect((await f.op.query(api.researchAnalysis.inventory, inventory)).page).toMatchObject([{ label: expect.stringContaining('Participant-reviewed spoken answer'), text: raw.text }]);
});
test('final review binds exact visible wording and effective IDs; incidental pause preserves review but correction invalidates it', async () => {
  const f = await fixture(), { committed, raw } = await f.spoken(), before = await f.snapshot();
  await expect(f.t.mutation(api.participant.confirmFinalReview, { token, expectedRevision: before.revision, answerGeneration: before.answerGeneration, manifestHash: 'f'.repeat(64), requestId: 'wrong-review-hash' })).rejects.toThrow('wording changed');
  await f.confirm(); expect(await f.evidence(committed.answerSourceId)).toMatchObject({ text: raw.text });
  const after = await f.snapshot(); await f.t.mutation(api.participant.transition, { token, expectedRevision: after.revision, state: 'paused' });
  expect((await f.snapshot()).reviewedCurrent).toBe(true);
  const paused = await f.snapshot(); const corrected = await f.t.mutation(api.participant.correct, { token, expectedRevision: paused.revision, sourceId: committed.answerSourceId, text: 'Delivery cost was clear.', requestId: 'correct-spoken-1' });
  const current = await f.snapshot(); expect(current.answerGeneration).toBe(2); expect(current.reviewedCurrent).toBe(false); expect(current.answers).toMatchObject([{ sourceId: corrected.sourceId, channel: 'text', text: 'Delivery cost was clear.' }]);
  await expect(f.evidence(committed.answerSourceId)).rejects.toThrow(); expect(await f.evidence(corrected.sourceId)).toMatchObject({ text: 'Delivery cost was clear.' });
  await expect(f.evidence(raw.rawSourceId)).rejects.toThrow();
});
test('new typed answers invalidate prior spoken review; abandoned partial exit does not require confirmation', async () => {
  const f = await fixture(), { committed } = await f.spoken(); await f.confirm(); const before = await f.snapshot();
  await f.t.mutation(api.participant.answer, { token, expectedRevision: before.revision, questionId: 'q2', requestId: 'typed-answer-two', text: 'I wanted a receipt.', channel: 'text' });
  const after = await f.snapshot(); expect(after.answerGeneration).toBe(2); expect(after.reviewedCurrent).toBe(false); await expect(f.evidence(committed.answerSourceId)).rejects.toThrow();
  await expect(f.t.mutation(api.participant.transition, { token, expectedRevision: after.revision, state: 'completed' })).rejects.toThrow('Review');
  expect(await f.t.mutation(api.participant.transition, { token, expectedRevision: after.revision, state: 'partial' })).toBe(after.revision + 1);
});
test('spoken answers drive goal-aware pending state honestly and cannot be final-reviewed while pending', async () => {
  const f = await fixture(true), { committed } = await f.spoken(), s = await f.t.query(api.participant.resume, { token });
  expect(s.question).toBeNull(); expect(s.pendingInterview?.scope.answerSourceId).toBe(committed.answerSourceId);
  const args = { token, scope: s.pendingInterview!.scope };
  expect(await f.t.query(api.researchInterview.inspect, { ...args, proof: await signGateway(secret, 'interview:inspect', args) })).toMatchObject({ answer: { channel: 'spoken-answer', text: 'Delivery cost was unclear.' } });
  await expect(f.confirm()).rejects.toThrow('pending');
});
test('unknown provider and expired-but-started transport never become settled; TTS barrier separates transport from provider occupancy', async () => {
  const f = await fixture(), identity = await f.reserve(); await f.save(); await f.settle(f.scope, 'unknown');
  vi.advanceTimersByTime(300000);
  expect(await f.speech('terminalBarrier', { token, scope: f.scope }, true)).toMatchObject({ state: 'unknown', active: true, transportSettled: false });
  await expect(f.commit()).rejects.toThrow(); await f.release(identity);
  expect(await f.speech('terminalBarrier', { token, scope: f.scope }, true)).toMatchObject({ state: 'unknown', active: true, transportSettled: true }); await expect(f.commit()).rejects.toThrow();
  const next = { ...f.scope, requestId: 'tts-attempt-one' }, tts = await f.reserve(next, 'elevenlabs'); await f.settle(next, 'unknown', 'elevenlabs'); await f.release(tts);
  expect(await f.speech('terminalBarrier', { token, scope: next, provider: 'elevenlabs' }, true)).toMatchObject({ state: 'unknown', active: true, rawSaved: false, transportSettled: true });
});
test('named grants preserve disabled legacy charges, refuse reset and scope authority to the study; counters persist on failure', async () => {
  const f = await fixture(); await f.reserve(); await f.settle(f.scope, 'unknown');
  expect(await f.t.run(ctx => ctx.db.get(f.legacyId))).toMatchObject({ enabled: false, chargedSeconds: 60, chargedCharacters: 35 });
  expect(await f.t.run(ctx => ctx.db.get(f.grantId))).toMatchObject({ chargedSeconds: 60, chargedCharacters: 0 });
  await expect(f.t.mutation(internal.researchSpeechGrants.provision, f.grantArgs)).rejects.toThrow('reset');
  await f.t.mutation(internal.researchSpeechGrants.disable, { name: f.grantArgs.name }); expect(await f.speech('status', { token }, true)).toEqual({ enabled: false });
  expect(await f.t.run(ctx => ctx.db.get(f.grantId))).toMatchObject({ enabled: false, chargedSeconds: 60 });
  await expect(f.t.mutation(internal.researchSpeechGrants.provision, { ...f.grantArgs, name: 'oversized-grant', allocatedSeconds: 5401 })).rejects.toThrow('Invalid');
});
test('continuous admission needs an allocated started voice lease; reused generation proves settlement and selected content must still match review', async () => {
  const f = await fixture();
  await expect(f.speech('reserve', { token, scope: f.scope, provider: 'deepgram', maxAudioSeconds: 60, maxCharacters: 0 })).rejects.toThrow();
  expect(await f.t.run(ctx => ctx.db.get(f.grantId))).toMatchObject({ chargedSeconds: 0 });
  const identity = await f.reserve(); await f.save(); await f.settle(); await f.release(identity);
  const next = { ...f.scope, requestId: 'next-tts-binding' }, reused = await f.reserve(next, 'elevenlabs');
  expect(reused.generation).toBeGreaterThan(identity.generation);
  expect(await f.speech('terminalBarrier', { token, scope: f.scope }, true)).toMatchObject({ transportSettled: true });
  const committed = await f.commit(); await f.settle(next, 'failed', 'elevenlabs'); await f.release(reused); await f.confirm();
  await f.t.run(async ctx => { const row = await ctx.db.query('researchSources').withIndex('by_sessionId_and_sourceId', q => q.eq('sessionId', f.scope.sessionId).eq('sourceId', committed.answerSourceId)).unique(); await ctx.db.patch(row!._id, { text: 'Changed without participant review' }); });
  expect((await f.snapshot()).reviewedCurrent).toBe(false); await expect(f.evidence(committed.answerSourceId)).rejects.toThrow();
});
test('corrupt source overflow fails closed and full 90-turn raw/answer/prompt budget fits the finite source ceiling', async () => {
  expect(90 * 3).toBeLessThan(RESEARCH_LIMITS.sourceCount);
  const f = await fixture(); await f.t.run(async ctx => { const base = await ctx.db.query('researchSources').withIndex('by_sessionId_and_sequence', q => q.eq('sessionId', f.scope.sessionId)).first(); const { _id, _creationTime, ...row } = base!; for (let i = 1; i <= RESEARCH_LIMITS.sourceCount; i++) await ctx.db.insert('researchSources', { ...row, sequence: i, sourceId: `corrupt-${i}`, requestId: `corrupt-request-${i}` }); await ctx.db.patch(f.scope.sessionId, { sourceCount: RESEARCH_LIMITS.sourceCount + 1 }); });
  await expect(f.snapshot()).rejects.toThrow('snapshot');
});
test('correcting the first answer preserves displayed prompt order and hashes exact question wording', async () => {
  const f = await fixture(), { committed } = await f.spoken(), first = await f.snapshot();
  await f.t.mutation(api.participant.answer, { token, expectedRevision: first.revision, questionId: 'q2', requestId: 'ordered-answer-two', text: 'The receipt arrived.', channel: 'text' });
  const before = await f.snapshot(); await f.confirm(); const reviewed = await f.snapshot();
  const correction = await f.t.mutation(api.participant.correct, { token, expectedRevision: reviewed.revision, sourceId: committed.answerSourceId, requestId: 'ordered-correction-one', text: 'Delivery cost was clear.' });
  const after = await f.snapshot();
  expect(after.answers.map(answer => [answer.questionId, answer.question, answer.text])).toEqual([['q1', 'What did you expect?', 'Delivery cost was clear.'], ['q2', 'What happened?', 'The receipt arrived.']]);
  expect(after.answers[0].sourceId).toBe(correction.sourceId); expect(after.answers[0].sequence).toBeGreaterThan(after.answers[1].sequence);
  expect(after.manifestHash).not.toBe(before.manifestHash); expect(after.reviewedCurrent).toBe(false);
  const oldHash = after.manifestHash;
  await f.t.run(async ctx => { const prompt = await ctx.db.query('researchSources').withIndex('by_sessionId_and_sourceId', q => q.eq('sessionId', f.scope.sessionId).eq('sourceId', after.answers[0].promptSourceId)).unique(); await ctx.db.patch(prompt!._id, { text: 'Changed prompt wording' }); });
  const changed = await f.snapshot(); expect(changed.answers[0].question).toBe('Changed prompt wording'); expect(changed.manifestHash).not.toBe(oldHash);
});
test('ambiguous duplicate question association fails closed in the bounded snapshot', async () => {
  const f = await fixture(); await f.spoken();
  await f.t.run(async ctx => {
    const session = await ctx.db.get(f.scope.sessionId), prompt = await ctx.db.query('researchSources').withIndex('by_sessionId_and_sequence', q => q.eq('sessionId', f.scope.sessionId)).first();
    const { _id, _creationTime, ...row } = prompt!;
    await ctx.db.insert('researchSources', { ...row, sourceId: 'ambiguous-q1-prompt', requestId: 'ambiguous-prompt-request', sequence: session!.sourceCount });
    await ctx.db.patch(session!._id, { sourceCount: session!.sourceCount + 1 });
  });
  await expect(f.snapshot()).rejects.toThrow('Question association');
});

async function attemptRow(f: Awaited<ReturnType<typeof fixture>>) {
  return f.t.run(ctx => ctx.db.query('researchSpeechAttempts').withIndex('by_sessionId_and_requestId', q => q.eq('sessionId', f.scope.sessionId).eq('requestId', f.scope.requestId)).unique());
}
test.each(['unknown', 'interrupted'])('positive reused-generation proof retires %s occupancy only alongside a new charged turn, without rewriting outcome/raw', async outcome => {
  const f = await fixture(), identity = await f.reserve(), raw = await f.save(); await f.settle(f.scope, outcome); await f.release(identity);
  await expect(f.reserve(f.scope)).rejects.toThrow('replay'); // Native lease acquired by this attempted replay is explicitly disposed below.
  const activeSlots = await f.t.run(ctx => ctx.db.query('researchGatewaySlots').withIndex('by_slot').take(4));
  for (const slot of activeSlots) if (slot.workStarted) await f.release({ leaseId: slot._id, requestId: slot.requestId, owner: slot.owner, generation: slot.generation });
  const next = { ...f.scope, requestId: 'new-distinct-spoken-turn' }, newIdentity = await f.reserve(next);
  expect(await attemptRow(f)).toMatchObject({ state: outcome, active: false, reservedSeconds: 60, rawSourceId: raw.rawSourceId, occupancyRelease: { reason: 'positive-native-transport-settlement', nextRequestId: next.requestId, transportLease: identity, observedGeneration: newIdentity.generation } });
  expect(await f.t.run(ctx => ctx.db.get(f.grantId))).toMatchObject({ chargedSeconds: 120 });
  await expect(f.commit()).rejects.toThrow();
});
test('positive exact identity release is retained in audit and budget denial leaves the old occupancy untouched', async () => {
  const f = await fixture(), old = await f.reserve(); await f.settle(f.scope, 'unknown'); await f.release(old);
  const transportLease = await f.t.run(async ctx => { const leaseId = await ctx.db.insert('researchGatewaySlots', { slot: 99, kind: 'voice', requestId: 'e'.repeat(32), owner: 'd'.repeat(32), generation: 1, expiresAt: Date.now() + 225000, bodyDeadlineAt: Date.now() + 8000, workStarted: true, allocationId: 'synthetic-voice-ingress' }); return { leaseId, requestId: 'e'.repeat(32), owner: 'd'.repeat(32), generation: 1 }; });
  const reserve = () => f.speech('reserve', { token, scope: { ...f.scope, requestId: 'exact-proof-next-turn' }, provider: 'deepgram', maxAudioSeconds: 60, maxCharacters: 0, transportLease });
  await f.t.run(ctx => ctx.db.patch(f.grantId, { allocatedSeconds: 60 }));
  const before = await attemptRow(f); await expect(reserve()).rejects.toThrow('exhausted'); expect(await attemptRow(f)).toEqual(before);
  await f.t.run(ctx => ctx.db.patch(f.grantId, { allocatedSeconds: 360 })); await reserve();
  expect(await attemptRow(f)).toMatchObject({ state: 'unknown', active: false, occupancyRelease: { transportLease: old, observedGeneration: old.generation } });
});
test.each(['reserved', 'legacy', 'missing', 'expiry-only', 'mismatched-owner', 'ambiguous'])('unsafe %s occupancy never recovers, expires, refunds or changes audit', async mode => {
  const f = await fixture(), identity = await f.reserve(); if (mode !== 'reserved') await f.settle(f.scope, 'unknown');
  await f.t.run(async ctx => {
    const row = (await ctx.db.query('researchSpeechAttempts').withIndex('by_sessionId_and_requestId', q => q.eq('sessionId', f.scope.sessionId).eq('requestId', f.scope.requestId)).unique())!;
    if (mode === 'legacy') await ctx.db.patch(row._id, { transportLease: undefined });
    if (mode === 'missing') await ctx.db.delete(identity.leaseId);
    if (mode === 'expiry-only') await ctx.db.patch(identity.leaseId, { expiresAt: Date.now() - 1 });
    if (mode === 'mismatched-owner') await ctx.db.patch(identity.leaseId, { workStarted: false, expiresAt: 0, owner: 'f'.repeat(32) });
    if (mode === 'ambiguous') { const { _id, _creationTime, ...copy } = row; await ctx.db.insert('researchSpeechAttempts', { ...copy, requestId: 'other-unresolved' }); }
  });
  const before = await attemptRow(f);
  await expect(f.speech('reserve', { token, scope: { ...f.scope, requestId: 'blocked-distinct-turn' }, provider: 'deepgram', maxAudioSeconds: 60, maxCharacters: 0 })).rejects.toThrow('occupied');
  expect(await attemptRow(f)).toEqual(before); expect(await f.t.run(ctx => ctx.db.get(f.grantId))).toMatchObject({ chargedSeconds: 60 });
});
