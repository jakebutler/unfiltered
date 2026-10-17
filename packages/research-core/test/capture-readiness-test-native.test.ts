import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import schema from '../../../convex/schema';
import { api, internal } from '../../../convex/_generated/api';
import { hashCapability } from '../../../convex/access';
import { signGateway } from '../../research-capture/src/proof';
import type { StudyRuntimeFacts } from '../src/readiness';
import { resolveEvidence, publicationAvailable, sharingAllowed } from '../../../convex/reportAccess';
const modules = import.meta.glob('../../../convex/**/*.ts'), secret = 'c'.repeat(64), token = 'a'.repeat(64);
const q = (name: string) => makeFunctionReference<'query'>(name), m = (name: string) => makeFunctionReference<'mutation'>(name);
const consent = { version: 'research-consent-1' as const, storage: true, analysis: true, microphone: false, camera: false, screen: true, dom: true, shareDom: true, shareTranscript: true, shareAudio: false, shareCamera: false, shareScreen: true, retainApprovedExcerpts: true };
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv('RESEARCH_MEDIA_GATEWAY_SECRET', secret); vi.stubEnv('RESEARCH_HOSTED_CLEANUP_ALLOCATION', 'test-retirement'); vi.stubEnv('RESEARCH_CAPTURE_LIMITS_JSON', JSON.stringify({segments:3})); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function fixture() {
  const t = convexTest(schema, modules);
  const userId = await t.run(async ctx => { const userId = await ctx.db.insert('users', { email: 'operator@synthetic.example' }); await ctx.db.insert('researchOperators', { userId, role: 'operator', name: 'Synthetic operator', active: true }); return userId; });
  const authId = await t.run(ctx => ctx.db.insert('authSessions', { userId, expirationTime: Date.now() + 3600000 })), op = t.withIdentity({ subject: `${userId}|${authId}` });
  const clientId = await op.mutation(api.research.createClient, { name: 'Synthetic client' }), projectId = await op.mutation(api.research.createProject, { clientId, name: 'Checkout' });
  const definition = { title: 'Synthetic capture study', introduction: 'Welcome to the saved study', goals: ['Private goal should not reach welcome'], script: [{ id: 'q1', question: 'What did you see?' }, { id: 'q2', question: 'What changed?' }], captureExpectation: { screen: true, controlledDom: true, alternatePath: 'Describe the checkout using text.' }, prototypeUrl: 'https://prototype.example', repository: null };
  const saved = await op.mutation(api.research.saveStudy, { clientId, projectId, expectedRevision: 0, definition }), scope = { clientId, projectId, studyId: saved.studyId, studyVersion: 1 };
  const capacities = { interviewCalls: 2, speechSeconds: 120, speechCharacters: 1200, captureBytes: 2000, analysisCalls: 2 };
  await t.mutation(m('researchReadiness:provision'), { name: 'finite-test-parent', ownerId: userId, expiresAt: Date.now() + 600000, total: capacities, partition: capacities, model: 'qwen3.8-max', maxInputBytes: 64000, maxOutputTokens: 128 });
  await t.mutation(internal.researchGatewayLeases.provisionAllocation, { allocationId: 'test-deployment', expiresAt: Date.now() + 600000, requestLimit: 20, readByteLimit: 10000, storageOperationLimit: 30 });
  await t.mutation(internal.researchGatewayLeases.provisionAllocation, { allocationId: 'test-retirement', purpose: 'cleanup', expiresAt: Date.now() + 33 * 86_400_000, requestLimit: 48, readByteLimit: 96, storageOperationLimit: 240 });
  const facts = (): StudyRuntimeFacts => ({ revision: 'b'.repeat(64), configurationDigest: 'f'.repeat(64), observedAt: Date.now(), interview: { enabled: true, qualified: true, model: 'qwen3.8-max' }, voice: { enabled: true, qualified: true }, capture: { enabled: true, qualified: true, gatewayAllocationId: 'test-deployment', cleanupAllocationId: 'test-retirement' }, analysis: { enabled: true, qualified: true, model: 'qwen3.8-max' }, screenBaselineQualified: true });
  const signed = async (operation: string, input: Record<string, unknown>) => ({ ...input, proof: await signGateway(secret, `readiness:${operation}`, input) });
  for (const capability of ['private-capture', 'goal-aware-interview', 'voice', 'analysis']) { const runtime = facts(), snapshot = await op.query(q('researchReadiness:snapshot'), await signed('snapshot', { scope, runtime })); await op.mutation(m('researchReadiness:command'), await signed('command', { command: { scope, capability, expectedRevision: snapshot.revision, enabled: true, requestId: `enable-${capability}` }, runtime })); }
  const policyId = await t.run(ctx => ctx.db.insert('researchDomPolicies', { studyId: saved.studyId, origin: 'https://prototype.example', componentIds: ['c1'], approvedAt: Date.now() }));
  const initial = await op.query(q('researchCaptureTests:preview'), await signed('welcomePreview', { scope, runtime: facts() }));
  const input = { scope, requestId: 'stable-capture-test', expectedBinding: initial.binding, device: { browser: 'Synthetic browser', platform: 'Synthetic desktop' } };
  const issue = (selected = input, selectedToken = token, runtime = facts()) => (async () => op.mutation(m('researchCaptureTests:issue'), await signed('captureTestIssue', { input: selected, tokenHash: await hashCapability(selectedToken), runtime })))();
  const receipt = (selected = input) => (async () => op.query(q('researchCaptureTests:receipt'), await signed('captureTestReceipt', { input: selected })))();
  const status = (runtime = facts()) => (async () => op.query(q('researchCaptureTests:status'), await signed('captureTestStatus', { input, runtime })))();
  async function begin() { const issued = await issue(); await t.mutation(api.participant.agree, { token, expectedRevision: 0, consent }); const capture = await t.mutation(api.capture.start, { token }); return { ...issued, capture }; }
  const rows = () => t.run(async ctx => ({ sessions: await ctx.db.query('researchSessions').withIndex('by_projectId', q => q.eq('projectId', projectId)).take(10), tests: await ctx.db.query('researchCaptureTests').withIndex('by_ownerId_and_requestId', q => q.eq('ownerId', userId)).take(10), child: await ctx.db.query('researchStudyAdmission').withIndex('by_studyId', q => q.eq('studyId', saved.studyId)).unique(), parent: await ctx.db.query('researchReadinessEnvelopes').withIndex('by_name').unique(), speech: await ctx.db.query('researchSpeechGrants').withIndex('by_name').take(10), policies: await ctx.db.query('researchInterviewPolicy').withIndex('by_name').take(10) }));
  return { t, op, authId, userId, clientId, projectId, scope, definition, policyId, facts, signed, initial, input, issue, receipt, status, begin, rows };
}
test('preview has no side effects and participant receives the same actual welcome, unchecked defaults and lifecycle dates', async () => {
  const f = await fixture(), before = await f.rows();
  const next = await f.op.query(q('researchCaptureTests:preview'), await f.signed('welcomePreview', { scope: f.scope, runtime: f.facts() })); expect(next).toEqual(f.initial); expect(await f.rows()).toEqual(before);
  expect(next.welcome.context.clientName).toBe('Synthetic client'); expect(next.welcome.context.operatorName).toBe('Synthetic operator'); expect(next.welcome.choices.every((c: any) => c.checked === false)).toBe(true); expect(next.welcome.lifecycle.expiresAt).toBeNull(); expect(next.welcome.capture).toMatchObject({ screen: 'expected', controlledDom: 'expected', camera: 'optional' }); expect(JSON.stringify(next)).not.toContain('Private goal');
  await f.op.mutation(internal.invitations.issue, { clientId: f.clientId, projectId: f.projectId, studyVersion: 1, requestId: 'ordinary-welcome', tokenHash: await hashCapability(token) });
  const welcome = (await f.t.query(api.participant.resume, { token })).welcome; expect({ ...welcome, lifecycle: next.welcome.lifecycle }).toEqual(next.welcome); expect(welcome.lifecycle.expiresAt).toBeGreaterThan(Date.now());
});
test('stable owner/scoped issuance and read-only unknown receipt; exact replay returns no new session, changed payload/auth/proof/CAS denied', async () => {
  const f = await fixture(); expect(await f.receipt()).toEqual({ state: 'unresolved' }); expect((await f.rows()).sessions).toEqual([]);
  await expect(f.t.query(q('researchCaptureTests:preview'), await f.signed('welcomePreview', { scope: f.scope, runtime: f.facts() }))).rejects.toThrow();
  await expect(f.op.query(q('researchCaptureTests:preview'), { scope: f.scope, runtime: f.facts(), proof: { at: Date.now(), signature: 'e'.repeat(64) } })).rejects.toThrow();
  await expect(f.issue({ ...f.input, expectedBinding: 'e'.repeat(64) })).rejects.toThrow(); await expect(f.issue({ ...f.input, scope: { ...f.scope, studyVersion: 2 } })).rejects.toThrow();
  const first = await f.issue(); expect(first.inserted).toBe(true); const again = await f.issue(f.input, 'e'.repeat(64)); expect(again.inserted).toBe(false); expect(again.receipt).toEqual(first.receipt); expect((await f.rows()).sessions).toHaveLength(1); expect((await f.receipt()).receipt).toEqual(first.receipt);
  await expect(f.receipt({ ...f.input, device: { ...f.input.device, browser: 'Changed' } })).rejects.toThrow(); expect(JSON.stringify(await f.receipt())).not.toContain(token); expect(first.receipt.deviceContext).toBe('operator-reported');
  await f.op.mutation(api.invitations.revoke, { clientId: f.clientId, projectId: f.projectId, invitationId: first.receipt.invitationId }); expect((await f.receipt()).receipt.revokedAt).not.toBeNull(); await expect(f.t.query(api.participant.resume, { token })).rejects.toThrow();
  const replacement = await f.issue({ ...f.input, requestId: 'explicit-new-test' }, 'e'.repeat(64)); expect(replacement.receipt.sessionId).not.toBe(first.receipt.sessionId); expect((await f.rows()).child!.captureBytesCharged).toBe(0);
});
test('origin authorization and connected event are not test success; real authorized click retained across disconnect', async () => {
  const f = await fixture(); await f.begin(); expect((await f.status()).event).toBeNull(); const challenge = 'd'.repeat(64);
  await expect(f.t.mutation(api.capture.connectDom, { token, origin: 'https://foreign.example', challenge })).rejects.toThrow(); await f.t.mutation(api.capture.connectDom, { token, origin: 'https://prototype.example', challenge });
  const connected = { sequence: 0, atMs: 0, kind: 'connected' as const, target: 'none', tag: 'none' as const, x: null, y: null };
  await f.t.mutation(api.capture.appendDom, { token, origin: 'https://prototype.example', challenge, requestId: 'connected-event', events: [connected] }); expect((await f.status()).domConnected).toBe(true); expect((await f.status()).event).toBeNull();
  const click = { sequence: 1, atMs: 10, kind: 'click' as const, target: 'c1', tag: 'button' as const, x: 50, y: 50 };
  await expect(f.t.mutation(api.capture.appendDom, { token, origin: 'https://prototype.example', challenge, requestId: 'forged-component', events: [{ ...click, target: 'c2' }] })).rejects.toThrow();
  await f.t.mutation(api.capture.appendDom, { token, origin: 'https://prototype.example', challenge, requestId: 'actual-click', events: [click] }); const status = await f.status(); expect(status.event).toMatchObject({ kind: 'click', sequence: 1, origin: 'https://prototype.example' });
  await f.t.mutation(api.capture.disconnectDom, { token, challenge }); expect((await f.status()).domConnected).toBe(false); expect((await f.status()).event).toEqual(status.event);
  await f.t.mutation(api.capture.changeConsent, { token, expectedRevision: 1, consent: { ...consent, dom: false, shareDom: false } }); expect((await f.status()).event).toBeNull();
});
test('reserved/uploading media never succeeds; exact native finalize records available evidence and bytes remain charged after OFF/cleanup', async () => {
  const f = await fixture(); const first = await f.begin();
  const descriptor = { modality: 'screen' as const, sequence: 0, startMs: 0, endMs: 500, bytes: 700, sha256: 'f'.repeat(64), mime: 'video/webm', questionId: 'q1', sourceId: null };
  const media = await f.t.mutation(api.capture.reserve, { token, requestId: 'real-browser-segment', descriptor }); expect((await f.status()).media).toEqual([]);
  const claim = { token, mediaId: media.id, attempt: 0, runtime: f.facts() }; await f.t.mutation(api.captureGateway.claim, { ...claim, proof: await signGateway(secret, 'claim', claim) }); expect((await f.status()).media).toEqual([]);
  const finalize = { mediaId: media.id, attempt: 0, bytes: descriptor.bytes, sha256: descriptor.sha256, mime: descriptor.mime }; await expect(f.t.mutation(api.captureGateway.finalize, { ...finalize, bytes: 701, proof: await signGateway(secret, 'finalize', { ...finalize, bytes: 701 }) })).rejects.toThrow();
  expect(await f.t.mutation(api.captureGateway.finalize, { ...finalize, proof: await signGateway(secret, 'finalize', finalize) })).toBe(true); expect((await f.status()).media[0]).toMatchObject({ mediaId: media.id, bytes: 700, sha256: descriptor.sha256, availableAt: Date.now(), partial: false });
  await f.t.mutation(api.capture.stop, { token }); expect((await f.status()).media).toHaveLength(1); const before = await f.rows(); expect(before.child!.captureBytesCharged).toBe(700);
  const runtime = f.facts(); runtime.capture.enabled = false; runtime.revision = 'd'.repeat(64); expect((await f.status(runtime)).current).toBe(false); expect((await f.status(runtime)).media).toEqual([]); expect((await f.receipt()).state).toBe('found'); expect((await f.rows()).child!.captureBytesCharged).toBe(700);
  await f.op.mutation(api.invitations.revoke, { clientId: f.clientId, projectId: f.projectId, invitationId: first.receipt.invitationId }); expect((await f.status()).current).toBe(false); expect((await f.rows()).parent!.committed).toEqual(before.parent!.committed);
});
test('changed configuration/policy/study and withdrawn or expired consent invalidate claims without erasing original receipt', async () => {
  const f = await fixture(); await f.begin(); const changed = f.facts(); changed.configurationDigest = 'd'.repeat(64); expect((await f.status(changed)).current).toBe(false);
  await f.t.run(ctx => ctx.db.patch(f.policyId, { componentIds: ['c2'] })); expect((await f.status()).reason).toContain('Changed'); await expect(f.t.mutation(api.capture.connectDom, { token, origin: 'https://prototype.example', challenge: 'd'.repeat(64) })).rejects.toThrow();
  await f.op.mutation(api.research.saveStudy, { clientId: f.clientId, projectId: f.projectId, expectedRevision: 1, definition: f.definition }); expect((await f.status()).current).toBe(false); expect((await f.receipt()).state).toBe('found');
  const g = await fixture(); const issued = await g.begin(); await g.t.run(ctx => ctx.db.patch(issued.receipt.sessionId, { consent: null, withdrawnAt: Date.now() })); expect((await g.status()).current).toBe(false);
  await g.t.run(ctx => ctx.db.patch(issued.receipt.invitationId, { expiresAt: Date.now() - 1 })); expect((await g.status()).current).toBe(false); expect((await g.receipt()).state).toBe('found');
});
test('test purpose denies all provider/evidence/inventory/publication/direct client paths while ordinary sessions remain available', async () => {
  const f = await fixture(); const issued = await f.begin(); expect((await f.t.query(api.participant.resume, { token })).pendingInterview).toBeNull();
  await f.t.mutation(api.participant.answer, { token, expectedRevision: 1, requestId: 'test-text-answer', questionId: 'q1', text: 'Fictional test answer', channel: 'text' });
  const source = await f.t.run(ctx => ctx.db.query('researchSources').withIndex('by_sessionId_and_requestId', q => q.eq('sessionId', issued.receipt.sessionId).eq('requestId', 'test-text-answer')).unique());
  const selection = { sessionId: issued.receipt.sessionId, kind: 'self-report' as const, id: source!._id, start: 0, end: 9 }, scope = { ownerId: f.userId, clientId: f.clientId, projectId: f.projectId };
  await expect(f.t.run(ctx => resolveEvidence(ctx, scope, selection))).rejects.toThrow();
  const page = { numItems: 25, cursor: null }; expect((await f.op.query(api.research.sessions, { clientId: f.clientId, projectId: f.projectId, paginationOpts: page })).page).toEqual([]); expect((await f.op.query(api.invitations.list, { clientId: f.clientId, projectId: f.projectId, paginationOpts: page })).page).toEqual([]);
  await expect(f.op.query(api.research.sessionSources, { clientId: f.clientId, projectId: f.projectId, sessionId: issued.receipt.sessionId, paginationOpts: page })).rejects.toThrow(); await expect(f.op.query(api.researchAnalysis.inventory, { clientId: f.clientId, projectId: f.projectId, sessionId: issued.receipt.sessionId, kind: 'self-report', paginationOpts: page })).rejects.toThrow();
  const prep = { scope: f.scope, requestId: 'forged-test-analysis', selections: [selection], runtime: f.facts() }; await expect(f.op.mutation(m('researchStudyAnalysis:prepare'), await f.signed('prepareAnalysis', prep))).rejects.toThrow();
  const reservation = { id: 'legacy-test-forgery', model: 'qwen3.8-max' as const, maxInputBytes: 64000, maxOutputTokens: 128, expiresAt: Date.now() + 1000, live: true }; const admit = { clientId: f.clientId, projectId: f.projectId, requestId: 'forged-test-analysis', selections: [selection], reservation, runtime: f.facts() }; await expect(f.op.mutation(api.researchAnalysis.admit, { ...admit, proof: await signGateway(secret, 'research:admit', admit) })).rejects.toThrow();
  const speech = { token, runtime: f.facts() }; expect(await f.t.query(api.researchSpeech.status, { ...speech, proof: await signGateway(secret, 'speech:status', speech) })).toEqual({ enabled: false });
  const speechScope = { sessionId: issued.receipt.sessionId, promptId: 'q2', expectedRevision: 2, requestId: 'test-speech-denial' }; const authorize = { ...speech, scope: speechScope, provider: 'elevenlabs' as const }; await expect(f.t.query(api.researchSpeech.authorize, { ...authorize, proof: await signGateway(secret, 'speech:authorize', authorize) })).rejects.toThrow();
  const inspect = { token, scope: { sessionId: issued.receipt.sessionId, requestId: 'test-model-denial', expectedRevision: 2, answerSourceId: source!.sourceId, promptId: 'q2' } }; await expect(f.t.query(api.researchInterview.inspect, { ...inspect, proof: await signGateway(secret, 'interview:inspect', inspect) })).rejects.toThrow();
  const evidence = { ...selection, hash: 'f'.repeat(64), consentEpoch: 0, sharingEpoch: 0, retainApprovedExcerpts: true, text: 'Fictional' }; expect(await f.t.run(ctx => sharingAllowed(ctx, evidence))).toBe(false);
  // Even a forged historical report with approved excerpts must fail client viewer admission.
  const reportId = await f.t.run(async ctx => { const analysisId = await ctx.db.insert('researchAnalyses', { ...scope, requestId: 'forged-legacy-analysis', manifestHash: 'f'.repeat(64), studyContext: 'synthetic', evidence: [evidence], state: 'ready', revision: 0, findings: [], excerpts: [], reviewedAt: Date.now(), reservation, receipt: null, createdAt: Date.now(), deadline: Date.now() + 1000 }); return ctx.db.insert('researchReports', { ...scope, analysisId, requestId: 'forged-test-report', version: 1, title: 'Synthetic', clientName: 'Synthetic', projectName: 'Synthetic', evidence: [evidence], findings: [], excerpts: [{ evidenceId: `self-report:${source!._id}:0:9`, text: 'Fictional' }], grants: [], previewHash: 'f'.repeat(64), state: 'published', publishedAt: Date.now(), expiresAt: Date.now() + 100000 }); });
  await expect(f.t.run(async ctx => publicationAvailable(ctx, (await ctx.db.get(reportId))!))).rejects.toThrow();
  const forgedReport = await f.t.run(ctx => ctx.db.get(reportId));
  const preview = { clientId: f.clientId, projectId: f.projectId, analysisId: forgedReport!.analysisId, reviewRevision: 0, title: 'Synthetic', grants: [] };
  await expect(f.op.query(api.researchReports.preview, preview)).rejects.toThrow(); await expect(f.op.mutation(api.researchReports.publish, { ...preview, previewHash: 'f'.repeat(64), requestId: 'forged-test-publication' })).rejects.toThrow();
  const unlock = { slug: 'e'.repeat(32), tokenHash: 'd'.repeat(64) }; await f.t.run(ctx => ctx.db.insert('researchShares', { ...scope, reportId, requestId: 'forged-test-share', slug: unlock.slug, passwordSalt: 'd'.repeat(64), passwordHash: 'c'.repeat(64), grants: [], revision: 0, issuedAt: Date.now(), expiresAt: Date.now() + 100000, revokedAt: null })); expect(await f.t.mutation(api.researchPortal.beginUnlock, { ...unlock, proof: await signGateway(secret, 'research:beginUnlock', unlock) })).toBeNull();
  const viewerToken = '9'.repeat(64);
  await f.t.run(async ctx => { const share = await ctx.db.query('researchShares').withIndex('by_slug', q => q.eq('slug', unlock.slug)).unique(); await ctx.db.insert('researchViewerSessions', { shareId: share!._id, reportId, tokenHash: await hashCapability(viewerToken), authorized: true, shareRevision: 0, expiresAt: Date.now() + 100000 }); });
  const sourceRead = { token: viewerToken, slug: unlock.slug, evidenceId: 'e1', intent: 'view' as const }; await expect(f.t.query(api.researchPortal.sharedSource, { ...sourceRead, proof: await signGateway(secret, 'research:sharedSource', sourceRead) })).rejects.toThrow();
  const reportRead = { token: viewerToken, slug: unlock.slug }; await expect(f.t.query(api.researchPortal.readPublished, { ...reportRead, proof: await signGateway(secret, 'research:readPublished', reportRead) })).rejects.toThrow();
  const before = await f.rows(); expect(before.child!.analysisCallsCharged).toBe(0); expect(before.speech[0].chargedSeconds).toBe(0); expect(before.policies[0].chargedCalls).toBe(0);
  await f.op.mutation(internal.invitations.issue, { clientId: f.clientId, projectId: f.projectId, studyVersion: 1, requestId: 'ordinary-unaffected', tokenHash: await hashCapability('e'.repeat(64)) }); expect((await f.op.query(api.research.sessions, { clientId: f.clientId, projectId: f.projectId, paginationOpts: page })).page).toHaveLength(1);
});

test('status proof expires within30seconds and clips parent, access, retention, gateway and auth without mutating accounting', async () => {
  const f = await fixture(), issued = await f.begin(), before = await f.rows();
  const first = await f.status(); expect(first.observedAt).toBe(Date.now()); expect(first.validUntil).toBe(Date.now() + 30000); expect(first.current).toBe(true);
  await f.t.run(ctx => ctx.db.patch(f.authId, { expirationTime: Date.now() + 1000 })); expect((await f.status()).validUntil).toBe(Date.now() + 1000);
  await f.t.run(ctx => ctx.db.patch(issued.receipt.invitationId, { expiresAt: Date.now() + 500 })); expect((await f.status()).validUntil).toBe(Date.now() + 500);
  await f.t.run(ctx => ctx.db.patch(issued.receipt.sessionId, { retainUntil: Date.now() + 400 })); expect((await f.status()).validUntil).toBe(Date.now() + 400);
  await f.t.run(async ctx => { const gateway = await ctx.db.query('researchGatewayAllocations').withIndex('by_allocationId', q => q.eq('allocationId', 'test-deployment')).unique(); await ctx.db.patch(gateway!._id, { expiresAt: Date.now() + 300 }); }); expect((await f.status()).validUntil).toBe(Date.now() + 300);
  await f.t.run(ctx => ctx.db.patch(before.parent!._id, { expiresAt: Date.now() + 200 })); expect((await f.status()).validUntil).toBe(Date.now() + 200);
  vi.advanceTimersByTime(201); const expired = await f.status(); expect(expired.validUntil).toBe(expired.observedAt); expect(expired.current).toBe(false);
  const after = await f.rows(); expect(after.parent!.committed).toEqual(before.parent!.committed); expect(after.child!.captureBytesCharged).toBe(before.child!.captureBytesCharged); expect(after.speech).toEqual(before.speech); expect(after.policies).toEqual(before.policies); expect((await f.receipt()).state).toBe('found');
});


test('live connection observation expires at capture deadline while retained evidence remains readable', async () => {
  const f = await fixture(); const issued = await f.begin(); const challenge = 'd'.repeat(64);
  // Keep unrelated finite authorization valid past the recording deadline.
  await f.t.run(async ctx => {
    const expiresAt = issued.capture.deadline + 600000;
    for (const table of ['researchReadinessEnvelopes', 'researchGatewayAllocations'] as const) {
      for (const row of await ctx.db.query(table).take(10)) await ctx.db.patch(row._id, { expiresAt });
    }
  });
  await f.t.mutation(api.capture.connectDom, { token, origin: 'https://prototype.example', challenge });
  await f.t.mutation(api.capture.appendDom, { token, origin: 'https://prototype.example', challenge, requestId: 'deadline-click', events: [{ sequence: 0, atMs: 0, kind: 'connected', target: 'none', tag: 'none', x: null, y: null }, { sequence: 1, atMs: 10, kind: 'click', target: 'c1', tag: 'button', x: 50, y: 50 }] });
  vi.setSystemTime(issued.capture.deadline - 1);
  const before = await f.status();
  expect(before.current).toBe(true); expect(before.domConnected).toBe(true);
  expect(before.recording).toBe('active'); expect(before.validUntil).toBe(issued.capture.deadline);
  vi.setSystemTime(issued.capture.deadline + 1);
  const after = await f.status();
  expect(after.current).toBe(true); expect(after.domConnected).toBe(false);
  expect(after.recording).toBe('stopped'); expect(after.event).toEqual(before.event);
  expect(after.validUntil).toBe(after.observedAt + 30000);
  const participant = await f.t.query(api.capture.status, { token });
  expect(participant.recording).toBe(after.recording);
});


test('ordinary absent-DOM setup is visible before issue; typed rejection persists and only a fresh authorized request creates a test', async () => {
  const f = await fixture(); await f.t.run(ctx => ctx.db.delete(f.policyId));
  const preview = await f.op.query(q('researchCaptureTests:preview'), await f.signed('welcomePreview', { scope: f.scope, runtime: f.facts() })); expect(preview.setup).toEqual({ controlledDomRequired: true, controlledDomAuthorized: false });
  const original = { ...f.input, expectedBinding: preview.binding }; const result = await f.issue(original); expect(result.state).toBe('closed'); expect(result.terminal.reason).toBe('controlled-dom-authorization-required'); expect((await f.rows()).sessions).toHaveLength(0); expect(await f.receipt(original)).toEqual(result);
  await f.op.mutation(api.capture.authorizePrototype, { clientId: f.clientId, projectId: f.projectId, studyId: f.scope.studyId, origin: 'https://prototype.example', componentIds: ['c1'] });
  const ready = await f.op.query(q('researchCaptureTests:preview'), await f.signed('welcomePreview', { scope: f.scope, runtime: f.facts() })); expect(ready.setup.controlledDomAuthorized).toBe(true);
  expect(await f.issue(original)).toEqual(result); expect((await f.rows()).sessions).toHaveLength(0);
  const fresh = await f.issue({ ...original, requestId: 'fresh-after-authorization', expectedBinding: ready.binding }); expect(fresh.inserted).toBe(true); expect((await f.rows()).sessions).toHaveLength(1); expect((await f.rows()).child!.captureBytesCharged).toBe(0);
});
test('atomic original closure wins before a delayed issue without creating, revoking or charging any test', async () => {
  const f = await fixture(), before = await f.rows(); expect(await f.receipt()).toEqual({ state: 'unresolved' });
  const close = await f.op.mutation(m('researchCaptureTests:close'), await f.signed('captureTestClose', { input: f.input })); expect(close.state).toBe('closed'); expect(close.terminal.reason).toBe('operator-closed'); expect(await f.issue()).toEqual(close); expect(await f.receipt()).toEqual(close); expect(await f.rows()).toEqual(before);
  await f.t.run(ctx => ctx.db.patch(before.parent!._id, { enabled: false })); expect(await f.receipt()).toEqual(close); expect(await f.op.mutation(m('researchCaptureTests:close'), await f.signed('captureTestClose', { input: f.input }))).toEqual(close);
  await expect(f.op.mutation(m('researchCaptureTests:close'), await f.signed('captureTestClose', { input: { ...f.input, device: { browser: 'Changed', platform: 'desktop' } } }))).rejects.toThrow();
  await expect(f.op.mutation(m('researchCaptureTests:close'), await f.signed('captureTestClose', { input: { ...f.input, scope: { ...f.scope, studyVersion: 2 } } }))).rejects.toThrow();
  await expect(f.t.mutation(m('researchCaptureTests:close'), await f.signed('captureTestClose', { input: f.input }))).rejects.toThrow();
});
test('issue wins before close: cancellation returns accepted original and never revokes it or creates a second test', async () => {
  const f = await fixture(), first = await f.issue(), before = await f.rows();
  const close = await f.op.mutation(m('researchCaptureTests:close'), await f.signed('captureTestClose', { input: f.input })); expect(close).toEqual({ state: 'found', receipt: first.receipt }); expect(close.receipt.revokedAt).toBeNull(); expect(await f.rows()).toEqual(before);
  const terminals = await f.t.run(ctx => ctx.db.query('researchCaptureTestTerminals').withIndex('by_ownerId_and_requestId', q => q.eq('ownerId', f.userId).eq('terminal.input.requestId', f.input.requestId)).take(2)); expect(terminals).toEqual([]);
  await expect(f.op.mutation(m('researchCaptureTests:close'), await f.signed('captureTestClose', { input: { ...f.input, device: { ...f.input.device, browser: 'Changed' } } }))).rejects.toThrow();
});
test('actual browser controller and native APIs complete required setup and terminal original recovery without a replay', async () => {
  const { CaptureTestController } = await import('../../../apps/research/src/StudyCaptureTest');
  const f = await fixture(); await f.t.run(ctx => ctx.db.delete(f.policyId)); const values = new Map<string,string>();
  const journal = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key,value); }, removeItem: (key: string) => { values.delete(key); } }, calls: string[] = [];
  const request = async (route: string, _auth: string, input: any) => {
    calls.push(route);
    if (route.endsWith('study-welcome')) return f.op.query(q('researchCaptureTests:preview'), await f.signed('welcomePreview', { scope: input.scope, runtime: f.facts() }));
    if (route.endsWith('/close')) return f.op.mutation(m('researchCaptureTests:close'), await f.signed('captureTestClose', { input }));
    if (route.endsWith('/receipt')) return f.receipt(input);
    const issued = await f.issue(input); return 'state' in issued ? issued : { receipt: issued.receipt, token: issued.inserted ? token : null };
  };
  const controller = new CaptureTestController(f.scope, journal, request); await controller.preview('auth', true); await controller.issue('auth', true, f.input.device); expect(calls).toHaveLength(1); expect((await f.rows()).sessions).toHaveLength(0);
  // Preserve a historical unknown journal. Only the native close transaction, not its absence, releases it.
  const original = { ...f.input, expectedBinding: controller.state.preview!.binding }; journal.setItem(controller.journalKey, JSON.stringify(original));
  const recovered = new CaptureTestController(f.scope, journal, request); await recovered.checkReceipt('auth'); expect(recovered.state.terminal).toBeNull(); await recovered.closeOriginal('auth'); expect(recovered.state.terminal!.reason).toBe('operator-closed'); expect(await f.issue(original)).toMatchObject({ state: 'closed' });
  await f.op.mutation(api.capture.authorizePrototype, { clientId: f.clientId, projectId: f.projectId, studyId: f.scope.studyId, origin: 'https://prototype.example', componentIds: ['c1'] });
  await recovered.issue('auth', true, f.input.device); expect((await f.rows()).sessions).toHaveLength(0);
  await recovered.preview('auth', true); await recovered.issue('auth', true, f.input.device); expect(recovered.state.receipt).not.toBeNull(); expect(recovered.state.original!.requestId).not.toBe(original.requestId); expect((await f.rows()).sessions).toHaveLength(1); expect((await f.rows()).child!.captureBytesCharged).toBe(0);
  expect(calls).toEqual(['/api/research/study-welcome','/api/research/capture-test/receipt','/api/research/capture-test/close','/api/research/study-welcome','/api/research/capture-test/issue']);
});
