import { paginationOptsValidator } from 'convex/server';
import { v, ConvexError } from 'convex/values';
import { mutation, query, type MutationCtx } from './_generated/server';
import { pageResult, pageSize, participant, revision } from './access';
import { consent, sessionState, sourcePage } from './validators';
import { boundedText, requestId, RESEARCH_LIMITS as LIMITS } from '../packages/research-core/src/limits';
import type { Doc } from './_generated/dataModel';
import { conversationCaptureTransition } from './capture';

const tokenArg = { token: v.string() };
const changeArgs = { ...tokenArg, expectedRevision: v.number() };
const questionView = v.union(v.object({ id: v.string(), question: v.string() }), v.null());
const receipt = v.object({ sourceId: v.string(), sequence: v.number(), savedAt: v.number(), revision: v.number() });
export const resume = query({ args: tokenArg, returns: v.object({ sessionId: v.id('researchSessions'), title: v.string(), introduction: v.string(), prototypeUrl: v.union(v.string(), v.null()), state: sessionState, revision: v.number(), savedAt: v.number(), retainUntil: v.number(), expiresAt: v.number(), consent: v.union(consent, v.null()), question: questionView, questionNumber: v.number(), questionCount: v.number() }), handler: async (ctx, args) => {
  const { session, study, invite } = await participant(ctx, args.token);
  return { sessionId: session._id, title: study.definition.title, introduction: study.definition.introduction, prototypeUrl: study.definition.prototypeUrl, state: session.state, revision: session.revision, savedAt: session.savedAt, retainUntil: session.retainUntil, expiresAt: invite.expiresAt, consent: session.consent, question: session.consent && !['completed', 'partial'].includes(session.state) ? study.definition.script[session.nextQuestion] ?? null : null, questionNumber: Math.min(session.nextQuestion + 1, study.definition.script.length), questionCount: study.definition.script.length };
} });
async function prompt(ctx: MutationCtx, session: Doc<'researchSessions'>, question: { id: string; question: string }, sequence: number) {
  await ctx.db.insert('researchSources', { sessionId: session._id, clientId: session.clientId, projectId: session.projectId, sequence, sourceId: `${session._id}:${sequence}`, requestId: `script-prompt-${sequence}`, questionId: question.id, author: 'interviewer', channel: 'script', text: question.question, recordedAt: Date.now(), supersedes: null });
}
export const agree = mutation({ args: { ...changeArgs, consent }, returns: v.number(), handler: async (ctx, args) => {
  const { session, study } = await participant(ctx, args.token); revision(session.revision, args.expectedRevision);
  if (session.state !== 'invited' || !args.consent.storage || !args.consent.analysis) throw new ConvexError('Storage and analysis consent are required to begin');
  if ((args.consent.shareAudio && !args.consent.microphone) || (args.consent.shareCamera && !args.consent.camera) || (args.consent.shareScreen && !args.consent.screen)) throw new ConvexError('Sharing requires matching capture consent');
  await prompt(ctx, session, study.definition.script[0], 0);
  await ctx.db.patch(session._id, { consent: args.consent, consentAt: Date.now(), state: 'active', sourceCount: 1, savedAt: Date.now(), revision: session.revision + 1 });
  return session.revision + 1;
} });
export const sources = query({ args: { ...tokenArg, paginationOpts: paginationOptsValidator }, returns: sourcePage, handler: async (ctx, args) => {
  const { session } = await participant(ctx, args.token); pageSize(args.paginationOpts.numItems);
  return pageResult(await ctx.db.query('researchSources').withIndex('by_sessionId_and_sequence', q => q.eq('sessionId', session._id)).paginate(args.paginationOpts));
} });
export const answer = mutation({ args: { ...changeArgs, requestId: v.string(), questionId: v.string(), text: v.string(), channel: v.union(v.literal('text'), v.literal('confirmed-transcript')) }, returns: receipt, handler: async (ctx, args) => {
  const { session, study } = await participant(ctx, args.token); requestId(args.requestId);
  boundedText(args.text, LIMITS.answerCharacters, 'answer'); const text = args.text;
  const prior = await ctx.db.query('researchSources').withIndex('by_sessionId_and_requestId', q => q.eq('sessionId', session._id).eq('requestId', args.requestId)).unique();
  if (prior) {
    if (prior.author !== 'participant' || prior.supersedes !== null || prior.text !== text || prior.questionId !== args.questionId || prior.channel !== args.channel) throw new ConvexError('Request identifier was already used for different content');
    return { sourceId: prior.sourceId, sequence: prior.sequence, savedAt: prior.recordedAt, revision: session.revision };
  }
  revision(session.revision, args.expectedRevision);
  if (session.state !== 'active' || !session.consent || study.definition.script[session.nextQuestion]?.id !== args.questionId || session.sourceCount + 2 > LIMITS.sourceCount) throw new ConvexError('This question is not ready for an answer');
  if (args.channel === 'confirmed-transcript' && !session.consent.microphone) throw new ConvexError('Microphone consent is required');
  const sequence = session.sourceCount, savedAt = Date.now(), sourceId = `${session._id}:${sequence}`;
  await ctx.db.insert('researchSources', { sessionId: session._id, clientId: session.clientId, projectId: session.projectId, sequence, sourceId, requestId: args.requestId, questionId: args.questionId, author: 'participant', channel: args.channel, text, recordedAt: savedAt, supersedes: null });
  const next = study.definition.script[session.nextQuestion + 1];
  if (next) await prompt(ctx, session, next, sequence + 1);
  await ctx.db.patch(session._id, { nextQuestion: session.nextQuestion + 1, sourceCount: sequence + (next ? 2 : 1), savedAt, revision: session.revision + 1 });
  return { sourceId, sequence, savedAt, revision: session.revision + 1 };
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
  if (await ctx.db.query('researchSources').withIndex('by_sessionId_and_supersedes', q => q.eq('sessionId', session._id).eq('supersedes', original.sourceId)).first()) throw new ConvexError('Correct the latest version of this source');
  const sequence = session.sourceCount, savedAt = Date.now(), sourceId = `${session._id}:${sequence}`;
  await ctx.db.insert('researchSources', { sessionId: session._id, clientId: session.clientId, projectId: session.projectId, sequence, sourceId, requestId: args.requestId, questionId: original.questionId, author: 'participant', channel: 'text', text, recordedAt: savedAt, supersedes: original.sourceId });
  await ctx.db.patch(session._id, { sourceCount: sequence + 1, savedAt, revision: session.revision + 1 });
  return { sourceId, sequence, savedAt, revision: session.revision + 1 };
} });
export const transition = mutation({ args: { ...changeArgs, state: v.union(v.literal('active'), v.literal('paused'), v.literal('completed'), v.literal('partial')) }, returns: v.number(), handler: async (ctx, args) => {
  const { session, study } = await participant(ctx, args.token); revision(session.revision, args.expectedRevision);
  if (!session.consent || !['active', 'paused'].includes(session.state)) throw new ConvexError('Session is closed for changes');
  if (args.state === 'completed' && session.nextQuestion !== study.definition.script.length) throw new ConvexError('Choose partial completion when questions remain');
  await conversationCaptureTransition(ctx, session, args.state);
  await ctx.db.patch(session._id, { state: args.state, savedAt: Date.now(), revision: session.revision + 1 }); return session.revision + 1;
} });
