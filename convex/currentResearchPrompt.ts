import type { Doc } from './_generated/dataModel';
import { scriptPrompt, type CurrentPrompt } from '../packages/research-core/src/interview';
/** Single prompt authority for participant text, accepted speech and TTS. */
export function currentResearchPrompt(session: Doc<'researchSessions'>, study: Doc<'researchStudies'>, includePending = false): CurrentPrompt | null {
  if (session.pendingInterview && !includePending) return null;
  if (session.currentPrompt !== undefined) return session.currentPrompt;
  const question = study.definition.script[session.nextQuestion];
  return question ? scriptPrompt(question) : null;
}
