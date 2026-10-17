import { ConvexError, v } from 'convex/values';
import { mutation, query } from './_generated/server';
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { hashCapability, denied, operator, operatorMutation, operatorQuery, revision } from './access';
import { publicationAvailable, resolveEvidence, verifyReportGateway } from './reportAccess';
import { reportFor } from './researchReports';
import { scope, finding, excerpt, rawGrant, sourceKind } from './reportValidators';
import { gatewayProof, gatewayObject } from './captureValidators';
import { ANALYSIS_LIMITS as L, evidenceId, hashValue, validatePublication, validateCitationCoverage } from '../packages/research-core/src/analysis';
import { requestId } from '../packages/research-core/src/limits';

const saltOrHash = (value: string) => /^[a-f0-9]{64}$/.test(value);
const shareView = v.object({ shareId: v.id('researchShares'), requestId: v.string(), slug: v.string(), revision: v.number(), issuedAt: v.number(), expiresAt: v.number(), revokedAt: v.union(v.number(), v.null()), grants: v.array(rawGrant) });
export const issueShare = mutation({ args: { ...scope, reportId: v.id('researchReports'), requestId: v.string(), slug: v.string(), passwordSalt: v.string(), passwordHash: v.string(), proof: gatewayProof }, returns: shareView, handler: async (ctx, { proof, ...args }) => {
  await verifyReportGateway('issueShare', args, proof); const actor = await operator(ctx), report = await reportFor(ctx, actor.userId, args); await publicationAvailable(ctx, report);
  if (!/^[a-f0-9]{32}$/.test(args.slug) || !saltOrHash(args.passwordSalt) || !saltOrHash(args.passwordHash)) return denied();
  requestId(args.requestId);
  const prior = await ctx.db.query('researchShares').withIndex('by_reportId_and_requestId', q => q.eq('reportId', args.reportId).eq('requestId', args.requestId)).unique();
  if (prior) return { shareId: prior._id, requestId: prior.requestId, slug: prior.slug, revision: prior.revision, issuedAt: prior.issuedAt, expiresAt: prior.expiresAt, revokedAt: prior.revokedAt, grants: prior.grants };
  if (await ctx.db.query('researchShares').withIndex('by_slug', q => q.eq('slug', args.slug)).first()) throw new ConvexError('Share identifier already used');
  const issuedAt = Date.now(), expiresAt = Math.min(report.expiresAt, issuedAt + L.grantDays * 86_400_000);
  const shareId = await ctx.db.insert('researchShares', { ownerId: actor.userId, clientId: args.clientId, projectId: args.projectId, reportId: report._id, requestId: args.requestId, slug: args.slug, passwordSalt: args.passwordSalt, passwordHash: args.passwordHash, grants: report.grants, revision: 0, issuedAt, expiresAt, revokedAt: null });
  return { shareId, requestId: args.requestId, slug: args.slug, revision: 0, issuedAt, expiresAt, revokedAt: null, grants: report.grants };
} });
export const shares = operatorQuery({ args: { ...scope, reportId: v.id('researchReports') }, returns: v.array(shareView), handler: async (ctx, args) => {
  await reportFor(ctx, ctx.operator.userId, args); const rows = await ctx.db.query('researchShares').withIndex('by_reportId', q => q.eq('reportId', args.reportId)).take(25);
  return rows.map(r => ({ shareId: r._id, requestId: r.requestId, slug: r.slug, revision: r.revision, issuedAt: r.issuedAt, expiresAt: r.expiresAt, revokedAt: r.revokedAt, grants: r.grants }));
} });
async function shareFor(ctx: QueryCtx, ownerId: Id<'users'>, args: { clientId: Id<'researchClients'>; projectId: Id<'researchProjects'>; shareId: Id<'researchShares'> }) {
  const row = await ctx.db.get(args.shareId); if (!row || row.ownerId !== ownerId || row.clientId !== args.clientId || row.projectId !== args.projectId) return denied();
  await reportFor(ctx, ownerId, { ...args, reportId: row.reportId }); return row;
}
export const revokeShare = operatorMutation({ args: { ...scope, shareId: v.id('researchShares'), expectedRevision: v.number() }, returns: v.number(), handler: async (ctx, args) => {
  const row = await shareFor(ctx, ctx.operator.userId, args); revision(row.revision, args.expectedRevision);
  await ctx.db.patch(row._id, { revokedAt: Date.now(), revision: row.revision + 1 }); return row.revision + 1;
} });
export const updateGrants = operatorMutation({ args: { ...scope, shareId: v.id('researchShares'), expectedRevision: v.number(), grants: v.array(rawGrant) }, returns: v.number(), handler: async (ctx, args) => {
  const share = await shareFor(ctx, ctx.operator.userId, args); revision(share.revision, args.expectedRevision);
  const report = await reportFor(ctx, ctx.operator.userId, { ...args, reportId: share.reportId }); await publicationAvailable(ctx, report);
  if (share.revokedAt !== null || share.expiresAt <= Date.now()) return denied();
  validatePublication(report.findings, report.evidence, [], args.grants);
  try { validateCitationCoverage(report.findings, report.excerpts, args.grants); } catch { throw new ConvexError('Revoke the share or preserve inspectable evidence for every published citation'); }
  for (const g of args.grants) { const max = report.grants.find(m => m.evidenceId === g.evidenceId); if (!max || g.view && !max.view || g.download && !max.download) throw new ConvexError('Wider access requires a new publication preview'); }
  await ctx.db.patch(share._id, { grants: args.grants, revision: share.revision + 1 }); return share.revision + 1;
} });
async function attempt(ctx: MutationCtx, key: string, maximum: number) {
  const now = Date.now(), row = await ctx.db.query('researchUnlockBuckets').withIndex('by_key', q => q.eq('key', key)).unique();
  if (row && row.resetAt > now && row.attempts >= maximum) return false;
  if (row) await ctx.db.patch(row._id, { attempts: row.resetAt > now ? row.attempts + 1 : 1, resetAt: row.resetAt > now ? row.resetAt : now + L.unlockWindowMs });
  else await ctx.db.insert('researchUnlockBuckets', { key, attempts: 1, resetAt: now + L.unlockWindowMs });
  return true;
}
// Rate admission happens before native KDF work. Both valid and invalid slugs consume the global bound.
export const beginUnlock = mutation({ args: { slug: v.string(), tokenHash: v.string(), proof: gatewayProof }, returns: v.union(v.object({ sessionId: v.id('researchViewerSessions'), passwordSalt: v.string(), passwordHash: v.string() }), v.null()), handler: async (ctx, { proof, ...args }) => {
  await verifyReportGateway('beginUnlock', args, proof);
  if (!saltOrHash(args.tokenHash) || !/^[a-f0-9]{32}$/.test(args.slug)) return null;
  if (!await attempt(ctx, 'global', 32) || !await attempt(ctx, await hashValue(args.slug), L.unlockAttempts)) return null;
  const share = await ctx.db.query('researchShares').withIndex('by_slug', q => q.eq('slug', args.slug)).unique();
  if (!share || share.revokedAt !== null || share.expiresAt <= Date.now()) return null;
  const report = await ctx.db.get(share.reportId); if (!report) return null;
  try { await publicationAvailable(ctx, report); } catch { return null; }
  if (await ctx.db.query('researchViewerSessions').withIndex('by_tokenHash', q => q.eq('tokenHash', args.tokenHash)).first()) return null;
  const sessionId = await ctx.db.insert('researchViewerSessions', { shareId: share._id, reportId: report._id, tokenHash: args.tokenHash, authorized: false, shareRevision: share.revision, expiresAt: Date.now() + 30_000 });
  return { sessionId, passwordSalt: share.passwordSalt, passwordHash: share.passwordHash };
} });
export const finishUnlock = mutation({ args: { sessionId: v.id('researchViewerSessions'), tokenHash: v.string(), accepted: v.boolean(), proof: gatewayProof }, returns: v.union(v.object({ expiresAt: v.number() }), v.null()), handler: async (ctx, { proof, ...args }) => {
  await verifyReportGateway('finishUnlock', args, proof); const row = await ctx.db.get(args.sessionId);
  if (!row || row.authorized || row.tokenHash !== args.tokenHash || row.expiresAt <= Date.now()) return null;
  const share = await ctx.db.get(row.shareId), report = await ctx.db.get(row.reportId);
  if (!args.accepted || !share || !report || share.revision !== row.shareRevision || share.revokedAt !== null || share.expiresAt <= Date.now()) { await ctx.db.delete(row._id); return null; }
  await publicationAvailable(ctx, report); const expiresAt = Math.min(share.expiresAt, report.expiresAt, Date.now() + L.viewerMs);
  await ctx.db.patch(row._id, { authorized: true, expiresAt }); return { expiresAt };
} });
export async function viewer(ctx: QueryCtx, token: string, slug: string) {
  const hash = await hashCapability(token), row = await ctx.db.query('researchViewerSessions').withIndex('by_tokenHash', q => q.eq('tokenHash', hash)).unique();
  if (!row?.authorized || row.expiresAt <= Date.now()) return denied();
  const share = await ctx.db.get(row.shareId), report = await ctx.db.get(row.reportId);
  if (!share || !report || share.slug !== slug || share.reportId !== report._id || row.shareRevision !== share.revision || share.revokedAt !== null || share.expiresAt <= Date.now()) return denied();
  await publicationAvailable(ctx, report); return { row, share, report };
}
const publishedEvidence = v.object({ evidenceId: v.string(), kind: sourceKind, sessionLabel: v.string(), start: v.number(), end: v.number(), artifactStart: v.union(v.number(), v.null()), artifactEnd: v.union(v.number(), v.null()), sourceUntil: v.number(), sourceAvailable: v.boolean(), fullArtifactLabel: v.string(), view: v.boolean(), download: v.boolean() });
export const readPublished = query({ args: { token: v.string(), slug: v.string(), proof: gatewayProof }, returns: v.object({ title: v.string(), clientName: v.string(), projectName: v.string(), version: v.number(), publishedAt: v.number(), expiresAt: v.number(), accessExpiresAt: v.number(), findings: v.array(finding), excerpts: v.array(excerpt), evidence: v.array(publishedEvidence), grants: v.array(rawGrant), downloadNotice: v.string() }), handler: async (ctx, { proof, ...args }) => {
  await verifyReportGateway('readPublished', args, proof); const { row, share, report } = await viewer(ctx, args.token, args.slug);
  const aliases = new Map(report.evidence.map((e, i) => [evidenceId(e), `e${i + 1}`])), sessions = [...new Set(report.evidence.map(e => e.sessionId))], evidence = [];
  for (const e of report.evidence) {
    const id = evidenceId(e), grant = share.grants.find(g => g.evidenceId === id), session = await ctx.db.get(e.sessionId);
    let sourceAvailable = false; try { const current = await resolveEvidence(ctx, report, e); sourceAvailable = current.hash === e.hash && current.consentEpoch === e.consentEpoch; } catch { /* natural expiry preserves only consented snapshot */ }
    let artifactStart: number | null = null, artifactEnd: number | null = null;
    if (sourceAvailable && ['screen-observation', 'camera-observation', 'audio'].includes(e.kind)) { const mid = ctx.db.normalizeId('researchMedia', e.id), media = mid && await ctx.db.get(mid); if (media) { artifactStart = media.descriptor.startMs; artifactEnd = media.descriptor.endMs; } }
    else if (sourceAvailable && e.kind === 'self-report') { const sid = ctx.db.normalizeId('researchSources', e.id), source = sid && await ctx.db.get(sid); if (source) { artifactStart = 0; artifactEnd = source.text.length; } }
    else if (sourceAvailable && e.kind === 'dom-event') { const bid = ctx.db.normalizeId('researchDomBatches', e.id), batch = bid && await ctx.db.get(bid); if (batch?.events.length) { artifactStart = batch.events[0].sequence; artifactEnd = batch.events.at(-1)!.sequence + 1; } }
    evidence.push({ evidenceId: aliases.get(id)!, kind: e.kind, sessionLabel: `Session ${sessions.indexOf(e.sessionId) + 1}`, start: e.start, end: e.end, artifactStart, artifactEnd, sourceUntil: session!.retainUntil, sourceAvailable, fullArtifactLabel: e.kind === 'self-report' ? 'Entire source turn' : e.kind === 'dom-event' ? 'Entire masked DOM event batch' : e.kind === 'capture-gap' ? 'Capture gap metadata' : 'Entire recorded segment', view: sourceAvailable && !!grant?.view, download: sourceAvailable && !!grant?.download });
  }
  return { title: report.title, clientName: report.clientName, projectName: report.projectName, version: report.version, publishedAt: report.publishedAt, expiresAt: report.expiresAt, accessExpiresAt: row.expiresAt, findings: report.findings.map(f => ({ ...f, supports: f.supports.map(id => aliases.get(id)!), counterevidence: f.counterevidence.map(id => aliases.get(id)!) })), excerpts: report.excerpts.map(e => ({ evidenceId: aliases.get(e.evidenceId)!, text: e.text })), evidence, grants: share.grants.map(g => ({ ...g, evidenceId: aliases.get(g.evidenceId)! })), downloadNotice: 'Viewing permits local capture. Downloads cannot be recalled. Revocation stops future application access; download-disabled is not DRM.' };
} });
export const sharedSource = query({ args: { token: v.string(), slug: v.string(), evidenceId: v.string(), intent: v.union(v.literal('view'), v.literal('download')), proof: gatewayProof }, returns: v.union(v.object({ type: v.literal('text'), text: v.string(), mime: v.string() }), v.object({ type: v.literal('media'), object: gatewayObject })), handler: async (ctx, { proof, ...args }) => {
  await verifyReportGateway('sharedSource', args, proof); const { share, report } = await viewer(ctx, args.token, args.slug);
  const match = /^e([1-9][0-9]*)$/.exec(args.evidenceId), selected = match && report.evidence[Number(match[1]) - 1];
  if (!selected) return denied(); const grant = share.grants.find(g => g.evidenceId === evidenceId(selected));
  if (!grant?.[args.intent]) return denied(); const e = await resolveEvidence(ctx, report, selected);
  if (e.hash !== selected.hash || e.consentEpoch !== selected.consentEpoch) return denied();
  if (e.kind === 'self-report') { const id = ctx.db.normalizeId('researchSources', e.id), source = id && await ctx.db.get(id); if (!source) return denied(); return { type: 'text' as const, text: source.text, mime: 'text/plain; charset=utf-8' }; }
  if (e.kind === 'dom-event') { const id = ctx.db.normalizeId('researchDomBatches', e.id), source = id && await ctx.db.get(id); if (!source) return denied(); return { type: 'text' as const, text: JSON.stringify({ origin: source.origin, events: source.events }), mime: 'application/json' }; }
  const id = ctx.db.normalizeId('researchMedia', e.id), m = id && await ctx.db.get(id); if (!m) return denied();
  return { type: 'media' as const, object: { id: m._id, key: m.objectKey, attempt: m.attempt, retryUntil: m.retryUntil, claimUntil: m.claimUntil, descriptor: m.descriptor, leaseUntil: m.leaseUntil, state: m.state } };
} });
export const logout = mutation({ args: { token: v.string(), proof: gatewayProof }, returns: v.null(), handler: async (ctx, { proof, ...args }) => {
  await verifyReportGateway('logout', args, proof); const hash = await hashCapability(args.token), row = await ctx.db.query('researchViewerSessions').withIndex('by_tokenHash', q => q.eq('tokenHash', hash)).unique(); if (row) await ctx.db.delete(row._id); return null;
} });
