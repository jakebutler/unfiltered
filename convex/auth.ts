import { Password } from '@convex-dev/auth/providers/Password';
import { convexAuth } from '@convex-dev/auth/server';
import { ConvexError } from 'convex/values';
import type { DataModel } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';

export function signInProfile(params: Record<string, unknown>) {
  if (params.flow !== 'signIn' || typeof params.email !== 'string' || params.email.length > 254 || typeof params.password !== 'string' || params.password.length > 256) throw new ConvexError('Sign in unavailable');
  return { email: params.email.trim().toLowerCase() };
}
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Password<DataModel>({ profile: signInProfile })],
  session: { totalDurationMs: 8 * 60 * 60 * 1000, inactiveDurationMs: 60 * 60 * 1000 },
  jwt: { durationMs: 5 * 60 * 1000 },
  signIn: { maxFailedAttempsPerHour: 5 },
  callbacks: {
    async beforeSessionCreation(ctx, { userId }) {
      const member = await (ctx as MutationCtx).db.query('researchOperators').withIndex('by_role', q => q.eq('role', 'operator')).unique();
      if (!member?.active || member.userId !== userId) throw new ConvexError('Sign in unavailable');
    },
  },
});
