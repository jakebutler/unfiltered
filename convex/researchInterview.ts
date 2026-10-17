import { runtimeFacts } from './researchReadinessValidators';
import { v, ConvexError } from 'convex/values';
import { query, mutation, internalMutation, type QueryCtx, type MutationCtx } from './_generated/server';
import { participant, denied, revision } from './access';
import { captureFor } from './capture';
import { verifyGateway, canonical } from '../packages/research-capture/src/proof';
import { hashValue } from '../packages/research-core/src/analysis';
import { advanceInterview, decideInterview, interviewStopReason, type InterviewContext, type InterviewDecision } from '../packages/research-core/src/interview';
import { requestId, RESEARCH_LIMITS } from '../packages/research-core/src/limits';
import { currentResearchPrompt } from './currentResearchPrompt';
import { gatewayProof } from './captureValidators';
import { currentPrompt, interviewScope, interviewReservation, interviewState, interviewReceipt, interviewDecision, pendingView } from './interviewValidators';
import type { Doc } from './_generated/dataModel';
import { interviewPolicyForStudy, requireRunningStudyCapability } from './researchReadiness';
declare const process: { env: Record<string, string | undefined> };
const auth = (name: string, input: unknown, proof: { at: number; signature: string }) => verifyGateway(process.env.RESEARCH_MEDIA_GATEWAY_SECRET, `interview:${name}`, input, proof);
type Scope = { sessionId: Doc<'researchSessions'>['_id']; promptId: string; expectedRevision: number; answerSourceId: string; requestId: string };
const args = { token: v.string(), scope: interviewScope, proof: gatewayProof };
const contextView = v.object({ sessionId: v.string(), revision: v.number(), consentEpoch: v.number(), retainUntil: v.number(), goals: v.array(v.string()), script: v.array(v.object({ id: v.string(), question: v.string() })), scriptIndex: v.number(), currentPrompt, followUps: v.array(v.string()), answer: v.object({ sourceId: v.string(), promptId: v.string(), text: v.string(), channel: v.union(v.literal('text'), v.literal('confirmed-transcript'), v.literal('spoken-answer')), intent: v.union(v.literal('answer'), v.literal('skip')) }) });
export async function interviewMaterial(ctx: QueryCtx, token: string, scope: Scope) {
  requestId(scope.requestId);
  const { session, study } = await participant(ctx, token);
  if (session.purpose === 'readiness-test') return denied();
  const pending = session.pendingInterview, prompt = currentResearchPrompt(session, study, true);
  revision(session.revision, scope.expectedRevision);
  if (!session.interviewEnabled || session.state !== 'active' || !session.consent?.storage || !session.consent.analysis || session._id !== scope.sessionId || !pending || !prompt || pending.sourceId !== scope.answerSourceId || pending.promptId !== scope.promptId || prompt.id !== scope.promptId) return denied();
  const source = await ctx.db.query('researchSources').withIndex('by_sessionId_and_sourceId', q => q.eq('sessionId', session._id).eq('sourceId', pending.sourceId)).unique();
  if (!source || source.author !== 'participant' || !['text', 'confirmed-transcript', 'spoken-answer'].includes(source.channel) || source.questionId !== prompt.id || await ctx.db.query('researchSources').withIndex('by_sessionId_and_supersedes', q => q.eq('sessionId', session._id).eq('supersedes', source.sourceId)).first()) return denied();
  const capture = await captureFor(ctx, session._id);
  const context: InterviewContext = { sessionId: session._id, revision: session.revision, consentEpoch: capture?.consentEpoch ?? 0, retainUntil: session.retainUntil, goals: study.definition.goals, script: study.definition.script, scriptIndex: session.nextQuestion, currentPrompt: prompt, followUps: session.followUps ?? [], answer: { sourceId: source.sourceId, promptId: prompt.id, text: source.text, channel: source.channel as 'text' | 'confirmed-transcript' | 'spoken-answer', intent: pending.intent } };
  return { session, study, context, contextHash: await hashValue(context) };
}
export async function pendingInterviewView(ctx: QueryCtx, session: Doc<'researchSessions'>) {
  const p = session.pendingInterview; if (!p) return null;
  const attempt = await ctx.db.query('researchInterviewAttempts').withIndex('by_sessionId_and_requestId', q => q.eq('sessionId', session._id).eq('requestId', p.requestId)).unique();
  return { scope: { sessionId: session._id, promptId: p.promptId, expectedRevision: session.revision, answerSourceId: p.sourceId, requestId: p.requestId }, state: attempt?.state ?? 'pending' as const, automaticAllowed: !attempt && session.state === 'active' && session.revision === p.revision };
}
async function attemptFor(ctx: QueryCtx, scope: Scope, id: string) {
  const attempt = await ctx.db.query('researchInterviewAttempts').withIndex('by_sessionId_and_requestId', q => q.eq('sessionId', scope.sessionId).eq('requestId', id)).unique();
  if (!attempt || scope.requestId !== id || attempt.promptId !== scope.promptId || attempt.answerSourceId !== scope.answerSourceId || attempt.expectedRevision !== scope.expectedRevision) return denied();
  return attempt;
}
export async function installInterviewDecision(ctx: MutationCtx, material: Awaited<ReturnType<typeof interviewMaterial>>, decision: InterviewDecision) {
  const { session } = material, sequence = session.sourceCount, now = Date.now();
  if (decision.prompt && sequence >= RESEARCH_LIMITS.sourceCount) throw new ConvexError('Interview source allowance is exhausted; submit a partial interview');
  if (decision.prompt) await ctx.db.insert('researchSources', { sessionId: session._id, clientId: session.clientId, projectId: session.projectId, sequence, sourceId: `${session._id}:${sequence}`, requestId: `interviewer-prompt-${sequence}`, questionId: decision.prompt.id, author: 'interviewer', channel: decision.kind === 'follow-up' ? 'follow-up' : 'script', text: decision.prompt.question, recordedAt: now, supersedes: null });
  await ctx.db.patch(session._id, { currentPrompt: decision.prompt, nextQuestion: decision.scriptIndex, followUps: decision.kind === 'follow-up' ? [...(session.followUps ?? []), decision.prompt.question] : [], pendingInterview: undefined, sourceCount: sequence + (decision.prompt ? 1 : 0), savedAt: now, revision: session.revision + 1 });
  return session.revision + 1;
}
export const inspect = query({ args, returns: contextView, handler: async (ctx, { proof, ...input }) => { await auth('inspect', input, proof); return (await interviewMaterial(ctx, input.token, input.scope)).context; } });
export const status = query({ args: { token: v.string() }, returns: pendingView, handler: async (ctx, input) => { const { session } = await participant(ctx, input.token); return pendingInterviewView(ctx, session); } });
const admission = v.object({ attemptId: v.string(), state: interviewState, reservation: interviewReservation });
export const admit = mutation({ args: { ...args, contextHash: v.string(), runtime: v.optional(runtimeFacts) }, returns: admission, handler: async (ctx, { proof, ...input }) => {
  await auth('admit', input, proof);
  const m = await interviewMaterial(ctx, input.token, input.scope);
  if (m.contextHash !== input.contextHash || m.session.pendingInterview?.requestId !== input.scope.requestId || interviewStopReason(m.context)) return denied();
  const prior = await ctx.db.query('researchInterviewAttempts').withIndex('by_sessionId_and_requestId', q => q.eq('sessionId', input.scope.sessionId).eq('requestId', input.scope.requestId)).unique();
  if (prior) { if (prior.contextHash !== input.contextHash) return denied(); return { attemptId: prior.requestId, state: prior.state === 'reserved' ? 'unknown' as const : prior.state, reservation: prior.reservation }; }
  await requireRunningStudyCapability(ctx, m.session, 'goal-aware-interview', input.runtime);
  const p = await interviewPolicyForStudy(ctx, m.session);
  if (!p?.enabled || p.qualification !== 'root-reviewed-research-interview' || p.expiresAt <= Date.now() || ![p.allocatedCalls, p.chargedCalls, p.maxSessionCalls, p.maxInputBytes, p.maxOutputTokens].every(n => Number.isSafeInteger(n) && n >= 0) || p.allocatedCalls > 1000 || p.maxSessionCalls > 60 || p.maxInputBytes < 1 || p.maxInputBytes > 64000 || p.maxOutputTokens < 1 || p.maxOutputTokens > 512) return denied();
  if ((await ctx.db.query('researchInterviewAttempts').withIndex('by_active', q => q.eq('active', true)).take(1)).length) throw new ConvexError('An interview call is unresolved; continue with the script');
  const budget = await ctx.db.query('researchInterviewBudgets').withIndex('by_sessionId', q => q.eq('sessionId', m.session._id)).unique(), charged = (budget?.chargedCalls ?? 0) + 1;
  if (charged > p.maxSessionCalls || p.chargedCalls >= p.allocatedCalls) throw new ConvexError('Interview allowance is exhausted; continue with the script');
  const reservation = { id: `interview-${m.session._id}-${input.scope.requestId}`, model: p.model, maxInputBytes: p.maxInputBytes, maxOutputTokens: p.maxOutputTokens, expiresAt: Math.min(p.expiresAt, Date.now() + 30000) };
  await ctx.db.patch(p._id, { chargedCalls: p.chargedCalls + 1 });
  if (budget) await ctx.db.patch(budget._id, { chargedCalls: charged }); else await ctx.db.insert('researchInterviewBudgets', { sessionId: m.session._id, chargedCalls: charged });
  await ctx.db.insert('researchInterviewAttempts', { sessionId: m.session._id, requestId: input.scope.requestId, answerSourceId: input.scope.answerSourceId, promptId: input.scope.promptId, expectedRevision: input.scope.expectedRevision, contextHash: input.contextHash, reservation, state: 'reserved', active: true, inputHash: null, requestBytes: null, outputHash: null, receipt: null, errorCode: null, installedRevision: null, createdAt: Date.now() });
  return { attemptId: input.scope.requestId, state: 'reserved' as const, reservation };
} });
export const begin = mutation({ args: { ...args, runtime: v.optional(runtimeFacts), attemptId: v.string(), contextHash: v.string(), prepared: v.object({ inputHash: v.string(), requestBytes: v.number(), maxOutputTokens: v.number() }) }, returns: v.boolean(), handler: async (ctx, { proof, ...input }) => {
  await auth('begin', input, proof); const m = await interviewMaterial(ctx, input.token, input.scope), a = await attemptFor(ctx, input.scope, input.attemptId);
  if (a.state !== 'reserved') return false;
  await requireRunningStudyCapability(ctx, m.session, 'goal-aware-interview', input.runtime);
  if (m.contextHash !== input.contextHash || a.contextHash !== input.contextHash || a.reservation.expiresAt <= Date.now() || !/^[a-f0-9]{64}$/.test(input.prepared.inputHash) || !Number.isSafeInteger(input.prepared.requestBytes) || input.prepared.requestBytes < 1 || input.prepared.requestBytes > a.reservation.maxInputBytes || input.prepared.maxOutputTokens !== a.reservation.maxOutputTokens) return denied();
  await ctx.db.patch(a._id, { state: 'dispatching', inputHash: input.prepared.inputHash, requestBytes: input.prepared.requestBytes }); return true;
} });
export const finish = mutation({ args: { ...args, attemptId: v.string(), contextHash: v.string(), result: v.object({ state: v.union(v.literal('ready'), v.literal('failed'), v.literal('unknown')), decision: v.union(interviewDecision, v.null()), providerRequestId: v.union(v.string(), v.null()), providerReceipt: v.union(interviewReceipt, v.null()), outputHash: v.union(v.string(), v.null()), errorCode: v.union(v.string(), v.null()) }) }, returns: v.null(), handler: async (ctx, { proof, ...input }) => {
  await auth('finish', input, proof); // Exact admitted attempt binds terminal metadata even after capability revocation.
  if (!await ctx.db.get(input.scope.sessionId)) return denied();
  const a = await attemptFor(ctx, input.scope, input.attemptId), r = input.result;
  if (a.contextHash !== input.contextHash || !['reserved', 'dispatching'].includes(a.state)) return null;
  if (r.outputHash !== null && !/^[a-f0-9]{64}$/.test(r.outputHash) || r.errorCode !== null && r.errorCode.length > 100) return denied();
  if (r.providerReceipt && (r.providerReceipt.requestId !== r.providerRequestId || r.providerReceipt.requestId.length > 256 || r.providerReceipt.model !== a.reservation.model || r.providerReceipt.requestBytes !== a.requestBytes || !Number.isFinite(r.providerReceipt.elapsedMs) || r.providerReceipt.elapsedMs < 0 || r.providerReceipt.elapsedMs > 60000 || r.providerReceipt.usage && !Object.values(r.providerReceipt.usage).every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1000000))) return denied();
  let installedRevision: number | null = null, state = r.state, errorCode = r.errorCode;
  if (r.state === 'ready') {
    if (a.state !== 'dispatching' || !r.decision || !r.providerReceipt || !r.outputHash) return denied();
    let m: Awaited<ReturnType<typeof interviewMaterial>> | null = null;
    try { m = await interviewMaterial(ctx, input.token, input.scope); } catch { /* Known completion may settle without stale prompt authority. */ }
    if (!m || m.contextHash !== input.contextHash) { state = 'failed'; errorCode = 'late-interview-result'; }
    else {
      const expected = r.decision.kind === 'advance' ? advanceInterview(m.context, r.decision.reason) : decideInterview(m.context, { decision: 'follow-up', question: r.decision.prompt.question, goalIndex: r.decision.goalIndex, sourceId: r.decision.evidence.sourceId, quote: r.decision.evidence.quote }, `followup-${input.contextHash.slice(0, 24)}`);
      if (canonical(expected) !== canonical(r.decision)) return denied();
      installedRevision = await installInterviewDecision(ctx, m, expected);
    }
  } else if (r.decision !== null) return denied();
  await ctx.db.patch(a._id, { state, active: state === 'unknown' || state === 'failed' && a.state === 'dispatching' && !r.providerReceipt, outputHash: r.outputHash, receipt: r.providerReceipt, errorCode, installedRevision }); return null;
} });
export const advance = mutation({ args: { ...args, contextHash: v.string(), decision: interviewDecision }, returns: v.null(), handler: async (ctx, { proof, ...input }) => {
  await auth('advance', input, proof); const m = await interviewMaterial(ctx, input.token, input.scope);
  if (m.contextHash !== input.contextHash || input.decision.kind !== 'advance' || canonical(input.decision) !== canonical(advanceInterview(m.context, input.decision.reason))) return denied();
  await installInterviewDecision(ctx, m, input.decision); return null;
} });
/** Root-only immutable finite allocation. Merely adding this function does not provision/activate it. */
export const provision = internalMutation({ args: { enabled: v.boolean(), allocatedCalls: v.number(), maxSessionCalls: v.number(), model: v.union(v.literal('qwen3.8-max'), v.literal('glm-5.3-flash')), maxInputBytes: v.number(), maxOutputTokens: v.number(), expiresAt: v.number() }, returns: v.null(), handler: async (ctx, input) => {
  if (await ctx.db.query('researchInterviewPolicy').withIndex('by_name', q => q.eq('name', 'demo')).unique()) throw new ConvexError('Existing allocation cannot be reset');
  if (![input.allocatedCalls, input.maxSessionCalls, input.maxInputBytes, input.maxOutputTokens, input.expiresAt].every(n => Number.isSafeInteger(n) && n > 0) || input.allocatedCalls > 1000 || input.maxSessionCalls > 60 || input.maxInputBytes > 64000 || input.maxOutputTokens > 512 || input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 30 * 86400000) return denied();
  await ctx.db.insert('researchInterviewPolicy', { ...input, name: 'demo', qualification: 'root-reviewed-research-interview', chargedCalls: 0 }); return null;
} });

/** Monotonic administrative OFF switch; allocation/history cannot be reset. */
export const disable = internalMutation({ args: {}, returns: v.null(), handler: async ctx => {
  const policy = await ctx.db.query('researchInterviewPolicy').withIndex('by_name', q => q.eq('name', 'demo')).unique();
  if (policy?.enabled) await ctx.db.patch(policy._id, { enabled: false });
  return null;
} });
