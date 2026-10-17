import { requireStudyCapability } from './researchReadiness';
import { v, ConvexError } from 'convex/values';
import { internalMutation, internalQuery, type QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { requestId } from '../packages/research-core/src/limits';
export async function studySpeechGrant(ctx: QueryCtx, session: Doc<'researchSessions'>) {
  const binding = await requireStudyCapability(ctx, session, 'voice');
  if (binding) {
    const grant = binding.speechGrantId ? await ctx.db.get(binding.speechGrantId) : null;
    if (!grant?.enabled || grant.expiresAt <= Date.now() || grant.qualification !== 'root-reviewed-continuous-research-speech' || grant.studyId !== session.studyId) throw new ConvexError('Scoped voice child is unavailable');
    return grant;
  }
  const matches = await ctx.db.query('researchSpeechGrants').withIndex('by_studyId_and_enabled_and_expiresAt', q => q.eq('studyId', session.studyId).eq('enabled', true).gt('expiresAt', Date.now())).take(2);
  if (matches.length > 1) throw new ConvexError('Study voice allocation is ambiguous');
  return matches[0] ?? null;
}
/** Prospective root allocation only. Architectural maxima are never an allocation. */
export const provision = internalMutation({ args: { name: v.string(), studyId: v.id('researchStudies'), enabled: v.boolean(), allocatedSeconds: v.number(), allocatedCharacters: v.number(), maxSessionSeconds: v.number(), maxSessionCharacters: v.number(), expiresAt: v.number() }, returns: v.id('researchSpeechGrants'), handler: async (ctx, args) => {
  requestId(args.name);
  if (await ctx.db.query('researchSpeechGrants').withIndex('by_name', q => q.eq('name', args.name)).unique()) throw new ConvexError('Existing voice grant cannot be reset');
  if (!await ctx.db.get(args.studyId) || ![args.allocatedSeconds, args.allocatedCharacters, args.maxSessionSeconds, args.maxSessionCharacters, args.expiresAt].every(n => Number.isSafeInteger(n) && n > 0)
    || args.allocatedSeconds > 5400 || args.allocatedCharacters > 108000 || args.maxSessionSeconds > 5400 || args.maxSessionCharacters > 108000 || args.maxSessionSeconds > args.allocatedSeconds || args.maxSessionCharacters > args.allocatedCharacters
    || args.expiresAt <= Date.now() || args.expiresAt > Date.now() + 30 * 86400000) throw new ConvexError('Invalid prospective study voice grant');
  return ctx.db.insert('researchSpeechGrants', { ...args, purpose: 'continuous-research-study', qualification: 'root-reviewed-continuous-research-speech', chargedSeconds: 0, chargedCharacters: 0, createdAt: Date.now() });
} });
export const disable = internalMutation({ args: { name: v.string() }, returns: v.null(), handler: async (ctx, args) => {
  const grant = await ctx.db.query('researchSpeechGrants').withIndex('by_name', q => q.eq('name', args.name)).unique();
  if (!grant) throw new ConvexError('Voice grant unavailable');
  await ctx.db.patch(grant._id, { enabled: false }); return null;
} });

const grantReadback = v.object({ grantId: v.id('researchSpeechGrants'), name: v.string(), studyId: v.id('researchStudies'), purpose: v.literal('continuous-research-study'), qualification: v.literal('root-reviewed-continuous-research-speech'), enabled: v.boolean(), allocatedSeconds: v.number(), allocatedCharacters: v.number(), chargedSeconds: v.number(), chargedCharacters: v.number(), maxSessionSeconds: v.number(), maxSessionCharacters: v.number(), expiresAt: v.number() });
/** Private bounded root readback, without changing any legacy policy or charges. */
export const readiness = internalQuery({ args: { name: v.string(), sessionIds: v.array(v.id('researchSessions')) }, returns: v.object({ grant: v.union(grantReadback, v.null()), sessions: v.array(v.object({ sessionId: v.id('researchSessions'), chargedSeconds: v.number(), chargedCharacters: v.number(), attempts: v.array(v.object({ requestId: v.string(), provider: v.string(), state: v.string(), active: v.boolean(), grantId: v.union(v.id('researchSpeechGrants'), v.null()), reservedSeconds: v.number(), reservedCharacters: v.number(), rawSourceId: v.union(v.string(), v.null()), acceptedSourceId: v.union(v.string(), v.null()), acceptedRevision: v.union(v.number(), v.null()) })), truncated: v.boolean() })) }), handler: async (ctx, args) => {
  requestId(args.name);
  if (args.sessionIds.length > 4 || new Set(args.sessionIds).size !== args.sessionIds.length) throw new ConvexError('At most four distinct voice fixture sessions');
  const grant = await ctx.db.query('researchSpeechGrants').withIndex('by_name', q => q.eq('name', args.name)).unique();
  if (!grant && args.sessionIds.length) throw new ConvexError('Named voice grant unavailable');
  const sessions = [];
  for (const sessionId of args.sessionIds) {
    const session = await ctx.db.get(sessionId);
    if (!session || session.studyId !== grant!.studyId) throw new ConvexError('Session does not belong to the named voice grant');
    const budget = await ctx.db.query('researchSpeechGrantBudgets').withIndex('by_grantId_and_sessionId', q => q.eq('grantId', grant!._id).eq('sessionId', sessionId)).unique();
    const attempts = await ctx.db.query('researchSpeechAttempts').withIndex('by_sessionId_and_requestId', q => q.eq('sessionId', sessionId)).take(9);
    sessions.push({ sessionId, chargedSeconds: budget?.chargedSeconds ?? 0, chargedCharacters: budget?.chargedCharacters ?? 0, attempts: attempts.slice(0, 8).map(row => ({ requestId: row.requestId, provider: row.provider, state: row.state, active: row.active, grantId: row.grantId ?? null, reservedSeconds: row.reservedSeconds, reservedCharacters: row.reservedCharacters, rawSourceId: row.rawSourceId, acceptedSourceId: row.acceptedSourceId, acceptedRevision: row.acceptedRevision ?? null })), truncated: attempts.length > 8 });
  }
  return { grant: grant ? { grantId: grant._id, name: grant.name, studyId: grant.studyId, purpose: grant.purpose, qualification: grant.qualification, enabled: grant.enabled, allocatedSeconds: grant.allocatedSeconds, allocatedCharacters: grant.allocatedCharacters, chargedSeconds: grant.chargedSeconds, chargedCharacters: grant.chargedCharacters, maxSessionSeconds: grant.maxSessionSeconds, maxSessionCharacters: grant.maxSessionCharacters, expiresAt: grant.expiresAt } : null, sessions };
} });
