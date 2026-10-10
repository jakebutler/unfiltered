import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';

const scope = { ownerId: v.id('users'), clientId: v.id('researchClients'), projectId: v.id('researchProjects'), studyId: v.id('researchStudies') };
const invitationArgs = { ...scope, invitationId: v.id('researchInvitations'), sessionId: v.id('researchSessions'), expiresAt: v.number() };
const retentionArgs = { ...scope, sessionId: v.id('researchSessions'), retainUntil: v.number() };
const BATCH = 100;
function scopeOf(row: Doc<'researchInvitations'> | Doc<'researchSessions'>) {
  return { ownerId: row.ownerId, clientId: row.clientId, projectId: row.projectId, studyId: row.studyId };
}
function matchesScope(row: ReturnType<typeof scopeOf>, expected: ReturnType<typeof scopeOf>) {
  return row.ownerId === expected.ownerId && row.clientId === expected.clientId && row.projectId === expected.projectId && row.studyId === expected.studyId;
}
export async function scheduleInvitation(ctx: MutationCtx, row: Doc<'researchInvitations'>): Promise<void> {
  await ctx.scheduler.runAt(row.expiresAt, internal.lifecycle.expireInvitation, { ...scopeOf(row), invitationId: row._id, sessionId: row.sessionId, expiresAt: row.expiresAt });
}
export async function scheduleRetention(ctx: MutationCtx, row: Doc<'researchSessions'>): Promise<void> {
  await ctx.scheduler.runAt(row.withdrawnAt !== undefined ? Date.now() : row.retainUntil, internal.lifecycle.purgeSources, { ...scopeOf(row), sessionId: row._id, retainUntil: row.retainUntil });
}

/** A persisted change invalidates quiet subscriptions that already read this invitation. */
export const expireInvitation = internalMutation({
  args: invitationArgs, returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.invitationId);
    if (!row || !matchesScope(row, args) || row.sessionId !== args.sessionId || row.expiresAt !== args.expiresAt || row.expiredAt !== undefined || row.expiresAt > Date.now()) return null;
    await ctx.db.patch(row._id, { expiredAt: Date.now(), lifecycleVersion: 1 });
    return null;
  },
});

/** Deletes every evidentiary source, including prompts, original answers and corrections. */
export const purgeSources = internalMutation({
  args: retentionArgs, returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.sessionId);
    if (!row || !matchesScope(row, args) || row.retainUntil !== args.retainUntil || row.retentionState === 'purged' || row.retainUntil > Date.now() && row.withdrawnAt === undefined) return null;
    const sources = await ctx.db.query('researchSources').withIndex('by_sessionId_and_sequence', q => q.eq('sessionId', row._id)).take(BATCH);
    for (const source of sources) await ctx.db.delete(source._id);
    const complete = sources.length < BATCH;
    // Metadata-only tombstone. No transcript, source excerpt, consent choices, or request IDs.
    // savedAt is left as the last participant activity, rather than pretending deletion was a response.
    await ctx.db.patch(row._id, {
      retentionState: complete ? 'purged' : 'purging',
      ...(complete ? { purgedAt: Date.now() } : {}),
      consent: null, consentAt: null, nextQuestion: 0,
      sourceCount: complete ? 0 : Math.max(0, row.sourceCount - sources.length),
      revision: row.revision + 1,
    });
    if (!complete) await ctx.scheduler.runAfter(0, internal.lifecycle.purgeSources, args);
    return null;
  },
});

/** Optional-field migration: only legacy rows are read, at most 100 per invocation. */
export const backfill = internalMutation({
  args: {}, returns: v.object({ invitations: v.number(), sessions: v.number() }),
  handler: async ctx => {
    const invitations = await ctx.db.query('researchInvitations').withIndex('by_lifecycleVersion_and_expiresAt', q => q.eq('lifecycleVersion', undefined)).take(BATCH / 2);
    for (const row of invitations) {
      await scheduleInvitation(ctx, row);
      await ctx.db.patch(row._id, { lifecycleVersion: 1 });
    }
    const sessions = await ctx.db.query('researchSessions').withIndex('by_retentionState_and_retainUntil', q => q.eq('retentionState', undefined)).take(BATCH / 2);
    for (const row of sessions) {
      await scheduleRetention(ctx, row);
      await ctx.db.patch(row._id, { retentionState: 'retained' });
    }
    if (invitations.length === BATCH / 2 || sessions.length === BATCH / 2) await ctx.scheduler.runAfter(0, internal.lifecycle.backfill, {});
    return { invitations: invitations.length, sessions: sessions.length };
  },
});

/** Indexed recovery for overdue expiration callbacks; never scans already expired rows. */
export const sweepInvitations = internalMutation({
  args: {}, returns: v.number(),
  handler: async ctx => {
    const rows = await ctx.db.query('researchInvitations').withIndex('by_expiredAt_and_expiresAt', q => q.eq('expiredAt', undefined).lte('expiresAt', Date.now())).take(BATCH);
    for (const row of rows) await ctx.db.patch(row._id, { expiredAt: Date.now(), lifecycleVersion: 1 });
    if (rows.length === BATCH) await ctx.scheduler.runAfter(0, internal.lifecycle.sweepInvitations, {});
    return rows.length;
  },
});

/** Recover missed starts and interrupted batches. Each callback deletes at most 100 sources. */
export const sweepRetention = internalMutation({
  args: {}, returns: v.number(),
  handler: async ctx => {
    const due = await ctx.db.query('researchSessions').withIndex('by_retentionState_and_retainUntil', q => q.eq('retentionState', 'retained').lte('retainUntil', Date.now())).take(BATCH / 2);
    // Read before changing due rows, so one sweep does not enqueue the same session twice.
    const interrupted = await ctx.db.query('researchSessions').withIndex('by_retentionState_and_retainUntil', q => q.eq('retentionState', 'purging')).take(BATCH / 2);
    for (const row of due) {
      await ctx.db.patch(row._id, { retentionState: 'purging', revision: row.revision + 1 });
      await scheduleRetention(ctx, row);
    }
    for (const row of interrupted) await scheduleRetention(ctx, row);
    // Due rows move out of the index range; interrupted batches are retried by the next cron.
    if (due.length === BATCH / 2) await ctx.scheduler.runAfter(0, internal.lifecycle.sweepRetention, {});
    return due.length + interrupted.length;
  },
});
