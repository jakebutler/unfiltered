import { ConvexError } from 'convex/values';
import type { QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { denied, projectFor, retainsSources } from './access';
import { captureFor, segmentVisible } from './capture';
import { evidenceId, hashValue, type Selection, type Evidence } from '../packages/research-core/src/analysis';
import { verifyGateway } from '../packages/research-capture/src/proof';
import { spokenAnswerReviewed } from './finalReview';
declare const process: { env: Record<string, string | undefined> };
export const verifyReportGateway = (operation: string, input: unknown, proof: { at: number; signature: string }) => verifyGateway(process.env.RESEARCH_MEDIA_GATEWAY_SECRET, `research:${operation}`, input, proof);
function normalized<T extends 'researchSources' | 'researchMedia' | 'researchDomBatches' | 'researchCaptureGaps'>(ctx: QueryCtx, table: T, id: string): Id<T> { const value = ctx.db.normalizeId(table, id); if (!value) return denied(); return value; }
export function acceptedSelfReport(row: Pick<Doc<'researchSources'>, 'author' | 'channel'>): boolean { return row.author === 'participant' && ['text', 'confirmed-transcript', 'spoken-answer'].includes(row.channel); }
export async function resolveEvidence(ctx: QueryCtx, scope: { ownerId: Id<'users'>; clientId: Id<'researchClients'>; projectId: Id<'researchProjects'> }, s: Selection): Promise<Evidence & { sessionId: Id<'researchSessions'> }> {
  const sid = ctx.db.normalizeId('researchSessions', s.sessionId), session = sid && await ctx.db.get(sid);
  if (!session || session.purpose === 'readiness-test' || session.ownerId !== scope.ownerId || session.clientId !== scope.clientId || session.projectId !== scope.projectId || !retainsSources(session) || session.withdrawnAt !== undefined || !session.consent?.storage || !session.consent.analysis) return denied();
  const base = { ...s, sessionId: session._id, sharingEpoch: session.sharingEpoch ?? 0, retainApprovedExcerpts: !!session.consent.retainApprovedExcerpts };
  if (s.kind === 'self-report') {
    const row = await ctx.db.get(normalized(ctx, 'researchSources', s.id));
    if (!row || row.sessionId !== session._id || !acceptedSelfReport(row) || s.end > row.text.length || await ctx.db.query('researchSources').withIndex('by_sessionId_and_supersedes', q => q.eq('sessionId', session._id).eq('supersedes', row.sourceId)).first()) return denied();
    if (row.channel === 'spoken-answer' && !await spokenAnswerReviewed(session, row)) return denied();
    return { ...base, consentEpoch: 0, hash: await hashValue({ sourceId: row.sourceId, text: row.text, channel: row.channel, supersedes: row.supersedes }), text: row.text.slice(s.start, s.end) };
  }
  const capture = await captureFor(ctx, session._id);
  if (!capture || ['purging', 'purged'].includes(capture.state)) return denied();
  if (s.kind === 'dom-event') {
    const row = await ctx.db.get(normalized(ctx, 'researchDomBatches', s.id)), event = row?.events.find(e => e.sequence === s.start);
    if (!row || row.sessionId !== session._id || !session.consent.dom || row.consentEpoch <= capture.revokedThrough.dom || s.end !== s.start + 1 || !event || event.kind === 'connected') return denied();
    return { ...base, consentEpoch: row.consentEpoch, hash: await hashValue({ origin: row.origin, event }), text: JSON.stringify(event) };
  }
  if (s.kind === 'capture-gap') {
    const row = await ctx.db.get(normalized(ctx, 'researchCaptureGaps', s.id));
    if (!row || row.sessionId !== session._id || s.start !== row.atMs || s.end !== s.start + 1) return denied();
    return { ...base, consentEpoch: 0, hash: await hashValue(row), text: `Capture gap: ${row.modality}, ${row.reason}, at ${row.atMs} ms` };
  }
  const row = await ctx.db.get(normalized(ctx, 'researchMedia', s.id));
  const modality = s.kind === 'audio' ? 'microphone' : s.kind === 'camera-observation' ? 'camera' : 'screen';
  if (!row || row.sessionId !== session._id || row.descriptor.modality !== modality || !segmentVisible(session, capture, row) || s.start < row.descriptor.startMs || s.end > row.descriptor.endMs) return denied();
  return { ...base, consentEpoch: row.consentEpoch, hash: row.descriptor.sha256, text: null };
}
export async function currentEvidence(ctx: QueryCtx, row: Pick<Doc<'researchAnalyses'>, 'ownerId' | 'clientId' | 'projectId' | 'evidence'>): Promise<void> {
  const { client, project } = await projectFor(ctx, row.ownerId, row.clientId, row.projectId);
  if (client.state !== 'active' || project.state !== 'active') return denied();
  for (const old of row.evidence) {
    const next = await resolveEvidence(ctx, row, old);
    if (next.hash !== old.hash || next.consentEpoch !== old.consentEpoch) return denied();
  }
}
export async function sharingAllowed(ctx: QueryCtx, e: Doc<'researchReports'>['evidence'][number], naturalExpiry = false): Promise<boolean> {
  const session = await ctx.db.get(e.sessionId);
  if (!session || session.purpose === 'readiness-test' || session.withdrawnAt !== undefined || (session.sharingEpoch ?? 0) !== e.sharingEpoch) return false;
  if (naturalExpiry && session.retainUntil <= Date.now()) return e.retainApprovedExcerpts;
  if (!retainsSources(session) || !session.consent?.storage || !session.consent.analysis) return false;
  if (e.kind === 'self-report') return session.consent.shareTranscript;
  if (e.kind === 'dom-event') return !!session.consent.dom && !!session.consent.shareDom;
  if (e.kind === 'camera-observation') return session.consent.camera && session.consent.shareCamera;
  if (e.kind === 'screen-observation') return session.consent.screen && session.consent.shareScreen;
  if (e.kind === 'audio') return session.consent.microphone && session.consent.shareAudio;
  // Gaps are publication limitations, not a grant of participant content.
  return true;
}
export async function publicationAvailable(ctx: QueryCtx, report: Doc<'researchReports'>): Promise<void> {
  const { client, project } = await projectFor(ctx, report.ownerId, report.clientId, report.projectId);
  if (client.state !== 'active' || project.state !== 'active' || report.state !== 'published' || report.expiresAt <= Date.now()) return denied();
  for (const e of report.evidence) {
    if (!await sharingAllowed(ctx, e, true)) return denied();
    const session = await ctx.db.get(e.sessionId);
    if (session!.retainUntil <= Date.now() && !report.excerpts.some(excerpt => excerpt.evidenceId === evidenceId(e))) return denied();
    if (session!.retainUntil > Date.now()) {
      const current = await resolveEvidence(ctx, report, e);
      if (current.hash !== e.hash || current.consentEpoch !== e.consentEpoch) return denied();
    }
  }
}
export function refFor(evidence: Evidence[], id: string): Evidence { const e = evidence.find(e => evidenceId(e) === id); if (!e) throw new ConvexError('Evidence unavailable'); return e; }
