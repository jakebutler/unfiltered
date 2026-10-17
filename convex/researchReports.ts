import { ConvexError, v } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import { operatorMutation, operatorQuery, pageSize, projectFor, revision, denied } from './access';
import { internal } from './_generated/api';
import { analysisFor } from './researchAnalysis';
import { currentEvidence, publicationAvailable, sharingAllowed, resolveEvidence } from './reportAccess';
import { scope, finding, excerpt, rawGrant, sourceKind, reportState } from './reportValidators';
import { ANALYSIS_LIMITS as L, evidenceId, hashValue, validatePublication, validateCitationCoverage } from '../packages/research-core/src/analysis';
import { boundedText, requestId } from '../packages/research-core/src/limits';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
const previewArgs = { ...scope, analysisId: v.id('researchAnalyses'), reviewRevision: v.number(), title: v.string(), grants: v.array(rawGrant) };
const displayEvidence = v.object({ evidenceId: v.string(), kind: sourceKind, sessionId: v.id('researchSessions'), start: v.number(), end: v.number(), sourceUntil: v.number(), fullArtifactLabel: v.string(), retainApprovedExcerpts: v.boolean() });
const previewView = v.object({ previewHash: v.string(), analysisId: v.id('researchAnalyses'), reviewRevision: v.number(), title: v.string(), clientName: v.string(), projectName: v.string(), findings: v.array(finding), excerpts: v.array(excerpt), grants: v.array(rawGrant), evidence: v.array(displayEvidence), retentionDays: v.number(), downloadNotice: v.string() });
type PreviewArgs = { clientId: Id<'researchClients'>; projectId: Id<'researchProjects'>; analysisId: Id<'researchAnalyses'>; reviewRevision: number; title: string; grants: { evidenceId: string; view: boolean; download: boolean }[] };
async function prepare(ctx: QueryCtx, ownerId: Id<'users'>, args: PreviewArgs) {
  const row = await analysisFor(ctx, ownerId, args); revision(row.revision, args.reviewRevision); await currentEvidence(ctx, row);
  if (row.state !== 'ready' || row.reviewedAt === null) throw new ConvexError('Review this exact analysis revision first');
  const title = boundedText(args.title, 160, 'report title'); validatePublication(row.findings, row.evidence, row.excerpts, args.grants);
  try { validateCitationCoverage(row.findings, row.excerpts, args.grants); } catch { throw new ConvexError('Every published citation needs an approved excerpt or selected raw grant'); }
  const selected = new Set([...row.findings.flatMap(f => [...f.supports, ...f.counterevidence]), ...row.excerpts.map(e => e.evidenceId), ...args.grants.map(g => g.evidenceId)]);
  const dependencies = [], evidence = [];
  for (const old of row.evidence.filter(e => selected.has(evidenceId(e)))) {
    // A fresh explicit publication can use newly granted sharing without rerunning inference.
    // Earlier publication snapshots retain their old epoch and remain invalidated.
    const e = await resolveEvidence(ctx, row, old); dependencies.push(e);
    if (!await sharingAllowed(ctx, e)) throw new ConvexError('Participant has not granted sharing for selected evidence');
    const session = await ctx.db.get(e.sessionId); if (!session) return denied();
    let fullArtifactLabel = e.kind === 'self-report' ? 'Entire source turn' : e.kind === 'dom-event' ? 'Entire masked DOM event batch' : e.kind === 'capture-gap' ? 'Capture gap metadata' : 'Entire recorded segment';
    if (['screen-observation', 'camera-observation', 'audio'].includes(e.kind)) { const id = ctx.db.normalizeId('researchMedia', e.id), media = id && await ctx.db.get(id); if (!media) return denied(); fullArtifactLabel += ` · ${media.descriptor.startMs}–${media.descriptor.endMs} ms · ${media.descriptor.bytes} bytes`; }
    evidence.push({ evidenceId: evidenceId(e), kind: e.kind, sessionId: e.sessionId, start: e.start, end: e.end, sourceUntil: session.retainUntil, fullArtifactLabel, retainApprovedExcerpts: e.retainApprovedExcerpts });
  }
  const { client, project } = await projectFor(ctx, ownerId, args.clientId, args.projectId);
  const previewHash = await hashValue({ clientName: client.name, projectName: project.name, analysisId: row._id, reviewRevision: args.reviewRevision, title, findings: row.findings, excerpts: row.excerpts, grants: args.grants, dependencies });
  return { row, dependencies, view: { previewHash, analysisId: row._id, reviewRevision: args.reviewRevision, title, clientName: client.name, projectName: project.name, findings: row.findings, excerpts: row.excerpts, grants: args.grants, evidence, retentionDays: L.reportDays, downloadNotice: 'Viewing permits local capture. Downloads cannot be recalled. Revocation stops future application access; download-disabled is not DRM.' } };
}
export const preview = operatorQuery({ args: previewArgs, returns: previewView, handler: async (ctx, args) => (await prepare(ctx, ctx.operator.userId, args)).view });
export const requestStatus = operatorQuery({ args: { ...scope, requestId: v.string() }, returns: v.union(v.object({ reportId: v.id('researchReports'), version: v.number(), publishedAt: v.number(), expiresAt: v.number() }), v.null()), handler: async (ctx, args) => {
  await projectFor(ctx, ctx.operator.userId, args.clientId, args.projectId); requestId(args.requestId);
  const row = await ctx.db.query('researchReports').withIndex('by_projectId_and_requestId', q => q.eq('projectId', args.projectId).eq('requestId', args.requestId)).unique();
  return row ? { reportId: row._id, version: row.version, publishedAt: row.publishedAt, expiresAt: row.expiresAt } : null;
} });
export const publish = operatorMutation({ args: { ...previewArgs, previewHash: v.string(), requestId: v.string() }, returns: v.object({ reportId: v.id('researchReports'), version: v.number(), publishedAt: v.number(), expiresAt: v.number() }), handler: async (ctx, args) => {
  requestId(args.requestId); const prepared = await prepare(ctx, ctx.operator.userId, args);
  if (prepared.view.previewHash !== args.previewHash) throw new ConvexError('Publication preview changed. Preview again.');
  const old = await ctx.db.query('researchReports').withIndex('by_projectId_and_requestId', q => q.eq('projectId', args.projectId).eq('requestId', args.requestId)).unique();
  if (old) { if (old.previewHash !== args.previewHash) throw new ConvexError('Publication request already used'); return { reportId: old._id, version: old.version, publishedAt: old.publishedAt, expiresAt: old.expiresAt }; }
  const last = await ctx.db.query('researchReports').withIndex('by_projectId_and_version', q => q.eq('projectId', args.projectId)).order('desc').first();
  const now = Date.now(), expiresAt = now + L.reportDays * 86_400_000, version = (last?.version ?? 0) + 1;
  const reportId = await ctx.db.insert('researchReports', { ownerId: ctx.operator.userId, clientId: args.clientId, projectId: args.projectId, analysisId: args.analysisId, requestId: args.requestId, version, title: prepared.view.title, clientName: prepared.view.clientName, projectName: prepared.view.projectName, evidence: prepared.dependencies.map(e => ({ ...e, text: null })), findings: prepared.row.findings, excerpts: prepared.row.excerpts, grants: args.grants, previewHash: args.previewHash, state: 'published', publishedAt: now, expiresAt });
  for (const sessionId of new Set(prepared.dependencies.map(e => e.sessionId))) await ctx.db.insert('researchDerivedDependencies', { sessionId, analysisId: null, reportId, active: true });
  await ctx.scheduler.runAt(expiresAt, internal.researchReportLifecycle.expireReport, { reportId, expiresAt });
  return { reportId, version, publishedAt: now, expiresAt };
} });
export async function reportFor(ctx: QueryCtx, ownerId: Id<'users'>, args: { clientId: Id<'researchClients'>; projectId: Id<'researchProjects'>; reportId: Id<'researchReports'> }) {
  await projectFor(ctx, ownerId, args.clientId, args.projectId); const row = await ctx.db.get(args.reportId);
  if (!row || row.ownerId !== ownerId || row.clientId !== args.clientId || row.projectId !== args.projectId) return denied(); return row;
}
export const list = operatorQuery({ args: { ...scope, paginationOpts: paginationOptsValidator }, returns: v.object({ page: v.array(v.object({ reportId: v.id('researchReports'), version: v.number(), title: v.string(), state: reportState, publishedAt: v.number(), expiresAt: v.number() })), isDone: v.boolean(), continueCursor: v.string() }), handler: async (ctx, args) => {
  await projectFor(ctx, ctx.operator.userId, args.clientId, args.projectId); pageSize(args.paginationOpts.numItems);
  const result = await ctx.db.query('researchReports').withIndex('by_projectId_and_version', q => q.eq('projectId', args.projectId)).order('desc').paginate(args.paginationOpts), page = [];
  for (const r of result.page) { let state = r.state; try { await publicationAvailable(ctx, r); } catch { if (state === 'published') state = r.expiresAt <= Date.now() ? 'expired' : 'invalidated'; } page.push({ reportId: r._id, version: r.version, title: r.title, state, publishedAt: r.publishedAt, expiresAt: r.expiresAt }); }
  return { page, isDone: result.isDone, continueCursor: result.continueCursor };
} });
export const withdraw = operatorMutation({ args: { ...scope, reportId: v.id('researchReports') }, returns: v.null(), handler: async (ctx, args) => {
  const row = await reportFor(ctx, ctx.operator.userId, args); await ctx.db.patch(row._id, { state: 'withdrawn' }); return null;
} });
export async function eraseReport(ctx: MutationCtx, reportId: Id<'researchReports'>, state: 'invalidated' | 'expired') {
  const row = await ctx.db.get(reportId); if (row) await ctx.db.patch(row._id, { state, findings: [], excerpts: [], evidence: [], grants: [] });
}
