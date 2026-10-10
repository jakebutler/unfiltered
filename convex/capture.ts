import { paginationOptsValidator } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { denied, hashCapability, operatorQuery, operatorMutation, pageResult, pageSize, participant, projectFor, retainsSources, revision } from './access';
import { consent } from './validators';
import { descriptor, domEvent, modality, segmentView } from './captureValidators';
import { CAPTURE_LIMITS as L, captureLimits, validateDescriptor, validateDomEvent } from '../packages/research-capture/src/contracts';
import { requestId } from '../packages/research-core/src/limits';
import { canonical } from '../packages/research-capture/src/proof';

// Convex provides process.env in its V8 runtime; this is a module-scoped type only.
declare const process: { env: Record<string, string | undefined> };

export async function captureFor(ctx: QueryCtx, sessionId: Id<'researchSessions'>) {
  return ctx.db.query('researchCaptures').withIndex('by_sessionId', q => q.eq('sessionId', sessionId)).unique();
}
export function segmentVisible(session: Doc<'researchSessions'>, capture: Doc<'researchCaptures'>, media: Doc<'researchMedia'>): boolean {
  return retainsSources(session) && !!session.consent?.storage && !!session.consent?.[media.descriptor.modality] && capture.state !== 'purging' && capture.state !== 'purged' && media.consentEpoch > capture.revokedThrough[media.descriptor.modality] && media.state === 'available';
}
export function viewMedia(row: Doc<'researchMedia'>) {
  return { id: row._id, descriptor: row.descriptor, state: row.state, sourceId: row.sourceId, recordedAt: row.recordedAt, availableAt: row.availableAt };
}
async function capacity(ctx: MutationCtx) {
  const row = await ctx.db.query('researchCaptureCapacity').withIndex('by_name', q => q.eq('name', 'demo')).unique();
  if (row) return row;
  const id = await ctx.db.insert('researchCaptureCapacity', { name: 'demo', retainedSessions: 0, activeSessionId: null, activeUntil: 0 });
  return (await ctx.db.get(id))!;
}
export const start = mutation({ args: { token: v.string() }, returns: v.object({ captureId: v.id('researchCaptures'), startedAt: v.number(), deadline: v.number(), bytesRemaining: v.number() }), handler: async (ctx, { token }) => {
  const { session } = await participant(ctx, token);
  if (session.state !== 'active' || !session.consent?.storage || !session.consent.analysis || ![session.consent.microphone, session.consent.camera, session.consent.screen, session.consent.dom].some(Boolean)) throw new ConvexError('Choose capture consent before recording');
  let row = await captureFor(ctx, session._id);
  if (row) {
    if (!['active', 'paused'].includes(row.state) || row.deadline <= Date.now()) throw new ConvexError('Recording has ended; the conversation can continue');
    if (row.state === 'paused') {
      // Resuming the conversation does not restart any capture. This explicit
      // participant action re-admits the existing recording without extending it.
      const cap = await capacity(ctx);
      if (cap.activeSessionId && cap.activeSessionId !== session._id && cap.activeUntil > Date.now()) throw new ConvexError('Recording capacity is unavailable; the conversation can continue');
      await ctx.db.patch(cap._id, { activeSessionId: session._id, activeUntil: row.deadline });
      await ctx.db.patch(row._id, { state: 'active' });
      row = (await ctx.db.get(row._id))!;
    }
  } else {
    const cap = await capacity(ctx), limits = captureLimits(process.env.RESEARCH_CAPTURE_LIMITS_JSON);
    if (cap.retainedSessions >= limits.retainedSessions || cap.activeSessionId && cap.activeUntil > Date.now()) throw new ConvexError('Recording capacity is unavailable; the conversation can continue');
    const now = Date.now(), deadline = Math.min(now + limits.sessionMs, session.retainUntil);
    const id = await ctx.db.insert('researchCaptures', { sessionId: session._id, ownerId: session.ownerId, clientId: session.clientId, projectId: session.projectId, state: 'active', startedAt: now, deadline, retainUntil: session.retainUntil, reservedBytes: 0, segmentCount: 0, consentEpoch: 1, revokedThrough: { microphone: 0, camera: 0, screen: 0, dom: 0 }, domCount: 0, domLastAt: 0, domGeneration: 0, domGenerationStart: 0, domChallengeHash: null, domOrigin: null });
    await ctx.db.patch(cap._id, { retainedSessions: cap.retainedSessions + 1, activeSessionId: session._id, activeUntil: deadline });
    row = (await ctx.db.get(id))!;
    await ctx.scheduler.runAt(deadline, internal.captureLifecycle.stopAtDeadline, { captureId: id, deadline });
    await ctx.scheduler.runAt(session.retainUntil, internal.captureLifecycle.purge, { captureId: id });
  }
  return { captureId: row._id, startedAt: row.startedAt, deadline: row.deadline, bytesRemaining: Math.max(0, captureLimits(process.env.RESEARCH_CAPTURE_LIMITS_JSON).sessionBytes - row.reservedBytes) };
} });
export const stop = mutation({ args: { token: v.string() }, returns: v.null(), handler: async (ctx, { token }) => {
  const { session } = await participant(ctx, token), capture = await captureFor(ctx, session._id);
  if (capture && ['active', 'paused'].includes(capture.state)) await ctx.db.patch(capture._id, { state: 'stopped', domChallengeHash: null });
  const cap = await capacity(ctx);
  if (cap.activeSessionId === session._id) await ctx.db.patch(cap._id, { activeSessionId: null, activeUntil: 0 });
  return null;
} });
/** Called in the same transaction as a conversation pause/end. Browser adapters
 * must observe this state and stop recorders/listeners; the API denies new data now. */
export async function conversationCaptureTransition(ctx: MutationCtx, session: Doc<'researchSessions'>, state: 'active' | 'paused' | 'partial' | 'completed') {
  if (state === 'active') return;
  const capture = await captureFor(ctx, session._id);
  if (!capture || !['active', 'paused'].includes(capture.state)) return;
  const tracks = (['microphone', 'camera', 'screen', 'dom'] as const).filter(mode => session.consent?.[mode]);
  const gaps = await ctx.db.query('researchCaptureGaps').withIndex('by_sessionId', q => q.eq('sessionId', session._id)).take(101);
  const room = gaps.length + tracks.length <= 100, atMs = Math.max(0, Math.min(L.sessionMs, Date.now() - capture.startedAt));
  if (room) for (const mode of tracks) await ctx.db.insert('researchCaptureGaps', { sessionId: session._id, captureId: capture._id, requestId: `transition-${session.revision + 1}-${mode}`, modality: mode, atMs, reason: state === 'paused' ? 'paused' : 'conversation-ended', recordedAt: Date.now() });
  await ctx.db.patch(capture._id, { state: state === 'paused' && room ? 'paused' : 'stopped', domChallengeHash: null, interruptedAt: Date.now(), interruptions: (capture.interruptions ?? 0) + 1 });
  const cap = await capacity(ctx);
  if (cap.activeSessionId === session._id) await ctx.db.patch(cap._id, { activeSessionId: null, activeUntil: 0 });
}
export const reserve = mutation({ args: { token: v.string(), requestId: v.string(), descriptor }, returns: segmentView, handler: async (ctx, args) => {
  const { session, study } = await participant(ctx, args.token); requestId(args.requestId); validateDescriptor(args.descriptor);
  const limits = captureLimits(process.env.RESEARCH_CAPTURE_LIMITS_JSON);
  if (args.descriptor.bytes > limits.segmentBytes || args.descriptor.endMs > limits.sessionMs) throw new ConvexError('Configured segment capacity exceeded');
  const capture = await captureFor(ctx, session._id);
  if (!capture || !session.consent?.storage || !session.consent[args.descriptor.modality]) return denied();
  const prior = await ctx.db.query('researchMedia').withIndex('by_sessionId_and_requestId', q => q.eq('sessionId', session._id).eq('requestId', args.requestId)).unique();
  if (prior) {
    if (canonical(prior.descriptor) !== canonical(args.descriptor)) throw new ConvexError('Request identifier was already used for different content');
    return viewMedia(prior);
  }
  if (session.state !== 'active' || capture.state !== 'active' || capture.deadline <= Date.now() || capture.reservedBytes + args.descriptor.bytes > limits.sessionBytes || capture.segmentCount >= limits.segments) throw new ConvexError('Recording capacity is unavailable');
  if (!study.definition.script.some(q => q.id === args.descriptor.questionId)) throw new ConvexError('Unknown interview question');
  if (args.descriptor.sourceId) {
    const source = await ctx.db.query('researchSources').withIndex('by_sessionId_and_sourceId', q => q.eq('sessionId', session._id).eq('sourceId', args.descriptor.sourceId!)).unique();
    if (!source || source.questionId !== args.descriptor.questionId) return denied();
  }
  const last = await ctx.db.query('researchMedia').withIndex('by_captureId_and_modality_and_sequence', q => q.eq('captureId', capture._id).eq('descriptor.modality', args.descriptor.modality)).order('desc').first();
  if (args.descriptor.sequence !== (last ? last.descriptor.sequence + 1 : 0) || last && args.descriptor.startMs < last.descriptor.endMs) throw new ConvexError('Segment sequence or interval is out of order');
  const now = Date.now();
  const id = await ctx.db.insert('researchMedia', { captureId: capture._id, sessionId: session._id, clientId: session.clientId, projectId: session.projectId, requestId: args.requestId, descriptor: args.descriptor, state: 'reserved', sourceId: `${session._id}:media:${capture.segmentCount}`, consentEpoch: capture.consentEpoch, objectKey: 'pending', attempt: 0, retiredKeys: [], retryUntil: now + limits.uploadRecoveryMs, claimUntil: now + limits.reservationMs, recordedAt: now, availableAt: null, expiresAt: now + limits.uploadRecoveryMs, leaseUntil: 0, deletedAt: null });
  await ctx.db.patch(id, { objectKey: `research/${session._id}/${id}-a0` });
  await ctx.db.patch(capture._id, { segmentCount: capture.segmentCount + 1, reservedBytes: capture.reservedBytes + args.descriptor.bytes });
  return viewMedia((await ctx.db.get(id))!);
} });
export const gap = mutation({ args: { token: v.string(), requestId: v.string(), modality, atMs: v.number(), reason: v.union(v.literal('permission-denied'), v.literal('track-ended'), v.literal('muted'), v.literal('upload-failed'), v.literal('capacity'), v.literal('paused'), v.literal('unsupported')) }, returns: v.null(), handler: async (ctx, args) => {
  const { session } = await participant(ctx, args.token), capture = await captureFor(ctx, session._id); requestId(args.requestId);
  if (!capture || !Number.isSafeInteger(args.atMs) || args.atMs < 0 || args.atMs > L.sessionMs) return denied();
  const prior = await ctx.db.query('researchCaptureGaps').withIndex('by_captureId_and_requestId', q => q.eq('captureId', capture._id).eq('requestId', args.requestId)).unique();
  if (prior) { if (prior.modality !== args.modality || prior.atMs !== args.atMs || prior.reason !== args.reason) throw new ConvexError('Conflicting gap'); return null; }
  const count = await ctx.db.query('researchCaptureGaps').withIndex('by_sessionId', q => q.eq('sessionId', session._id)).take(101);
  if (count.length >= 100) throw new ConvexError('Gap limit reached');
  await ctx.db.insert('researchCaptureGaps', { sessionId: session._id, captureId: capture._id, requestId: args.requestId, modality: args.modality, atMs: args.atMs, reason: args.reason, recordedAt: Date.now() });
  return null;
} });
export const changeConsent = mutation({ args: { token: v.string(), expectedRevision: v.number(), consent }, returns: v.number(), handler: async (ctx, args) => {
  const { session } = await participant(ctx, args.token); revision(session.revision, args.expectedRevision);
  if (!session.consent) return denied();
  if (args.consent.shareAudio && !args.consent.microphone || args.consent.shareCamera && !args.consent.camera || args.consent.shareScreen && !args.consent.screen) throw new ConvexError('Sharing requires matching capture consent');
  const capture = await captureFor(ctx, session._id);
  if (capture) {
    const revokedThrough = { ...capture.revokedThrough };
    for (const track of ['microphone', 'camera', 'screen', 'dom'] as const) if (!args.consent[track] || !args.consent.storage || !args.consent.analysis) revokedThrough[track] = capture.consentEpoch;
    await ctx.db.patch(capture._id, { consentEpoch: capture.consentEpoch + 1, revokedThrough, ...(!args.consent.dom || !args.consent.storage || !args.consent.analysis ? { domChallengeHash: null } : {}) });
    await ctx.scheduler.runAfter(0, internal.captureLifecycle.purge, { captureId: capture._id });
  }
  await ctx.db.patch(session._id, { consent: args.consent, consentAt: Date.now(), savedAt: Date.now(), revision: session.revision + 1, ...(!args.consent.storage || !args.consent.analysis ? { withdrawnAt: Date.now(), retentionState: 'purging' as const } : {}) });
  if (!args.consent.storage || !args.consent.analysis) await ctx.scheduler.runAfter(0, internal.lifecycle.purgeSources, { ownerId: session.ownerId, clientId: session.clientId, projectId: session.projectId, studyId: session.studyId, sessionId: session._id, retainUntil: session.retainUntil });
  return session.revision + 1;
} });
export const authorizePrototype = operatorMutation({ args: { clientId: v.id('researchClients'), projectId: v.id('researchProjects'), studyId: v.id('researchStudies'), origin: v.string(), componentIds: v.array(v.string()) }, returns: v.null(), handler: async (ctx, args) => {
  await projectFor(ctx, ctx.operator.userId, args.clientId, args.projectId);
  const study = await ctx.db.get(args.studyId), origin = new URL(args.origin);
  if (!study || study.projectId !== args.projectId || study.clientId !== args.clientId || !study.definition.prototypeUrl || origin.origin !== args.origin || new URL(study.definition.prototypeUrl).origin !== args.origin || !['https:', 'http:'].includes(origin.protocol)) return denied();
  if (args.componentIds.length > 64 || new Set(args.componentIds).size !== args.componentIds.length || args.componentIds.some(id => !/^c[0-9]{1,3}$/.test(id))) throw new ConvexError('Invalid approved component IDs');
  const prior = await ctx.db.query('researchDomPolicies').withIndex('by_studyId', q => q.eq('studyId', args.studyId)).unique();
  if (prior && (prior.origin !== args.origin || canonical(prior.componentIds) !== canonical(args.componentIds))) throw new ConvexError('Prototype authorization is immutable; create a new study');
  if (!prior) await ctx.db.insert('researchDomPolicies', { studyId: args.studyId, origin: args.origin, componentIds: args.componentIds, approvedAt: Date.now() });
  return null;
} });
export const connectDom = mutation({ args: { token: v.string(), origin: v.string(), challenge: v.string() }, returns: v.object({ generation: v.number(), nextSequence: v.number() }), handler: async (ctx, args) => {
  const { session } = await participant(ctx, args.token), capture = await captureFor(ctx, session._id);
  const policy = await ctx.db.query('researchDomPolicies').withIndex('by_studyId', q => q.eq('studyId', session.studyId)).unique();
  if (!capture || session.state !== 'active' || capture.state !== 'active' || capture.deadline <= Date.now() || !session.consent?.dom || !policy || policy.origin !== args.origin) return denied();
  const hash = await hashCapability(args.challenge);
  if (capture.domChallengeHash === hash) return { generation: capture.domGeneration, nextSequence: capture.domCount };
  if (capture.domChallengeHash) throw new ConvexError('DOM recording already has an instrumented document');
  await ctx.db.patch(capture._id, { domChallengeHash: hash, domOrigin: args.origin, domGeneration: capture.domGeneration + 1, domGenerationStart: capture.domCount });
  return { generation: capture.domGeneration + 1, nextSequence: capture.domCount };
} });
/** Close only the caller's current DOM generation. An old popup cannot disconnect
 * a newer instrumented document; replay does not append another gap. */
export const disconnectDom = mutation({ args: { token: v.string(), challenge: v.string() }, returns: v.null(), handler: async (ctx, args) => {
  const { session } = await participant(ctx, args.token), capture = await captureFor(ctx, session._id);
  if (!capture || !session.consent?.dom || !session.consent.storage || !session.consent.analysis) return denied();
  const hash = await hashCapability(args.challenge);
  if (capture.domChallengeHash !== hash) return null;
  const gaps = await ctx.db.query('researchCaptureGaps').withIndex('by_sessionId', q => q.eq('sessionId', session._id)).take(100);
  const room = gaps.length < 100;
  if (room) await ctx.db.insert('researchCaptureGaps', { sessionId: session._id, captureId: capture._id, requestId: `dom-disconnect-${capture.domGeneration}`, modality: 'dom', atMs: Math.max(0, Math.min(L.sessionMs, Date.now() - capture.startedAt)), reason: 'track-ended', recordedAt: Date.now() });
  await ctx.db.patch(capture._id, { domChallengeHash: null, ...(!room ? { state: 'stopped' as const } : {}) });
  if (!room) {
    const cap = await capacity(ctx);
    if (cap.activeSessionId === session._id) await ctx.db.patch(cap._id, { activeSessionId: null, activeUntil: 0 });
  }
  return null;
} });
export const appendDom = mutation({ args: { token: v.string(), challenge: v.string(), requestId: v.string(), origin: v.string(), events: v.array(domEvent) }, returns: v.string(), handler: async (ctx, args) => {
  const { session } = await participant(ctx, args.token), capture = await captureFor(ctx, session._id); requestId(args.requestId);
  if (!capture || !session.consent?.dom) return denied();
  const challengeHash = await hashCapability(args.challenge);
  const prior = await ctx.db.query('researchDomBatches').withIndex('by_captureId_and_requestId', q => q.eq('captureId', capture._id).eq('requestId', args.requestId)).unique();
  if (prior) {
    if (prior.consentEpoch <= capture.revokedThrough.dom) return denied();
    if (canonical(prior.events) !== canonical(args.events) || prior.origin !== args.origin || prior.challengeHash !== challengeHash) throw new ConvexError('Conflicting DOM batch');
    return prior.sourceId;
  }
  if (session.state !== 'active' || capture.domChallengeHash !== challengeHash || capture.domOrigin !== args.origin || capture.state !== 'active' || capture.deadline <= Date.now()) return denied();
  const limits = captureLimits(process.env.RESEARCH_CAPTURE_LIMITS_JSON);
  if (args.events.length < 1 || args.events.length > limits.domBatch) throw new ConvexError('Invalid DOM batch');
  const policy = await ctx.db.query('researchDomPolicies').withIndex('by_studyId', q => q.eq('studyId', session.studyId)).unique();
  for (const event of args.events) { validateDomEvent(event); if (event.target !== 'none' && !policy?.componentIds.includes(event.target)) throw new ConvexError('Unapproved component ID'); }
  if (capture.domCount + args.events.length > limits.domEvents || args.events.some((event, i) => event.atMs < capture.domLastAt || event.sequence !== capture.domCount + i || (event.kind === 'connected') !== (i === 0 && capture.domCount === capture.domGenerationStart) || i > 0 && event.atMs < args.events[i - 1].atMs)) throw new ConvexError('DOM sequence or capacity unavailable');
  const sourceId = `${session._id}:dom:${capture.domCount}`;
  await ctx.db.insert('researchDomBatches', { captureId: capture._id, sessionId: session._id, generation: capture.domGeneration, challengeHash, consentEpoch: capture.consentEpoch, requestId: args.requestId, sourceId, origin: args.origin, events: args.events, recordedAt: Date.now() });
  await ctx.db.patch(capture._id, { domCount: capture.domCount + args.events.length, domLastAt: args.events.at(-1)!.atMs });
  return sourceId;
} });
export const media = operatorQuery({ args: { clientId: v.id('researchClients'), projectId: v.id('researchProjects'), sessionId: v.id('researchSessions'), paginationOpts: paginationOptsValidator }, returns: v.object({ page: v.array(segmentView), isDone: v.boolean(), continueCursor: v.string() }), handler: async (ctx, args) => {
  const { client, project } = await projectFor(ctx, ctx.operator.userId, args.clientId, args.projectId); pageSize(args.paginationOpts.numItems);
  const session = await ctx.db.get(args.sessionId), capture = await captureFor(ctx, args.sessionId);
  if (!session || !capture || client.state !== 'active' || project.state !== 'active' || session.clientId !== args.clientId || session.projectId !== args.projectId || !retainsSources(session)) return denied();
  const result = await ctx.db.query('researchMedia').withIndex('by_sessionId', q => q.eq('sessionId', args.sessionId)).paginate(args.paginationOpts);
  return { ...pageResult(result), page: result.page.filter(row => row.consentEpoch > capture.revokedThrough[row.descriptor.modality]).map(viewMedia) };
} });
const modalityNumbers = v.object({ microphone: v.number(), camera: v.number(), screen: v.number() });
export const status = query({ args: { token: v.string() }, returns: v.object({ recording: v.union(v.literal('not-started'), v.literal('active'), v.literal('paused'), v.literal('stopped'), v.literal('purging'), v.literal('purged')), bytesRemaining: v.number(), deadline: v.union(v.number(), v.null()), startedAt: v.union(v.number(), v.null()), nextSequence: modalityNumbers, nextStartMs: modalityNumbers, domPolicy: v.union(v.object({ origin: v.string(), componentIds: v.array(v.string()) }), v.null()), domConnected: v.boolean() }), handler: async (ctx, args) => {
  const { session } = await participant(ctx, args.token), capture = await captureFor(ctx, session._id);
  const recording: 'active' | 'paused' | 'stopped' | 'purging' | 'purged' | 'not-started' = capture ? ['active', 'paused'].includes(capture.state) && capture.deadline <= Date.now() ? 'stopped' : capture.state : 'not-started';
  const nextSequence = { microphone: 0, camera: 0, screen: 0 }, nextStartMs = { microphone: 0, camera: 0, screen: 0 };
  if (capture) for (const mode of ['microphone', 'camera', 'screen'] as const) {
    const latest = await ctx.db.query('researchMedia').withIndex('by_captureId_and_modality_and_sequence', q => q.eq('captureId', capture._id).eq('descriptor.modality', mode)).order('desc').first();
    if (latest) { nextSequence[mode] = latest.descriptor.sequence + 1; nextStartMs[mode] = latest.descriptor.endMs; }
  }
  const policy = session.consent?.dom && session.consent.storage && session.consent.analysis
    ? await ctx.db.query('researchDomPolicies').withIndex('by_studyId', q => q.eq('studyId', session.studyId)).unique() : null;
  return { recording, bytesRemaining: Math.max(0, captureLimits(process.env.RESEARCH_CAPTURE_LIMITS_JSON).sessionBytes - (capture?.reservedBytes ?? 0)), deadline: capture?.deadline ?? null, startedAt: capture?.startedAt ?? null, nextSequence, nextStartMs, domPolicy: policy ? { origin: policy.origin, componentIds: policy.componentIds } : null, domConnected: recording === 'active' && session.state === 'active' && !!capture && !!session.consent?.dom && capture.domCount > capture.domGenerationStart && capture.domChallengeHash !== null };
} });

const inspectionScope = { clientId: v.id('researchClients'), projectId: v.id('researchProjects'), sessionId: v.id('researchSessions') };
async function inspectCapture(ctx: QueryCtx, ownerId: Id<'users'>, args: { clientId: Id<'researchClients'>; projectId: Id<'researchProjects'>; sessionId: Id<'researchSessions'> }) {
  const { client, project } = await projectFor(ctx, ownerId, args.clientId, args.projectId);
  const session = await ctx.db.get(args.sessionId), capture = await captureFor(ctx, args.sessionId);
  if (!session || !capture || client.state !== 'active' || project.state !== 'active' || session.clientId !== args.clientId || session.projectId !== args.projectId || !retainsSources(session) || !session.consent?.storage || !session.consent.analysis || capture.state === 'purging' || capture.state === 'purged') return denied();
  return { session, capture };
}
const domBatchView = v.object({ sourceId: v.string(), generation: v.number(), origin: v.string(), events: v.array(domEvent), recordedAt: v.number() });
export const domBatches = operatorQuery({ args: { ...inspectionScope, paginationOpts: paginationOptsValidator }, returns: v.object({ page: v.array(domBatchView), isDone: v.boolean(), continueCursor: v.string() }), handler: async (ctx, args) => {
  pageSize(args.paginationOpts.numItems);
  const { session, capture } = await inspectCapture(ctx, ctx.operator.userId, args);
  if (!session.consent?.dom) return denied();
  const result = await ctx.db.query('researchDomBatches').withIndex('by_captureId_and_consentEpoch', q => q.eq('captureId', capture._id).gt('consentEpoch', capture.revokedThrough.dom)).paginate(args.paginationOpts);
  return { ...pageResult(result), page: result.page.map(({ sourceId, generation, origin, events, recordedAt }) => ({ sourceId, generation, origin, events, recordedAt })) };
} });
const gapView = v.object({ modality: v.union(modality, v.literal('dom')), atMs: v.number(), reason: v.union(v.literal('permission-denied'), v.literal('track-ended'), v.literal('muted'), v.literal('upload-failed'), v.literal('capacity'), v.literal('paused'), v.literal('conversation-ended'), v.literal('unsupported')), recordedAt: v.number() });
export const gaps = operatorQuery({ args: { ...inspectionScope, paginationOpts: paginationOptsValidator }, returns: v.object({ page: v.array(gapView), isDone: v.boolean(), continueCursor: v.string() }), handler: async (ctx, args) => {
  pageSize(args.paginationOpts.numItems); await inspectCapture(ctx, ctx.operator.userId, args);
  const result = await ctx.db.query('researchCaptureGaps').withIndex('by_sessionId', q => q.eq('sessionId', args.sessionId)).paginate(args.paginationOpts);
  return { ...pageResult(result), page: result.page.map(({ modality, atMs, reason, recordedAt }) => ({ modality, atMs, reason, recordedAt })) };
} });
