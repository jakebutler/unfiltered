import { ConvexError, v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import { interviewReceipt, interviewReservation, interviewState } from './interviewValidators';

declare const process: { env: Record<string, string | undefined> };
function localOnly() {
  if (process.env.CONVEX_CLOUD_URL !== 'http://127.0.0.1:3210') throw new ConvexError('Interview fixture requires isolated localhost');
}
const policyReceipt = v.object({ enabled: v.boolean(), qualification: v.literal('root-reviewed-research-interview'), allocatedCalls: v.number(), chargedCalls: v.number(), maxSessionCalls: v.number(), model: v.union(v.literal('qwen3.8-max'), v.literal('glm-5.3-flash')), maxInputBytes: v.number(), maxOutputTokens: v.number(), expiresAt: v.number() });
const attemptReceipt = v.object({ requestId: v.string(), answerSourceId: v.string(), promptId: v.string(), expectedRevision: v.number(), contextHash: v.string(), reservation: interviewReservation, state: interviewState, active: v.boolean(), inputHash: v.union(v.string(), v.null()), requestBytes: v.union(v.number(), v.null()), outputHash: v.union(v.string(), v.null()), receipt: v.union(interviewReceipt, v.null()), errorCode: v.union(v.string(), v.null()), installedRevision: v.union(v.number(), v.null()) });
const publicPolicy = ({ enabled, qualification, allocatedCalls, chargedCalls, maxSessionCalls, model, maxInputBytes, maxOutputTokens, expiresAt }: { enabled: boolean; qualification: 'root-reviewed-research-interview'; allocatedCalls: number; chargedCalls: number; maxSessionCalls: number; model: 'qwen3.8-max' | 'glm-5.3-flash'; maxInputBytes: number; maxOutputTokens: number; expiresAt: number }) => ({ enabled, qualification, allocatedCalls, chargedCalls, maxSessionCalls, model, maxInputBytes, maxOutputTokens, expiresAt });
/** Private administration only; bounded readback never consumes or clears attempts. */
export const readiness = internalQuery({ args: { sessionIds: v.array(v.id('researchSessions')) }, returns: v.object({ policy: v.union(policyReceipt, v.null()), hasPriorEvidence: v.boolean(), activeAttempts: v.number(), activeTruncated: v.boolean(), sessions: v.array(v.object({ sessionId: v.id('researchSessions'), chargedCalls: v.number(), attempts: v.array(attemptReceipt), truncated: v.boolean() })) }), handler: async (ctx, { sessionIds }) => {
  localOnly();
  if (sessionIds.length > 2 || new Set(sessionIds).size !== sessionIds.length) throw new ConvexError('At most two distinct fixture sessions');
  const policy = await ctx.db.query('researchInterviewPolicy').withIndex('by_name', q => q.eq('name', 'demo')).unique();
  const active = await ctx.db.query('researchInterviewAttempts').withIndex('by_active', q => q.eq('active', true)).take(3);
  const sessions = [];
  for (const sessionId of sessionIds) {
    if (!await ctx.db.get(sessionId)) throw new ConvexError('Unknown fixture session');
    const budget = await ctx.db.query('researchInterviewBudgets').withIndex('by_sessionId', q => q.eq('sessionId', sessionId)).unique();
    const rows = await ctx.db.query('researchInterviewAttempts').withIndex('by_sessionId_and_requestId', q => q.eq('sessionId', sessionId)).take(3);
    const attempts = rows.slice(0, 2).map(({ requestId, answerSourceId, promptId, expectedRevision, contextHash, reservation, state, active, inputHash, requestBytes, outputHash, receipt, errorCode, installedRevision }) => ({ requestId, answerSourceId, promptId, expectedRevision, contextHash, reservation, state, active, inputHash, requestBytes, outputHash, receipt, errorCode, installedRevision }));
    sessions.push({ sessionId, chargedCalls: budget?.chargedCalls ?? 0, attempts, truncated: rows.length > 2 });
  }
  const hasPriorEvidence = !!((await ctx.db.query('researchInterviewBudgets').take(1)).length || (await ctx.db.query('researchInterviewAttempts').take(1)).length);
  return { policy: policy ? publicPolicy(policy) : null, hasPriorEvidence, activeAttempts: Math.min(active.length, 2), activeTruncated: active.length > 2, sessions };
} });
/** Monotonic disable: never refunds, deletes unknown holds, resets or re-enables. */
export const disable = internalMutation({ args: {}, returns: v.union(policyReceipt, v.null()), handler: async ctx => {
  localOnly(); const row = await ctx.db.query('researchInterviewPolicy').withIndex('by_name', q => q.eq('name', 'demo')).unique();
  if (!row) return null;
  await ctx.db.patch(row._id, { enabled: false }); return publicPolicy({ ...row, enabled: false });
} });
