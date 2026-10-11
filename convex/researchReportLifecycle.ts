import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { currentEvidence, publicationAvailable } from './reportAccess';
import { eraseReport } from './researchReports';

export const expireAnalysis = internalMutation({ args: { analysisId: v.id('researchAnalyses'), deadline: v.number() }, returns: v.null(), handler: async (ctx, args) => {
  const row = await ctx.db.get(args.analysisId);
  if (!row || row.deadline !== args.deadline || row.deadline > Date.now()) return null;
  if (row.state === 'dispatching') await ctx.db.patch(row._id, { state: 'unknown', revision: row.revision + 1 });
  else if (row.state === 'admitted') await ctx.db.patch(row._id, { state: 'failed', revision: row.revision + 1 });
  return null;
} });
export const expireReport = internalMutation({ args: { reportId: v.id('researchReports'), expiresAt: v.number() }, returns: v.null(), handler: async (ctx, args) => {
  const row = await ctx.db.get(args.reportId);
  if (row && row.expiresAt === args.expiresAt && row.expiresAt <= Date.now()) await eraseReport(ctx, row._id, 'expired'); return null;
} });
// Cursor traverses active dependencies even if an earlier still-valid report is retained.
export const invalidateSession = internalMutation({ args: { sessionId: v.id('researchSessions'), cursor: v.union(v.string(), v.null()) }, returns: v.null(), handler: async (ctx, args) => {
  const page = await ctx.db.query('researchDerivedDependencies').withIndex('by_sessionId_and_active', q => q.eq('sessionId', args.sessionId).eq('active', true)).paginate({ cursor: args.cursor, numItems: 25 });
  for (const dependency of page.page) {
    let invalid = false;
    if (dependency.analysisId) { const row = await ctx.db.get(dependency.analysisId); if (row) try { await currentEvidence(ctx, row); } catch { invalid = true; await ctx.db.patch(row._id, { state: 'invalidated', evidence: [], studyContext: '', findings: [], excerpts: [], reviewedAt: null, receipt: row.receipt ? { ...row.receipt, frames: [] } : null, revision: row.revision + 1 }); } else invalid = true; }
    if (dependency.reportId) { const row = await ctx.db.get(dependency.reportId); if (row) try { await publicationAvailable(ctx, row); } catch { invalid = true; await eraseReport(ctx, row._id, row.expiresAt <= Date.now() ? 'expired' : 'invalidated'); } else invalid = true; }
    if (invalid) await ctx.db.patch(dependency._id, { active: false });
  }
  if (!page.isDone) await ctx.scheduler.runAfter(0, internal.researchReportLifecycle.invalidateSession, { sessionId: args.sessionId, cursor: page.continueCursor }); return null;
} });
export const sweep = internalMutation({ args: {}, returns: v.null(), handler: async ctx => {
  for (const state of ['admitted', 'dispatching'] as const) {
    const rows = await ctx.db.query('researchAnalyses').withIndex('by_state_and_deadline', q => q.eq('state', state).lte('deadline', Date.now())).take(25);
    for (const row of rows) await ctx.db.patch(row._id, { state: state === 'dispatching' ? 'unknown' : 'failed', revision: row.revision + 1 });
  }
  const reports = await ctx.db.query('researchReports').withIndex('by_state_and_expiresAt', q => q.eq('state', 'published').lte('expiresAt', Date.now())).take(25);
  for (const r of reports) await eraseReport(ctx, r._id, 'expired');
  const sessions = await ctx.db.query('researchViewerSessions').withIndex('by_expiresAt', q => q.lte('expiresAt', Date.now())).take(25); for (const s of sessions) await ctx.db.delete(s._id);
  const buckets = await ctx.db.query('researchUnlockBuckets').withIndex('by_resetAt', q => q.lte('resetAt', Date.now())).take(25); for (const b of buckets) await ctx.db.delete(b._id);
  return null;
} });
