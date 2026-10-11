import { runtimeFacts } from './researchReadinessValidators';
import { validateStudyAnalysisReservation, requirePreparedAnalysisEnabled } from './researchStudyAnalysis';
import { ConvexError, v } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import { mutation, query } from './_generated/server';
import { internal } from './_generated/api';
import { denied, operator, operatorMutation, operatorQuery, pageSize, projectFor, revision } from './access';
import { currentEvidence, acceptedSelfReport, resolveEvidence, verifyReportGateway, sharingAllowed } from './reportAccess';
import { scope, selection, reservation, providerReceipt, finding, excerpt, evidence, analysisState } from './reportValidators';
import { gatewayProof, gatewayObject } from './captureValidators';
import { ANALYSIS_LIMITS as L, checkSelections, evidenceId, hashValue, validateFindings, validatePublication } from '../packages/research-core/src/analysis';
import { requestId } from '../packages/research-core/src/limits';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';

const view = v.object({ analysisId: v.id('researchAnalyses'), state: analysisState, revision: v.number(), findings: v.array(finding), excerpts: v.array(excerpt), evidence: v.array(evidence), reviewedAt: v.union(v.number(), v.null()), receipt: v.union(providerReceipt, v.null()), createdAt: v.number(), deadline: v.number(), manifestHash: v.string() });
/** Global server-configured reservations are single-use across projects, states and gateway restarts. */
export const availableReservations = query({ args: { reservationIds: v.array(v.string()), proof: gatewayProof }, returns: v.array(v.string()), handler: async (ctx, { proof, ...args }) => {
  await verifyReportGateway('availableReservations', args, proof); await operator(ctx);
  if (args.reservationIds.length > 8 || new Set(args.reservationIds).size !== args.reservationIds.length || args.reservationIds.some(id => !/^[a-zA-Z0-9_-]{8,128}$/.test(id))) return denied();
  const available = [];
  for (const id of args.reservationIds) if (!await ctx.db.query('researchAnalyses').withIndex('by_reservationId', q => q.eq('reservation.id', id)).first()) available.push(id);
  return available;
} });
export const requestStatus = operatorQuery({ args: { ...scope, requestId: v.string() }, returns: v.union(v.object({ analysisId: v.id('researchAnalyses'), state: analysisState }), v.null()), handler: async (ctx, args) => {
  await projectFor(ctx, ctx.operator.userId, args.clientId, args.projectId); requestId(args.requestId);
  const row = await ctx.db.query('researchAnalyses').withIndex('by_projectId_and_requestId', q => q.eq('projectId', args.projectId).eq('requestId', args.requestId)).unique();
  if (!row) return null;
  try { await currentEvidence(ctx, row); return { analysisId: row._id, state: visible(row).state }; } catch { return { analysisId: row._id, state: 'invalidated' as const }; }
} });
export async function analysisFor(ctx: QueryCtx, ownerId: Id<'users'>, args: { clientId: Id<'researchClients'>; projectId: Id<'researchProjects'>; analysisId: Id<'researchAnalyses'> }) {
  await projectFor(ctx, ownerId, args.clientId, args.projectId);
  const row = await ctx.db.get(args.analysisId);
  if (!row || row.ownerId !== ownerId || row.clientId !== args.clientId || row.projectId !== args.projectId) return denied();
  return row;
}
function visible(row: Doc<'researchAnalyses'>) {
  return { analysisId: row._id, state: row.state === 'dispatching' && row.deadline <= Date.now() ? 'unknown' as const : row.state, revision: row.revision, findings: row.findings, excerpts: row.excerpts, evidence: row.evidence, reviewedAt: row.reviewedAt, receipt: row.receipt, createdAt: row.createdAt, deadline: row.deadline, manifestHash: row.manifestHash };
}
export const list = operatorQuery({ args: { ...scope, paginationOpts: paginationOptsValidator }, returns: v.object({ page: v.array(view), isDone: v.boolean(), continueCursor: v.string() }), handler: async (ctx, args) => {
  await projectFor(ctx, ctx.operator.userId, args.clientId, args.projectId); pageSize(args.paginationOpts.numItems);
  const page = await ctx.db.query('researchAnalyses').withIndex('by_projectId', q => q.eq('projectId', args.projectId)).order('desc').paginate(args.paginationOpts);
  const result = [];
  for (const row of page.page) {
    try { await currentEvidence(ctx, row); result.push(visible(row)); }
    catch { result.push({ ...visible(row), state: 'invalidated' as const, findings: [], excerpts: [], evidence: [], receipt: null }); }
  }
  return { page: result, isDone: page.isDone, continueCursor: page.continueCursor };
} });
export const read = operatorQuery({ args: { ...scope, analysisId: v.id('researchAnalyses') }, returns: view, handler: async (ctx, args) => {
  const row = await analysisFor(ctx, ctx.operator.userId, args);
  try { await currentEvidence(ctx, row); return visible(row); }
  catch { return { ...visible(row), state: 'invalidated' as const, findings: [], excerpts: [], evidence: [], receipt: null }; }
} });
export const admit = mutation({ args: { ...scope, runtime: v.optional(runtimeFacts), requestId: v.string(), selections: v.array(selection), reservation, proof: gatewayProof }, returns: v.object({ analysisId: v.id('researchAnalyses'), state: analysisState }), handler: async (ctx, { proof, ...args }) => {
  await verifyReportGateway('admit', args, proof);
  const actor = await operator(ctx), { client, project } = await projectFor(ctx, actor.userId, args.clientId, args.projectId);
  if (client.state !== 'active' || project.state !== 'active') return denied();
  requestId(args.requestId); checkSelections(args.selections);
  const r = args.reservation;
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(r.id) || !Number.isSafeInteger(r.expiresAt) || r.expiresAt <= Date.now() || !Number.isSafeInteger(r.maxInputBytes) || r.maxInputBytes < 1 || r.maxInputBytes > L.inputBytes || !Number.isSafeInteger(r.maxOutputTokens) || r.maxOutputTokens < 1 || r.maxOutputTokens > 4096) throw new ConvexError('Analysis reservation unavailable');
  const resolved = [];
  const studies = new Map<string, unknown>();
  for (const s of args.selections) {
    resolved.push(await resolveEvidence(ctx, { ...args, ownerId: actor.userId }, s));
    const session = await ctx.db.get(s.sessionId), study = session && await ctx.db.get(session.studyId);
    if (!study) return denied();
    studies.set(study._id, { studyId: study._id, version: study.version, definition: study.definition });
  }
  const studyContext = JSON.stringify([...studies.values()]);
  if (new TextEncoder().encode(studyContext + JSON.stringify(resolved)).length > r.maxInputBytes) throw new ConvexError('Selected evidence exceeds admission');
  const manifestHash = await hashValue({ evidence: resolved, studyContext, reservation: r });
  const prior = await ctx.db.query('researchAnalyses').withIndex('by_projectId_and_requestId', q => q.eq('projectId', args.projectId).eq('requestId', args.requestId)).unique();
  if (prior) { if (prior.manifestHash !== manifestHash) throw new ConvexError('Request identifier already used'); return { analysisId: prior._id, state: prior.state }; }
  await validateStudyAnalysisReservation(ctx, actor.userId, args);
  if (await ctx.db.query('researchAnalyses').withIndex('by_reservationId', q => q.eq('reservation.id', r.id)).first()) throw new ConvexError('Reservation has already been consumed');
  const now = Date.now(), deadline = Math.min(r.expiresAt, now + L.jobMs);
  const analysisId = await ctx.db.insert('researchAnalyses', { ownerId: actor.userId, clientId: args.clientId, projectId: args.projectId, requestId: args.requestId, manifestHash, studyContext, evidence: resolved, state: 'admitted', revision: 0, findings: [], excerpts: [], reviewedAt: null, reservation: r, receipt: null, createdAt: now, deadline });
  for (const sessionId of new Set(resolved.map(e => e.sessionId))) await ctx.db.insert('researchDerivedDependencies', { sessionId, analysisId, reportId: null, active: true });
  await ctx.scheduler.runAt(deadline, internal.researchReportLifecycle.expireAnalysis, { analysisId, deadline });
  return { analysisId, state: 'admitted' as const };
} });
export const material = query({ args: { ...scope, analysisId: v.id('researchAnalyses'), proof: gatewayProof }, returns: v.object({ evidence: v.array(evidence), studyContext: v.string(), reservation, state: analysisState, deadline: v.number(), media: v.array(v.object({ evidenceId: v.string(), object: gatewayObject })) }), handler: async (ctx, { proof, ...args }) => {
  await verifyReportGateway('material', args, proof); const actor = await operator(ctx), row = await analysisFor(ctx, actor.userId, args);
  await currentEvidence(ctx, row);
  if (!['admitted', 'dispatching'].includes(row.state) || row.deadline <= Date.now()) return denied();
  const media = [];
  for (const e of row.evidence) if (['screen-observation', 'camera-observation', 'audio'].includes(e.kind)) {
    const id = ctx.db.normalizeId('researchMedia', e.id), m = id && await ctx.db.get(id); if (!m) return denied();
    media.push({ evidenceId: evidenceId(e), object: { id: m._id, key: m.objectKey, attempt: m.attempt, retryUntil: m.retryUntil, claimUntil: m.claimUntil, descriptor: m.descriptor, leaseUntil: m.leaseUntil, state: m.state } });
  }
  return { evidence: row.evidence, studyContext: row.studyContext, reservation: row.reservation, state: row.state, deadline: row.deadline, media };
} });
export const beginDispatch = mutation({ args: { ...scope, runtime: v.optional(runtimeFacts), analysisId: v.id('researchAnalyses'), receipt: providerReceipt, proof: gatewayProof }, returns: v.boolean(), handler: async (ctx, { proof, ...args }) => {
  await verifyReportGateway('beginDispatch', args, proof); const actor = await operator(ctx), row = await analysisFor(ctx, actor.userId, args); await currentEvidence(ctx, row);
  if (row.state !== 'admitted') return false;
  await requirePreparedAnalysisEnabled(ctx, row.reservation.id, args.runtime);
  if (row.deadline <= Date.now() || row.reservation.expiresAt <= Date.now() || args.receipt.model !== row.reservation.model || !/^[a-f0-9]{64}$/.test(args.receipt.inputHash) || args.receipt.requestId !== null || args.receipt.outputHash !== null || args.receipt.errorCode !== null || (args.receipt.classification === 'live') !== row.reservation.live) return denied();
  if (args.receipt.maxOutputTokens !== row.reservation.maxOutputTokens || !Number.isSafeInteger(args.receipt.requestBytes) || args.receipt.requestBytes < 1 || args.receipt.requestBytes > Math.min(1_000_000, row.reservation.maxInputBytes + L.frames * L.frameBytes * 2)) return denied();
  const frames = row.evidence.filter(e => ['screen-observation', 'camera-observation'].includes(e.kind));
  if (args.receipt.frames.length !== frames.length || new Set(args.receipt.frames.map(f => f.evidenceId)).size !== frames.length) return denied();
  for (const f of args.receipt.frames) { const e = frames.find(e => evidenceId(e) === f.evidenceId); if (!e || e.hash !== f.mediaHash || f.atMs !== e.start || !/^[a-f0-9]{64}$/.test(f.imageHash) || !Number.isSafeInteger(f.bytes) || f.bytes < 1 || f.bytes > L.frameBytes) return denied(); }
  await ctx.db.patch(row._id, { state: 'dispatching', receipt: args.receipt, revision: row.revision + 1 }); return true;
} });
export const finish = mutation({ args: { ...scope, analysisId: v.id('researchAnalyses'), state: v.union(v.literal('ready'), v.literal('failed'), v.literal('unknown')), findings: v.array(finding), requestId: v.union(v.string(), v.null()), outputHash: v.union(v.string(), v.null()), errorCode: v.union(v.string(), v.null()), proof: gatewayProof }, returns: v.null(), handler: async (ctx, { proof, ...args }) => {
  await verifyReportGateway('finish', args, proof); const actor = await operator(ctx), row = await analysisFor(ctx, actor.userId, args); await currentEvidence(ctx, row);
  if (row.state !== 'dispatching' || !row.receipt) return null;
  if (args.errorCode !== null && !/^[a-zA-Z0-9_-]{1,80}$/.test(args.errorCode) || args.requestId !== null && args.requestId.length > 160) return denied();
  if (args.state === 'ready') {
    if (row.deadline <= Date.now() || !args.requestId || args.errorCode || args.outputHash !== await hashValue(args.findings)) return denied();
    validateFindings(args.findings, row.evidence);
  } else if (args.findings.length || args.outputHash !== null) return denied();
  await ctx.db.patch(row._id, { state: args.state, findings: args.findings, receipt: { ...row.receipt, requestId: args.requestId, outputHash: args.outputHash, errorCode: args.errorCode }, revision: row.revision + 1 }); return null;
} });
export const saveReview = operatorMutation({ args: { ...scope, analysisId: v.id('researchAnalyses'), expectedRevision: v.number(), findings: v.array(finding), excerpts: v.array(excerpt) }, returns: v.number(), handler: async (ctx, args) => {
  const row = await analysisFor(ctx, ctx.operator.userId, args); revision(row.revision, args.expectedRevision); await currentEvidence(ctx, row);
  if (row.state !== 'ready') throw new ConvexError('Only completed analysis can be reviewed');
  validatePublication(args.findings, row.evidence, args.excerpts, []);
  await ctx.db.patch(row._id, { findings: args.findings, excerpts: args.excerpts, reviewedAt: Date.now(), revision: row.revision + 1 }); return row.revision + 1;
} });
export const inventory = operatorQuery({ args: { ...scope, sessionId: v.id('researchSessions'), kind: v.union(v.literal('self-report'), v.literal('dom-event'), v.literal('screen-observation'), v.literal('camera-observation'), v.literal('audio'), v.literal('capture-gap')), paginationOpts: paginationOptsValidator }, returns: v.object({ page: v.array(v.object({ selection, label: v.string(), text: v.union(v.string(), v.null()), shareAllowed: v.boolean() })), isDone: v.boolean(), continueCursor: v.string() }), handler: async (ctx, args) => {
  await projectFor(ctx, ctx.operator.userId, args.clientId, args.projectId); pageSize(args.paginationOpts.numItems);
  const session = await ctx.db.get(args.sessionId);
  if (!session || session.purpose === 'readiness-test' || session.ownerId !== ctx.operator.userId || session.clientId !== args.clientId || session.projectId !== args.projectId) return denied();
  const table = args.kind === 'self-report' ? 'researchSources' : args.kind === 'dom-event' ? 'researchDomBatches' : args.kind === 'capture-gap' ? 'researchCaptureGaps' : 'researchMedia';
  const raw = table === 'researchSources'
    ? await ctx.db.query(table).withIndex('by_sessionId_and_sequence', q => q.eq('sessionId', args.sessionId)).paginate(args.paginationOpts)
    : table === 'researchDomBatches'
      ? await ctx.db.query(table).withIndex('by_sessionId', q => q.eq('sessionId', args.sessionId)).paginate(args.paginationOpts)
      : table === 'researchCaptureGaps'
        ? await ctx.db.query(table).withIndex('by_sessionId', q => q.eq('sessionId', args.sessionId)).paginate(args.paginationOpts)
        : await ctx.db.query(table).withIndex('by_sessionId', q => q.eq('sessionId', args.sessionId)).paginate(args.paginationOpts);
  const candidates = [], sourceLabels = new Map<string, string>();
  for (const row of raw.page) {
    if ('text' in row && acceptedSelfReport(row)) { candidates.push({ sessionId: args.sessionId, kind: args.kind, id: String(row._id), start: 0, end: row.text.length }); sourceLabels.set(String(row._id), row.channel === 'spoken-answer' ? 'Participant-reviewed spoken answer' : row.channel === 'confirmed-transcript' ? 'Confirmed transcript' : 'Participant text'); }
    else if ('events' in row) { for (const event of row.events) if (event.kind !== 'connected') candidates.push({ sessionId: args.sessionId, kind: args.kind, id: String(row._id), start: event.sequence, end: event.sequence + 1 }); }
    else if ('reason' in row) candidates.push({ sessionId: args.sessionId, kind: args.kind, id: String(row._id), start: row.atMs, end: row.atMs + 1 });
    else if ('descriptor' in row) { const expected = args.kind === 'audio' ? 'microphone' : args.kind === 'camera-observation' ? 'camera' : 'screen'; if (row.descriptor.modality === expected) candidates.push({ sessionId: args.sessionId, kind: args.kind, id: String(row._id), start: row.descriptor.startMs, end: args.kind === 'audio' ? row.descriptor.endMs : row.descriptor.startMs + 1 }); }
  }
  const page = [];
  for (const s of candidates) try { const e = await resolveEvidence(ctx, { ...args, ownerId: ctx.operator.userId }, s); page.push({ selection: s, label: `${s.kind}${sourceLabels.has(s.id) ? ` · ${sourceLabels.get(s.id)}` : ''} · ${s.start}–${s.end}`, text: e.text, shareAllowed: await sharingAllowed(ctx, e) }); } catch { /* unavailable rows expose no content */ }
  return { page, isDone: raw.isDone, continueCursor: raw.continueCursor };
} });
