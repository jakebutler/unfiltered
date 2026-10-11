import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import schema from '../../../convex/schema';
import { api, internal } from '../../../convex/_generated/api';
import { hashCapability } from '../../../convex/access';
import { signGateway } from '../../research-capture/src/proof';
import type { StudyCapability, StudyReadinessCommand, StudyRuntimeFacts } from '../src/readiness';
const modules = import.meta.glob('../../../convex/**/*.ts'), secret = 'c'.repeat(64), token = 'a'.repeat(64);
const q = (name: string) => makeFunctionReference<'query'>(name), m = (name: string) => makeFunctionReference<'mutation'>(name);
const capacities = { interviewCalls: 2, speechSeconds: 120, speechCharacters: 1200, captureBytes: 2000, analysisCalls: 2 };
const consent = { version: 'research-consent-1' as const, storage: true, analysis: true, microphone: true, camera: false, screen: false, shareTranscript: false, shareAudio: false, shareCamera: false, shareScreen: false, retainApprovedExcerpts: false };
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv('RESEARCH_MEDIA_GATEWAY_SECRET', secret); vi.stubEnv('RESEARCH_HOSTED_CLEANUP_ALLOCATION', 'deployment-retirement'); vi.stubEnv('RESEARCH_CAPTURE_LIMITS_JSON', JSON.stringify({segments:3})); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function fixture(provision = true) {
  const t = convexTest(schema, modules);
  const userId = await t.run(async ctx => { const user = await ctx.db.insert('users', { email: 'operator@synthetic.example' }); await ctx.db.insert('researchOperators', { userId: user, role: 'operator', name: 'Synthetic', active: true }); return user; });
  const authSession = await t.run(ctx => ctx.db.insert('authSessions', { userId, expirationTime: Date.now() + 3600000 })), op = t.withIdentity({ subject: `${userId}|${authSession}` });
  if (provision) await t.mutation(m('researchReadiness:provision'), { name: 'prospective-parent', ownerId: userId, expiresAt: Date.now() + 600000, total: capacities, partition: { ...capacities, interviewCalls: 1, speechSeconds: 60, speechCharacters: 600, captureBytes: 1000, analysisCalls: 1 }, model: 'qwen3.8-max', maxInputBytes: 64000, maxOutputTokens: 128 });
  const clientId = await op.mutation(api.research.createClient, { name: 'A' }), projectId = await op.mutation(api.research.createProject, { clientId, name: 'Checkout' });
  const definition = { title: 'Synthetic study', introduction: 'Synthetic only', goals: ['Understand delivery'], script: [{ id: 'q1', question: 'What did you see?' }, { id: 'q2', question: 'What would you change?' }], prototypeUrl: null, repository: null };
  const first = await op.mutation(api.research.saveStudy, { clientId, projectId, expectedRevision: 0, definition });
  const scope = { clientId, projectId, studyId: first.studyId, studyVersion: first.version };
  await t.mutation(internal.researchGatewayLeases.provisionAllocation, { allocationId: 'deployment-retirement', purpose: 'cleanup', expiresAt: Date.now() + 33 * 86_400_000, requestLimit: 48, readByteLimit: 96, storageOperationLimit: 240 });
  const facts = (enabled = true): StudyRuntimeFacts => ({ revision: (enabled ? 'b' : 'd').repeat(64), configurationDigest: 'f'.repeat(64), observedAt: Date.now(), interview: { enabled, qualified: true, model: 'qwen3.8-max' }, voice: { enabled, qualified: true }, capture: { enabled, qualified: true, gatewayAllocationId: 'deployment-ceiling', cleanupAllocationId: 'deployment-retirement' }, analysis: { enabled, qualified: true, model: 'qwen3.8-max' }, screenBaselineQualified: true });
  await t.mutation(internal.researchGatewayLeases.provisionAllocation, { allocationId: 'deployment-ceiling', expiresAt: Date.now() + 600000, requestLimit: 20, readByteLimit: 10000, storageOperationLimit: 30 });
  async function signed(operation: string, input: Record<string, unknown>) { return { ...input, proof: await signGateway(secret, `readiness:${operation}`, input) }; }
  async function snapshot(runtime = facts(), selected = scope) { return op.query(q('researchReadiness:snapshot'), await signed('snapshot', { scope: selected, runtime })); }
  async function change(capability: StudyCapability, enabled = true, requestId = `change-${capability}-${enabled}`, selected = scope, runtime = facts()) { const view = await snapshot(runtime, selected); const command = { scope: selected, expectedRevision: view.revision, capability, enabled, requestId }; const receipt = await op.mutation(m('researchReadiness:command'), await signed('command', { command, runtime })); return { command, receipt }; }
  const rows = () => t.run(async ctx => ({ envelope: await ctx.db.query('researchReadinessEnvelopes').withIndex('by_name', q => q.eq('name', 'prospective-parent')).unique(), bindings: await ctx.db.query('researchStudyAdmission').withIndex('by_studyId').take(8), policies: await ctx.db.query('researchInterviewPolicy').withIndex('by_name').take(8), grants: await ctx.db.query('researchSpeechGrants').withIndex('by_name').take(8), gateway: await ctx.db.query('researchGatewayAllocations').withIndex('by_allocationId', q => q.eq('allocationId', 'deployment-ceiling')).unique() }));
  async function invite(capabilityToken = token, requestId = 'ordinary-invite') { const issued = await op.mutation(internal.invitations.issue, { clientId, projectId, studyVersion: 1, requestId, tokenHash: await hashCapability(capabilityToken) }); await t.mutation(api.participant.agree, { token: capabilityToken, expectedRevision: 0, consent }); return issued; }
  return { t, op, authSession, userId, scope, clientId, projectId, definition, facts, signed, snapshot, change, rows, invite };
}
test('saved study created after root parent provisions can partition once without root study commands; OFF/re-enable and receipt replay preserve counters', async () => {
  const f = await fixture(); const result = await f.change('goal-aware-interview'); expect(result.receipt.state).toBe('accepted');
  const first = await f.rows(); expect(first.envelope.committed.interviewCalls).toBe(1); expect(first.policies[0].chargedCalls).toBe(0); expect(first.bindings[0].issued).toEqual(['goal-aware-interview']);
  const off = await f.change('goal-aware-interview', false, 'turn-interview-off'); expect(off.receipt.state).toBe('accepted'); await f.change('goal-aware-interview', true, 'reenable-interview');
  const again = await f.rows(); expect(again.envelope.committed).toEqual(first.envelope.committed); expect(again.policies).toEqual(first.policies); expect(again.gateway).toEqual(first.gateway);
  const replay = await f.op.mutation(m('researchReadiness:command'), await f.signed('command', { command: result.command, runtime: f.facts(false) })); expect(replay.state).toBe('accepted'); expect(replay.snapshot.capabilities.find((r: any) => r.id === 'goal-aware-interview').state).toBe('setup-required');
  expect((await f.rows()).envelope.committed).toEqual(first.envelope.committed);
});
test('actual server OFF, missing qualification, stale saved revision, missing envelope and expired facts never partition authority', async () => {
  const f = await fixture(); expect((await f.change('voice', true, 'runtime-off-request', f.scope, f.facts(false))).receipt.state).toBe('denied');
  const runtime = f.facts(); runtime.voice.qualified = false; expect((await f.change('voice', true, 'unqualified-request', f.scope, runtime)).receipt.state).toBe('denied');
  const view = await f.snapshot(), cmd = { scope: f.scope, expectedRevision: view.revision, capability: 'voice', enabled: true, requestId: 'stale-request' };
  await f.op.mutation(api.research.updateProject, { clientId: f.clientId, projectId: f.projectId, expectedRevision: 1, name: 'Changed', state: 'active' });
  expect((await f.op.mutation(m('researchReadiness:command'), await f.signed('command', { command: cmd, runtime: f.facts() }))).reason).toBe('stale-revision');
  expect((await f.rows()).bindings).toEqual([]); expect((await f.rows()).envelope.committed).toEqual({ ...capacities, interviewCalls: 0, speechSeconds: 0, speechCharacters: 0, captureBytes: 0, analysisCalls: 0 });
  const staleFacts = f.facts(); staleFacts.observedAt -= 10001; await expect(f.snapshot(staleFacts)).rejects.toThrow();
  const empty = await fixture(false); expect((await empty.change('voice')).receipt.state).toBe('denied');
});
test('auth, client/project/version isolation and proof are enforced before command or receipt mutation', async () => {
  const f = await fixture(), runtime = f.facts(), view = await f.snapshot();
  await expect(f.t.query(q('researchReadiness:snapshot'), await f.signed('snapshot', { scope: f.scope, runtime }))).rejects.toThrow();
  await expect(f.op.query(q('researchReadiness:snapshot'), { scope: f.scope, runtime, proof: { at: Date.now(), signature: 'e'.repeat(64) } })).rejects.toThrow();
  await expect(f.snapshot(runtime, { ...f.scope, studyVersion: 2 })).rejects.toThrow();
  const clientId = await f.op.mutation(api.research.createClient, { name: 'B' }); await expect(f.snapshot(runtime, { ...f.scope, clientId })).rejects.toThrow();
  const command: StudyReadinessCommand = { scope: f.scope, expectedRevision: view.revision, capability: 'voice', enabled: true, requestId: 'unresolved-command' };
  expect(await f.op.query(q('researchReadiness:receipt'), await f.signed('receipt', { command, runtime }))).toEqual({ state: 'unresolved' }); expect((await f.rows()).bindings).toEqual([]);
  await f.op.mutation(m('researchReadiness:command'), await f.signed('command', { command, runtime }));
  await expect(f.op.query(q('researchReadiness:receipt'), await f.signed('receipt', { command: { ...command, enabled: false }, runtime }))).rejects.toThrow();
  expect((await f.op.query(q('researchReadiness:receipt'), await f.signed('receipt', { command, runtime: f.facts(false) }))).receipt.snapshot.capabilities.find((r: any) => r.id === 'voice').state).toBe('setup-required');
});
test('concurrent studies cannot oversubscribe finite parent; re-enable never resets charged child or old singleton history', async () => {
  const f = await fixture(); await f.t.mutation(internal.researchInterview.provision, { enabled: false, allocatedCalls: 1, maxSessionCalls: 1, model: 'qwen3.8-max', maxInputBytes: 64000, maxOutputTokens: 128, expiresAt: Date.now() + 600000 });
  await f.t.run(async ctx => { const old = await ctx.db.query('researchInterviewPolicy').withIndex('by_name', q => q.eq('name', 'demo')).unique(); await ctx.db.patch(old!._id, { chargedCalls: 1 }); });
  const old = (await f.rows()).policies.find((r: any) => r.name === 'demo'); await f.change('goal-aware-interview');
  const second = await f.op.mutation(api.research.saveStudy, { clientId: f.clientId, projectId: f.projectId, expectedRevision: 1, definition: f.definition }); const secondScope = { ...f.scope, studyId: second.studyId, studyVersion: 2 }; await f.change('goal-aware-interview', true, 'second-study-partition', secondScope);
  const third = await f.op.mutation(api.research.saveStudy, { clientId: f.clientId, projectId: f.projectId, expectedRevision: 2, definition: f.definition }); expect((await f.change('goal-aware-interview', true, 'third-study-denied', { ...f.scope, studyId: third.studyId, studyVersion: 3 })).receipt.state).toBe('denied');
  expect((await f.rows()).envelope.committed.interviewCalls).toBe(2); expect((await f.rows()).policies.find((r: any) => r.name === 'demo')).toEqual(old);
  const issued = (await f.rows()).policies.find((r: any) => r.studyId === f.scope.studyId); await f.t.run(ctx => ctx.db.patch(issued._id, { chargedCalls: 1 })); await f.change('goal-aware-interview', false, 'off-exhausted-child');
  expect((await f.change('goal-aware-interview', true, 'no-replenish')).receipt.state).toBe('denied'); expect((await f.rows()).policies.find((r: any) => r.studyId === f.scope.studyId).chargedCalls).toBe(1);
});
test('exact saved prompt characters and60 second turn minimum prevent misleading voice readiness', async () => {
  const f = await fixture(); await f.t.run(async ctx => { const parent = (await ctx.db.query('researchReadinessEnvelopes').withIndex('by_name').unique())!; await ctx.db.patch(parent._id, { partition: { ...parent.partition, speechCharacters: 16 } }); });
  const row = (await f.snapshot()).capabilities.find((r: any) => r.id === 'voice'); expect(row.state).toBe('exhausted'); expect(row.allowances).toContainEqual(expect.objectContaining({ remaining: 16, unit: 'characters' })); expect((await f.change('voice')).receipt.state).toBe('denied'); expect((await f.rows()).grants).toEqual([]);
});
test('source-bound analysis preparation consumes child once, exact readback works OFF, different context and cross-study selections fail', async () => {
  const f = await fixture(); await f.change('analysis'); const invite = await f.invite(); const resume = await f.t.query(api.participant.resume, { token });
  await f.t.mutation(api.participant.answer, { token, expectedRevision: resume.revision, requestId: 'saved-text-answer', questionId: 'q1', text: 'Delivery cost was unclear.', channel: 'text' });
  const source = await f.t.run(ctx => ctx.db.query('researchSources').withIndex('by_sessionId_and_requestId', q => q.eq('sessionId', invite.sessionId).eq('requestId', 'saved-text-answer')).unique());
  const input = { scope: f.scope, requestId: 'prepare-analysis-once', selections: [{ sessionId: invite.sessionId, kind: 'self-report', id: source!._id, start: 0, end: 8 }] };
  const reservation = await f.op.mutation(m('researchStudyAnalysis:prepare'), await f.signed('prepareAnalysis', { ...input, runtime: f.facts() }));
  expect(await f.op.mutation(m('researchStudyAnalysis:prepare'), await f.signed('prepareAnalysis', { ...input, runtime: f.facts() }))).toEqual(reservation); expect((await f.rows()).bindings[0].analysisCallsCharged).toBe(1);
  await f.change('analysis', false, 'analysis-off'); expect(await f.op.query(q('researchStudyAnalysis:readPrepared'), await f.signed('readPreparedAnalysis', input))).toEqual(reservation);
  await expect(f.op.mutation(m('researchStudyAnalysis:prepare'), await f.signed('prepareAnalysis', { ...input, selections: [{ ...input.selections[0], end: 9 }], runtime: f.facts() }))).rejects.toThrow();
  const second = await f.op.mutation(api.research.saveStudy, { clientId: f.clientId, projectId: f.projectId, expectedRevision: 1, definition: f.definition }); await expect(f.op.mutation(m('researchStudyAnalysis:prepare'), await f.signed('prepareAnalysis', { ...input, scope: { ...f.scope, studyId: second.studyId, studyVersion: 2 }, runtime: f.facts() }))).rejects.toThrow();
  expect((await f.rows()).bindings[0].analysisCallsCharged).toBe(1); expect((await f.rows()).envelope.committed.analysisCalls).toBe(1);
});
test('native interview charges its bound child once; unknown admission stays charged and OFF permits original status and scripted recovery', async () => {
  const f = await fixture(); await f.change('goal-aware-interview'); await f.invite();
  await f.t.mutation(api.participant.answer, { token, expectedRevision: 1, requestId: 'ordinary-answer', questionId: 'q1', text: 'Delivery cost was unclear.', channel: 'text' });
  const pending = (await f.t.query(api.participant.resume, { token })).pendingInterview!.scope;
  const body = { token, scope: pending }, inspected = await f.t.query(api.researchInterview.inspect, { ...body, proof: await signGateway(secret, 'interview:inspect', body) });
  const { hashValue } = await import('../src/analysis'), contextHash = await hashValue(inspected), input = { ...body, contextHash, runtime: f.facts() };
  const offInput = { ...input, runtime: f.facts(false) }; await expect(f.t.mutation(api.researchInterview.admit, { ...offInput, proof: await signGateway(secret, 'interview:admit', offInput) })).rejects.toThrow(); expect((await f.rows()).policies[0].chargedCalls).toBe(0);
  const admitted = await f.t.mutation(api.researchInterview.admit, { ...input, proof: await signGateway(secret, 'interview:admit', input) }); expect(admitted.state).toBe('reserved');
  expect((await f.t.mutation(api.researchInterview.admit, { ...input, proof: await signGateway(secret, 'interview:admit', input) })).state).toBe('unknown');
  const before = await f.rows(); expect(before.policies[0].chargedCalls).toBe(1); expect(before.envelope.committed.interviewCalls).toBe(1);
  const off = await f.change('goal-aware-interview', false, 'disable-unknown-work'); expect(off.receipt.state).toBe('accepted');
  const begin = { ...input, attemptId: admitted.attemptId, prepared: { inputHash: 'f'.repeat(64), requestBytes: 1000, maxOutputTokens: 128 } }; await expect(f.t.mutation(api.researchInterview.begin, { ...begin, proof: await signGateway(secret, 'interview:begin', begin) })).rejects.toThrow();
  const finish = { token: input.token, scope: input.scope, contextHash: input.contextHash, attemptId: admitted.attemptId, result: { state: 'unknown' as const, decision: null, providerRequestId: null, providerReceipt: null, outputHash: null, errorCode: 'network' } }; await f.t.mutation(api.researchInterview.finish, { ...finish, proof: await signGateway(secret, 'interview:finish', finish) });
  expect((await f.t.query(api.researchInterview.status, { token }))?.state).toBe('unknown');
  await f.t.mutation(api.participant.continueScript, { token, expectedRevision: pending.expectedRevision, requestId: 'recover-original-script', answerSourceId: pending.answerSourceId, promptId: pending.promptId });
  expect((await f.rows()).policies[0].chargedCalls).toBe(1); expect((await f.rows()).envelope.committed).toEqual(before.envelope.committed);
  expect((await f.t.run(ctx => ctx.db.query('researchInterviewAttempts').withIndex('by_active', q => q.eq('active', true)).unique()))?.state).toBe('unknown');
});
test('capture partition aggregates conservative reservations across sessions and duplicate/OFF handling preserves admitted bytes', async () => {
  const f = await fixture(); await f.change('private-capture'); const first = await f.invite(); await f.t.mutation(api.capture.start, { token });
  const descriptor = { modality: 'microphone' as const, sequence: 0, startMs: 0, endMs: 10, bytes: 700, sha256: 'f'.repeat(64), mime: 'audio/webm', questionId: 'q1', sourceId: null }, input = { token, requestId: 'capture-first-segment', descriptor };
  const reserved = await f.t.mutation(api.capture.reserve, input); expect(await f.t.mutation(api.capture.reserve, input)).toEqual(reserved); await f.t.mutation(api.capture.stop, { token });
  const otherToken = 'e'.repeat(64); await f.invite(otherToken, 'second-participant-invite'); await f.t.mutation(api.capture.start, { token: otherToken });
  await expect(f.t.mutation(api.capture.reserve, { ...input, token: otherToken, requestId: 'capture-too-large', descriptor: { ...descriptor, bytes: 400 } })).rejects.toThrow('Study capture allowance');
  await f.t.mutation(api.capture.reserve, { ...input, token: otherToken, requestId: 'capture-second-segment', descriptor: { ...descriptor, bytes: 300 } });
  const before = await f.rows(); expect(before.bindings[0].captureBytesCharged).toBe(1000); expect(before.envelope.committed.captureBytes).toBe(1000);
  await f.change('private-capture', false, 'capture-off'); const claim = { token, mediaId: reserved.id, attempt: 0 }; await expect(f.t.mutation(api.captureGateway.claim, { ...claim, proof: await signGateway(secret, 'claim', claim) })).rejects.toThrow();
  await f.t.mutation(api.capture.stop, { token: otherToken }); expect((await f.rows()).bindings[0].captureBytesCharged).toBe(1000);
  expect(await f.t.mutation(api.capture.reserve, input)).toEqual(reserved); expect((await f.rows()).gateway).toEqual(before.gateway);
  expect((await f.t.run(ctx => ctx.db.query('researchCaptures').withIndex('by_sessionId', q => q.eq('sessionId', first.sessionId)).unique()))?.reservedBytes).toBe(700);
});
test('voice child native reservation charges60 seconds once; unknown, OFF and terminal readback retain child/global/session history', async () => {
  const f = await fixture(); await f.change('voice'); const invite = await f.invite();
  await f.t.run(ctx => ctx.db.insert('researchSpeechPolicy', { name: 'demo', enabled: false, qualification: 'root-reviewed-synthetic-speech', allocatedSeconds: 60, allocatedCharacters: 120, chargedSeconds: 60, chargedCharacters: 120, maxSessionSeconds: 60, maxSessionCharacters: 120 }));
  const old = await f.t.run(ctx => ctx.db.query('researchSpeechPolicy').withIndex('by_name').unique());
  const acquire = { kind: 'voice' as const, requestId: '1'.repeat(32), owner: '2'.repeat(32), allocationId: 'deployment-ceiling' }, lease = await f.t.mutation(api.researchGatewayLeases.acquireAllocated, { ...acquire, proof: await signGateway(secret, 'lease-acquire-allocated', acquire) }); expect(lease).not.toBeNull();
  const identity = { leaseId: lease!.leaseId, requestId: lease!.requestId, owner: lease!.owner, generation: lease!.generation }; await f.t.mutation(api.researchGatewayLeases.beginWork, { ...identity, proof: await signGateway(secret, 'lease-begin', identity) });
  const scope = { sessionId: invite.sessionId, promptId: 'q1', expectedRevision: 1, requestId: 'ordinary-voice-turn' }, reserve = { token, scope, runtime: f.facts(), provider: 'deepgram' as const, maxAudioSeconds: 60, maxCharacters: 0, transportLease: identity };
  await f.t.mutation(api.researchSpeech.reserve, { ...reserve, proof: await signGateway(secret, 'speech:reserve', reserve) }); await expect(f.t.mutation(api.researchSpeech.reserve, { ...reserve, proof: await signGateway(secret, 'speech:reserve', reserve) })).rejects.toThrow('original voice attempt');
  const before = await f.rows(); expect(before.grants[0].chargedSeconds).toBe(60); expect(before.envelope.committed.speechSeconds).toBe(60);
  const settle = { sessionId: invite.sessionId, requestId: scope.requestId, provider: 'deepgram' as const, outcome: 'unknown' as const }; await f.t.mutation(api.researchSpeech.settle, { ...settle, proof: await signGateway(secret, 'speech:settle', settle) });
  expect((await f.snapshot()).capabilities.find((r: any) => r.id === 'voice').state).toBe('unresolved'); expect((await f.change('voice', false, 'stop-unknown-voice')).receipt.state).toBe('accepted');
  const read = { token, scope }; expect((await f.t.query(api.researchSpeech.terminalBarrier, { ...read, proof: await signGateway(secret, 'speech:terminalBarrier', read) })).state).toBe('unknown');
  expect((await f.rows()).grants[0].chargedSeconds).toBe(60); expect((await f.t.run(ctx => ctx.db.query('researchSpeechPolicy').withIndex('by_name').unique()))).toEqual(old);
  expect((await f.t.run(ctx => ctx.db.query('researchSpeechGrantBudgets').withIndex('by_grantId_and_sessionId', q => q.eq('grantId', before.grants[0]._id).eq('sessionId', invite.sessionId)).unique()))?.chargedSeconds).toBe(60);
});
test('prepared analysis cannot bypass fresh runtime or scoped OFF, dispatch/finish charge only prepared child once', async () => {
  const f = await fixture(); await f.change('analysis'); const invite = await f.invite();
  await f.t.mutation(api.participant.answer, { token, expectedRevision: 1, requestId: 'analysis-source-answer', questionId: 'q1', text: 'Delivery cost was unclear.', channel: 'text' });
  const source = await f.t.run(ctx => ctx.db.query('researchSources').withIndex('by_sessionId_and_requestId', q => q.eq('sessionId', invite.sessionId).eq('requestId', 'analysis-source-answer')).unique());
  const selections = [{ sessionId: invite.sessionId, kind: 'self-report' as const, id: source!._id, start: 0, end: 8 }], input = { scope: f.scope, requestId: 'analysis-dispatch-once', selections };
  const reservation = await f.op.mutation(m('researchStudyAnalysis:prepare'), await f.signed('prepareAnalysis', { ...input, runtime: f.facts() }));
  const base = { clientId: f.clientId, projectId: f.projectId, requestId: input.requestId, selections, reservation };
  await expect(f.op.mutation(api.researchAnalysis.admit, { ...base, proof: await signGateway(secret, 'research:admit', base) })).rejects.toThrow();
  const stopped = { ...base, runtime: f.facts(false) }; await expect(f.op.mutation(api.researchAnalysis.admit, { ...stopped, proof: await signGateway(secret, 'research:admit', stopped) })).rejects.toThrow();
  const admitted = { ...base, runtime: f.facts() }, result = await f.op.mutation(api.researchAnalysis.admit, { ...admitted, proof: await signGateway(secret, 'research:admit', admitted) }); expect(result.state).toBe('admitted');
  const receipt = { requestId: null, model: reservation.model, inputHash: 'f'.repeat(64), requestBytes: 1000, maxOutputTokens: reservation.maxOutputTokens, outputHash: null, frames: [], classification: 'live' as const, errorCode: null }, begin = { clientId: f.clientId, projectId: f.projectId, analysisId: result.analysisId, receipt, runtime: f.facts() };
  const denied = { ...begin, runtime: f.facts(false) }; await expect(f.op.mutation(api.researchAnalysis.beginDispatch, { ...denied, proof: await signGateway(secret, 'research:beginDispatch', denied) })).rejects.toThrow();
  expect(await f.op.mutation(api.researchAnalysis.beginDispatch, { ...begin, proof: await signGateway(secret, 'research:beginDispatch', begin) })).toBe(true);
  expect(await f.op.mutation(api.researchAnalysis.beginDispatch, { ...begin, proof: await signGateway(secret, 'research:beginDispatch', begin) })).toBe(false);
  await f.change('analysis', false, 'analysis-disable-in-flight'); const finish = { clientId: f.clientId, projectId: f.projectId, analysisId: result.analysisId, state: 'unknown' as const, findings: [], requestId: null, outputHash: null, errorCode: 'network' };
  await f.op.mutation(api.researchAnalysis.finish, { ...finish, proof: await signGateway(secret, 'research:finish', finish) }); expect((await f.op.query(api.researchAnalysis.requestStatus, { clientId: f.clientId, projectId: f.projectId, requestId: input.requestId }))?.state).toBe('unknown');
  expect((await f.rows()).bindings[0].analysisCallsCharged).toBe(1); expect((await f.rows()).envelope.committed.analysisCalls).toBe(1);
});

test('fresh observation remains finite independently of expired budgets and preserves scripted and controlled origin facts', async () => {
  const f = await fixture(); await f.t.run(ctx => ctx.db.insert('researchDomPolicies', { studyId: f.scope.studyId, origin: 'https://prototype.example', componentIds: ['c1'], approvedAt: Date.now() }));
  const before = await f.rows(); await f.t.run(async ctx => { await ctx.db.patch(before.envelope!._id, { expiresAt: Date.now() - 1 }); await ctx.db.patch(before.gateway!._id, { expiresAt: Date.now() - 1 }); });
  const view = await f.snapshot(); expect(view.observedAt).toBe(Date.now()); expect(view.validUntil).toBe(Date.now() + 30000); expect(view.capabilities.find((r: any) => r.id === 'scripted-text').state).toBe('ready'); expect(view.capabilities.find((r: any) => r.id === 'controlled-dom').state).toBe('ready'); expect(view.capabilities.find((r: any) => r.id === 'voice').canEnable).toBe(false);
  await f.t.run(ctx => ctx.db.patch(f.authSession, { expirationTime: Date.now() + 500 })); expect((await f.snapshot()).validUntil).toBe(Date.now() + 500); expect((await f.rows()).envelope!.committed).toEqual(before.envelope!.committed);
});

test.each(['parent-disabled', 'parent-expired', 'study-disabled'] as const)('prepared analysis cannot begin after %s even with a configured qualified provider', async reason => {
  const f = await fixture(); await f.change('analysis'); const invite = await f.invite();
  await f.t.mutation(api.participant.answer, { token, expectedRevision: 1, requestId: 'dormant-analysis-source', questionId: 'q1', text: 'Delivery cost was unclear.', channel: 'text' });
  const source = await f.t.run(ctx => ctx.db.query('researchSources').withIndex('by_sessionId_and_requestId', q => q.eq('sessionId', invite.sessionId).eq('requestId', 'dormant-analysis-source')).unique());
  const selections = [{ sessionId: invite.sessionId, kind: 'self-report' as const, id: source!._id, start: 0, end: 8 }];
  const input = { scope: f.scope, requestId: 'dormant-analysis-once', selections };
  const reservation = await f.op.mutation(m('researchStudyAnalysis:prepare'), await f.signed('prepareAnalysis', { ...input, runtime: f.facts() }));
  const admission = { clientId: f.clientId, projectId: f.projectId, requestId: input.requestId, selections, reservation, runtime: f.facts() };
  const result = await f.op.mutation(api.researchAnalysis.admit, { ...admission, proof: await signGateway(secret, 'research:admit', admission) });
  const before = await f.rows();
  if (reason === 'study-disabled') await f.change('analysis', false, 'dormant-analysis-disable');
  else await f.t.run(ctx => ctx.db.patch(before.envelope!._id, reason === 'parent-disabled' ? { enabled: false } : { expiresAt: Date.now() - 1 }));
  const begin = { clientId: f.clientId, projectId: f.projectId, analysisId: result.analysisId, runtime: f.facts(), receipt: { requestId: null, model: reservation.model, inputHash: 'f'.repeat(64), requestBytes: 1000, maxOutputTokens: reservation.maxOutputTokens, outputHash: null, frames: [], classification: 'live' as const, errorCode: null } };
  await expect(f.op.mutation(api.researchAnalysis.beginDispatch, { ...begin, proof: await signGateway(secret, 'research:beginDispatch', begin) })).rejects.toThrow();
  const row = await f.t.run(ctx => ctx.db.get(result.analysisId));
  expect(row.state).toBe('admitted'); expect(row.receipt).toBeNull();
  const after = await f.rows(); expect(after.bindings[0].analysisCallsCharged).toBe(before.bindings[0].analysisCallsCharged); expect(after.envelope!.committed).toEqual(before.envelope!.committed);
});
