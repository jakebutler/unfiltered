import { welcomeForStudy } from './researchWelcome';
import { welcome } from './researchWelcomeValidators';
import { interviewPolicyForStudy } from './researchReadiness';
import { paginationOptsValidator } from 'convex/server';
import { v, ConvexError } from 'convex/values';
import { mutation, query, type MutationCtx } from './_generated/server';
import { pageResult, pageSize, participant, revision } from './access';
import { consent, sessionState, sourcePage } from './validators';
import { boundedText, requestId, RESEARCH_LIMITS as LIMITS } from '../packages/research-core/src/limits';
import type { Doc } from './_generated/dataModel';
import { conversationCaptureTransition } from './capture';
import { currentResearchPrompt } from './currentResearchPrompt';
import { pendingInterviewView, interviewMaterial, installInterviewDecision } from './researchInterview';
import { pendingView } from './interviewValidators';
import { advanceInterview, scriptPrompt } from '../packages/research-core/src/interview';
import { internal } from './_generated/api';
import { answerChanged, finalReviewSnapshot, reviewSnapshotView } from './finalReview';

const tokenArg = { token: v.string() };
const changeArgs = { ...tokenArg, expectedRevision: v.number() };
const questionView = v.union(v.object({ id: v.string(), question: v.string() }), v.null());
const receipt = v.object({ sourceId: v.string(), sequence: v.number(), savedAt: v.number(), revision: v.number() });
export const resume = query({ args: tokenArg, returns: v.object({ welcome, sessionId: v.id('researchSessions'), title: v.string(), introduction: v.string(), prototypeUrl: v.union(v.string(), v.null()), state: sessionState, revision: v.number(), savedAt: v.number(), retainUntil: v.number(), expiresAt: v.number(), consent: v.union(consent, v.null()), question: questionView, questionNumber: v.number(), questionCount: v.number(), pendingInterview: pendingView }), handler: async (ctx, args) => {
  const { session, study, invite } = await participant(ctx, args.token);
  return { welcome: await welcomeForStudy(ctx, study, { expiresAt: invite.expiresAt, retainUntil: session.retainUntil, ...(session.purpose ? { purpose: session.purpose } : {}) }), sessionId: session._id, title: study.definition.title, introduction: study.definition.introduction, prototypeUrl: study.definition.prototypeUrl, state: session.state, revision: session.revision, savedAt: session.savedAt, retainUntil: session.retainUntil, expiresAt: invite.expiresAt, consent: session.consent, question: session.consent && !['completed', 'partial'].includes(session.state) ? currentResearchPrompt(session, study) ? { id: currentResearchPrompt(session, study)!.id, question: currentResearchPrompt(session, study)!.question } : null : null, questionNumber: Math.min(session.nextQuestion + 1, study.definition.script.length), questionCount: study.definition.script.length, pendingInterview: await pendingInterviewView(ctx, session) };
} });
async function prompt(ctx: MutationCtx, session: Doc<'researchSessions'>, question: { id: string; question: string }, sequence: number) {
  await ctx.db.insert('researchSources', { sessionId: session._id, clientId: session.clientId, projectId: session.projectId, sequence, sourceId: `${session._id}:${sequence}`, requestId: `script-prompt-${sequence}`, questionId: question.id, author: 'interviewer', channel: 'script', text: question.question, recordedAt: Date.now(), supersedes: null });
}
/** Caller proves current prompt/revision/consent before this shared native append. */
export async function appendParticipantAnswer(ctx: MutationCtx, session: Doc<'researchSessions'>, study: Doc<'researchStudies'>, input: { requestId: string; questionId: string; text: string; channel: 'text' | 'confirmed-transcript' | 'spoken-answer'; intent?: 'answer' | 'skip'; supersedes: string | null }) {
  if (session.sourceCount + 2 > LIMITS.sourceCount) throw new ConvexError('Interview source allowance is exhausted');
  const sequence = session.sourceCount, savedAt = Date.now(), sourceId = `${session._id}:${sequence}`;
  await ctx.db.insert('researchSources', { sessionId: session._id, clientId: session.clientId, projectId: session.projectId, sequence, sourceId, requestId: input.requestId, questionId: input.questionId, author: 'participant', channel: input.channel, intent: input.intent ?? 'answer', text: input.text, recordedAt: savedAt, supersedes: input.supersedes });
  if (session.interviewEnabled) {
    await ctx.db.patch(session._id, { ...answerChanged(session), pendingInterview: { sourceId, promptId: input.questionId, requestId: `interview-${sequence}-${session.revision + 1}`, revision: session.revision + 1, intent: input.intent ?? 'answer' }, sourceCount: sequence + 1, savedAt, revision: session.revision + 1 });
  } else {
    const next = study.definition.script[session.nextQuestion + 1];
    if (next) await prompt(ctx, session, next, sequence + 1);
    await ctx.db.patch(session._id, { ...answerChanged(session), nextQuestion: session.nextQuestion + 1, sourceCount: sequence + (next ? 2 : 1), savedAt, revision: session.revision + 1 });
  }
  return { sourceId, sequence, savedAt, revision: session.revision + 1 };
}
export const agree = mutation({ args: { ...changeArgs, consent }, returns: v.number(), handler: async (ctx, args) => {
  const { session, study } = await participant(ctx, args.token); revision(session.revision, args.expectedRevision);
  if (session.state !== 'invited' || !args.consent.storage || !args.consent.analysis) throw new ConvexError('Storage and analysis consent are required to begin');
  if ((args.consent.shareAudio && !args.consent.microphone) || (args.consent.shareCamera && !args.consent.camera) || (args.consent.shareScreen && !args.consent.screen) || (args.consent.shareDom && !args.consent.dom)) throw new ConvexError('Sharing requires matching capture consent');
  let policy = null;
  try { policy = await interviewPolicyForStudy(ctx, session); } catch { /* Scripted consent remains available when scoped model opt-in is OFF. */ }
  const interviewEnabled = session.purpose !== 'readiness-test' && !!policy?.enabled && policy.expiresAt > Date.now();
  await prompt(ctx, session, study.definition.script[0], 0);
  await ctx.db.patch(session._id, { consent: args.consent, consentAt: Date.now(), state: 'active', interviewEnabled, ...(interviewEnabled ? { currentPrompt: scriptPrompt(study.definition.script[0]), followUps: [] } : {}), sourceCount: 1, savedAt: Date.now(), revision: session.revision + 1 });
  return session.revision + 1;
} });
export const sources = query({ args: { ...tokenArg, paginationOpts: paginationOptsValidator }, returns: sourcePage, handler: async (ctx, args) => {
  const { session } = await participant(ctx, args.token); pageSize(args.paginationOpts.numItems);
  return pageResult(await ctx.db.query('researchSources').withIndex('by_sessionId_and_sequence', q => q.eq('sessionId', session._id)).paginate(args.paginationOpts));
} });
export const answer = mutation({ args: { ...changeArgs, requestId: v.string(), questionId: v.string(), text: v.string(), channel: v.union(v.literal('text'), v.literal('confirmed-transcript')), speechAttemptId: v.optional(v.string()), intent: v.optional(v.union(v.literal('answer'), v.literal('skip'))) }, returns: receipt, handler: async (ctx, args) => {
  const { session, study } = await participant(ctx, args.token); requestId(args.requestId);
  boundedText(args.text, LIMITS.answerCharacters, 'answer'); const text = args.text;
  const prior = await ctx.db.query('researchSources').withIndex('by_sessionId_and_requestId', q => q.eq('sessionId', session._id).eq('requestId', args.requestId)).unique();
  if (prior) {
    let rawSourceId: string | null = null;
    if (args.speechAttemptId) {
      const attempt = await ctx.db.query('researchSpeechAttempts').withIndex('by_sessionId_and_requestId', q => q.eq('sessionId', session._id).eq('requestId', args.speechAttemptId!)).unique();
      if (!attempt || attempt.transportFence || attempt.acceptedSourceId !== prior.sourceId) throw new ConvexError('Voice attempt differs from the saved answer');
      rawSourceId = attempt.rawSourceId;
    }
    if (prior.author !== 'participant' || prior.supersedes !== rawSourceId || prior.text !== text || prior.questionId !== args.questionId || prior.channel !== args.channel || (prior.intent ?? 'answer') !== (args.intent ?? 'answer')) throw new ConvexError('Request identifier was already used for different content');
    return { sourceId: prior.sourceId, sequence: prior.sequence, savedAt: prior.recordedAt, revision: session.revision };
  }
  revision(session.revision, args.expectedRevision);
  if (session.state !== 'active' || !session.consent || currentResearchPrompt(session, study)?.id !== args.questionId || session.sourceCount + 2 > LIMITS.sourceCount) throw new ConvexError('This question is not ready for an answer');
  if (args.channel === 'confirmed-transcript' && !session.consent.microphone) throw new ConvexError('Microphone consent is required');
  let voiceAttempt: Doc<'researchSpeechAttempts'> | null = null;
  if (args.speechAttemptId !== undefined) {
    requestId(args.speechAttemptId);
    voiceAttempt = await ctx.db.query('researchSpeechAttempts').withIndex('by_sessionId_and_requestId', q => q.eq('sessionId', session._id).eq('requestId', args.speechAttemptId!)).unique();
    if (args.channel !== 'confirmed-transcript' || !voiceAttempt || voiceAttempt.transportFence || voiceAttempt.provider !== 'deepgram' || voiceAttempt.promptId !== args.questionId || voiceAttempt.expectedRevision !== args.expectedRevision || voiceAttempt.consentAt !== session.consentAt || voiceAttempt.rawSourceId === null || voiceAttempt.acceptedSourceId !== null) throw new ConvexError('Check the original voice transcript before accepting this answer');
    const raw = await ctx.db.query('researchSources').withIndex('by_sessionId_and_sourceId', q => q.eq('sessionId', session._id).eq('sourceId', voiceAttempt!.rawSourceId!)).unique();
    if (!raw || raw.channel !== 'unreviewed-transcript' || raw.questionId !== args.questionId) throw new ConvexError('Original voice transcript is unavailable');
  } else if (args.channel === 'confirmed-transcript') throw new ConvexError('A saved voice transcript is required');
  const result = await appendParticipantAnswer(ctx, session, study, { ...args, text, supersedes: voiceAttempt?.rawSourceId ?? null });
  if (voiceAttempt) await ctx.db.patch(voiceAttempt._id, { acceptedSourceId: result.sourceId, acceptedRevision: result.revision });
  return result;
} });
export const correct = mutation({ args: { ...changeArgs, requestId: v.string(), sourceId: v.string(), text: v.string() }, returns: receipt, handler: async (ctx, args) => {
  const { session } = await participant(ctx, args.token); requestId(args.requestId);
  boundedText(args.text, LIMITS.answerCharacters, 'correction'); const text = args.text;
  const prior = await ctx.db.query('researchSources').withIndex('by_sessionId_and_requestId', q => q.eq('sessionId', session._id).eq('requestId', args.requestId)).unique();
  if (prior) {
    if (prior.supersedes !== args.sourceId || prior.text !== text) throw new ConvexError('Request identifier was already used for different content');
    return { sourceId: prior.sourceId, sequence: prior.sequence, savedAt: prior.recordedAt, revision: session.revision };
  }
  revision(session.revision, args.expectedRevision);
  if (!['active', 'paused'].includes(session.state) || !session.consent || session.sourceCount >= LIMITS.sourceCount) throw new ConvexError('Session is closed for changes');
  const original = await ctx.db.query('researchSources').withIndex('by_sessionId_and_sourceId', q => q.eq('sessionId', session._id).eq('sourceId', args.sourceId)).unique();
  if (!original || original.author !== 'participant') throw new ConvexError('Source unavailable');
  if (original.channel === 'unreviewed-transcript') throw new ConvexError('Review the original transcript in the current answer before continuing');
  if (await ctx.db.query('researchSources').withIndex('by_sessionId_and_supersedes', q => q.eq('sessionId', session._id).eq('supersedes', original.sourceId)).first()) throw new ConvexError('Correct the latest version of this source');
  const sequence = session.sourceCount, savedAt = Date.now(), sourceId = `${session._id}:${sequence}`;
  await ctx.db.insert('researchSources', { sessionId: session._id, clientId: session.clientId, projectId: session.projectId, sequence, sourceId, requestId: args.requestId, questionId: original.questionId, author: 'participant', channel: 'text', text, recordedAt: savedAt, supersedes: original.sourceId });
  await ctx.db.patch(session._id, { ...answerChanged(session), sourceCount: sequence + 1, savedAt, revision: session.revision + 1 });
  await ctx.scheduler.runAfter(0, internal.researchReportLifecycle.invalidateSession, { sessionId: session._id, cursor: null });
  return { sourceId, sequence, savedAt, revision: session.revision + 1 };
} });
export const transition = mutation({ args: { ...changeArgs, state: v.union(v.literal('active'), v.literal('paused'), v.literal('completed'), v.literal('partial')) }, returns: v.number(), handler: async (ctx, args) => {
  const { session, study } = await participant(ctx, args.token); revision(session.revision, args.expectedRevision);
  if (!session.consent || !['active', 'paused'].includes(session.state)) throw new ConvexError('Session is closed for changes');
  if (args.state === 'completed' && session.nextQuestion !== study.definition.script.length) throw new ConvexError('Choose partial completion when questions remain');
  if (args.state === 'completed') {
    const snapshot = await finalReviewSnapshot(ctx, session);
    if (snapshot.answers.some(row => row.channel === 'spoken-answer') && !snapshot.reviewedCurrent) throw new ConvexError('Review the current spoken answer wording before completing, or leave without confirming');
  }
  await conversationCaptureTransition(ctx, session, args.state);
  await ctx.db.patch(session._id, { state: args.state, savedAt: Date.now(), revision: session.revision + 1 }); return session.revision + 1;
} });

export const reviewSnapshot = query({ args: tokenArg, returns: reviewSnapshotView, handler: async (ctx, args) => {
  const { session } = await participant(ctx, args.token);
  if (!session.consent?.storage || !session.consent.analysis) throw new ConvexError('Review is unavailable');
  return finalReviewSnapshot(ctx, session);
} });
export const confirmFinalReview = mutation({ args: { ...changeArgs, requestId: v.string(), answerGeneration: v.number(), manifestHash: v.string() }, returns: v.object({ reviewedAt: v.number(), answerGeneration: v.number(), manifestHash: v.string(), revision: v.number() }), handler: async (ctx, args) => {
  requestId(args.requestId); const { session } = await participant(ctx, args.token), old = session.finalReview;
  if (old?.requestId === args.requestId) {
    if (old.answerGeneration !== (session.answerGeneration ?? 0) || old.answerGeneration !== args.answerGeneration || old.manifestHash !== args.manifestHash || old.reviewedRevision !== args.expectedRevision + 1) throw new ConvexError('The reviewed wording changed');
    return { reviewedAt: old.reviewedAt, answerGeneration: old.answerGeneration, manifestHash: old.manifestHash, revision: old.reviewedRevision };
  }
  revision(session.revision, args.expectedRevision);
  if (!['active', 'paused'].includes(session.state) || session.pendingInterview || !session.consent?.storage || !session.consent.analysis) throw new ConvexError('Finish or recover the pending question before reviewing');
  const snapshot = await finalReviewSnapshot(ctx, session);
  if (!Number.isSafeInteger(args.answerGeneration) || snapshot.answerGeneration !== args.answerGeneration || snapshot.manifestHash !== args.manifestHash) throw new ConvexError('The reviewed wording changed');
  const reviewedAt = Date.now(), changed = session.revision + 1;
  await ctx.db.patch(session._id, { finalReview: { answerGeneration: snapshot.answerGeneration, manifestHash: snapshot.manifestHash, answers: snapshot.answers.map(({ sourceId, contentHash }) => ({ sourceId, contentHash })), reviewedRevision: changed, reviewedAt, requestId: args.requestId }, revision: changed, savedAt: reviewedAt });
  return { reviewedAt, answerGeneration: snapshot.answerGeneration, manifestHash: snapshot.manifestHash, revision: changed };
} });

/** Explicit no-model recovery. Unknown call charge survives this prompt transition. */
export const continueScript = mutation({ args: { ...changeArgs, requestId: v.string(), answerSourceId: v.string(), promptId: v.string() }, returns: v.number(), handler: async (ctx, args) => {
  requestId(args.requestId); const { session } = await participant(ctx, args.token), old = session.lastInterviewRecovery;
  if (old?.requestId === args.requestId) { if (old.answerSourceId !== args.answerSourceId || old.promptId !== args.promptId || old.expectedRevision !== args.expectedRevision) throw new ConvexError('Recovery request differs'); return old.revision; }
  const m = await interviewMaterial(ctx, args.token, { sessionId: session._id, requestId: args.requestId, expectedRevision: args.expectedRevision, answerSourceId: args.answerSourceId, promptId: args.promptId });
  const changed = await installInterviewDecision(ctx, m, advanceInterview(m.context, 'recovery'));
  await ctx.db.patch(session._id, { lastInterviewRecovery: { requestId: args.requestId, answerSourceId: args.answerSourceId, promptId: args.promptId, expectedRevision: args.expectedRevision, revision: changed } });
  return changed;
} });
