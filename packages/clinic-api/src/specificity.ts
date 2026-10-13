/** Answer specificity (SP-0.1) for the clinic session: which recorded answers are still non-specific, which
 * authored follow-up may be asked next, and how a reply to that follow-up settles it. One mechanism for every
 * contracted field; no field-specific code. Patient words are never replaced and nothing is diagnosed. */
import { assessSpecificity, specificityBudget, specificityContracts, specificityQuestion, specificityTerminal, type SpecificityAssessment, type SpecificityContract } from '../../clinic-content/src/specificity.js';
import type { TopicResponse } from '../../clinic-content/src/index.js';
import { lookupReference } from '../../clinic-reference/src/index.js';

export type SpecificityTerminal = keyof typeof specificityTerminal;
/** Per answered field ("Q08:medicines[x].name"): follow-ups asked, and how the patient settled it. */
export interface SpecificityState { asked: number; terminal?: SpecificityTerminal; terminalSourceId?: string; spellingAsked?: boolean; confirmed?: { system: string; code: string; display: string; sourceId: string }; }
export type SpecificityStates = Record<string, SpecificityState>;
/** Marks a displayed prompt as a specificity follow-up; copied into the operation so the reply can settle it. */
export interface SpecificityPromptMark { key: string; spelling?: { system: string; code: string; display: string }; }
export interface SpecificityFinding extends SpecificityAssessment { key: string; topicId: string; path: string; contract: SpecificityContract; value: string; state?: SpecificityState; }

export const specificityKey = (topicId: string, path: string) => `${topicId}:${path}`;
const affirmative = /^\s*(?:yes|yeah|yep|yup|correct|right|that'?s (?:it|right|correct|the one)|exactly|sure|uh[- ]?huh|mm[- ]?hmm)\b/i;

/** Every recorded text answer that has a contract, with its deterministic assessment. */
export function specificityFindings(responses: Readonly<Record<string, TopicResponse | undefined>>, states: SpecificityStates = {}): SpecificityFinding[] {
  const found: SpecificityFinding[] = [];
  const add = (contract: SpecificityContract, path: string, value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const key = specificityKey(contract.topicId, path);
    found.push({ key, topicId: contract.topicId, path, contract, value, state: states[key], ...assessSpecificity(contract, value, lookupReference) });
  };
  for (const contract of specificityContracts) {
    const answers = responses[contract.topicId]?.answers;
    if (!answers) continue;
    // Scalar slot ids may contain a dot ("lastMeasuredWeight.measuredWhen"); otherwise "list.field" is a collection field.
    const scalar = answers[contract.path];
    if (scalar) { if (scalar.state === 'known' && !scalar.items) add(contract, contract.path, scalar.value); continue; }
    const [list, field] = contract.path.split('.');
    if (!field) continue;
    const collection = answers[list!];
    if (collection?.state !== 'known' || !collection.items) continue;
    for (const item of collection.items) { const answer = item.answers[field]; if (answer?.state === 'known') add(contract, `${list}[${item.id}].${field}`, answer.value); }
  }
  return found;
}
/** Still-missing detail: a non-specific answer. A reply like "I don't know" ends the follow-ups but the gap stays visible. */
export const specificityGaps = (findings: readonly SpecificityFinding[]) => findings.filter(finding => finding.level !== 'specific');

/** Authored follow-ups that may be asked now, within the budget. Identity questions are listed first. */
export function specificityProbes(findings: readonly SpecificityFinding[], states: SpecificityStates): { finding: SpecificityFinding; text: string; mark: SpecificityPromptMark }[] {
  const askedByTopic = new Map<string, number>();
  for (const [key, state] of Object.entries(states)) { const topicId = key.slice(0, key.indexOf(':')); askedByTopic.set(topicId, (askedByTopic.get(topicId) ?? 0) + state.asked); }
  const probes = findings.flatMap(finding => {
    const state = states[finding.key];
    if ((askedByTopic.get(finding.topicId) ?? 0) >= specificityBudget.perTopic || state?.terminal) return [];
    if (finding.level !== 'specific') {
      if ((state?.asked ?? 0) >= specificityBudget.perField) return [];
      return [{ finding, text: specificityQuestion(finding.contract, finding.value), mark: { key: finding.key } }];
    }
    // A close spelling is offered once, as a question; the answer stays the patient's either way.
    if (finding.spelling && !state?.spellingAsked && !state?.confirmed) return [{ finding, text: specificityQuestion(finding.contract, finding.value, finding.spelling.display), mark: { key: finding.key, spelling: finding.spelling } }];
    return [];
  });
  return probes.sort((a, b) => Number(b.finding.contract.kind === 'entity') - Number(a.finding.contract.kind === 'entity'));
}

/** Settles the reply to a specificity follow-up that recorded no new value for its field. */
export function settleSpecificityReply(states: SpecificityStates, mark: SpecificityPromptMark, reply: { sourceId: string; text: string; updatedPath: boolean }): SpecificityStates {
  const next = { ...states }, state: SpecificityState = { ...next[mark.key], asked: next[mark.key]?.asked ?? 0 };
  if (mark.spelling) {
    state.spellingAsked = true;
    if (!reply.updatedPath && affirmative.test(reply.text)) state.confirmed = { ...mark.spelling, sourceId: reply.sourceId };
  } else if (!reply.updatedPath) {
    const terminal = (Object.keys(specificityTerminal) as SpecificityTerminal[]).find(kind => specificityTerminal[kind].test(reply.text));
    if (terminal) Object.assign(state, { terminal, terminalSourceId: reply.sourceId });
  }
  next[mark.key] = state;
  return next;
}
export function countSpecificityAsk(states: SpecificityStates, mark: SpecificityPromptMark): SpecificityStates {
  const state: SpecificityState = { ...states[mark.key], asked: states[mark.key]?.asked ?? 0 };
  return { ...states, [mark.key]: mark.spelling ? { ...state, spellingAsked: true } : { ...state, asked: state.asked + 1 } };
}

const terminalText: Record<SpecificityTerminal, string> = { 'will-provide': 'patient will bring or check it', unknown: "patient doesn't know", declined: 'patient preferred not to say' };
/** Staff- and review-facing note for one answered field, or undefined when nothing is missing or attached. */
export function specificityNote(finding: SpecificityFinding): { needsDetail?: string; code?: { system: string; code: string; display: string; basis: 'exact' | 'synonym' | 'patient-confirmed' } } | undefined {
  const confirmed = finding.state?.confirmed;
  const code = finding.match ? { system: finding.match.system, code: finding.match.code, display: finding.match.display, basis: finding.match.kind } : confirmed ? { system: confirmed.system, code: confirmed.code, display: confirmed.display, basis: 'patient-confirmed' as const } : undefined;
  const needsDetail = finding.level !== 'specific' ? `${finding.contract.missing}${finding.state?.terminal ? ` (${terminalText[finding.state.terminal]})` : ''}` : undefined;
  return needsDetail || code ? { ...(needsDetail ? { needsDetail } : {}), ...(code ? { code } : {}) } : undefined;
}
