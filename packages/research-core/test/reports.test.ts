import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../convex/schema';
import { api, internal } from '../../../convex/_generated/api';
import { hashCapability } from '../../../convex/access';
import { signGateway } from '../../research-capture/src/proof';
import { evidenceId, hashValue, validateFindings } from '../src/analysis';
const modules = import.meta.glob('../../../convex/**/*.ts'), secret = 'a'.repeat(64), paginationOpts = { numItems: 25, cursor: null };
const consent = { version: 'research-consent-1' as const, storage: true, analysis: true, microphone: false, camera: false, screen: false, dom: false, shareDom: false, shareTranscript: true, shareAudio: false, shareCamera: false, shareScreen: false, retainApprovedExcerpts: true };
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv('RESEARCH_MEDIA_GATEWAY_SECRET', secret); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function fixture() {
  const t = convexTest(schema, modules), identity = await t.run(async ctx => { const userId = await ctx.db.insert('users', { email: 'reports@synthetic.example' }); await ctx.db.insert('researchOperators', { userId, role: 'operator', name: 'Synthetic operator', active: true }); const sessionId = await ctx.db.insert('authSessions', { userId, expirationTime: Date.now() + 86_400_000 }); return { userId, sessionId }; });
  const op = t.withIdentity({ subject: `${identity.userId}|${identity.sessionId}` }), clientId = await op.mutation(api.research.createClient, { name: 'Frozen client' }), projectId = await op.mutation(api.research.createProject, { clientId, name: 'Frozen project' });
  await op.mutation(api.research.saveStudy, { clientId, projectId, expectedRevision: 0, definition: { title: 'Report study', introduction: 'Synthetic only', goals: ['Inspect evidence'], script: [{ id: 'q1', question: 'What happened?' }], prototypeUrl: null, repository: null } });
  const token = 'b'.repeat(64), invite = await op.mutation(internal.invitations.issue, { clientId, projectId, studyVersion: 1, requestId: 'reports-invite', tokenHash: await hashCapability(token) });
  await t.mutation(api.participant.agree, { token, expectedRevision: 0, consent });
  await t.mutation(api.participant.answer, { token, expectedRevision: 1, requestId: 'reports-answer', questionId: 'q1', text: 'I could not find delivery cost.', channel: 'text' });
  const sources = await op.query(api.research.sessionSources, { clientId, projectId, sessionId: invite.sessionId, paginationOpts }), source = sources.page.find(s => s.author === 'participant')!;
  const scope = { clientId, projectId }, selection = { sessionId: invite.sessionId, id: source._id, kind: 'self-report' as const, start: 0, end: source.text.length };
  const sign = async <T>(operation: string, args: T) => ({ ...args, proof: await signGateway(secret, `research:${operation}`, args) });
  const reservation = { id: 'root-fixture-reservation', model: 'glm-5.3-flash' as const, maxInputBytes: 64_000, maxOutputTokens: 1000, live: false, expiresAt: Date.now() + 120_000 };
  const admitted = await op.mutation(api.researchAnalysis.admit, await sign('admit', { ...scope, requestId: 'analysis-request-1', selections: [selection], reservation }));
  const analysisId = admitted.analysisId, analysisScope = { ...scope, analysisId }, refs = evidenceId(selection), findings = [{ id: 'f1', statement: 'Participant reported difficulty finding delivery cost.', type: 'self-report' as const, supports: [refs], counterevidence: [], limitations: 'One synthetic participant self-report.' }];
  async function ready() {
    await op.mutation(api.researchAnalysis.beginDispatch, await sign('beginDispatch', { ...analysisScope, receipt: { requestId: null, model: reservation.model, inputHash: 'c'.repeat(64), requestBytes: 1000, maxOutputTokens: 1000, outputHash: null, frames: [], classification: 'offline-fixture' as const, errorCode: null } }));
    await op.mutation(api.researchAnalysis.finish, await sign('finish', { ...analysisScope, state: 'ready' as const, findings, requestId: 'fixture-response', outputHash: await hashValue(findings), errorCode: null }));
    return op.mutation(api.researchAnalysis.saveReview, { ...analysisScope, expectedRevision: 2, findings, excerpts: [{ evidenceId: refs, text: source.text }] });
  }
  async function publish(grants = [{ evidenceId: refs, view: true, download: false }]) {
    const reviewRevision = await ready(), args = { ...analysisScope, reviewRevision, title: 'Exact report', grants }, preview = await op.query(api.researchReports.preview, args);
    return op.mutation(api.researchReports.publish, { ...args, previewHash: preview.previewHash, requestId: 'publish-request-1' });
  }
  async function unlock(reportId: Awaited<ReturnType<typeof publish>>['reportId']) {
    const share = await op.mutation(api.researchPortal.issueShare, await sign('issueShare', { ...scope, reportId, requestId: 'share-request-1', slug: 'd'.repeat(32), passwordSalt: 'e'.repeat(64), passwordHash: 'f'.repeat(64) }));
    const viewerToken = '1'.repeat(64), tokenHash = await hashCapability(viewerToken), challenge = await t.mutation(api.researchPortal.beginUnlock, await sign('beginUnlock', { slug: share.slug, tokenHash }));
    await t.mutation(api.researchPortal.finishUnlock, await sign('finishUnlock', { sessionId: challenge!.sessionId, tokenHash, accepted: true }));
    return { share, viewerToken };
  }
  return { t, op, scope, source, selection, refs, findings, sign, reservation, analysisId, analysisScope, admitted, token, sessionId: invite.sessionId, ready, publish, unlock };
}
describe('source-linked analysis and publication authority', () => {
  it('operator analysis and report pagination returns the declared public envelope', async () => {
    const f = await fixture(); await f.publish();
    const analyses = await f.op.query(api.researchAnalysis.list, { ...f.scope, paginationOpts });
    const reports = await f.op.query(api.researchReports.list, { ...f.scope, paginationOpts });
    for (const page of [analyses, reports]) expect(Object.keys(page).sort()).toEqual(['continueCursor', 'isDone', 'page']);
    expect(analyses.page[0].analysisId).toBe(f.analysisId); expect(reports.page[0].state).toBe('published');
  });
  it('excludes retained unreviewed speech from evidence while accepting confirmed transcripts', async () => {
    const f = await fixture();
    const rawId = await f.t.run(ctx => ctx.db.insert('researchSources', { sessionId: f.sessionId, clientId: f.scope.clientId, projectId: f.scope.projectId, sourceId: 'raw-voice-source', requestId: 'raw-voice-request', questionId: 'q1', author: 'participant', channel: 'unreviewed-transcript', text: 'Delivery was free', sequence: 2, recordedAt: Date.now(), supersedes: null }));
    const rawSelection = { ...f.selection, id: rawId, end: 'Delivery was free'.length };
    await expect(f.op.mutation(api.researchAnalysis.admit, await f.sign('admit', { ...f.scope, requestId: 'raw-speech-admission', selections: [rawSelection], reservation: { ...f.reservation, id: 'raw-speech-reservation' } }))).rejects.toThrow('Access unavailable');
    const before = await f.op.query(api.researchAnalysis.inventory, { ...f.scope, sessionId: f.sessionId, kind: 'self-report', paginationOpts });
    expect(before.page.some(e => e.selection.id === rawId)).toBe(false);
    expect((await f.op.query(api.research.sessionSources, { ...f.scope, sessionId: f.sessionId, paginationOpts })).page.find(s => s._id === rawId)?.text).toBe('Delivery was free');
    // Synthetic persisted acceptance: native speech tests separately cover the
    // authenticated participant acceptance operation and immutable raw linkage.
    const acceptedId = await f.t.run(ctx => ctx.db.insert('researchSources', { sessionId: f.sessionId, clientId: f.scope.clientId, projectId: f.scope.projectId, sourceId: 'confirmed-voice-source', requestId: 'confirmed-voice-request', questionId: 'q1', author: 'participant', channel: 'confirmed-transcript', text: 'Delivery cost was unclear', sequence: 3, recordedAt: Date.now(), supersedes: 'raw-voice-source' }));
    const selection = { ...f.selection, id: acceptedId, end: 'Delivery cost was unclear'.length };
    expect((await f.op.query(api.researchAnalysis.inventory, { ...f.scope, sessionId: f.sessionId, kind: 'self-report', paginationOpts })).page.map(e => e.selection.id)).toContain(acceptedId);
    const admission = await f.op.mutation(api.researchAnalysis.admit, await f.sign('admit', { ...f.scope, requestId: 'confirmed-speech-admission', selections: [selection], reservation: { ...f.reservation, id: 'confirmed-speech-reservation' } }));
    expect(admission.state).toBe('admitted');
    expect((await f.op.query(api.researchAnalysis.material, await f.sign('material', { ...f.scope, analysisId: admission.analysisId }))).evidence[0].text).toBe('Delivery cost was unclear');
  });
  it('requires gateway admission and a globally single-use root reservation', async () => {
    const f = await fixture();
    await expect(f.op.mutation(api.researchAnalysis.admit, { ...f.scope, requestId: 'forged-admission', selections: [f.selection], reservation: { ...f.reservation, maxOutputTokens: 4096 }, proof: { at: Date.now(), signature: '0'.repeat(64) } })).rejects.toThrow();
    const duplicate = await f.op.mutation(api.researchAnalysis.admit, await f.sign('admit', { ...f.scope, requestId: 'analysis-request-1', selections: [f.selection], reservation: f.reservation })); expect(duplicate.analysisId).toBe(f.analysisId);
    await expect(f.op.mutation(api.researchAnalysis.admit, await f.sign('admit', { ...f.scope, requestId: 'new-request-same-budget', selections: [f.selection], reservation: f.reservation }))).rejects.toThrow('Reservation has already been consumed');
  });
  it('rejects cross-client manifests and source corrections invalidate results and copied excerpts', async () => {
    const f = await fixture(), clientId = await f.op.mutation(api.research.createClient, { name: 'Other client' }), projectId = await f.op.mutation(api.research.createProject, { clientId, name: 'Other project' });
    await expect(f.op.mutation(api.researchAnalysis.admit, await f.sign('admit', { clientId, projectId, requestId: 'cross-client-analysis', selections: [f.selection], reservation: { ...f.reservation, id: 'other-reservation' } }))).rejects.toThrow('Access unavailable');
    await f.ready(); await f.t.mutation(api.participant.correct, { token: f.token, expectedRevision: 2, requestId: 'source-correction', sourceId: f.source.sourceId, text: 'Correction: I found the delivery cost.' });
    expect((await f.op.query(api.researchAnalysis.read, f.analysisScope)).state).toBe('invalidated');
    await f.t.mutation(internal.researchReportLifecycle.invalidateSession, { sessionId: f.sessionId, cursor: null });
    expect(await f.t.run(ctx => ctx.db.get(f.analysisId))).toMatchObject({ state: 'invalidated', findings: [], excerpts: [], evidence: [], studyContext: '' });
  });
  it('an unknown provider outcome cannot dispatch twice or publish', async () => {
    const f = await fixture(), args = { ...f.analysisScope, receipt: { requestId: null, model: f.reservation.model, inputHash: 'c'.repeat(64), requestBytes: 1000, maxOutputTokens: 1000, outputHash: null, frames: [], classification: 'offline-fixture' as const, errorCode: null } };
    expect(await f.op.mutation(api.researchAnalysis.beginDispatch, await f.sign('beginDispatch', args))).toBe(true);
    await f.op.mutation(api.researchAnalysis.finish, await f.sign('finish', { ...f.analysisScope, state: 'unknown' as const, findings: [], requestId: null, outputHash: null, errorCode: 'timeout' }));
    expect(await f.op.mutation(api.researchAnalysis.beginDispatch, await f.sign('beginDispatch', args))).toBe(false);
    await expect(f.op.query(api.researchReports.preview, { ...f.analysisScope, reviewRevision: 2, title: 'Not published', grants: [] })).rejects.toThrow('Review this exact analysis revision first');
  });
  it('immutable snapshot maps private IDs to aliases and separates excerpt/view/download grants', async () => {
    const f = await fixture(), publication = await f.publish(), viewer = await f.unlock(publication.reportId);
    const readArgs = { token: viewer.viewerToken, slug: viewer.share.slug }, document = await f.t.query(api.researchPortal.readPublished, await f.sign('readPublished', readArgs));
    expect(document.findings[0].supports).toEqual(['e1']); expect(JSON.stringify(document)).not.toContain(f.source._id); expect(document.excerpts[0].text).toBe(f.source.text);
    await expect(f.t.query(api.researchPortal.sharedSource, await f.sign('sharedSource', { ...readArgs, evidenceId: 'e1', intent: 'download' as const }))).rejects.toThrow('Access unavailable');
    expect(await f.t.query(api.researchPortal.sharedSource, await f.sign('sharedSource', { ...readArgs, evidenceId: 'e1', intent: 'view' as const }))).toMatchObject({ type: 'text', text: f.source.text });
    await f.op.mutation(api.research.updateClient, { clientId: f.scope.clientId, expectedRevision: 0, name: 'Renamed client', state: 'active' });
    expect((await f.t.query(api.researchPortal.readPublished, await f.sign('readPublished', readArgs))).clientName).toBe('Frozen client');
    await expect(f.t.query(api.researchPortal.readPublished, await f.sign('readPublished', { ...readArgs, slug: '0'.repeat(32) }))).rejects.toThrow('Access unavailable');
    await f.op.mutation(api.researchPortal.revokeShare, { ...f.scope, shareId: viewer.share.shareId, expectedRevision: 0 });
    await expect(f.t.query(api.researchPortal.readPublished, await f.sign('readPublished', readArgs))).rejects.toThrow('Access unavailable');
  });
  it('requires sharing consent, even when only an approved excerpt is published', async () => {
    const f = await fixture(); await f.t.mutation(api.capture.changeConsent, { token: f.token, expectedRevision: 2, consent: { ...consent, shareTranscript: false } });
    const reviewRevision = await f.ready();
    await expect(f.op.query(api.researchReports.preview, { ...f.analysisScope, reviewRevision, title: 'No sharing consent', grants: [] })).rejects.toThrow('Participant has not granted sharing');
  });
  it('natural expiry keeps explicitly consented approved excerpts, while withdrawal removes access and derivatives', async () => {
    const f = await fixture(), publication = await f.publish([]), viewer = await f.unlock(publication.reportId), args = { token: viewer.viewerToken, slug: viewer.share.slug };
    await f.t.run(ctx => ctx.db.patch(f.sessionId, { retainUntil: Date.now() - 1, retentionState: 'purged', consent: null, purgedAt: Date.now() }));
    const retained = await f.t.query(api.researchPortal.readPublished, await f.sign('readPublished', args)); expect(retained.excerpts).toHaveLength(1); expect(retained.evidence[0].sourceAvailable).toBe(false);
    await f.t.run(ctx => ctx.db.patch(f.sessionId, { withdrawnAt: Date.now() }));
    await expect(f.t.query(api.researchPortal.readPublished, await f.sign('readPublished', args))).rejects.toThrow('Access unavailable');
    await f.t.mutation(internal.researchReportLifecycle.invalidateSession, { sessionId: f.sessionId, cursor: null });
    expect(await f.t.run(ctx => ctx.db.get(publication.reportId))).toMatchObject({ state: 'invalidated', findings: [], excerpts: [], evidence: [] });
  });
  it('limits password challenges before verification and a wrong password cannot mint a viewer', async () => {
    const f = await fixture(), publication = await f.publish(), viewer = await f.unlock(publication.reportId);
    for (let i = 0; i < 7; i++) { const tokenHash = i.toString(16).padStart(64, '0'), challenge = await f.t.mutation(api.researchPortal.beginUnlock, await f.sign('beginUnlock', { slug: viewer.share.slug, tokenHash })); expect(challenge).not.toBeNull(); expect(await f.t.mutation(api.researchPortal.finishUnlock, await f.sign('finishUnlock', { sessionId: challenge!.sessionId, tokenHash, accepted: false }))).toBeNull(); }
    expect(await f.t.mutation(api.researchPortal.beginUnlock, await f.sign('beginUnlock', { slug: viewer.share.slug, tokenHash: '9'.repeat(64) }))).toBeNull();
    expect(await f.t.run(ctx => ctx.db.query('researchViewerSessions').withIndex('by_tokenHash', q => q.eq('tokenHash', '9'.repeat(64))).first())).toBeNull();
  });
  it('camera and DOM provenance cannot be fabricated by model labels', () => {
    const e = { sessionId: 'session', kind: 'camera-observation' as const, id: 'media', start: 100, end: 101, hash: 'a'.repeat(64), consentEpoch: 1, sharingEpoch: 0, retainApprovedExcerpts: true, text: null }, refs = [evidenceId(e)];
    expect(() => validateFindings([{ id: 'f1', statement: 'Participant was confused.', type: 'tentative-camera', supports: refs, counterevidence: [], limitations: '' }], [e])).toThrow('visible cues');
    expect(() => validateFindings([{ id: 'f1', statement: 'Participant was confused.', type: 'interpretation', supports: refs, counterevidence: [], limitations: '' }], [e])).toThrow('Camera-only');
    expect(() => validateFindings([{ id: 'f1', statement: 'Clicked checkout.', type: 'observed-dom', supports: refs, counterevidence: [], limitations: '' }], [e])).toThrow();
  });
  it('a reviewed citation cannot publish without an inspectable approved excerpt or raw grant', async () => {
    const f = await fixture(); await f.ready();
    const reviewRevision = await f.op.mutation(api.researchAnalysis.saveReview, { ...f.analysisScope, expectedRevision: 3, findings: f.findings, excerpts: [] });
    await expect(f.op.query(api.researchReports.preview, { ...f.analysisScope, reviewRevision, title: 'Uninspectable source', grants: [] })).rejects.toThrow('Every published citation');
  });
  it('binds actual DOM, sampled screen/camera provenance and gaps; modality withdrawal fences old frames', async () => {
    const f = await fixture();
    const multimodalConsent = { ...consent, camera: true, screen: true, dom: true, shareCamera: true, shareScreen: true, shareDom: true };
    await f.t.mutation(api.capture.changeConsent, { token: f.token, expectedRevision: 2, consent: multimodalConsent });
    const capture = await f.t.mutation(api.capture.start, { token: f.token });
    const camera = await f.t.mutation(api.capture.reserve, { token: f.token, requestId: 'camera-fixture-segment', descriptor: { modality: 'camera', sequence: 0, startMs: 0, endMs: 1000, bytes: 8, sha256: '2'.repeat(64), mime: 'video/webm', questionId: 'q1', sourceId: null } });
    const screen = await f.t.mutation(api.capture.reserve, { token: f.token, requestId: 'screen-fixture-segment', descriptor: { modality: 'screen', sequence: 0, startMs: 0, endMs: 1000, bytes: 8, sha256: '3'.repeat(64), mime: 'video/webm', questionId: 'q1', sourceId: null } });
    const domId = await f.t.run(async ctx => { await ctx.db.patch(camera.id, { state: 'available', availableAt: Date.now() }); await ctx.db.patch(screen.id, { state: 'available', availableAt: Date.now() }); return ctx.db.insert('researchDomBatches', { captureId: capture.captureId, sessionId: f.sessionId, generation: 0, challengeHash: '4'.repeat(64), consentEpoch: 1, requestId: 'masked-dom-fixture', sourceId: 'masked-dom', origin: 'https://controlled.synthetic.example', events: [{ sequence: 0, atMs: 200, kind: 'click', target: 'c1', tag: 'button', x: 50, y: 50 }], recordedAt: Date.now() }); });
    await f.t.mutation(api.capture.gap, { token: f.token, requestId: 'upload-gap-fixture', modality: 'screen', atMs: 300, reason: 'upload-failed' });
    const gap = await f.t.run(ctx => ctx.db.query('researchCaptureGaps').withIndex('by_sessionId', q => q.eq('sessionId', f.sessionId)).first());
    const selections = [f.selection, { sessionId: f.sessionId, id: camera.id, kind: 'camera-observation' as const, start: 100, end: 101 }, { sessionId: f.sessionId, id: screen.id, kind: 'screen-observation' as const, start: 200, end: 201 }, { sessionId: f.sessionId, id: domId, kind: 'dom-event' as const, start: 0, end: 1 }, { sessionId: f.sessionId, id: gap!._id, kind: 'capture-gap' as const, start: 300, end: 301 }];
    const admitted = await f.op.mutation(api.researchAnalysis.admit, await f.sign('admit', { ...f.scope, requestId: 'multimodal-analysis', selections, reservation: { ...f.reservation, id: 'multimodal-root-reservation' } })), scope = { ...f.scope, analysisId: admitted.analysisId };
    const material = await f.op.query(api.researchAnalysis.material, await f.sign('material', scope)); expect(material.evidence.map(e => e.kind)).toEqual(['self-report', 'camera-observation', 'screen-observation', 'dom-event', 'capture-gap']); expect(material.evidence[3].text).toContain('click'); expect(material.evidence[4].text).toContain('upload-failed');
    const receipt = { requestId: null, model: f.reservation.model, inputHash: 'c'.repeat(64), requestBytes: 2000, maxOutputTokens: 1000, outputHash: null, frames: [{ evidenceId: evidenceId(selections[1]), mediaHash: '2'.repeat(64), atMs: 100, imageHash: '5'.repeat(64), bytes: 20 }, { evidenceId: evidenceId(selections[2]), mediaHash: '3'.repeat(64), atMs: 200, imageHash: '6'.repeat(64), bytes: 20 }], classification: 'offline-fixture' as const, errorCode: null };
    await expect(f.op.mutation(api.researchAnalysis.beginDispatch, await f.sign('beginDispatch', { ...scope, receipt: { ...receipt, frames: receipt.frames.map(frame => ({ ...frame, atMs: frame.atMs + 1 })) } }))).rejects.toThrow('Access unavailable');
    expect(await f.op.mutation(api.researchAnalysis.beginDispatch, await f.sign('beginDispatch', { ...scope, receipt }))).toBe(true);
    await f.t.mutation(api.capture.changeConsent, { token: f.token, expectedRevision: 3, consent: { ...multimodalConsent, camera: false, shareCamera: false } });
    await expect(f.op.query(api.researchAnalysis.material, await f.sign('material', scope))).rejects.toThrow('Access unavailable'); expect((await f.op.query(api.researchAnalysis.read, scope)).state).toBe('invalidated');
  });
});
