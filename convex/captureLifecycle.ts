import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';

export const stopAtDeadline = internalMutation({ args: { captureId: v.id('researchCaptures'), deadline: v.number() }, returns: v.null(), handler: async (ctx, args) => {
  const row = await ctx.db.get(args.captureId);
  if (!row || row.deadline !== args.deadline || row.deadline > Date.now()) return null;
  if (row.state === 'active' || row.state === 'paused') await ctx.db.patch(row._id, { state: 'stopped', domChallengeHash: null });
  const cap = await ctx.db.query('researchCaptureCapacity').withIndex('by_name', q => q.eq('name', 'demo')).unique();
  if (cap?.activeSessionId === row.sessionId) await ctx.db.patch(cap._id, { activeSessionId: null, activeUntil: 0 });
  return null;
} });

/** Persist deletion intent before the gateway touches object bytes. Each call is bounded. */
export const purge = internalMutation({ args: { captureId: v.id('researchCaptures') }, returns: v.null(), handler: async (ctx, args) => {
  const row = await ctx.db.get(args.captureId);
  if (!row || row.state === 'purged') return null;
  const session = await ctx.db.get(row.sessionId), project = await ctx.db.get(row.projectId), client = await ctx.db.get(row.clientId);
  const invitations = await ctx.db.query('researchInvitations').withIndex('by_sessionId', q => q.eq('sessionId', row.sessionId)).take(2), invite = invitations[0];
  const full = !session || row.retainUntil <= Date.now() || !!session.withdrawnAt || session.retentionState === 'purging' || session.retentionState === 'purged';
  const uploadsClosed = full || project?.state !== 'active' || client?.state !== 'active' || invitations.length !== 1 || invite.revokedAt !== null || invite.expiredAt !== undefined || invite.expiresAt <= Date.now();
  if (full) await ctx.db.patch(row._id, { state: 'purging', domChallengeHash: null });
  else if (uploadsClosed && (row.state === 'active' || row.state === 'paused')) await ctx.db.patch(row._id, { state: 'stopped', domChallengeHash: null });
  if (uploadsClosed) {
    const capacity = await ctx.db.query('researchCaptureCapacity').withIndex('by_name', q => q.eq('name', 'demo')).unique();
    if (capacity?.activeSessionId === row.sessionId) await ctx.db.patch(capacity._id, { activeSessionId: null, activeUntil: 0 });
  }
  let changed = 0, more = false;
  for (const state of ['reserved', 'uploading', 'retry-fencing', 'available'] as const) {
    // Select only eligible rows in each bounded index. Still-consented rows cannot
    // pin the front of a batch and starve a withdrawn modality behind them.
    const items = full || uploadsClosed && state !== 'available'
      ? await ctx.db.query('researchMedia').withIndex('by_captureId_and_state', q => q.eq('captureId', row._id).eq('state', state)).take(25)
      : state !== 'available'
        ? await ctx.db.query('researchMedia').withIndex('by_captureId_and_state_and_expiresAt', q => q.eq('captureId', row._id).eq('state', state).lte('expiresAt', Date.now())).take(25)
        : [];
    more ||= items.length === 25;
    for (const media of items) { await ctx.db.patch(media._id, { state: 'delete-pending' }); changed++; }
    if (!full) for (const modality of ['microphone', 'camera', 'screen'] as const) {
      const withdrawn = await ctx.db.query('researchMedia').withIndex('by_captureId_and_state_and_modality_and_consentEpoch', q => q.eq('captureId', row._id).eq('state', state).eq('descriptor.modality', modality).lte('consentEpoch', row.revokedThrough[modality])).take(25);
      more ||= withdrawn.length === 25;
      for (const media of withdrawn) { await ctx.db.patch(media._id, { state: 'delete-pending' }); changed++; }
    }
  }
  // DOM batches carry masked events only; withdrawal deletes them, not merely hides them.
  const dom = full
    ? await ctx.db.query('researchDomBatches').withIndex('by_sessionId', q => q.eq('sessionId', row.sessionId)).take(100)
    : await ctx.db.query('researchDomBatches').withIndex('by_captureId_and_consentEpoch', q => q.eq('captureId', row._id).lte('consentEpoch', row.revokedThrough.dom)).take(100);
  for (const batch of dom) await ctx.db.delete(batch._id);
  more ||= dom.length === 100;
  if (full) {
    const gaps = await ctx.db.query('researchCaptureGaps').withIndex('by_sessionId', q => q.eq('sessionId', row.sessionId)).take(100);
    for (const gap of gaps) await ctx.db.delete(gap._id);
    // Keep receipts until object deletion is acknowledged; then remove the content metadata.
    const deleted = await ctx.db.query('researchMedia').withIndex('by_captureId_and_state', q => q.eq('captureId', row._id).eq('state', 'deleted')).take(100);
    for (const media of deleted) await ctx.db.delete(media._id);
    const remaining = await ctx.db.query('researchMedia').withIndex('by_sessionId', q => q.eq('sessionId', row.sessionId)).first();
    if (!remaining && dom.length < 100 && gaps.length < 100) {
      await ctx.db.patch(row._id, { state: 'purged', reservedBytes: 0, segmentCount: 0, domCount: 0, domChallengeHash: null, domOrigin: null });
      const cap = await ctx.db.query('researchCaptureCapacity').withIndex('by_name', q => q.eq('name', 'demo')).unique();
      if (cap) await ctx.db.patch(cap._id, { retainedSessions: Math.max(0, cap.retainedSessions - 1), ...(cap.activeSessionId === row.sessionId ? { activeSessionId: null, activeUntil: 0 } : {}) });
    } else if (changed || more || deleted.length === 100) await ctx.scheduler.runAfter(0, internal.captureLifecycle.purge, args);
  } else if (more) await ctx.scheduler.runAfter(0, internal.captureLifecycle.purge, args);
  return null;
} });

export const sweep = internalMutation({ args: {}, returns: v.number(), handler: async ctx => {
  // The admission authority permits at most six non-purged captures globally.
  let count = 0;
  for (const state of ['active', 'paused', 'stopped', 'purging'] as const) {
    const rows: Doc<'researchCaptures'>[] = await ctx.db.query('researchCaptures').withIndex('by_state_and_retainUntil', q => q.eq('state', state)).take(6);
    for (const row of rows) {
      if ((row.state === 'active' || row.state === 'paused') && row.deadline <= Date.now()) await ctx.scheduler.runAfter(0, internal.captureLifecycle.stopAtDeadline, { captureId: row._id, deadline: row.deadline });
      await ctx.scheduler.runAfter(0, internal.captureLifecycle.purge, { captureId: row._id }); count++;
    }
  }
  return count;
} });
