import { boundedText, RESEARCH_LIMITS as L } from './limits';

export type CurrentPrompt = { id: string; scriptQuestionId: string; kind: 'script' | 'follow-up'; question: string; followUpNumber: 0 | 1 | 2 };
export type InterviewAnswer = { sourceId: string; promptId: string; text: string; channel: 'text' | 'confirmed-transcript' | 'spoken-answer'; intent: 'answer' | 'skip' };
/** Supplied by current native authority, never reconstructed from browser state. */
export type InterviewContext = {
  sessionId: string; revision: number; consentEpoch: number; retainUntil: number;
  goals: string[]; script: { id: string; question: string }[]; scriptIndex: number;
  currentPrompt: CurrentPrompt; followUps: string[]; answer: InterviewAnswer;
};
export type InterviewProposal = { decision: 'advance' } | { decision: 'follow-up'; question: string; goalIndex: number; sourceId: string; quote: string };
export type InterviewDecision = {
  kind: 'advance'; reason: 'skip' | 'resistance' | 'follow-up-limit' | 'disabled' | 'no-probe' | 'recovery';
  scriptIndex: number; prompt: CurrentPrompt | null;
} | { kind: 'follow-up'; scriptIndex: number; prompt: CurrentPrompt; goalIndex: number; evidence: { sourceId: string; quote: string } };
export class InterviewError extends Error { constructor(readonly code: string) { super(code); this.name = 'InterviewError'; } }
const bad = (code: string): never => { throw new InterviewError(code); };
const normalize = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();
export function scriptPrompt(question: { id: string; question: string }): CurrentPrompt {
  return { ...question, scriptQuestionId: question.id, kind: 'script', followUpNumber: 0 };
}
export function validateInterviewContext(context: InterviewContext): void {
  const c = context, q = c.script[c.scriptIndex];
  if (!c.sessionId || !Number.isSafeInteger(c.revision) || c.revision < 0 || !Number.isSafeInteger(c.consentEpoch) || c.consentEpoch < 0 || !Number.isSafeInteger(c.retainUntil)
    || c.goals.length < 1 || c.goals.length > L.goals || c.script.length < 1 || c.script.length > L.scriptQuestions || new Set(c.script.map(q => q.id)).size !== c.script.length
    || !Number.isSafeInteger(c.scriptIndex) || c.scriptIndex < 0 || !q || !c.currentPrompt.id || c.currentPrompt.id.length > 160 || c.currentPrompt.scriptQuestionId !== q.id
    || ![0, 1, 2].includes(c.currentPrompt.followUpNumber) || c.followUps.length !== c.currentPrompt.followUpNumber || c.answer.promptId !== c.currentPrompt.id || !c.answer.sourceId
    || !['text', 'confirmed-transcript', 'spoken-answer'].includes(c.answer.channel) || !['answer', 'skip'].includes(c.answer.intent)) bad('invalid-interview-context');
  c.goals.forEach(g => boundedText(g, 500, 'goal'));
  c.script.forEach(q => { boundedText(q.id, 80, 'script identifier'); boundedText(q.question, 2000, 'script question'); });
  boundedText(c.currentPrompt.question, 2000, 'current prompt'); c.followUps.forEach(q => boundedText(q, 280, 'follow-up'));
  if (c.answer.intent === 'answer') boundedText(c.answer.text, L.answerCharacters, 'answer');
  else if (c.answer.text.length > L.answerCharacters || /\u0000/.test(c.answer.text)) bad('invalid-skip-text');
  if (c.currentPrompt.followUpNumber === 0 ? c.currentPrompt.kind !== 'script' || c.currentPrompt.id !== q.id || c.currentPrompt.question !== q.question
    : c.currentPrompt.kind !== 'follow-up' || c.currentPrompt.question !== c.followUps.at(-1) || c.script.some(q => q.id === c.currentPrompt.id)) bad('invalid-current-prompt');
}
/** Only explicit resistance; concise answers and uncertainty are not refusal. */
export function interviewStopReason(context: InterviewContext): 'skip' | 'resistance' | 'follow-up-limit' | null {
  validateInterviewContext(context);
  if (context.answer.intent === 'skip') return 'skip';
  const text = normalize(context.answer.text).replace(/[’]/g, "'");
  if (/^(?:(?:please )?skip(?: this(?: question| topic)?)?|(?:please |let's )?move on|i (?:don't|do not|would rather not|prefer not to|don't want to) (?:answer|discuss|talk about)(?: this| that)?|i'd rather not (?:answer|discuss)(?: this)?|i(?:'m| am) not comfortable (?:answering|discussing|sharing)(?: this| that)?|no more questions(?: about this)?)(?:[.!?,]| because\b|$)/.test(text)) return 'resistance';
  return context.currentPrompt.followUpNumber === 2 ? 'follow-up-limit' : null;
}
export function advanceInterview(context: InterviewContext, reason: Extract<InterviewDecision, { kind: 'advance' }>['reason']): InterviewDecision {
  validateInterviewContext(context);
  const scriptIndex = context.scriptIndex + 1;
  return { kind: 'advance', reason, scriptIndex, prompt: context.script[scriptIndex] ? scriptPrompt(context.script[scriptIndex]) : null };
}
export function decideInterview(context: InterviewContext, raw: unknown, nextPromptId: string): InterviewDecision {
  const stopped = interviewStopReason(context); if (stopped) return advanceInterview(context, stopped);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('invalid-interview-proposal');
  const p = raw as Record<string, unknown>;
  if (p.decision === 'advance' && Object.keys(p).length === 1) return advanceInterview(context, 'no-probe');
  if (p.decision !== 'follow-up' || Object.keys(p).sort().join(',') !== 'decision,goalIndex,question,quote,sourceId'
    || typeof p.question !== 'string' || typeof p.quote !== 'string' || typeof p.sourceId !== 'string' || !Number.isSafeInteger(p.goalIndex) || (p.goalIndex as number) < 0 || (p.goalIndex as number) >= context.goals.length) bad('invalid-interview-proposal');
  const question = boundedText(p.question as string, 280, 'follow-up'), quote = boundedText(p.quote as string, 800, 'follow-up quote');
  const text = context.answer.text, offset = text.indexOf(quote);
  if (p.sourceId !== context.answer.sourceId || offset < 0 || text.indexOf(quote, offset + 1) >= 0) bad('unbound-follow-up-evidence');
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(nextPromptId) || context.script.some(q => q.id === nextPromptId) || nextPromptId === context.currentPrompt.id) bad('invalid-follow-up-identifier');
  if (/\b(?:password|passcode|one[- ]time (?:password|code)|otp|verification code|security code|cvv|cvc|credit card (?:number|details)|debit card (?:number|details)|card number|bank account number|routing number|api key|access token|private key|seed phrase|recovery phrase)\b|\b(?:enter|share|provide|tell|give|type|send)\b.{0,40}\bpin\b/i.test(question)) bad('credential-solicitation-denied');
  if (!question.endsWith('?') || /[\r\n]/.test(question) || [...context.script.map(q => q.question), ...context.followUps].some(q => normalize(q) === normalize(question))) bad('repeated-or-invalid-follow-up');
  if (/\b(?:you (?:are|seem|look|sound|feel) (?:confused|anxious|depressed|dishonest)|your (?:emotion|diagnosis|personality))\b|\bdiagnos\w*\b/i.test(question)) bad('unsupported-participant-inference');
  return { kind: 'follow-up', scriptIndex: context.scriptIndex, prompt: { id: nextPromptId, scriptQuestionId: context.currentPrompt.scriptQuestionId, kind: 'follow-up', question, followUpNumber: (context.currentPrompt.followUpNumber + 1) as 1 | 2 }, goalIndex: p.goalIndex as number, evidence: { sourceId: p.sourceId as string, quote } };
}
