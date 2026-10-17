import { getAuthSessionId } from '@convex-dev/auth/server';
import { CAPTURE_TEST_STATUS_MAX_AGE_MS } from '../packages/research-core/src/welcome';
import { v, ConvexError } from 'convex/values';
import { mutation, query, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { operator, denied, retainsSources } from './access';
import { gatewayProof } from './captureValidators';
import { savedScope, runtimeFacts } from './researchReadinessValidators';
import { testIssue, testReceipt, testClosed, welcome } from './researchWelcomeValidators';
import { admissionForStudy, checkReadinessRuntime, savedReadinessStudy } from './researchReadiness';
import { studyCaptureIdentity } from './researchTestBinding';
import { welcomeForStudy } from './researchWelcome';
import { captureFor, segmentVisible } from './capture';
import { canonical, verifyGateway } from '../packages/research-capture/src/proof';
import { hashValue } from '../packages/research-core/src/analysis';
import { boundedText, requestId } from '../packages/research-core/src/limits';
import { scheduleInvitation, scheduleRetention } from './lifecycle';
import type { StudyRuntimeFacts } from '../packages/research-core/src/readiness';
declare const process: { env: Record<string, string | undefined> };
const authorize = (name: string, input: unknown, proof: { at: number; signature: string }) => verifyGateway(process.env.RESEARCH_MEDIA_GATEWAY_SECRET, `readiness:${name}`, input, proof);
type Scope = { clientId: Id<'researchClients'>; projectId: Id<'researchProjects'>; studyId: Id<'researchStudies'>; studyVersion: number };
async function material(ctx: QueryCtx, scope: Scope, ownerId: Id<'users'>, runtime: StudyRuntimeFacts) {
  checkReadinessRuntime(runtime);
  const saved = await savedReadinessStudy(ctx, scope, ownerId), identity = await studyCaptureIdentity(ctx, saved.study);
  const binding = await hashValue({ implementation: 'study-capture-test-v1', scope, studyIdentity: identity.identity, configurationDigest: runtime.configurationDigest, runtimeRevision: runtime.revision });
  return { ...saved, ...identity, binding };
}
async function receiptView(ctx: QueryCtx, row: Doc<'researchCaptureTests'>) {
  const invitation = await ctx.db.get(row.invitationId), session = await ctx.db.get(row.sessionId);
  if (!invitation || !session || session.purpose !== 'readiness-test' || invitation.sessionId !== session._id || invitation.studyId !== row.scope.studyId) return denied();
  return { invitationId: invitation._id, sessionId: session._id, requestId: row.input.requestId, scope: row.scope, binding: row.binding, configurationDigest: row.configurationDigest, issuedAt: row.issuedAt, expiresAt: invitation.expiresAt, retainUntil: session.retainUntil, device: row.input.device, deviceContext: 'operator-reported' as const, revokedAt: invitation.revokedAt };
}
async function original(ctx: QueryCtx, ownerId: Id<'users'>, input: Doc<'researchCaptureTests'>['input']) {
  requestId(input.requestId); await savedReadinessStudy(ctx, input.scope, ownerId);
  const row = await ctx.db.query('researchCaptureTests').withIndex('by_ownerId_and_requestId', q => q.eq('ownerId', ownerId).eq('input.requestId', input.requestId)).unique();
  if (row && canonical(row.input) !== canonical(input)) throw new ConvexError('Request identifier was already used for a different test');
  return row;
}
async function terminalFor(ctx: QueryCtx, ownerId: Id<'users'>, input: Doc<'researchCaptureTests'>['input']) {
  const row = await ctx.db.query('researchCaptureTestTerminals').withIndex('by_ownerId_and_requestId', q => q.eq('ownerId', ownerId).eq('terminal.input.requestId', input.requestId)).unique();
  if (row && canonical(row.terminal.input) !== canonical(input)) return denied();
  return row ? { state: 'closed' as const, terminal: row.terminal } : null;
}
export const preview = query({ args: { scope: savedScope, runtime: runtimeFacts, proof: gatewayProof }, returns: v.object({ welcome, binding: v.string(), configurationDigest: v.string(), setup: v.object({ controlledDomRequired: v.boolean(), controlledDomAuthorized: v.boolean() }) }), handler: async (ctx, { proof, ...input }) => {
  await authorize('welcomePreview', input, proof); const actor = await operator(ctx), view = await material(ctx, input.scope, actor.userId, input.runtime);
  return { welcome: await welcomeForStudy(ctx, view.study), binding: view.binding, configurationDigest: input.runtime.configurationDigest, setup: { controlledDomRequired: !!view.study.definition.captureExpectation?.controlledDom, controlledDomAuthorized: !!view.policy } };
} });
export const issue = mutation({ args: { input: testIssue, tokenHash: v.string(), runtime: runtimeFacts, proof: gatewayProof }, returns: v.union(v.object({ receipt: testReceipt, inserted: v.boolean() }), testClosed), handler: async (ctx, { proof, ...args }) => {
  await authorize('captureTestIssue', args, proof); const actor = await operator(ctx), prior = await original(ctx, actor.userId, args.input);
  const terminal = await terminalFor(ctx, actor.userId, args.input);
  if (prior) return { receipt: await receiptView(ctx, prior), inserted: false };
  if (terminal) return terminal;
  const view = await material(ctx, args.input.scope, actor.userId, args.runtime), project = await ctx.db.get(args.input.scope.projectId);
  if (!view.active || project?.latestStudyVersion !== view.study.version || args.input.expectedBinding !== view.binding || !/^[a-f0-9]{64}$/.test(args.tokenHash)) return denied();
  boundedText(args.input.device.browser, 100, 'browser context'); boundedText(args.input.device.platform, 100, 'platform context');
  const child = await admissionForStudy(ctx, view.study._id), parent = child && await ctx.db.get(child.envelopeId);
  if (!child || !parent?.enabled || parent.expiresAt <= Date.now() || !child.enabled.includes('private-capture') || child.captureBytesCharged >= child.captureByteLimit || !args.runtime.capture.enabled || !args.runtime.capture.qualified) return denied();
  if (view.study.definition.captureExpectation?.controlledDom && !view.policy) {
    const terminal = { input: args.input, reason: 'controlled-dom-authorization-required' as const, closedAt: Date.now() };
    await ctx.db.insert('researchCaptureTestTerminals', { ownerId: actor.userId, terminal });
    return { state: 'closed' as const, terminal }; // Return: throwing would roll back this authoritative outcome.
  }
  if (await ctx.db.query('researchInvitations').withIndex('by_tokenHash', q => q.eq('tokenHash', args.tokenHash)).first()) return denied();
  const now = Date.now(), expiresAt = now + 7 * 86400000, retainUntil = now + 30 * 86400000;
  const sessionId = await ctx.db.insert('researchSessions', { purpose: 'readiness-test', ownerId: actor.userId, ...{ clientId: args.input.scope.clientId, projectId: args.input.scope.projectId, studyId: view.study._id }, state: 'invited', revision: 0, nextQuestion: 0, interviewEnabled: false, sourceCount: 0, consent: null, consentAt: null, createdAt: now, savedAt: now, retainUntil, retentionState: 'retained' });
  const invitationId = await ctx.db.insert('researchInvitations', { ownerId: actor.userId, clientId: args.input.scope.clientId, projectId: args.input.scope.projectId, studyId: view.study._id, tokenHash: args.tokenHash, sessionId, expiresAt, revokedAt: null, requestId: `test-${sessionId}`, lifecycleVersion: 1 });
  const id = await ctx.db.insert('researchCaptureTests', { ownerId: actor.userId, input: args.input, scope: args.input.scope, sessionId, invitationId, binding: view.binding, studyIdentity: view.identity, configurationDigest: args.runtime.configurationDigest, runtimeRevision: args.runtime.revision, issuedAt: now });
  await scheduleInvitation(ctx, (await ctx.db.get(invitationId))!); await scheduleRetention(ctx, (await ctx.db.get(sessionId))!);
  return { receipt: await receiptView(ctx, (await ctx.db.get(id))!), inserted: true };
} });
export const receipt = query({ args: { input: testIssue, proof: gatewayProof }, returns: v.union(v.object({ state: v.literal('unresolved') }), v.object({ state: v.literal('found'), receipt: testReceipt }), testClosed), handler: async (ctx, { proof, ...args }) => {
  await authorize('captureTestReceipt', args, proof); const actor = await operator(ctx), row = await original(ctx, actor.userId, args.input);
  const terminal = await terminalFor(ctx, actor.userId, args.input);
  return row ? { state: 'found' as const, receipt: await receiptView(ctx, row) } : terminal ?? { state: 'unresolved' as const };
} });
/** Deliberate cancellation serializes with issue on both exact request indexes. Absence alone is never terminal. */
export const close = mutation({ args: { input: testIssue, proof: gatewayProof }, returns: v.union(v.object({ state: v.literal('found'), receipt: testReceipt }), testClosed), handler: async (ctx, { proof, ...args }) => {
  await authorize('captureTestClose', args, proof); const actor = await operator(ctx), row = await original(ctx, actor.userId, args.input), terminal = await terminalFor(ctx, actor.userId, args.input);
  if (row) return { state: 'found' as const, receipt: await receiptView(ctx, row) };
  if (terminal) return terminal;
  boundedText(args.input.device.browser, 100, 'browser context'); boundedText(args.input.device.platform, 100, 'platform context');
  if (!/^[a-f0-9]{64}$/.test(args.input.expectedBinding)) return denied();
  const next = { input: args.input, reason: 'operator-closed' as const, closedAt: Date.now() };
  await ctx.db.insert('researchCaptureTestTerminals', { ownerId: actor.userId, terminal: next });
  return { state: 'closed' as const, terminal: next };
} });
const eventView = v.object({ batchId: v.id('researchDomBatches'), sequence: v.number(), kind: v.string(), recordedAt: v.number(), generation: v.number(), origin: v.string() });
const mediaView = v.object({ mediaId: v.id('researchMedia'), modality: v.string(), availableAt: v.number(), bytes: v.number(), sha256: v.string(), mime: v.string(), startMs: v.number(), endMs: v.number(), partial: v.boolean() });
export const status = query({ args: { input: testIssue, runtime: runtimeFacts, proof: gatewayProof }, returns: v.union(testClosed, v.object({ state: v.literal('unresolved') }), v.object({ state: v.literal('found'), receipt: testReceipt, observedAt: v.number(), validUntil: v.number(), current: v.boolean(), reason: v.string(), domConnected: v.boolean(), event: v.union(eventView, v.null()), media: v.array(mediaView), recording: v.string(), gaps: v.array(v.object({ modality: v.string(), reason: v.string(), recordedAt: v.number() })), cleanup: v.string() })), handler: async (ctx, { proof, ...args }) => {
  await authorize('captureTestStatus', args, proof); const actor = await operator(ctx), row = await original(ctx, actor.userId, args.input);
  const terminal = await terminalFor(ctx, actor.userId, args.input);
  if (!row) return terminal ?? { state: 'unresolved' as const };
  const receipt = await receiptView(ctx, row), view = await material(ctx, row.scope, actor.userId, args.runtime), session = (await ctx.db.get(row.sessionId))!, invitation = (await ctx.db.get(row.invitationId))!, project = await ctx.db.get(row.scope.projectId), capture = await captureFor(ctx, row.sessionId);
  const identityCurrent = view.active && project?.latestStudyVersion === row.scope.studyVersion && view.binding === row.binding;
  const child = await admissionForStudy(ctx, row.scope.studyId), parent = child && await ctx.db.get(child.envelopeId);
  const observedAt = Date.now(), authId = await getAuthSessionId(ctx), authSession = authId && await ctx.db.get(authId);
  const allocation = args.runtime.capture.gatewayAllocationId ? await ctx.db.query('researchGatewayAllocations').withIndex('by_allocationId', q => q.eq('allocationId', args.runtime.capture.gatewayAllocationId!)).unique() : null;
  const liveCaptureDeadline = capture?.state === 'active' && capture.deadline > observedAt ? capture.deadline : Infinity;
  const recording = capture?.state === 'active' && capture.deadline <= observedAt ? 'stopped' : capture?.state ?? 'not-started';
  const validUntil = Math.max(observedAt, Math.min(liveCaptureDeadline, observedAt + CAPTURE_TEST_STATUS_MAX_AGE_MS, invitation.expiresAt, session.retainUntil, parent?.expiresAt ?? observedAt, allocation?.expiresAt ?? observedAt, authSession?.expirationTime ?? observedAt));
  const current = validUntil > observedAt && !!parent?.enabled && parent.expiresAt > Date.now() && !!child?.enabled.includes('private-capture') && identityCurrent && invitation.revokedAt === null && invitation.expiredAt === undefined && invitation.expiresAt > Date.now() && retainsSources(session) && session.withdrawnAt === undefined && !!session.consent?.storage && !!session.consent.analysis && !!capture && !['purging', 'purged'].includes(capture.state) && args.runtime.capture.enabled && args.runtime.capture.qualified;
  let event = null; const media = [];
  const gaps = capture ? await ctx.db.query('researchCaptureGaps').withIndex('by_sessionId', q => q.eq('sessionId', session._id)).take(101) : [];
  if (current && capture) {
    if (session.consent?.dom) {
      const batches = await ctx.db.query('researchDomBatches').withIndex('by_captureId_and_consentEpoch', q => q.eq('captureId', capture._id).gt('consentEpoch', capture.revokedThrough.dom)).order('desc').take(101);
      if (batches.length <= 100) for (const batch of batches) {
        const real = batch.events.find(e => e.kind !== 'connected');
        if (real && view.policy && batch.origin === view.policy.origin && view.policy.componentIds.includes(real.target)) { event = { batchId: batch._id, sequence: real.sequence, kind: real.kind, recordedAt: batch.recordedAt, generation: batch.generation, origin: batch.origin }; break; }
      }
    }
    for (const modality of ['microphone', 'camera', 'screen'] as const) {
      const rows = await ctx.db.query('researchMedia').withIndex('by_captureId_and_state_and_modality_and_consentEpoch', q => q.eq('captureId', capture._id).eq('state', 'available').eq('descriptor.modality', modality).gt('consentEpoch', capture.revokedThrough[modality])).order('desc').take(1);
      const m = rows[0];
      if (m && m.availableAt !== null && segmentVisible(session, capture, m)) media.push({ mediaId: m._id, modality, availableAt: m.availableAt, bytes: m.descriptor.bytes, sha256: m.descriptor.sha256, mime: m.descriptor.mime, startMs: m.descriptor.startMs, endMs: m.descriptor.endMs, partial: (capture.interruptions ?? 0) > 0 || gaps.some(g => g.modality === modality && ['track-ended', 'upload-failed', 'paused', 'capacity'].includes(g.reason)) });
    }
  }
  return { state: 'found' as const, receipt, observedAt, validUntil, current, reason: !identityCurrent ? 'Changed study or configuration; test again.' : !current ? 'Test access, consent or runtime is unavailable; retained references do not prove current readiness.' : 'Authoritative retained test evidence; device context is operator-reported.', domConnected: current && !!capture?.domChallengeHash && capture.domCount > capture.domGenerationStart && capture.state === 'active' && capture.deadline > Date.now() && session.state === 'active', event, media, recording, gaps: gaps.map(g => ({ modality: g.modality, reason: g.reason, recordedAt: g.recordedAt })), cleanup: session.retentionState ?? 'retained' };
} });
