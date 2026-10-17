/** Explicit local-only admin fixture. No public function can shorten real retention. */
import { v, ConvexError } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import { scheduleInvitation, scheduleRetention } from './lifecycle';

// Convex provides process.env in its V8 runtime; this is a type declaration only.
declare const process: { env: Record<string, string | undefined> };

function assertLocalFixture() {
  if (process.env.CONVEX_SITE_URL !== 'http://127.0.0.1:3211' || process.env.RESEARCH_LIFECYCLE_QUALIFICATION !== 'local-only') throw new ConvexError('Local lifecycle qualification is disabled');
}
export const prepare = internalMutation({
  args: { invitationId: v.id('researchInvitations') },
  returns: v.object({ preparedAt: v.number(), expiresAt: v.number(), retainUntil: v.number(), sourceCount: v.number() }),
  handler: async (ctx, args) => {
    assertLocalFixture();
    const invite = await ctx.db.get(args.invitationId);
    if (!invite) throw new ConvexError('Fixture unavailable');
    const session = await ctx.db.get(invite.sessionId), project = await ctx.db.get(invite.projectId), client = await ctx.db.get(invite.clientId);
    if (!session || !project || !client || !client.name.startsWith('Lifecycle qualification ') || project.name !== 'Local lifecycle fixture' || session.createdAt < Date.now() - 120_000 || session.retentionState !== 'retained' || session.sourceCount !== 4 || invite.revokedAt !== null || invite.expiredAt !== undefined || invite.ownerId !== session.ownerId || invite.clientId !== session.clientId || invite.projectId !== session.projectId || invite.studyId !== session.studyId) throw new ConvexError('Use a fresh explicit lifecycle fixture with four sources');
    const preparedAt = Date.now(), expiresAt = preparedAt + 15_000, retainUntil = preparedAt + 35_000;
    await ctx.db.patch(invite._id, { expiresAt });
    await ctx.db.patch(session._id, { retainUntil });
    await scheduleInvitation(ctx, { ...invite, expiresAt });
    await scheduleRetention(ctx, { ...session, retainUntil });
    return { preparedAt, expiresAt, retainUntil, sourceCount: session.sourceCount };
  },
});
export const inspect = internalQuery({
  args: { sessionId: v.id('researchSessions'), invitationId: v.id('researchInvitations') },
  returns: v.object({ invitationExpiredAt: v.union(v.number(), v.null()), retentionState: v.union(v.literal('retained'), v.literal('purging'), v.literal('purged'), v.null()), sourceCount: v.number(), physicalSourceCount: v.number(), hasConsent: v.boolean(), purgedAt: v.union(v.number(), v.null()) }),
  handler: async (ctx, args) => {
    assertLocalFixture();
    const session = await ctx.db.get(args.sessionId);
    const invitation = await ctx.db.get(args.invitationId);
    if (!invitation || invitation.sessionId !== args.sessionId) throw new ConvexError('Fixture unavailable');
    const client = session ? await ctx.db.get(session.clientId) : null;
    if (!session || !client?.name.startsWith('Lifecycle qualification ')) throw new ConvexError('Fixture unavailable');
    const remaining = await ctx.db.query('researchSources').withIndex('by_sessionId_and_sequence', q => q.eq('sessionId', session._id)).take(100);
    return { invitationExpiredAt: invitation.expiredAt ?? null, retentionState: session.retentionState ?? null, sourceCount: session.sourceCount, physicalSourceCount: remaining.length, hasConsent: session.consent !== null, purgedAt: session.purgedAt ?? null };
  },
});
