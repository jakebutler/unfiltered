import { createAccount, invalidateSessions, modifyAccountCredentials } from '@convex-dev/auth/server';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';

export const existing = internalQuery({ args: {}, returns: v.union(v.id('users'), v.null()), handler: async ctx => (await ctx.db.query('researchOperators').withIndex('by_role', q => q.eq('role', 'operator')).unique())?.userId ?? null });
export const bind = internalMutation({ args: { userId: v.id('users'), name: v.string() }, returns: v.null(), handler: async (ctx, args) => {
  const current = await ctx.db.query('researchOperators').withIndex('by_role', q => q.eq('role', 'operator')).unique();
  if (current) throw new Error('An operator is already configured');
  if (!await ctx.db.get(args.userId)) throw new Error('Account missing');
  await ctx.db.insert('researchOperators', { role: 'operator', userId: args.userId, name: args.name, active: true });
  return null;
} });
// Admin-only CLI action, not a public enrollment route. A partial bootstrap can
// leave an unauthorised account, never a second authorised operator.
export const operator = internalAction({
  args: { email: v.string(), password: v.string(), name: v.string() }, returns: v.id('users'),
  handler: async (ctx, args): Promise<Id<'users'>> => {
    if (await ctx.runQuery(internal.bootstrap.existing, {})) throw new Error('An operator is already configured');
    const email = args.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || args.password.length < 16 || args.password.length > 256 || !args.name.trim() || args.name.length > 80) throw new Error('Invalid operator setup');
    const { user } = await createAccount(ctx, { provider: 'password', account: { id: email, secret: args.password }, profile: { email, name: args.name.trim() }, shouldLinkViaEmail: false, shouldLinkViaPhone: false });
    await ctx.runMutation(internal.bootstrap.bind, { userId: user._id, name: args.name.trim() });
    return user._id;
  },
});
export const resetPassword = internalAction({ args: { email: v.string(), password: v.string() }, returns: v.null(), handler: async (ctx, args) => {
  if (args.password.length < 16 || args.password.length > 256) throw new Error('Password must be 16–256 characters');
  const userId = await ctx.runQuery(internal.bootstrap.existing, {});
  if (!userId) throw new Error('Operator not configured');
  const email = await ctx.runQuery(internal.bootstrap.operatorEmail, { userId });
  if (args.email.trim().toLowerCase() !== email) throw new Error('Operator mismatch');
  await modifyAccountCredentials(ctx, { provider: 'password', account: { id: email, secret: args.password } });
  await invalidateSessions(ctx, { userId });
  return null;
} });
export const operatorEmail = internalQuery({ args: { userId: v.id('users') }, returns: v.string(), handler: async (ctx, { userId }) => {
  const user = await ctx.db.get(userId); if (!user?.email) throw new Error('Account missing'); return user.email;
} });
