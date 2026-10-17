import { adaptiveSourceSegments } from './adaptive-source.js';
import type { AdaptiveContext } from './adaptive-validation.js';
import type { ProvisionalCapture } from './provisional-draft.js';
import type { ReplyAdvance } from './adaptive-reply.js';
export interface IssuedReplyAction {
  id: string; topicId: string; promptId: string; targetPaths: readonly string[]; text: string; kind: string;
}
export interface UsefulAdvance {
  action: IssuedReplyAction; nominatedActionId: string;
  rejectedNomination?: 'supplied-uncertainty' | 'supplied-refusal' | 'stopped-topic' | 'supplied-answer' | 'patient-navigation-command';
}
const uncertainty = /\b(?:not sure|uncertain|unsure|don['’]?t know|do not know|can['’]?t recall|cannot recall|can['’]?t remember|cannot remember)\b/i;
const refusal = /\b(?:prefer not|rather not|don['’]?t want to|do not want to|decline|skip this|move on)\b/i;
/** Rejection guard for a known reply-quality failure; it confers no field or
 * readiness credit. General source/control interpretation remains qualified
 * empirically, independently of this finite known-failure control.
 */
export function selectUsefulAdvance(context: AdaptiveContext, advance: ReplyAdvance, actions: readonly IssuedReplyAction[], issuedTargets?: readonly { id: string; topicId: string; path: string }[], navigation?: ProvisionalCapture): UsefulAdvance | undefined {
  const nominated = actions.find(action => action.id === advance.actionId); if (!nominated) return;
  // Quoted model controls/defer are audit proposals, never patient stop authority.
  const navigationTopics = new Set(advance.controls.filter(control => control.kind === 'move-on' && supportsNavigationCommand(context, control)).map(control => control.targetTopicId));
  const supplied = navigation?.claims.filter(claim => claim.status === 'proposed') ?? [];
  const source = context.source.text;
  const clauses = source.split(/[;.!?]|\b(?:but|however)\b/i);
  const reason = (action: IssuedReplyAction): UsefulAdvance['rejectedNomination'] => {
    if (context.responses[action.topicId]?.stopped) return 'stopped-topic';
    if (navigationTopics.has(action.topicId)) return 'patient-navigation-command';
    if (action.targetPaths.some(path => supplied.some(claim => claim.topicId === action.topicId && claim.path === path)
      || navigation?.closures?.some(closure => closure.topicId === action.topicId && closure.collection === path))) return 'supplied-answer';
    if (!issuedTargets && action.topicId === context.displayed?.topicId && refusal.test(source)) return 'supplied-refusal';
    if (!issuedTargets && action.targetPaths.includes('lastMeasuredWeight.representsCurrent') && clauses.some(clause => uncertainty.test(clause) && /\b(?:weight|reading|reflects?)\b/i.test(clause))) return 'supplied-uncertainty';
  };
  const rejectedNomination = reason(nominated); if (!rejectedNomination) return { action: nominated, nominatedActionId: nominated.id };
  // A rejected current-topic nomination can move to another already issued,
  // applicable topic; it never opens a branch or invents prose from the tail.
  const sameTopic = rejectedNomination === 'supplied-answer' ? [...actions].sort((a, b) => a.targetPaths.length - b.targetPaths.length).find(action => action.topicId === nominated.topicId && !reason(action)) : undefined;
  const alternative = sameTopic ?? actions.find(action => action.topicId !== nominated.topicId && !reason(action));
  return alternative ? { action: alternative, nominatedActionId: nominated.id, rejectedNomination } : undefined;
}

/** Deliberately finite command language for navigation only. Complete issued
 * sentences prevent a crop of third-party advice from gaining command authority.
 * Arbitrary paraphrases remain proposals requiring empirical qualification. */
function supportsNavigationCommand(context: AdaptiveContext, control: ReplyAdvance['controls'][number]): boolean {
  if (control.attribution !== 'direct-patient-command' || !control.targetTopicId) return false;
  const clean = (text: string) => text.trim().toLowerCase().replace(/[.!?]+$/, '').replace(/’/g, "'");
  const sentences = adaptiveSourceSegments(context).filter(segment => segment.kind === 'sentence');
  const aliases: Record<string,readonly string[]> = { Q03:['weight'], Q04:['weight','height'], Q08:['medicines','medications'], Q11:['diet','food'], Q15:['sleep'], Q16:['mental health'] };
  return control.evidence.some(address => {
    const sentence = sentences.find(sentence => sentence.id === address.statementId);
    if (!sentence || clean(sentence.text) !== clean(address.quote)) return false;
    const match = /^(?:please )?(?:move on(?: from)?|skip|leave) (.+)$/.exec(clean(address.quote))
      ?? /^i (?:do not|don't|would rather not|prefer not to) (?:discuss|talk about) (.+)$/.exec(clean(address.quote));
    if (!match) return false;
    const topic = match[1].replace(/^(?:the )?(?:topic of )?/, '');
    return topic === control.targetTopicId!.toLowerCase() || (aliases[control.targetTopicId!] ?? []).includes(topic)
      || ['this topic','that topic','current topic'].includes(topic) && control.targetTopicId === context.displayed?.topicId;
  });
}
