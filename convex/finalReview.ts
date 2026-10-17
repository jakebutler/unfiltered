import { v, ConvexError } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { RESEARCH_LIMITS as L } from '../packages/research-core/src/limits';
import { hashValue } from '../packages/research-core/src/analysis';
import { canonical } from '../packages/research-capture/src/proof';

export const answerChannel = v.union(v.literal('text'), v.literal('confirmed-transcript'), v.literal('spoken-answer'));
export const reviewedAnswer = v.object({ sourceId: v.string(), contentHash: v.string() });
export const finalReviewReceipt = v.object({ answerGeneration: v.number(), manifestHash: v.string(), answers: v.array(reviewedAnswer), reviewedRevision: v.number(), reviewedAt: v.number(), requestId: v.string() });
export const reviewSnapshotView = v.object({ answerGeneration: v.number(), revision: v.number(), manifestHash: v.string(), answers: v.array(v.object({ sourceId: v.string(), questionId: v.string(), question: v.string(), promptSourceId: v.string(), sequence: v.number(), channel: answerChannel, text: v.string(), contentHash: v.string() })), reviewedCurrent: v.boolean() });
export const isAnswerSource = (row: Pick<Doc<'researchSources'>, 'author' | 'channel'>) => row.author === 'participant' && ['text', 'confirmed-transcript', 'spoken-answer'].includes(row.channel);
export const answerContentHash = (row: Pick<Doc<'researchSources'>, 'sourceId' | 'questionId' | 'channel' | 'text' | 'supersedes'>) => hashValue({ sourceId: row.sourceId, questionId: row.questionId, channel: row.channel, text: row.text, supersedes: row.supersedes });
/** Answer-only counter: raw recognition, prompts and pause do not confer review. */
export function answerChanged(session: Doc<'researchSessions'>) {
  const old = session.answerGeneration ?? 0;
  if (!Number.isSafeInteger(old) || old < 0) throw new ConvexError('Answer generation is unavailable');
  return { answerGeneration: old + 1, finalReview: undefined };
}
export async function spokenAnswerReviewed(session: Doc<'researchSessions'>, row: Doc<'researchSources'>) {
  const review = session.finalReview, contentHash = await answerContentHash(row);
  return !!review && review.answerGeneration === (session.answerGeneration ?? 0) && /^[a-f0-9]{64}$/.test(review.manifestHash)
    && review.answers.length <= L.scriptQuestions * 3 && review.answers.some(item => item.sourceId === row.sourceId && item.contentHash === contentHash);
}
/** One bounded session index read. Wording is returned from the same snapshot hashed. */
export async function finalReviewSnapshot(ctx: QueryCtx, session: Doc<'researchSessions'>) {
  const rows = await ctx.db.query('researchSources').withIndex('by_sessionId_and_sequence', q => q.eq('sessionId', session._id)).take(L.sourceCount + 1);
  if (rows.length > L.sourceCount || rows.length !== session.sourceCount) throw new ConvexError('Source snapshot is unavailable');
  const superseded = new Set(rows.map(row => row.supersedes).filter(Boolean));
  const effective = rows.filter(row => isAnswerSource(row) && !superseded.has(row.sourceId));
  if (effective.length > L.scriptQuestions * 3 || new Set(effective.map(row => row.questionId)).size !== effective.length) throw new ConvexError('Answer snapshot is unavailable');
  const byId = new Map(rows.map(row => [row.sourceId, row]));
  if (byId.size !== rows.length || new Set(rows.map(row => row.sequence)).size !== rows.length || rows.some(row => !Number.isSafeInteger(row.sequence) || row.sequence < 0)) throw new ConvexError('Source association is ambiguous');
  const associated = effective.map(row => {
    const prompts = rows.filter(prompt => prompt.author === 'interviewer' && ['script', 'follow-up'].includes(prompt.channel) && prompt.questionId === row.questionId);
    if (prompts.length !== 1 || !prompts[0].text.trim() || prompts[0].text.length > 2000) throw new ConvexError('Question association is unavailable');
    let first = row;
    // A correction inherits its original question position, including a spoken
    // answer's immutable raw predecessor. Only strictly earlier same-question
    // participant ancestors are valid; this also rejects cycles and forks.
    while (first.supersedes) {
      const prior = byId.get(first.supersedes);
      if (!prior || prior.author !== 'participant' || prior.questionId !== row.questionId || prior.sequence >= first.sequence || rows.filter(item => item.supersedes === prior.sourceId).length !== 1) throw new ConvexError('Answer lineage is ambiguous');
      first = prior;
    }
    if (prompts[0].sequence >= first.sequence) throw new ConvexError('Question order is unavailable');
    return { row, prompt: prompts[0] };
  }).sort((a, b) => a.prompt.sequence - b.prompt.sequence);
  const answers = await Promise.all(associated.map(async ({ row, prompt }) => ({ sourceId: row.sourceId, questionId: row.questionId, question: prompt.text, promptSourceId: prompt.sourceId, sequence: row.sequence, channel: row.channel as 'text' | 'confirmed-transcript' | 'spoken-answer', text: row.text, contentHash: await answerContentHash(row) })));
  if (new TextEncoder().encode(canonical(answers)).byteLength > 4 * 1024 * 1024) throw new ConvexError('Answer review exceeds its bounded payload');
  const manifestHash = await hashValue(answers), answerGeneration = session.answerGeneration ?? 0, review = session.finalReview;
  return { answerGeneration, revision: session.revision, manifestHash, answers, reviewedCurrent: !!review && review.answerGeneration === answerGeneration && review.manifestHash === manifestHash };
}
