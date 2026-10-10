import { action, internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { v, ConvexError } from 'convex/values';
import { hashCapability, operator, operatorMutation, operatorQuery, pageResult, pageSize, projectFor } from './access';
import { paginationOptsValidator } from 'convex/server';
import { requestId } from '../packages/research-core/src/limits';
import type { Id } from './_generated/dataModel';

const issueArgs = { clientId: v.id('researchClients'), projectId: v.id('researchProjects'), studyVersion: v.number(), requestId: v.string() };
const result = { invitationId: v.id('researchInvitations'), sessionId: v.id('researchSessions'), expiresAt: v.number() };
export const create = action({ args: issueArgs, returns: v.object({ ...result, token: v.union(v.string(), v.null()) }), handler: async (ctx, args): Promise<{ invitationId: Id<'researchInvitations'>; sessionId: Id<'researchSessions'>; expiresAt: number; token: string | null }> => {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
  const issued = await ctx.runMutation(internal.invitations.issue, { ...args, tokenHash: await hashCapability(token) });
  // On an ambiguous prior result, an explicit replay returns the same receipt but
  // cannot recover the plaintext capability. Revoke it and issue a new invitation.
  const { inserted, ...receipt } = issued;
  return { ...receipt, token: inserted ? token : null };
} });
export const issue = internalMutation({ args: { ...issueArgs, tokenHash: v.string() }, returns: v.object({ ...result, inserted: v.boolean() }), handler: async (ctx, args) => {
  const member = await operator(ctx);
  const { client, project } = await projectFor(ctx, member.userId, args.clientId, args.projectId);
  requestId(args.requestId);
  if (client.state !== 'active' || project.state !== 'active' || !/^[a-f0-9]{64}$/.test(args.tokenHash)) throw new ConvexError('Invitation unavailable');
  const existing = await ctx.db.query('researchInvitations').withIndex('by_projectId_and_requestId', q => q.eq('projectId', project._id).eq('requestId', args.requestId)).unique();
  if (existing) {
    const originalStudy = await ctx.db.get(existing.studyId);
    if (originalStudy?.version !== args.studyVersion) throw new ConvexError('Request identifier was already used for a different study');
    return { invitationId: existing._id, sessionId: existing.sessionId, expiresAt: existing.expiresAt, inserted: false };
  }
  if (!Number.isSafeInteger(args.studyVersion) || args.studyVersion < 1) throw new ConvexError('Invalid study version');
  const study = await ctx.db.query('researchStudies').withIndex('by_projectId_and_version', q => q.eq('projectId', project._id).eq('version', args.studyVersion)).unique();
  if (!study) throw new ConvexError('Save the study before inviting');
  const now = Date.now(), expiresAt = now + 7 * 86400000;
  const sessionId = await ctx.db.insert('researchSessions', { ownerId: member.userId, clientId: client._id, projectId: project._id, studyId: study._id, state: 'invited', revision: 0, nextQuestion: 0, sourceCount: 0, consent: null, consentAt: null, createdAt: now, savedAt: now, retainUntil: now + 30 * 86400000 });
  const invitationId = await ctx.db.insert('researchInvitations', { ownerId: member.userId, clientId: client._id, projectId: project._id, studyId: study._id, tokenHash: args.tokenHash, sessionId, expiresAt, revokedAt: null, requestId: args.requestId });
  return { invitationId, sessionId, expiresAt, inserted: true };
} });
export const revoke = operatorMutation({ args: { clientId: v.id('researchClients'), projectId: v.id('researchProjects'), invitationId: v.id('researchInvitations') }, returns: v.null(), handler: async (ctx, args) => {
  await projectFor(ctx, ctx.operator.userId, args.clientId, args.projectId);
  const invitation = await ctx.db.get(args.invitationId);
  if (!invitation || invitation.clientId !== args.clientId || invitation.projectId !== args.projectId || invitation.ownerId !== ctx.operator.userId) throw new ConvexError('Access unavailable');
  if (invitation.revokedAt === null) await ctx.db.patch(invitation._id, { revokedAt: Date.now() });
  return null;
} });
export const list = operatorQuery({ args: { clientId: v.id('researchClients'), projectId: v.id('researchProjects'), paginationOpts: paginationOptsValidator }, returns: v.object({ page: v.array(v.object({ ...result, studyId: v.id('researchStudies'), revokedAt: v.union(v.number(), v.null()) })), isDone: v.boolean(), continueCursor: v.string() }), handler: async (ctx, args) => {
  await projectFor(ctx, ctx.operator.userId, args.clientId, args.projectId); pageSize(args.paginationOpts.numItems);
  const rows = await ctx.db.query('researchInvitations').withIndex('by_projectId_and_requestId', q => q.eq('projectId', args.projectId)).paginate(args.paginationOpts);
  return { ...pageResult(rows), page: rows.page.map(({ _id, sessionId, expiresAt, studyId, revokedAt }) => ({ invitationId: _id, sessionId, expiresAt, studyId, revokedAt })) };
} });
