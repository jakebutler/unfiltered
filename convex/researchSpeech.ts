import { requireRunningStudyCapability } from './researchReadiness';
import { runtimeFacts } from './researchReadinessValidators';
import { v, ConvexError } from 'convex/values';
import { mutation, query, type QueryCtx } from './_generated/server';
import { currentResearchPrompt } from './currentResearchPrompt';
import { participant, denied, revision } from './access';
import { captureFor } from './capture';
import { gatewayProof } from './captureValidators';
import { verifyGateway } from '../packages/research-capture/src/proof';
import { RESEARCH_LIMITS, boundedText, requestId } from '../packages/research-core/src/limits';
import type { Doc } from './_generated/dataModel';
import { studySpeechGrant } from './researchSpeechGrants';
import { appendParticipantAnswer } from './participant';

declare const process: { env: Record<string, string | undefined> };
const auth = (operation: string, input: unknown, proof: { at: number; signature: string }) => verifyGateway(process.env.RESEARCH_MEDIA_GATEWAY_SECRET, `speech:${operation}`, input, proof);
const provider = v.union(v.literal('deepgram'), v.literal('elevenlabs'));
const outcome = v.union(v.literal('completed'), v.literal('interrupted'), v.literal('failed'), v.literal('unknown'));
export const speechScope = v.object({ sessionId: v.id('researchSessions'), promptId: v.string(), expectedRevision: v.number(), requestId: v.string() });
const speechArgs = { token: v.string(), scope: speechScope, provider };
export const speechTransportLease = v.object({ leaseId: v.id('researchGatewaySlots'), requestId: v.string(), owner: v.string(), generation: v.number() });
const transcriptReceipt = v.object({ attemptId: v.string(), rawSourceId: v.string(), text: v.string(), promptId: v.string(), expectedRevision: v.number() });
type Scope = { sessionId: Doc<'researchSessions'>['_id']; promptId: string; expectedRevision: number; requestId: string };
type Provider = 'deepgram' | 'elevenlabs';
async function receipt(ctx: QueryCtx, attempt: Doc<'researchSpeechAttempts'>) {
  if (attempt.rawSourceId === null) return null;
  const source = await ctx.db.query('researchSources').withIndex('by_sessionId_and_sourceId', q => q.eq('sessionId', attempt.sessionId).eq('sourceId', attempt.rawSourceId!)).unique();
  if (!source || source.channel !== 'unreviewed-transcript' || source.questionId !== attempt.promptId) return null;
  return { attemptId: attempt.requestId, rawSourceId: source.sourceId, text: source.text, promptId: attempt.promptId, expectedRevision: attempt.expectedRevision };
}
async function current(ctx: QueryCtx, token: string, scope: Scope, target: Provider) {
  requestId(scope.requestId);
  const access = await participant(ctx, token), { session, study } = access;
  revision(session.revision, scope.expectedRevision);
  if (session.purpose === 'readiness-test' || session._id !== scope.sessionId || session.state !== 'active' || !session.consent?.storage || !session.consent.analysis || target === 'deepgram' && !session.consent.microphone || currentResearchPrompt(session, study)?.id !== scope.promptId) return denied();
  const capture = await captureFor(ctx, session._id);
  return { ...access, consentEpoch: capture?.consentEpoch ?? 0, question: currentResearchPrompt(session, study)! };
}
async function attemptFor(ctx: QueryCtx, scope: Scope, target: Provider) {
  const attempt = await ctx.db.query('researchSpeechAttempts').withIndex('by_sessionId_and_requestId', q => q.eq('sessionId', scope.sessionId).eq('requestId', scope.requestId)).unique();
  if (!attempt || attempt.provider !== target || attempt.promptId !== scope.promptId || attempt.expectedRevision !== scope.expectedRevision) return denied();
  return attempt;
}
function unfenced(attempt: Doc<'researchSpeechAttempts'>) {
  if (attempt.transportFence) return denied();
}
/** Commit-time read participates in Convex OCC: a concurrent exact-generation
 * fence forces the mutation to retry and reject before any late write commits. */
async function transportOwner(ctx: QueryCtx, attempt: Doc<'researchSpeechAttempts'>) {
  unfenced(attempt);
  const identity = attempt.transportLease;
  // Preserve only the intentionally unallocated local synthetic policy path.
  if (!identity && !attempt.grantId && !process.env.RESEARCH_HOSTED_GATEWAY_ORIGIN && !process.env.RESEARCH_HOSTED_GATEWAY_ALLOCATION && (!process.env.CONVEX_SITE_URL || process.env.CONVEX_SITE_URL === 'http://127.0.0.1:3211')) return;
  const slot = identity ? await ctx.db.get(identity.leaseId) : null;
  if (!identity || !slot || slot.kind !== 'voice' || !slot.workStarted || slot.owner !== identity.owner || slot.requestId !== identity.requestId || slot.generation !== identity.generation) return denied();
}
async function textHash(text: string) {
  const value = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('');
}
export const status = query({ args: { token: v.string(), runtime: v.optional(runtimeFacts), proof: gatewayProof }, returns: v.object({ enabled: v.boolean(), continuous: v.optional(v.boolean()), grantName: v.optional(v.string()) }), handler: async (ctx, { proof, ...args }) => {
  await auth('status', args, proof); const { session } = await participant(ctx, args.token);
  if (session.purpose === 'readiness-test') return { enabled: false };
  let grant = null;
  try { await requireRunningStudyCapability(ctx, session, 'voice', args.runtime); grant = await studySpeechGrant(ctx, session); } catch { return { enabled: false }; }
  if (grant) { const { study } = await participant(ctx, args.token), question = currentResearchPrompt(session, study)?.question; return { enabled: session.state === 'active' && !!question && grant.allocatedSeconds - grant.chargedSeconds >= 60 && grant.allocatedCharacters - grant.chargedCharacters >= question.length, continuous: true, grantName: grant.name }; }
  const policy = await ctx.db.query('researchSpeechPolicy').withIndex('by_name', q => q.eq('name', 'demo')).unique();
  return { enabled: session.state === 'active' && !!policy?.enabled && policy.qualification === 'root-reviewed-synthetic-speech' };
} });
export const authorize = query({ args: { ...speechArgs, runtime: v.optional(runtimeFacts), proof: gatewayProof }, returns: v.null(), handler: async (ctx, { proof, ...args }) => {
  await auth('authorize', args, proof); await current(ctx, args.token, args.scope, args.provider);
  const { session } = await participant(ctx, args.token);
  await requireRunningStudyCapability(ctx, session, 'voice', args.runtime);
  const grant = await studySpeechGrant(ctx, session);
  if (grant) {
    const { question } = await current(ctx, args.token, args.scope, args.provider);
    if (args.provider === 'deepgram' ? grant.chargedSeconds + 60 > grant.allocatedSeconds : grant.chargedCharacters + question.question.length > grant.allocatedCharacters) throw new ConvexError('Voice allowance is exhausted; continue typing');
    return null;
  }
  const policy = await ctx.db.query('researchSpeechPolicy').withIndex('by_name', q => q.eq('name', 'demo')).unique();
  if (!policy?.enabled || policy.qualification !== 'root-reviewed-synthetic-speech') return denied(); return null;
} });
export const reserve = mutation({ args: { ...speechArgs, runtime: v.optional(runtimeFacts), maxAudioSeconds: v.number(), maxCharacters: v.number(), transportLease: v.optional(speechTransportLease), proof: gatewayProof }, returns: v.null(), handler: async (ctx, { proof, ...args }) => {
  await auth('reserve', args, proof); const { session, consentEpoch, question } = await current(ctx, args.token, args.scope, args.provider);
  if (await ctx.db.query('researchSpeechAttempts').withIndex('by_sessionId_and_requestId', q => q.eq('sessionId', session._id).eq('requestId', args.scope.requestId)).unique()) throw new ConvexError('Check the original voice attempt; replay is unavailable');
  await requireRunningStudyCapability(ctx, session, 'voice', args.runtime);
  const grant = await studySpeechGrant(ctx, session);
  const legacy = grant ? null : await ctx.db.query('researchSpeechPolicy').withIndex('by_name', q => q.eq('name', 'demo')).unique();
  const policy = grant ?? legacy;
  if (!policy?.enabled) return denied();
  const valid = [policy.allocatedSeconds, policy.allocatedCharacters, policy.chargedSeconds, policy.chargedCharacters, policy.maxSessionSeconds, policy.maxSessionCharacters].every(value => Number.isSafeInteger(value) && value >= 0);
  if (!valid || (grant ? grant.qualification !== 'root-reviewed-continuous-research-speech' || policy.maxSessionSeconds > 5400 || policy.maxSessionCharacters > 108000 || policy.allocatedSeconds > 5400 || policy.allocatedCharacters > 108000 : !legacy || legacy.qualification !== 'root-reviewed-synthetic-speech' || policy.maxSessionSeconds > 180 || policy.maxSessionCharacters > 3600 || policy.allocatedSeconds > 3600 || policy.allocatedCharacters > 10_000)) return denied();
  if (args.provider === 'deepgram' ? args.maxAudioSeconds !== 60 || args.maxCharacters !== 0 : args.maxAudioSeconds !== 0 || args.maxCharacters !== question.question.length || args.maxCharacters < 1 || args.maxCharacters > 1200) return denied();
  // Accounting uncertainty never expires/refunds. Local transport occupancy may
  // end only on a positive native release proof, atomically with a distinct turn.
  const occupied = await ctx.db.query('researchSpeechAttempts').withIndex('by_provider_and_active', q => q.eq('provider', args.provider).eq('active', true)).take(2);
  const prior = occupied[0];
  const releaseProof = prior && prior.requestId !== args.scope.requestId && occupied.length === 1 && ['unknown', 'interrupted'].includes(prior.state) ? await transportSettlementProof(ctx, prior) : null;
  if (occupied.length && !releaseProof) throw new ConvexError('Voice capacity is occupied by an unresolved attempt');
  if (grant) {
    const identity = args.transportLease, slot = identity ? await ctx.db.get(identity.leaseId) : null;
    if (!identity || !slot || !slot.allocationId || slot.kind !== 'voice' || !slot.workStarted || slot.requestId !== identity.requestId || slot.owner !== identity.owner || slot.generation !== identity.generation || slot.expiresAt - 45000 <= Date.now()) return denied();
  }
  const budget = grant ? await ctx.db.query('researchSpeechGrantBudgets').withIndex('by_grantId_and_sessionId', q => q.eq('grantId', grant._id).eq('sessionId', session._id)).unique() : await ctx.db.query('researchSpeechBudgets').withIndex('by_sessionId', q => q.eq('sessionId', session._id)).unique();
  const seconds = (budget?.chargedSeconds ?? 0) + args.maxAudioSeconds, characters = (budget?.chargedCharacters ?? 0) + args.maxCharacters;
  if (seconds > policy.maxSessionSeconds || characters > policy.maxSessionCharacters || policy.chargedSeconds + args.maxAudioSeconds > policy.allocatedSeconds || policy.chargedCharacters + args.maxCharacters > policy.allocatedCharacters) throw new ConvexError('Voice allowance is exhausted; continue typing');
  await ctx.db.patch(policy._id, { chargedSeconds: policy.chargedSeconds + args.maxAudioSeconds, chargedCharacters: policy.chargedCharacters + args.maxCharacters });
  if (budget) await ctx.db.patch(budget._id, { chargedSeconds: seconds, chargedCharacters: characters });
  else if (grant) await ctx.db.insert('researchSpeechGrantBudgets', { grantId: grant._id, sessionId: session._id, chargedSeconds: seconds, chargedCharacters: characters });
  else await ctx.db.insert('researchSpeechBudgets', { sessionId: session._id, chargedSeconds: seconds, chargedCharacters: characters });
  if (prior && releaseProof) await ctx.db.patch(prior._id, { active: false, occupancyRelease: { ...releaseProof, reason: 'positive-native-transport-settlement', nextRequestId: args.scope.requestId, releasedAt: Date.now() } });
  await ctx.db.insert('researchSpeechAttempts', { ...(grant ? { grantId: grant._id, transportLease: args.transportLease } : {}), sessionId: session._id, requestId: args.scope.requestId, provider: args.provider, promptId: args.scope.promptId, expectedRevision: args.scope.expectedRevision, consentAt: session.consentAt!, consentEpoch, textHash: args.provider === 'elevenlabs' ? await textHash(question.question) : null, reservedSeconds: args.maxAudioSeconds, reservedCharacters: args.maxCharacters, state: 'reserved', active: true, createdAt: Date.now(), deadline: Date.now() + (args.provider === 'deepgram' ? 70_000 : 35_000), rawSourceId: null, acceptedSourceId: null });
  return null;
} });
export const inspect = query({ args: { ...speechArgs, proof: gatewayProof }, returns: v.null(), handler: async (ctx, { proof, ...args }) => {
  await auth('inspect', args, proof); const { session, consentEpoch, question } = await current(ctx, args.token, args.scope, args.provider), attempt = await attemptFor(ctx, args.scope, args.provider);
  await transportOwner(ctx, attempt);
  const readableOutput = args.provider === 'elevenlabs' && attempt.state === 'completed';
  if ((!attempt.active || attempt.state !== 'reserved') && !readableOutput || attempt.deadline <= Date.now() || attempt.consentAt !== session.consentAt || attempt.consentEpoch !== consentEpoch || args.provider === 'elevenlabs' && attempt.textHash !== await textHash(question.question)) return denied(); return null;
} });
export const saveTranscript = mutation({ args: { token: v.string(), scope: speechScope, text: v.string(), outcome, proof: gatewayProof }, returns: transcriptReceipt, handler: async (ctx, { proof, ...args }) => {
  await auth('saveTranscript', args, proof); const { session, consentEpoch } = await current(ctx, args.token, args.scope, 'deepgram'), attempt = await attemptFor(ctx, args.scope, 'deepgram');
  await transportOwner(ctx, attempt);
  boundedText(args.text, RESEARCH_LIMITS.answerCharacters, 'transcript');
  const prior = await receipt(ctx, attempt);
  if (prior) { if (prior.text !== args.text) return denied(); return prior; }
  if (attempt.state !== 'reserved' || !attempt.active || attempt.deadline <= Date.now() || attempt.consentAt !== session.consentAt || attempt.consentEpoch !== consentEpoch || session.sourceCount >= RESEARCH_LIMITS.sourceCount) return denied();
  const sequence = session.sourceCount, sourceId = `${session._id}:${sequence}`, recordedAt = Date.now();
  await ctx.db.insert('researchSources', { sessionId: session._id, clientId: session.clientId, projectId: session.projectId, sequence, sourceId, requestId: `speech-raw-${args.scope.requestId}`, questionId: args.scope.promptId, author: 'participant', channel: 'unreviewed-transcript', text: args.text, recordedAt, supersedes: null });
  await ctx.db.patch(session._id, { sourceCount: sequence + 1, savedAt: recordedAt });
  await ctx.db.patch(attempt._id, { rawSourceId: sourceId });
  return { attemptId: args.scope.requestId, rawSourceId: sourceId, text: args.text, promptId: args.scope.promptId, expectedRevision: args.scope.expectedRevision };
} });
export const readTranscript = query({ args: { token: v.string(), scope: speechScope, proof: gatewayProof }, returns: v.union(transcriptReceipt, v.null()), handler: async (ctx, { proof, ...args }) => {
  await auth('readTranscript', args, proof); const { session } = await participant(ctx, args.token);
  if (session._id !== args.scope.sessionId || !session.consent?.storage || !session.consent.analysis || !session.consent.microphone) return denied();
  return receipt(ctx, await attemptFor(ctx, args.scope, 'deepgram'));
} });
export const output = query({ args: { token: v.string(), input: v.object({ requestId: v.string(), sessionId: v.id('researchSessions'), sourceId: v.string(), expectedRevision: v.number() }), proof: gatewayProof }, returns: v.object({ sessionId: v.string(), sourceId: v.string(), revision: v.number(), text: v.string() }), handler: async (ctx, { proof, ...args }) => {
  await auth('output', args, proof); const scope = { ...args.input, promptId: args.input.sourceId };
  const { session, question } = await current(ctx, args.token, scope, 'elevenlabs');
  return { sessionId: session._id, sourceId: question.id, revision: session.revision, text: question.question };
} });
async function transportSettlementProof(ctx: QueryCtx, attempt: Doc<'researchSpeechAttempts'>) {
  // A generation fence proves no future native writes, not old worker drainage.
  // Its distinct audit cannot satisfy transcript acceptance/transport settlement.
  if (attempt.transportFence) return null;
  const identity = attempt.transportLease; if (!identity) return null;
  const slot = await ctx.db.get(identity.leaseId); if (!slot) return null;
  // Started slots cannot be reused by expiry. The trusted WS path terminates
  // the provider, observes close, and drains authority work before release ACK.
  // This proves local transport ended; provider outcome/charges stay untouched.
  if (slot.generation > identity.generation || slot.kind === 'voice' && slot.generation === identity.generation && slot.requestId === identity.requestId && slot.owner === identity.owner && !slot.workStarted && slot.expiresAt === 0)
    return { transportLease: identity, observedGeneration: slot.generation };
  return null;
}
async function transportSettled(ctx: QueryCtx, attempt: Doc<'researchSpeechAttempts'>) {
  return !!await transportSettlementProof(ctx, attempt);
}
export const terminalBarrier = query({ args: { token: v.string(), scope: speechScope, provider: v.optional(provider), proof: gatewayProof }, returns: v.object({ state: v.union(v.literal('reserved'), outcome), active: v.boolean(), rawSaved: v.boolean(), transportSettled: v.boolean() }), handler: async (ctx, { proof, ...args }) => {
  await auth('terminalBarrier', args, proof); const { session } = await participant(ctx, args.token);
  if (session._id !== args.scope.sessionId || !session.consent?.storage || !session.consent.analysis || !session.consent.microphone) return denied();
  const attempt = await attemptFor(ctx, args.scope, args.provider ?? 'deepgram');
  return { state: attempt.state, active: attempt.active, rawSaved: !!await receipt(ctx, attempt), transportSettled: await transportSettled(ctx, attempt) };
} });
const spokenReceipt = v.object({ attemptId: v.string(), rawSourceId: v.string(), answerSourceId: v.string(), acceptedRevision: v.number() });
export const commitSpoken = mutation({ args: { token: v.string(), scope: speechScope, proof: gatewayProof }, returns: spokenReceipt, handler: async (ctx, { proof, ...args }) => {
  await auth('commitSpoken', args, proof); const { session } = await participant(ctx, args.token);
  if (session._id !== args.scope.sessionId || !session.consent?.storage || !session.consent.analysis || !session.consent.microphone) return denied();
  const attempt = await attemptFor(ctx, args.scope, 'deepgram');
  unfenced(attempt);
  if (!attempt.grantId || !attempt.rawSourceId) return denied();
  if (attempt.acceptedSourceId !== null) {
    const prior = await ctx.db.query('researchSources').withIndex('by_sessionId_and_sourceId', q => q.eq('sessionId', session._id).eq('sourceId', attempt.acceptedSourceId!)).unique();
    if (!prior || prior.channel !== 'spoken-answer' || prior.supersedes !== attempt.rawSourceId || prior.questionId !== attempt.promptId || attempt.acceptedRevision === undefined) return denied();
    return { attemptId: attempt.requestId, rawSourceId: attempt.rawSourceId, answerSourceId: prior.sourceId, acceptedRevision: attempt.acceptedRevision };
  }
  const m = await current(ctx, args.token, args.scope, 'deepgram'), raw = await receipt(ctx, attempt);
  if (!raw || attempt.state !== 'completed' || attempt.active || !await transportSettled(ctx, attempt) || attempt.consentAt !== m.session.consentAt || attempt.consentEpoch !== m.consentEpoch) throw new ConvexError('Wait for the original voice turn to settle; no replay is authorized');
  const result = await appendParticipantAnswer(ctx, session, m.study, { requestId: `speech-spoken-${attempt.requestId}`, questionId: args.scope.promptId, text: raw.text, channel: 'spoken-answer', supersedes: attempt.rawSourceId });
  await ctx.db.patch(attempt._id, { acceptedSourceId: result.sourceId, acceptedRevision: result.revision });
  return { attemptId: attempt.requestId, rawSourceId: attempt.rawSourceId, answerSourceId: result.sourceId, acceptedRevision: result.revision };
} });
export const settle = mutation({ args: { sessionId: v.id('researchSessions'), requestId: v.string(), provider, outcome, proof: gatewayProof }, returns: v.null(), handler: async (ctx, { proof, ...args }) => {
  await auth('settle', args, proof);
  const attempt = await ctx.db.query('researchSpeechAttempts').withIndex('by_sessionId_and_requestId', q => q.eq('sessionId', args.sessionId).eq('requestId', args.requestId)).unique();
  if (!attempt || attempt.provider !== args.provider) return denied();
  await transportOwner(ctx, attempt);
  if (attempt.state !== 'reserved') return null;
  // Settlement never refunds charged allowance; only confirmed completion or
  // failure before provider dispatch releases provider concurrency.
  await ctx.db.patch(attempt._id, { state: args.outcome, active: args.outcome === 'unknown' || args.outcome === 'interrupted' });
  return null;
} });
