import { getAuthSessionId, getAuthUserId } from '@convex-dev/auth/server';
import { customCtx, customMutation, customQuery } from 'convex-helpers/server/customFunctions';
import { mutation, query, type QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { ConvexError } from 'convex/values';

export function denied(): never { throw new ConvexError('Access unavailable'); }
export async function operator(ctx: QueryCtx) {
  const userId = await getAuthUserId(ctx);
  const member = await ctx.db.query('researchOperators').withIndex('by_role', q => q.eq('role', 'operator')).unique();
  if (!userId || !member?.active || member.userId !== userId) return denied();
  const sessionId = await getAuthSessionId(ctx);
  if (!sessionId) return denied();
  const session = await ctx.db.get(sessionId);
  if (!session || session.userId !== userId || session.expirationTime <= Date.now()) return denied();
  return { userId, name: member.name };
}
export const operatorQuery = customQuery(query, customCtx(async ctx => ({ operator: await operator(ctx) })));
export const operatorMutation = customMutation(mutation, customCtx(async ctx => ({ operator: await operator(ctx) })));

export async function clientFor(ctx: QueryCtx, ownerId: Id<'users'>, clientId: Id<'researchClients'>) {
  const client = await ctx.db.get(clientId);
  if (!client || client.ownerId !== ownerId) return denied();
  return client;
}
export async function projectFor(ctx: QueryCtx, ownerId: Id<'users'>, clientId: Id<'researchClients'>, projectId: Id<'researchProjects'>) {
  const client = await clientFor(ctx, ownerId, clientId);
  const project = await ctx.db.get(projectId);
  if (!project || project.ownerId !== ownerId || project.clientId !== client._id) return denied();
  return { client, project };
}
export async function hashCapability(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) return denied();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
export async function participant(ctx: QueryCtx, token: string) {
  const hash = await hashCapability(token);
  const invite = await ctx.db.query('researchInvitations').withIndex('by_tokenHash', q => q.eq('tokenHash', hash)).unique();
  if (!invite || invite.revokedAt !== null || invite.expiresAt <= Date.now()) return denied();
  const { client, project } = await projectFor(ctx, invite.ownerId, invite.clientId, invite.projectId);
  const session = await ctx.db.get(invite.sessionId);
  const study = await ctx.db.get(invite.studyId);
  if (client.state !== 'active' || project.state !== 'active' || !session || !study || session.studyId !== study._id || session.projectId !== project._id || session.clientId !== client._id || session.retainUntil <= Date.now()) return denied();
  return { invite, session, study, project };
}
export function revision(actual: number, expected: number) {
  if (!Number.isSafeInteger(expected) || actual !== expected) throw new ConvexError('The session changed. Refresh before saving.');
}
export function pageSize(size: number) {
  if (!Number.isSafeInteger(size) || size < 1 || size > 25) throw new ConvexError('Choose 1–25 results');
}
export function pageResult<T>(result: { page: T[]; isDone: boolean; continueCursor: string }) {
  return { page: result.page, isDone: result.isDone, continueCursor: result.continueCursor };
}
