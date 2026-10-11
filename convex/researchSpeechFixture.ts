import { ConvexError, v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';

declare const process: { env: Record<string, string | undefined> };
function localOnly() {
  if (process.env.CONVEX_CLOUD_URL !== 'http://127.0.0.1:3210') throw new ConvexError('Synthetic speech fixture requires the isolated local deployment');
}
const policyReceipt = v.object({ enabled: v.boolean(), qualification: v.literal('root-reviewed-synthetic-speech'), allocatedSeconds: v.number(), allocatedCharacters: v.number(), chargedSeconds: v.number(), chargedCharacters: v.number(), maxSessionSeconds: v.number(), maxSessionCharacters: v.number() });
const policyFields = { allocatedSeconds: v.number(), allocatedCharacters: v.number(), maxSessionSeconds: v.number(), maxSessionCharacters: v.number() };
const publicPolicy = (row: { enabled: boolean; qualification: 'root-reviewed-synthetic-speech'; allocatedSeconds: number; allocatedCharacters: number; chargedSeconds: number; chargedCharacters: number; maxSessionSeconds: number; maxSessionCharacters: number }) => ({ enabled: row.enabled, qualification: row.qualification, allocatedSeconds: row.allocatedSeconds, allocatedCharacters: row.allocatedCharacters, chargedSeconds: row.chargedSeconds, chargedCharacters: row.chargedCharacters, maxSessionSeconds: row.maxSessionSeconds, maxSessionCharacters: row.maxSessionCharacters });
/** Local root fixture administration only. One immutable policy, no reset/re-enable. */
export const provision = internalMutation({ args: policyFields, returns: policyReceipt, handler: async (ctx, args) => {
  localOnly();
  if (![args.allocatedSeconds, args.allocatedCharacters, args.maxSessionSeconds, args.maxSessionCharacters].every(n => Number.isSafeInteger(n) && n > 0) || args.allocatedSeconds > 120 || args.allocatedCharacters > 400 || args.maxSessionSeconds > 120 || args.maxSessionCharacters > 200 || args.maxSessionSeconds > args.allocatedSeconds || args.maxSessionCharacters > args.allocatedCharacters) throw new ConvexError('Invalid bounded synthetic speech allowance');
  if (await ctx.db.query('researchSpeechPolicy').withIndex('by_name', q => q.eq('name', 'demo')).first()) throw new ConvexError('Speech policy is immutable; inspect existing counters');
  // Refuse even an orphaned reservation; provisioning cannot erase past evidence.
  if ((await ctx.db.query('researchSpeechBudgets').take(1)).length) throw new ConvexError('Prior speech allowance evidence already exists');
  for (const provider of ['deepgram', 'elevenlabs'] as const) for (const active of [true, false]) if ((await ctx.db.query('researchSpeechAttempts').withIndex('by_provider_and_active', q => q.eq('provider', provider).eq('active', active)).take(1)).length) throw new ConvexError('Prior speech reservation evidence already exists');
  const row = { name: 'demo' as const, qualification: 'root-reviewed-synthetic-speech' as const, enabled: true, ...args, chargedSeconds: 0, chargedCharacters: 0 };
  await ctx.db.insert('researchSpeechPolicy', row); return publicPolicy(row);
} });
export const readiness = internalQuery({ args: { sessionIds: v.array(v.id('researchSessions')) }, returns: v.object({ policy: v.union(policyReceipt, v.null()), sessions: v.array(v.object({ sessionId: v.id('researchSessions'), chargedSeconds: v.number(), chargedCharacters: v.number(), attempts: v.array(v.object({ requestId: v.string(), provider: v.string(), state: v.string(), active: v.boolean(), reservedSeconds: v.number(), reservedCharacters: v.number(), rawSourceId: v.union(v.string(), v.null()), acceptedSourceId: v.union(v.string(), v.null()) })), truncated: v.boolean() })) }), handler: async (ctx, { sessionIds }) => {
  localOnly(); if (sessionIds.length > 4 || new Set(sessionIds).size !== sessionIds.length) throw new ConvexError('At most four distinct fixture sessions');
  const policy = await ctx.db.query('researchSpeechPolicy').withIndex('by_name', q => q.eq('name', 'demo')).unique();
  const sessions = [];
  for (const sessionId of sessionIds) {
    const budget = await ctx.db.query('researchSpeechBudgets').withIndex('by_sessionId', q => q.eq('sessionId', sessionId)).unique();
    const attempts = await ctx.db.query('researchSpeechAttempts').withIndex('by_sessionId_and_requestId', q => q.eq('sessionId', sessionId)).take(9);
    sessions.push({ sessionId, chargedSeconds: budget?.chargedSeconds ?? 0, chargedCharacters: budget?.chargedCharacters ?? 0, attempts: attempts.slice(0, 8).map(row => ({ requestId: row.requestId, provider: row.provider, state: row.state, active: row.active, reservedSeconds: row.reservedSeconds, reservedCharacters: row.reservedCharacters, rawSourceId: row.rawSourceId, acceptedSourceId: row.acceptedSourceId })), truncated: attempts.length > 8 });
  }
  return { policy: policy ? publicPolicy(policy) : null, sessions };
} });
/** Stops future admission; preserves all charges, sources, attempts and holds. */
export const disable = internalMutation({ args: {}, returns: v.union(policyReceipt, v.null()), handler: async ctx => {
  localOnly(); const row = await ctx.db.query('researchSpeechPolicy').withIndex('by_name', q => q.eq('name', 'demo')).unique();
  if (!row) return null; await ctx.db.patch(row._id, { enabled: false }); return publicPolicy({ ...row, enabled: false });
} });
