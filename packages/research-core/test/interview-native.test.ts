import { convexTest } from 'convex-test';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { makeFunctionReference } from 'convex/server';
import schema from '../../../convex/schema';
import { api, internal } from '../../../convex/_generated/api';
import { hashCapability } from '../../../convex/access';
import { signGateway } from '../../research-capture/src/proof';
import { hashValue } from '../src/analysis';
import { advanceInterview } from '../src/interview';
import { runInterviewTurn, type InterviewAuthority, type InterviewProvider } from '../../../apps/research-server/src/interview';
const modules = import.meta.glob('../../../convex/**/*.ts'), secret = 'c'.repeat(64), token = 'a'.repeat(64);
const consent = { version: 'research-consent-1' as const, storage: true, analysis: true, microphone: true, camera: false, screen: false, shareTranscript: false, shareAudio: false, shareCamera: false, shareScreen: false, retainApprovedExcerpts: false };
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv('RESEARCH_MEDIA_GATEWAY_SECRET', secret); }); afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function fixture(enabled = true) {
  const t = convexTest(schema, modules), userId = await t.run(async ctx => { const id = await ctx.db.insert('users', { email: 'interview@synthetic.example' }); await ctx.db.insert('researchOperators', { userId: id, role: 'operator', name: 'Synthetic', active: true }); return id; });
  const authId = await t.run(ctx => ctx.db.insert('authSessions', { userId, expirationTime: Date.now() + 3600000 })), op = t.withIdentity({ subject: `${userId}|${authId}` });
  const clientId = await op.mutation(api.research.createClient, { name: 'A' }), projectId = await op.mutation(api.research.createProject, { clientId, name: 'Checkout' });
  await op.mutation(api.research.saveStudy, { clientId, projectId, expectedRevision: 0, definition: { title: 'Synthetic study', introduction: 'Synthetic only', goals: ['Understand delivery'], script: [{ id: 'q1', question: 'What happened?' }, { id: 'q2', question: 'What would you change?' }], prototypeUrl: null, repository: null } });
  if (enabled) await t.mutation(internal.researchInterview.provision, { enabled: true, allocatedCalls: 6, maxSessionCalls: 4, model: 'qwen3.8-max', maxInputBytes: 64000, maxOutputTokens: 128, expiresAt: Date.now() + 600000 });
  const invite = await op.mutation(internal.invitations.issue, { clientId, projectId, studyVersion: 1, requestId: 'interview-invite', tokenHash: await hashCapability(token) });
  await t.mutation(api.participant.agree, { token, expectedRevision: 0, consent });
  const resume = () => t.query(api.participant.resume, { token });
  async function answer(text = 'Delivery cost was unclear.', intent: 'answer' | 'skip' = 'answer') { const s = await resume(); return t.mutation(api.participant.answer, { token, expectedRevision: s.revision, requestId: `answer-${s.revision}`, questionId: s.question!.id, text, channel: 'text', intent }); }
  async function call(name: string, input: Record<string, any>, read = false) { const body = { token, ...input }, args = { ...body, proof: await signGateway(secret, `interview:${name}`, body) }; return read ? t.query(makeFunctionReference<'query'>(`researchInterview:${name}`), args) : t.mutation(makeFunctionReference<'mutation'>(`researchInterview:${name}`), args); }
  const authority: InterviewAuthority = { inspect: scope => call('inspect', { scope }, true), admit: (scope, contextHash) => call('admit', { scope, contextHash }), begin: (scope, attemptId, contextHash, prepared) => call('begin', { scope, attemptId, contextHash, prepared }), finish: (scope, attemptId, contextHash, result) => call('finish', { scope, attemptId, contextHash, result }), advance: (scope, contextHash, decision) => call('advance', { scope, contextHash, decision }) };
  const provider: InterviewProvider = { model: 'qwen3.8-max', prepare: vi.fn(async () => ({ inputHash: 'b'.repeat(64), requestBytes: 1234, maxOutputTokens: 128 })), generate: vi.fn(async (_messages, reservation) => ({ requestId: 'offline-only', proposal: { decision: 'follow-up', question: 'Where did you look for delivery cost?', goalIndex: 0, sourceId: (await resume()).pendingInterview!.scope.answerSourceId, quote: 'Delivery cost' }, outputHash: 'd'.repeat(64), receipt: { requestId: 'offline-only', model: reservation.model, providerExecution: 'completed', usage: null, requestBytes: 1234, elapsedMs: 1 } })) };
  const policy = () => t.run(ctx => ctx.db.query('researchInterviewPolicy').withIndex('by_name', q => q.eq('name', 'demo')).unique());
  const attempt = () => t.run(ctx => ctx.db.query('researchInterviewAttempts').withIndex('by_active').take(6));
  return { t, op, invite, answer, resume, call, authority, provider, policy, attempt };
}
test('default-off existing sessions advance original script without pending state or allocation', async () => { const f = await fixture(false); await f.answer(); expect(await f.resume()).toMatchObject({ question: { id: 'q2' }, pendingInterview: null }); expect(await f.policy()).toBeNull(); });
test('accepted answer persists before pending; stale next answer and speech prompt access are denied', async () => {
  const f = await fixture(); const saved = await f.answer(), s = await f.resume(); expect(s).toMatchObject({ question: null, pendingInterview: { state: 'pending', automaticAllowed: true, scope: { answerSourceId: saved.sourceId, expectedRevision: 2 } } });
  expect((await f.t.query(api.participant.sources, { token, paginationOpts: { numItems: 25, cursor: null } })).page.at(-1)?.text).toBe('Delivery cost was unclear.');
  await expect(f.t.mutation(api.participant.answer, { token, expectedRevision: 2, requestId: 'second-answer', questionId: 'q1', text: 'duplicate', channel: 'text' })).rejects.toThrow('not ready');
  const input = { token, input: { sessionId: s.sessionId, sourceId: 'q1', expectedRevision: 2, requestId: 'speech-output' } };
  await expect(f.t.query(api.researchSpeech.output, { ...input, proof: await signGateway(secret, 'speech:output', input) })).rejects.toThrow();
});
test('native once-only provider admission installs follow-up shared with speech and preserves original script', async () => {
  const f = await fixture(); await f.answer(); const pending = (await f.resume()).pendingInterview!;
  expect(await runInterviewTurn(f.authority, { enabled: true, provider: f.provider }, pending.scope, new AbortController().signal)).toMatchObject({ state: 'ready', decision: { prompt: { scriptQuestionId: 'q1', followUpNumber: 1 } } });
  const s = await f.resume(); expect(s.pendingInterview).toBeNull(); expect(s.question!.id).toMatch(/^followup-/); expect(s.questionNumber).toBe(1);
  const input = { token, input: { sessionId: s.sessionId, sourceId: s.question!.id, expectedRevision: s.revision, requestId: 'speech-followup' } };
  expect(await f.t.query(api.researchSpeech.output, { ...input, proof: await signGateway(secret, 'speech:output', input) })).toMatchObject({ text: s.question!.question });
  expect((await f.policy())?.chargedCalls).toBe(1);
});
test('explicit Skip bypasses provider and preserves original question coverage', async () => {
  const f = await fixture(); await f.answer('[Skipped this question]', 'skip');
  expect(await runInterviewTurn(f.authority, { enabled: true, provider: f.provider }, (await f.resume()).pendingInterview!.scope, new AbortController().signal)).toMatchObject({ state: 'advanced', decision: { reason: 'skip' } });
  expect((await f.resume()).question?.id).toBe('q2'); expect((await f.policy())?.chargedCalls).toBe(0); expect(f.provider.generate).not.toHaveBeenCalled();
});
test('unknown consumed reservation survives reconstructed runtime and explicit recovery without refund/replay', async () => {
  const f = await fixture(); await f.answer(); const p = (await f.resume()).pendingInterview!;
  vi.mocked(f.provider.generate).mockRejectedValue(new Error('unknown network'));
  expect(await runInterviewTurn(f.authority, { enabled: true, provider: f.provider }, p.scope, new AbortController().signal)).toMatchObject({ state: 'unknown' });
  const next = { ...f.provider, generate: vi.fn(f.provider.generate) };
  expect(await runInterviewTurn(f.authority, { enabled: true, provider: next }, p.scope, new AbortController().signal)).toMatchObject({ state: 'unknown' }); expect(next.generate).not.toHaveBeenCalled();
  const recover = { token, expectedRevision: p.scope.expectedRevision, requestId: 'recover-unknown', answerSourceId: p.scope.answerSourceId, promptId: p.scope.promptId };
  const revision = await f.t.mutation(api.participant.continueScript, recover); expect(await f.t.mutation(api.participant.continueScript, recover)).toBe(revision);
  expect((await f.resume()).question?.id).toBe('q2'); expect((await f.policy())?.chargedCalls).toBe(1); expect((await f.attempt())[0]).toMatchObject({ state: 'unknown', active: true });
});
test('known pre-dispatch failure settles concurrency but never refunds consumed allocation', async () => {
  const f = await fixture(); await f.answer(); vi.mocked(f.provider.prepare).mockRejectedValue(new Error('oversize'));
  expect(await runInterviewTurn(f.authority, { enabled: true, provider: f.provider }, (await f.resume()).pendingInterview!.scope, new AbortController().signal)).toMatchObject({ state: 'failed' });
  expect((await f.attempt())[0]).toMatchObject({ state: 'failed', active: false }); expect((await f.policy())?.chargedCalls).toBe(1); expect(f.provider.generate).not.toHaveBeenCalled();
});
test('late known completion after recovery/pause/correction/revocation/withdrawal settles metadata without prompt install', async () => {
  for (const change of ['recovery', 'pause', 'correction', 'revoke', 'withdraw'] as const) {
    const f = await fixture(); await f.answer(); const p = (await f.resume()).pendingInterview!, context = await f.authority.inspect(p.scope), contextHash = await hashValue(context), admission = await f.authority.admit(p.scope, contextHash);
    await f.authority.begin(p.scope, admission.attemptId, contextHash, { inputHash: 'b'.repeat(64), requestBytes: 1234, maxOutputTokens: 128 });
    if (change === 'recovery') await f.t.mutation(api.participant.continueScript, { token, expectedRevision: 2, requestId: 'late-recovery', answerSourceId: p.scope.answerSourceId, promptId: p.scope.promptId });
    if (change === 'pause') await f.t.mutation(api.participant.transition, { token, expectedRevision: 2, state: 'paused' });
    if (change === 'correction') await f.t.mutation(api.participant.correct, { token, expectedRevision: 2, requestId: 'late-correction', sourceId: p.scope.answerSourceId, text: 'The cost was clear.' });
    if (change === 'revoke') await f.t.run(ctx => ctx.db.patch(f.invite.invitationId, { revokedAt: Date.now() }));
    if (change === 'withdraw') await f.t.mutation(api.capture.changeConsent, { token, expectedRevision: 2, consent: { ...consent, storage: false, analysis: false } });
    const before = await f.t.run(ctx => ctx.db.get(p.scope.sessionId));
    await f.authority.finish(p.scope, admission.attemptId, contextHash, { state: 'ready', decision: advanceInterview(context, 'no-probe'), providerRequestId: 'completed-late', providerReceipt: { requestId: 'completed-late', model: 'qwen3.8-max', providerExecution: 'completed', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, requestBytes: 1234, elapsedMs: 20 }, outputHash: 'd'.repeat(64), errorCode: null });
    expect((await f.attempt())[0]).toMatchObject({ state: 'failed', active: false, errorCode: 'late-interview-result', receipt: { requestId: 'completed-late' }, installedRevision: null });
    expect(await f.t.run(ctx => ctx.db.get(p.scope.sessionId))).toEqual(before);
  }
});
test('native proof and exact prompt/revision cannot be forged across capability/scope', async () => {
  const f = await fixture(); await f.answer(); const p = (await f.resume()).pendingInterview!;
  await expect(f.t.query(api.researchInterview.inspect, { token, scope: p.scope, proof: { at: Date.now(), signature: '0'.repeat(64) } })).rejects.toThrow();
  await expect(f.call('inspect', { scope: { ...p.scope, promptId: 'q2' } }, true)).rejects.toThrow();
  await expect(f.call('inspect', { scope: { ...p.scope, sessionId: 'invalid' } }, true)).rejects.toThrow();
});

test('internal interview disable is monotonic and retains charged unknown attempts and immutable policy', async () => {
  const f = await fixture(); await f.answer(); const pending = (await f.resume()).pendingInterview!;
  vi.mocked(f.provider.generate).mockRejectedValue(new Error('uncertain provider'));
  await runInterviewTurn(f.authority, { enabled: true, provider: f.provider }, pending.scope, new AbortController().signal);
  const before = await f.policy(), attempts = await f.attempt();
  await f.t.mutation(internal.researchInterview.disable, {}); await f.t.mutation(internal.researchInterview.disable, {});
  expect(await f.policy()).toEqual({ ...before, enabled: false }); expect(await f.attempt()).toEqual(attempts);
  await expect(f.t.mutation(internal.researchInterview.provision, { enabled: true, allocatedCalls: 6, maxSessionCalls: 4, model: 'qwen3.8-max', maxInputBytes: 64000, maxOutputTokens: 128, expiresAt: Date.now() + 600000 })).rejects.toThrow('reset');
  const empty = await fixture(false); await empty.t.mutation(internal.researchInterview.disable, {}); expect(await empty.policy()).toBeNull();
});
