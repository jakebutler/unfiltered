import { z } from 'zod';
import { addCollectionItem, applyGuidedAnswer, diabetesBranchApplicability, evaluateSlots, finishCollection, guidedFieldForPath, type EvidenceContext, type ScenarioId, type SlotAnswer, type SlotAnswers, type SlotDefinition, type TopicDefinition, type TopicResponse } from '../../clinic-content/src/index.js';
import { canonicalJson } from '../../clinical-core/src/domain.js';
import { escalation } from './safety.js';

export class AdaptiveError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'AdaptiveError'; }
}
export interface AdaptiveSource { id: string; role: 'patient' | 'assistant'; text: string; at: string; channel?: 'text' | 'confirmed-transcript' | 'unreviewed-transcript'; }
export interface AdaptiveBinding {
  operationId: string; sessionId: string; patient: string; scenario: ScenarioId;
  revision: number; contentVersion: string; snapshotDigest: string;
}
export interface DisplayedPrompt {
  topicId: string; promptId: string; targetPaths: readonly string[];
  /** Exact scoped copy has its own proposed wording provenance; clinical requirements are unchanged. */
  wording?: { version: 'S2.scoped.2'; status: 'proposed-detail'; sourcePromptId: string };
}
export interface DialogueState {
  activeTopicId?: string; suspended?: DisplayedPrompt;
  lastUnsuccessful?: { topicId: string; targetPaths: readonly string[]; sourceId: string; count: number; purposeExplained?: boolean };
}
export interface AdaptiveContext {
  /** Trusted server data. Binding and patient/session identity must never enter the provider prompt. */
  binding: AdaptiveBinding;
  source: AdaptiveSource;
  sources: readonly AdaptiveSource[];
  topics: readonly TopicDefinition[];
  responses: Readonly<Record<string, TopicResponse | undefined>>;
  /** Full provisional route: direct state binds queued admission while a
   * predecessor may settle metadata. Never sent as provider authority. */
  directResponses?: Readonly<Record<string, TopicResponse | undefined>>;
  /** Proposed display values permit existing-item corrections without earning
   * branch/readiness/navigation authority. */
  provisionalClaims?: readonly import('./provisional-draft.js').ProvisionalClaim[];
  captureResponses?: Readonly<Record<string, TopicResponse | undefined>>;
  displayed?: DisplayedPrompt;
  dialogue?: DialogueState;
  safetyPaused?: boolean;
  /** Server-selected prototype evidence profile, never a provider/client flag. */
  sourceQuoteProtocol?: 'unique-anchor-v1';
  displayedText?: string;
  nativeRouting?: Partial<import('../../clinic-content/src/native-questionnaire.js').NativePromptAuthority>;
  /** Explicitly selected local content/verified context; never model-authored replies. */
  approvedReplies?: readonly { id: string; text: string; purpose: string }[];
}

const spanSchema = z.object({ sourceId: z.string().min(1).max(160), start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict();
const spansSchema = z.array(spanSchema).min(1).max(4);
const pathSchema = z.string().min(1).max(300);
const factSchema = z.object({
  topicId: z.string().min(1).max(40), path: pathSchema,
  state: z.enum(['known', 'negative', 'unknown', 'declined', 'uncertain', 'not-applicable']),
  evidence: spansSchema,
  transform: z.enum(['verbatim', 'explicit-number', 'explicit-unit', 'explicit-choice', 'explicit-height', 'scoped-response']),
  correctsSourceIds: z.array(z.string().min(1).max(160)).min(1).max(8).optional(),
}).strict();
const itemFieldSchema = factSchema.omit({ topicId: true, correctsSourceIds: true });
const proposalObjectSchema = z.object({
  schema: z.literal(1),
  facts: z.array(factSchema).max(32),
  newItems: z.array(z.object({ topicId: z.string().min(1).max(40), collection: pathSchema, key: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), fields: z.array(itemFieldSchema).min(1).max(12) }).strict()).max(8),
  completedLists: z.array(z.object({ topicId: z.string().min(1).max(40), path: pathSchema, evidence: spansSchema }).strict()).max(8),
  acts: z.array(z.object({ kind: z.enum(['answer', 'question', 'correction', 'move-on', 'topic-switch', 'unclear']), evidence: spansSchema, targetTopicId: z.string().min(1).max(40).optional(), replyId: z.string().min(1).max(120).optional() }).strict()).max(4),
  unmapped: z.array(z.object({ evidence: spansSchema, reason: z.enum(['ambiguous', 'unsupported-target', 'capacity']) }).strict()).max(8).optional(),
  next: z.object({ topicId: z.string().min(1).max(40), promptId: z.string().min(1).max(120), targetPaths: z.array(pathSchema).min(1).max(12) }).strict().optional(),
}).strict();
export const adaptiveProposalSchema = proposalObjectSchema.superRefine((value, ctx) => {
  if (value.facts.length + value.newItems.reduce((n, item) => n + item.fields.length, 0) > 32) ctx.addIssue({ code: 'custom', message: 'candidate-limit' });
});
const valueFactSchema = factSchema.extend({ valueEvidence: spanSchema.nullable() });
const valueItemFieldSchema = valueFactSchema.omit({ topicId: true, correctsSourceIds: true });
/** V5 canonical boundary. Schema 1 never accepts these additional keys. */
export const adaptiveValueProposalSchema = proposalObjectSchema.extend({
  schema: z.literal(2),
  facts: z.array(valueFactSchema).max(32),
  newItems: z.array(z.object({ topicId: z.string().min(1).max(40), collection: pathSchema, key: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), fields: z.array(valueItemFieldSchema).min(1).max(12) }).strict()).max(8),
}).superRefine((value, ctx) => {
  const fields = [...value.facts, ...value.newItems.flatMap(item => item.fields)];
  if (fields.length > 32) ctx.addIssue({ code: 'custom', message: 'candidate-limit' });
  for (const field of fields) if ((field.state === 'known') !== (field.valueEvidence !== null)) ctx.addIssue({ code: 'custom', message: 'value-state-mismatch' });
});
export type AdaptiveValueProposal = z.infer<typeof adaptiveValueProposalSchema>;
export type AdaptiveProposal = z.infer<typeof adaptiveProposalSchema>;
export type EvidenceSpan = z.infer<typeof spanSchema>;
export type AdaptiveFact = z.infer<typeof factSchema>;
export type ValidatedAct = AdaptiveProposal['acts'][number];
export interface AdaptiveUpdate { topicId: string; path: string; answer: SlotAnswer; }
export interface AdaptiveProvenance {
  topicId: string; path: string; evidence: EvidenceSpan[]; transform: string; sourceText: string[];
  /** V5 audit context only. Never consumed as accepted semantic/value coverage. */
  supportEvidence?: EvidenceSpan[];
  supportSourceText?: string[];
  valueEvidence?: EvidenceSpan;
  evidenceProtocol?: 'contextual-values-v5';
  correctsSourceIds?: string[];
  /** An equivalent content target, derived only from already accepted evidence, not a new patient assertion. */
  derivedFrom?: { version: 'evidence-coverage-v1'; kind: 'fact' | 'question'; topicId?: string; path?: string; paths?: string[] };
}
export interface AdaptiveClarification {
  topicId: string; path: string; reason: 'ambiguous-value' | 'unscoped-response' | 'conflict' | 'condition-unresolved' | 'stopped-topic';
  evidence: EvidenceSpan[];
  previous?: SlotAnswer;
  proposed?: SlotAnswer;
}
export interface AdaptiveOutcome {
  responses: Record<string, TopicResponse | undefined>;
  updates: AdaptiveUpdate[];
  provenance: AdaptiveProvenance[];
  clarifications: AdaptiveClarification[];
  /** Rejected candidates whose meaning is already covered; retained for audit, not patient re-questioning. */
  coveredCandidates?: (AdaptiveClarification & { coverage: { kind: 'collection-item' | 'question'; evidence: EvidenceSpan[] } })[];
  acts: ValidatedAct[];
  nomination?: AdaptiveProposal['next'];
  /** Questions found in the source but omitted from the proposal, retained for human review. */
  unresolvedQuestions?: EvidenceSpan[];
  /** Machine abstention, not a patient answer state; retained with exact original evidence. */
  unmapped?: AdaptiveProposal['unmapped'];
  sourceId: string;
  /** Empty/failed interpretation is not a fully mapped patient statement. */
  hasUnresolvedInterpretation: boolean;
  /** intake-interpreter-v1 only: model candidates rejected by server checks (audit, never patient re-questioning). */
  rejectedCandidates?: AdaptiveRejectedCandidate[];
  /** intake-interpreter-v1 only: guarded neutral acknowledgement, shown before the next authored question. */
  acknowledgement?: string;
}
export interface AdaptiveRejectedCandidate {
  protocol: 'intake-interpreter-v1';
  kind: 'fact' | 'item' | 'list-done' | 'question' | 'move-on';
  reason: string;
  topicId?: string; path?: string; state?: string;
  /** Present only when the cited words were found in the patient source. */
  evidence?: EvidenceSpan[];
  /** Bounded copy of an unlocatable model quote, for audit only. */
  quote?: string;
}
declare const validatedBrand: unique symbol;
export interface ValidatedAdaptiveTurn { readonly [validatedBrand]: true; readonly binding: AdaptiveBinding; readonly sourceId: string; }
const validatedResults = new WeakMap<ValidatedAdaptiveTurn, { fingerprint: string; outcome: AdaptiveOutcome }>();
const emptyResponse = (): TopicResponse => ({ presented: false, answers: {} });
const signature = (context: AdaptiveContext) => canonicalJson(context);
const sameAnswer = (a: SlotAnswer, b: SlotAnswer) => canonicalJson({ ...a, sourceIds: [] }) === canonicalJson({ ...b, sourceIds: [] });
const normalize = (text: string) => text.trim().toLowerCase().replace(/[’]/g, "'").replace(/[.!?]+$/, '').trim();
const uncertainty = /\b(maybe|might|may have|possibly|not sure|unsure|uncertain|think|suspect|don't know|do not know|cannot tell|can't tell|no diagnosis yet)\b/i;
const negation = /\b(no|not|never|none|without|don't|do not|haven't|have not)\b/i;

/** Resolve only content-owned scalar paths and existing collection item IDs. */
export function adaptiveSlot(topic: TopicDefinition, response: TopicResponse, path: string): { definition: SlotDefinition; answer?: SlotAnswer; siblings: SlotAnswers; definitions: readonly SlotDefinition[] } {
  function resolve(definitions: readonly SlotDefinition[], answers: SlotAnswers, rest: string): ReturnType<typeof adaptiveSlot> {
    const exact = definitions.find(slot => slot.id === rest);
    if (exact) return { definition: exact, answer: answers[exact.id], siblings: answers, definitions };
    for (const slot of definitions) {
      if (slot.kind !== 'collection' || !rest.startsWith(`${slot.id}[`)) continue;
      const match = /^\[([A-Za-z0-9_-]+)\]\.(.+)$/.exec(rest.slice(slot.id.length));
      const collection = answers[slot.id];
      const item = match && collection?.state === 'known' && collection.items?.find(entry => entry.id === match[1]);
      if (match && item) return resolve(slot.fields ?? [], item.answers, match[2]);
    }
    throw new AdaptiveError('unknown-slot-path');
  }
  return resolve(topic.slots, response.answers, path);
}

function verifyContext(context: AdaptiveContext) {
  if (context.source.role !== 'patient' || !/^[A-Za-z0-9_-]{1,64}$/.test(context.source.id) || !context.source.text.trim() || context.source.text.length > 8000 || !Number.isFinite(Date.parse(context.source.at))) throw new AdaptiveError('invalid-adaptive-source');
  const found = context.sources.filter(source => source.id === context.source.id);
  if (found.length !== 1 || canonicalJson(found[0]) !== canonicalJson(context.source) || new Set(context.sources.map(source => source.id)).size !== context.sources.length) throw new AdaptiveError('invalid-adaptive-source');
  if (new Set(context.topics.map(topic => topic.id)).size !== context.topics.length || !context.binding.snapshotDigest || !context.binding.contentVersion || !Number.isInteger(context.binding.revision) || context.binding.revision < 0) throw new AdaptiveError('invalid-adaptive-context');
}

function quotes(context: AdaptiveContext, spans: readonly EvidenceSpan[]): string[] {
  return spans.map(span => {
    // New facts must be grounded in this accepted patient turn. Prior facts are trusted context, not new patient answers.
    if (span.sourceId !== context.source.id || span.start >= span.end || span.end > context.source.text.length) throw new AdaptiveError('invalid-source-span');
    const text = context.source.text.slice(span.start, span.end);
    if (!text.trim()) throw new AdaptiveError('invalid-source-span');
    // Do not split UTF-16 surrogate pairs, even though offsets use ordinary JavaScript string indexing.
    const split = (offset: number) => offset > 0 && offset < context.source.text.length && /[\uD800-\uDBFF]/.test(context.source.text[offset - 1]) && /[\uDC00-\uDFFF]/.test(context.source.text[offset]);
    if (split(span.start) || split(span.end)) throw new AdaptiveError('invalid-source-span');
    return text;
  });
}

const smallNumbers: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11 };
export function parseExplicitHeight(text: string): { feet: number; inches: number } | undefined {
  const match = /^(\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven)\s*(?:feet|foot|ft\.?|')\s*(\d+(?:\.\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven)\s*(?:inches|inch|in\.?|")$/i.exec(text.trim());
  if (!match) return;
  const number = (value: string) => smallNumbers[value.toLowerCase()] ?? Number(value);
  const feet = number(match[1]), inches = number(match[2]);
  return Number.isSafeInteger(feet) && feet >= 0 && Number.isFinite(inches) && inches >= 0 && inches < 12 && feet * 12 + inches > 0 ? { feet, inches } : undefined;
}

const unitAliases: Record<string, string> = { pound: 'lb', pounds: 'lb', lb: 'lb', lbs: 'lb', kilogram: 'kg', kilograms: 'kg', kg: 'kg', stone: 'st', stones: 'st', st: 'st', centimetre: 'cm', centimetres: 'cm', centimeter: 'cm', centimeters: 'cm', cm: 'cm', metre: 'm', metres: 'm', meter: 'm', meters: 'm', m: 'm', inch: 'in', inches: 'in', in: 'in', foot: 'ft', feet: 'ft', ft: 'ft', 'ft-in': 'ft-in' };
function scoped(context: AdaptiveContext, fact: AdaptiveFact) {
  return context.displayed?.topicId === fact.topicId && context.displayed.targetPaths.includes(fact.path);
}
function singleScoped(context: AdaptiveContext, fact: AdaptiveFact) {
  return scoped(context, fact) && context.displayed!.targetPaths.length === 1;
}
const conditionNames: Record<string, RegExp> = {
    diabetes: /\bdiabetes\b/i, prediabetes: /\bpre[- ]?diabetes\b/i, bloodPressure: /\bhigh blood pressure|hypertension\b/i,
    cholesterol: /\bhigh cholesterol\b/i, heartDisease: /\bheart disease\b/i, stroke: /\bstroke\b/i,
    sleepApnea: /\bsleep apn[oe]+a\b/i, liver: /\bliver\b/i, kidney: /\bkidney\b/i, joint: /\barthritis|joint\b/i,
    thyroidHormone: /\bthyroid|hormone\b/i, digestive: /\bdigestive\b/i,
};
function explicitConditionMention(path: string, text: string) {
  if (path === 'conditions.diabetes') text = text.replace(/\bpre[- ]?diabetes\b/gi, '');
  return conditionNames[path.replace('conditions.', '')]?.test(text) ?? false;
}

interface TextRegion { start: number; end: number; text: string; }
function regions(text: string, clauses = false): TextRegion[] {
  const delimiter = clauses ? /[;,\n]|[.!?](?=\s|$)|\bbut\b/gi : /[\n]|[.!?](?=\s|$)/g;
  const result: TextRegion[] = []; let start = 0;
  for (const match of text.matchAll(delimiter)) {
    const end = match.index! + match[0].length;
    result.push({ start, end, text: text.slice(start, end) }); start = end;
  }
  if (start < text.length) result.push({ start, end: text.length, text: text.slice(start) });
  return result;
}
function around(text: string, position: number, clauses = false): TextRegion {
  return regions(text, clauses).find(region => region.start <= position && region.end > position) ?? { start: 0, end: text.length, text };
}
const otherSubject = /\b(my|our)\s+(mother|father|mom|dad|parent|sister|brother|wife|husband|partner|child|son|daughter|grandmother|grandfather|friend)\b|\b(she|he|they)\s+(has|have|was|is|takes?)\b/i;
const hypothetical = /\b(if|suppose|supposing|hypothetical|whether)\b/i;
const isQuestion = (text: string) => text.includes('?') || /^\s*(?:should|could|would|can|do|does|did|am|is|are|what|why|how|when|where|which)\b/i.test(text);
function conditionContext(context: AdaptiveContext, fact: AdaptiveFact): { clause: string; sentence: string } | undefined {
  // Locate the named condition in the cited source, then inspect its complete surrounding clause.
  for (const span of fact.evidence) {
    const quote = context.source.text.slice(span.start, span.end);
    const searchable = fact.path === 'conditions.diabetes' ? quote.replace(/\bpre[- ]?diabetes\b/gi, text => ' '.repeat(text.length)) : quote;
    const match = conditionNames[fact.path.replace('conditions.', '')]?.exec(searchable);
    if (match) return { clause: around(context.source.text, span.start + match.index, true).text, sentence: around(context.source.text, span.start + match.index).text };
  }
  if (singleScoped(context, fact) || fact.state === 'negative' && scoped(context, fact) && /^(no|none|none that i know of|none known)$/.test(normalize(fact.evidence.map(span => context.source.text.slice(span.start, span.end)).join(' ')))) return { clause: around(context.source.text, fact.evidence[0].start, true).text, sentence: around(context.source.text, fact.evidence[0].start).text };
}
function normalizedContextAllowed(context: AdaptiveContext, fact: AdaptiveFact): boolean {
  if (fact.path.startsWith('conditions.')) {
    const local = conditionContext(context, fact);
    if (!local || isQuestion(local.sentence) || hypothetical.test(local.sentence) || otherSubject.test(local.sentence)) return false;
    if (fact.state === 'known') return !negation.test(local.clause) && !uncertainty.test(local.sentence);
    if (fact.state === 'negative') return negation.test(local.clause) && !uncertainty.test(local.sentence);
    return true;
  }
  if (fact.state !== 'known' || fact.transform === 'verbatim') return true;
  return fact.evidence.every(span => {
    let clause = around(context.source.text, span.start, true).text;
    const sentence = around(context.source.text, span.start).text;
    // An explicitly unavailable date does not negate a separately supplied measurement value/unit.
    // This bounded coordination rule removes only that date predicate, never value/unit uncertainty.
    if (/\.(?:value|unit)$/.test(fact.path)) clause = clause.replace(/\band\s+(?:i\s+)?(?:don't|do not|can't|cannot)\s+(?:know|remember|recall)\s+(?:the\s+)?(?:date|day|month|year|when it was (?:measured|taken))(?:\s+of (?:that|the) (?:reading|measurement))?\s*[.!]?$/i, '');
    // Exact reported estimates retain their explicit estimated status; other normalized facts fail closed.
    const estimate = fact.path.startsWith('currentWeightEstimate.');
    if (isQuestion(sentence) || hypothetical.test(clause) || otherSubject.test(clause)) return false;
    if (uncertainty.test(clause) && !estimate) return false;
    // Boolean measurement polarity is derived separately, not from a cherry-picked word.
    if (!['lastMeasuredWeight.representsCurrent', 'lastMeasuredWeight.describedAsOld'].includes(fact.path) && negation.test(clause)) return false;
    return true;
  });
}
const historyWindows: Record<string, RegExp> = {
  childhood: /\b(childhood|child|kid|children|primary school|elementary school)\b/i,
  teenage: /\b(teen|teens|teenage|teenager|adolescent|high school|secondary school)\b/i,
  afterSchool: /\b(after (?:leaving )?school|after (?:high school|graduation)|early adult|college|university|twenties|20s)\b/i,
  lastFiveYears: /\b(last|past) (?:five|5) years\b/i,
  past18Months: /\b(last|past) (?:eighteen|18) months\b/i,
};
function historyScopeAllowed(context: AdaptiveContext, fact: AdaptiveFact): boolean {
  if (fact.topicId !== 'Q03' || !historyWindows[fact.path]) return true;
  const text = fact.evidence.map(span => around(context.source.text, span.start, true).text).join(' ');
  if (adaptiveHistoryScopes(context, fact.evidence).includes(fact.path)) return true;
  return singleScoped(context, fact) && !Object.values(historyWindows).some(pattern => pattern.test(text));
}
/** Same trusted history classification used by the guard; no model-supplied window routing. */
export function adaptiveHistoryScopes(context: AdaptiveContext, evidence: readonly EvidenceSpan[]): string[] {
  const text = evidence.map(span => around(context.source.text, span.start, true).text).join(' ');
  return Object.entries(historyWindows).filter(([path, pattern]) => pattern.test(path === 'teenage' ? text.replace(/after (?:leaving )?(?:high |secondary )?school/gi, '') : text)).map(([path]) => path);
}
export function adaptiveHistoryWindowUncertainty(context: AdaptiveContext, path: string): boolean {
  const pattern = historyWindows[path];
  if (!pattern) return true;
  // This veto can only retain a rejection's routing block; it grants no answer.
  // Inspect the complete statement so a fronted window and its predicate stay
  // together across commas, using the same apostrophe normalization as answers.
  return regions(context.source.text).some(region => {
    const text = normalize(region.text);
    const windowText = path === 'teenage'
      ? text.replace(/after (?:leaving )?(?:high |secondary )?school/gi, '')
      : text;
    return pattern.test(windowText)
      && (uncertainty.test(text) || /\b(?:don't|do not|cannot|can't) (?:remember|recall|know)|\bunknown\b/i.test(text));
  });
}
function medicationRoleAllowed(context: AdaptiveContext, fact: AdaptiveFact, role: 'label' | 'actual', scopeStart?: number): boolean {
  return fact.evidence.every(span => {
    const sentence = around(context.source.text, span.start);
    const clause = around(context.source.text, span.start, true).text;
    const quote = context.source.text.slice(span.start, span.end);
    if (isQuestion(sentence.text) || otherSubject.test(clause)) return false;
    if (fact.state === 'known' && ((negation.test(clause) && !negation.test(quote)) || (uncertainty.test(clause) && !uncertainty.test(quote)))) return false;
    const start = scopeStart ?? sentence.start;
    const markers = [...context.source.text.slice(start, span.end).matchAll(/\b(label|directions?|prescribed|i\s+(?:actually\s+)?(?:take|use|inject)|actually\s+(?:take|use|inject))\b/gi)];
    const inside = markers.filter(marker => start + marker.index! >= span.start);
    if (new Set(inside.map(marker => /take|use|inject/i.test(marker[0]))).size > 1) return false;
    const marker = markers.at(-1)?.[0];
    if (!marker) return singleScoped(context, fact);
    const actual = /take|use|inject/i.test(marker);
    return role === 'actual' ? actual : !actual;
  });
}
function numericAssociationAllowed(context: AdaptiveContext, fact: AdaptiveFact): boolean {
  const span = fact.evidence[0], region = around(context.source.text, span.start, true);
  const before = context.source.text.slice(region.start, span.start), after = context.source.text.slice(span.end, region.end);
  const month = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*$/i;
  if (month.test(before) || /\b(?:on|in|since|during)\s*$/i.test(before) || /^\s*[-/]\s*\d/.test(after) || /\d[-/]\s*$/.test(before)) return false;
  const units = /^\s*(cm|centimet(?:er|re)s?|m|met(?:er|re)s?|in|inches|inch|ft|feet|foot|kg|kilograms?|lb|lbs|pounds?|st|stones?|mg|mcg|iu)\b/i.exec(after)?.[1].toLowerCase();
  const heightUnit = units && /^(cm|centimet(?:er|re)s?|m|met(?:er|re)s?|in|inches|inch|ft|feet|foot)$/.test(units);
  const weightUnit = units && /^(kg|kilograms?|lb|lbs|pounds?|st|stones?)$/.test(units);
  const anchor = [...before.matchAll(/\b(height|tall|weight|weighed|measured|reading|scale|estimate|guess|a1c|glucose|meter|sugar|sensor)\b/gi)].at(-1);
  const label = anchor?.[0].toLowerCase();
  if (fact.path === 'height.value' && (units && !heightUnit || label && !['height', 'tall'].includes(label))) return false;
  if (['lastMeasuredWeight.value', 'currentWeightEstimate.value'].includes(fact.path) && (units && !weightUnit || label && ['height', 'tall', 'a1c', 'glucose', 'meter', 'sugar', 'sensor'].includes(label))) return false;
  // A marker may introduce one number. A later date/other number cannot borrow the earlier marker.
  if (anchor && /\b\d+(?:\.\d+)?\b/.test(before.slice(anchor.index! + anchor[0].length))) return false;
  return true;
}

function medicineScopeAllowed(context: AdaptiveContext, fact: AdaptiveFact, response: TopicResponse, proposedNames: readonly string[]): boolean {
  const match = /^medicines\[([^\]]+)\]\.(.+)$/.exec(fact.path);
  if (!match) return true;
  const list = response.answers.medicines;
  const item = list?.state === 'known' ? list.items?.find(entry => entry.id === match[1]) : undefined;
  const nameAnswer = item && item.answers.name;
  const name = nameAnswer?.state === 'known' && typeof nameAnswer.value === 'string' ? nameAnswer.value : undefined;
  if (match[2] === 'name') return fact.evidence.every(span => {
    const sentence = around(context.source.text, span.start).text;
    const clause = around(context.source.text, span.start, true).text;
    return !isQuestion(sentence) && !hypothetical.test(sentence) && !otherSubject.test(clause) && !negation.test(clause) && !uncertainty.test(clause);
  });
  if (!name) return false;
  const text = context.source.text, lower = text.toLowerCase(), target = name.toLowerCase();
  const names = [...proposedNames, ...(list?.state === 'known' ? list.items?.flatMap(entry => entry.answers.name?.state === 'known' && typeof entry.answers.name.value === 'string' ? [entry.answers.name.value.toLowerCase()] : []) ?? [] : [])];
  // Names in existing items and explicit source headings delimit medicine records. No drug lexicon/inference.
  const headings = [...text.matchAll(/(?:^|[.;\n])\s*([A-Za-z][A-Za-z0-9 -]{0,50}):/g)].map(m => ({ at: m.index! + m[0].indexOf(m[1]), name: [...names].sort((a, b) => b.length - a.length).find(name => m[1].trim().toLowerCase() === name || m[1].trim().toLowerCase().startsWith(`${name} `)) ?? m[1].trim().toLowerCase() }));
  const anchors = [...new Set([...names, target])].flatMap(label => {
    const found: { at: number; name: string }[] = []; let at = lower.indexOf(label);
    while (at >= 0) { found.push({ at, name: label }); at = lower.indexOf(label, at + label.length); }
    return found;
  }).concat(headings).sort((a, b) => a.at - b.at);
  return fact.evidence.every(span => {
    const clause = around(text, span.start, true).text;
    const quote = text.slice(span.start, span.end);
    if (match[2] === 'strength' && fact.state === 'known' && (negation.test(clause) || uncertainty.test(clause))) return false;
    const sharedConcerns = match[2] === 'concerns' && fact.state === 'negative' && /\bno concerns (?:with|about|for) (?:either|both|any of them|all)\b/i.test(quote) && anchors.some(anchor => anchor.name === target && anchor.at < span.start);
    if (sharedConcerns) return true;
    if (anchors.some(anchor => anchor.at > span.start && anchor.at < span.end && anchor.name !== target)) return false;
    const active = anchors.filter(anchor => anchor.at <= span.start).at(-1);
    if (active && active.name !== target) return false;
    if (!active && !singleScoped(context, fact)) return false;
    if (isQuestion(around(text, span.start).text) || otherSubject.test(clause)) return false;
    if (['actualUse', 'labelDirections'].includes(match[2]) && !medicationRoleAllowed(context, fact, match[2] === 'actualUse' ? 'actual' : 'label', active?.at)) return false;
    return true;
  });
}

function correctionCueAllowed(context: AdaptiveContext, fact: AdaptiveFact): boolean {
  return fact.evidence.every(span => {
    const sentence = around(context.source.text, span.start);
    const before = context.source.text.slice(sentence.start, span.start);
    const start = sentence.start + before.lastIndexOf(';') + 1;
    const end = context.source.text.indexOf(';', span.end);
    const statement = context.source.text.slice(start, end < 0 ? sentence.end : Math.min(sentence.end, end));
    return /\b(correction|correct that|actually|i meant|i mean|not .* but)\b/i.test(statement);
  });
}

function otherIntakeAbsence(context: AdaptiveContext, fact: AdaptiveFact): boolean {
  if (fact.topicId !== 'Q11' || fact.path !== 'otherIntake' || context.displayed?.topicId !== 'Q11') return false;
  const span = fact.evidence[0], sentence = around(context.source.text, span.start);
  const text = normalize(sentence.text);
  const absence = /^(?:there was )?nothing else(?: that day| yesterday| today| all day)?$/.test(text)
    || /^no other food (?:or|and) drink(?: that day| yesterday| today)?$/.test(text)
    || /^i (?:didn't|did not) (?:eat or drink|have) anything else(?: that day| yesterday| today)?$/.test(text)
    || singleScoped(context, fact) && /^(no|none)$/.test(text);
  if (!absence || isQuestion(sentence.text) || uncertainty.test(sentence.text)) return false;
  // A later explicit exception/retraction cannot be hidden by citing the initial absence alone.
  const after = context.source.text.slice(span.end);
  return !/\b(except|actually|but (?:i|there)|i (?:(?:also|did|then|later) )?(?:had|ate|drank)|i (?:also|did|then|later) (?:have|eat|drink)|there (?:was|were) more)\b/i.test(after);
}

function diagnosticUncertaintyReport(text: string): boolean {
  const normalized = normalize(text);
  return !otherSubject.test(normalized) && !isQuestion(normalized) && /\bi(?:(?: do not| don't| cannot| can't) (?:know|remember|recall|tell)|(?: am|'m) (?:not sure|unsure|uncertain))\s+(?:about\s+)?(?:(?:whether|if)\s+)?(?:i (?:have|had|was (?:ever )?diagnosed|have been (?:told|diagnosed))|(?:was |am )?(?:diagnosed|told))\b/i.test(normalized);
}

/** A condition item is patient history. Exact words cannot remove another subject or status. */
function patientConditionScopeAllowed(context: AdaptiveContext, fact: AdaptiveFact, response: TopicResponse): boolean {
  if (fact.topicId !== 'Q06') return true;
  const item = /^reportedConditions\[([^\]]+)\]\.(.+)$/.exec(fact.path);
  if (!item && fact.path !== 'uncertainDiagnosis') return true;
  if (item && item[2] !== 'term') {
    const list = response.answers.reportedConditions;
    const term = list?.state === 'known' ? list.items?.find(entry => entry.id === item[1])?.answers.term : undefined;
    if (!term || !['known', 'uncertain'].includes(term.state)) return false;
  }
  return fact.evidence.every(span => {
    const quote = context.source.text.slice(span.start, span.end);
    const clause = around(context.source.text, span.start, true).text;
    if (otherSubject.test(clause) || otherSubject.test(quote) || /\b(she|he|they|her|his|their)\b/i.test(clause) || isQuestion(clause) || isQuestion(quote)) return false;
    const diagnosticUncertainty = diagnosticUncertaintyReport(quote);
    if (hypothetical.test(clause) && !diagnosticUncertainty) return false;
    if (item && item[2] !== 'term') return true;
    // Preserve a fully reported negative/uncertain status, but reject a stripped condition name.
    if (negation.test(clause) && !negation.test(quote) || uncertainty.test(clause) && !uncertainty.test(quote)) return false;
    const status = /\b(possible|suspected|unconfirmed|ruled out)\b/i;
    if (status.test(clause) && !status.test(quote)) return false;
    const patient = /\b(i|i'm|i've|me|my (?:doctor|clinician|diagnosis|condition))\b/i.test(clause);
    const asked = context.displayed?.topicId === 'Q06' && (context.displayed.promptId === 'Q06' || context.displayed.targetPaths.some(path => path === 'reportedConditions' || path === fact.path || path.startsWith('reportedConditions[')));
    return patient || asked;
  });
}

/** Bounded contradiction guard: inability to supply the requested detail is not a known narrative.
 * Use the full source sentence and the unavailable predicate's object; unrelated uncertainty remains intact.
 */
function unavailableTarget(context: AdaptiveContext, fact: AdaptiveFact, definition: SlotDefinition): boolean {
  const leaf = fact.path.split('].').at(-1)!;
  const aliases: Record<string, RegExp> = {
    foodAmounts: /\b(portion|amount|how much|quantity|serving|size)\b/i,
    drinkAmounts: /\b(portion|amount|how much|quantity|serving|size|cup|glass)\b/i,
    drinkAdditions: /\b(add|added|additions|sugar|cream|milk|sweetener)\b/i,
    foods: /\b(food|ate|eat|eaten|what i had)\b/i,
    drinks: /\b(drink|drank|beverage)\b/i,
    'lastMeasuredWeight.measuredWhen': /\b(when|date|day|month|year)\b/i,
    'lastMeasuredWeight.datePrecision': /\b(when|date|day|month|year|exact|approximate)\b/i,
    labelDirections: /\b(label|direction|instruction)\b/i,
    directions: /\b(label|direction|instruction)\b/i,
    actualUse: /\b(take|taking|use|using|dose|frequency)\b/i,
    strength: /\b(strength|mg|mcg|iu|dose)\b/i,
  };
  const labelWords = definition.label.toLowerCase().match(/[a-z]{4,}/g)?.filter(word => !['what', 'your', 'with', 'about', 'reported', 'ordinary', 'approximate'].includes(word)) ?? [];
  const targetPattern = historyWindows[fact.path] ?? aliases[leaf];
  for (const span of fact.evidence) {
    const sentence = around(context.source.text, span.start);
    const normalized = sentence.text.replace(/[’]/g, "'");
    const pattern = /\b(?:(?:i )?(?:don't|do not|can't|cannot) (?:know|remember|recall|tell)|(?:i am |i'm )?(?:not sure|unsure|uncertain)(?: about)?|unknown)\b/gi;
    for (const match of normalized.matchAll(pattern)) {
      const start = sentence.start + match.index!;
      // A coordinated new subject/predicate ends the unavailable object's scope, not the evidence source.
      const tail = normalized.slice(match.index! + match[0].length).split(/[;,.!?]|\b(?:but|and) (?:(?:i|my|the)\b)/i)[0];
      const named = targetPattern ? targetPattern.test(tail) : labelWords.some(word => new RegExp(`\\b${word}\\b`, 'i').test(tail));
      if (fact.topicId === 'Q06' && fact.path === 'uncertainDiagnosis' && diagnosticUncertaintyReport(context.source.text.slice(span.start, span.end))) continue;
      const before = normalized.slice(0, match.index!).split(/[;,.!?]|\b(?:but|and)\b/i).at(-1)!;
      // A trailing predicate belongs to its preceding subject, even if the selected quote stops early.
      const trailing = /\b(?:is|was|remains|are|were)(?: still)?\s*$/i.test(before) && /^(?:unknown|uncertain|not sure)$/i.test(match[0]);
      const precedingTarget = targetPattern ? targetPattern.test(before) : labelWords.some(word => new RegExp(`\\b${word}\\b`, 'i').test(before));
      if (trailing && precedingTarget) return true;
      if (named) return true;
      const inside = span.start <= start && span.end >= start + match[0].length;
      if (!inside) continue;
      // An explicit different detail can coexist with a known fact, even in one sentence.
      const differentDetail = Object.entries(aliases).some(([path, pattern]) => path !== leaf && pattern.test(tail));
      const logistics = /\b(who to (?:call|contact)|mask|setting|appointment|pharmacy|whom to (?:call|contact))\b/i.test(tail);
      if (!differentDetail && !logistics) return true;
    }
  }
  return false;
}

function deriveAnswer(context: AdaptiveContext, fact: AdaptiveFact, definition: SlotDefinition, sourceText: string[]): SlotAnswer | undefined {
  const text = sourceText.join(' '), clean = normalize(text), sourceIds = [context.source.id];
  if (!normalizedContextAllowed(context, fact) || !historyScopeAllowed(context, fact)) return;
  if (fact.topicId === 'W07' && ['directions', 'actualUse'].includes(fact.path) && !medicationRoleAllowed(context, fact, fact.path === 'actualUse' ? 'actual' : 'label')) return;
  if (fact.state !== 'known') {
    const recallAbsence = fact.state === 'negative' && fact.topicId === 'Q11' && fact.path === 'otherIntake';
    if (recallAbsence && !otherIntakeAbsence(context, fact)) return;
    const stateMatch = fact.state === 'negative' ? recallAbsence || /^(no|none|none that i know of|none known|no concerns|no changes)$/.test(clean) || negation.test(clean)
      : fact.state === 'unknown' ? /\b(don't know|do not know|don't remember|cannot recall|can't recall|unknown)\b/.test(clean)
      : fact.state === 'uncertain' ? uncertainty.test(clean)
      : fact.state === 'declined' ? /\b(prefer not|rather not|don't want|do not want|rather discuss|skip|move on)\b/.test(clean)
      : /\b(not applicable|doesn't apply|does not apply)\b/.test(clean);
    if (!stateMatch || (fact.state === 'negative' && !definition.acceptsNegative) || (fact.state === 'not-applicable' && !definition.acceptsNotApplicable)) return;
    if (fact.path.startsWith('conditions.') && !explicitConditionMention(fact.path, text) && !(scoped(context, fact) && /^(no|none|none that i know of|none known)$/.test(clean))) return;
    if (fact.state === 'negative' && uncertainty.test(clean)) return;
    if (fact.path === 'medicines' && definition.kind === 'collection' && fact.state === 'negative') {
      const scopedNone = scoped(context, fact) && /^(no|none|none that i know of|none known)$/.test(clean);
      const entireList = /^(?:i (?:don't|do not) take (?:any )?|i take no |no )(?:medicines|medications|meds|drugs|supplements|products)(?: or (?:medicines|medications|meds|drugs|supplements|products))?(?: at all)?$/.test(clean);
      if (!(scopedNone || entireList) || isQuestion(context.source.text) || /\bi take (?!no\b|none\b|any\b)\S+/i.test(context.source.text)) return;
    }
    // Unscoped single-word negatives/refusals cannot populate arbitrary unrelated fields.
    if (sourceText.length === 1 && /^(no|none|unknown|not sure|skip|move on|not applicable|i don't know|i do not know|i don't remember|i cannot recall|i prefer not to answer)$/.test(clean) && !scoped(context, fact)) return;
    return { state: fact.state, sourceIds, note: text };
  }
  if (definition.kind === 'configuration' || definition.kind === 'collection') return;
  if (fact.transform === 'verbatim') {
    if (unavailableTarget(context, fact, definition)) return;
    if (/^(fine|normal|normally|okay|ok|good|i eat normally|always struggled|i've always struggled|i have always struggled|i don't know|i do not know|i don't remember|unknown|not sure|no|none|not applicable)$/.test(clean)) return;
    if (['serviceDate', 'requestedDate'].includes(fact.path) && (!/^\d{4}-\d{2}-\d{2}$/.test(clean) || !Number.isFinite(Date.parse(clean)) || new Date(clean).toISOString().slice(0, 10) !== clean)) return;
    return definition.kind === 'text' ? { state: 'known', value: text.trim(), sourceIds } : undefined;
  }
  if (fact.transform === 'explicit-height') {
    const value = sourceText.length === 1 && parseExplicitHeight(text);
    return definition.kind === 'height-value' && value ? { state: 'known', value, sourceIds } : undefined;
  }
  if (fact.transform === 'explicit-number') {
    if (!['positive-number', 'height-value'].includes(definition.kind) || sourceText.length !== 1 || !/^\d+(?:\.\d+)?$/.test(text.trim())) return;
    const value = Number(text);
    if (!Number.isFinite(value) || value <= 0 || !numericAssociationAllowed(context, fact)) return;
    const before = context.source.text.slice(Math.max(0, fact.evidence[0].start - 24), fact.evidence[0].start);
    const after = context.source.text.slice(fact.evidence[0].end, fact.evidence[0].end + 16);
    if (/\b(?:not|or)\s*$/i.test(before) || /^\s*or\s+\d/i.test(after)) return;
    const clauseBefore = context.source.text.slice(0, fact.evidence[0].start).split(/[;,\n]/).at(-1)!.slice(-100);
    if (fact.path === 'height.value') {
      const local = around(context.source.text, fact.evidence[0].start, true).text;
      if (/\b(mg|mcg|iu|dose|tablet|capsule|metformin|glucose|a1c)\b/i.test(local) || !scoped(context, fact) && !/\b(height|tall|cm|centimet(?:er|re)s?|feet|foot|inches|inch|met(?:er|re)s?)\b/i.test(local)) return;
    }
    if (fact.path === 'lastMeasuredWeight.value' && (/\b(estimate|guess|think|probably)\b/i.test(clauseBefore) || !scoped(context, fact) && !/\b(measured|weighed|reading|scale)\b/i.test(clauseBefore))) return;
    if (fact.path === 'currentWeightEstimate.value' && !scoped(context, fact) && !/\b(estimate|guess|think|probably)\b/i.test(clauseBefore)) return;
    if (fact.path === 'a1c.value' && !/\ba1c\b/i.test(clauseBefore) && (!scoped(context, fact) || /\b(meter|glucose|sugar|sensor)\b/i.test(clauseBefore))) return;
    if (fact.path === 'latestGlucose.value' && (/\ba1c\b/i.test(clauseBefore) || !scoped(context, fact) && !/\b(meter|glucose|sugar|sensor)\b/i.test(clauseBefore))) return;
    return { state: 'known', value, sourceIds };
  }
  if (fact.transform === 'explicit-unit') {
    const value = parseExplicitHeight(text) ? 'ft-in' : unitAliases[clean];
    return definition.kind === 'choice' && value && definition.choices?.includes(value) ? { state: 'known', value, sourceIds } : undefined;
  }
  if (definition.kind === 'presence' && ['explicit-choice', 'scoped-response'].includes(fact.transform)) {
    if (negation.test(clean) || uncertainty.test(clean)) return;
    if (/^(yes|true)$/.test(clean) && singleScoped(context, fact)) return { state: 'known', value: true, sourceIds };
    if (fact.path.startsWith('conditions.') && explicitConditionMention(fact.path, text) && /\b(i have|i've been|i was|i am|i'm|my)\b/i.test(conditionContext(context, fact)?.clause ?? '') && /\b(have|diagnosed|told)\b/i.test(text)) return { state: 'known', value: true, sourceIds };
    if (singleScoped(context, fact) && /\b(have|diagnosed|told)\b/i.test(text)) return { state: 'known', value: true, sourceIds };
    return;
  }
  if (definition.kind === 'choice' && ['explicit-choice', 'scoped-response'].includes(fact.transform)) {
    let value: string | boolean | number | undefined = definition.choices?.find(choice => typeof choice === 'string' && (normalize(choice) === clean || normalize(choice).replace(/[-_]/g, ' ') === clean));
    const administrativeAliases: Record<string, Record<string, string>> = {
      issueType: { bill: 'bill-question', 'my bill': 'bill-question', 'billing question': 'bill-question', 'coverage question': 'coverage-question', 'payment question': 'payment-question' },
      requestedResolution: { 'please explain the charge': 'explanation', 'explain the charge': 'explanation', 'payment options': 'payment-options', 'contact me': 'contact-me', 'review a possible error': 'review-possible-error' },
    };
    if (value === undefined) value = administrativeAliases[fact.path]?.[clean];
    if (value === undefined && fact.path === 'lastMeasuredWeight.datePrecision') {
      if (/\b(about|around|approximately|last|ago|sometime)\b/i.test(text)) value = 'approximate';
      else if (/\b\d{4}-\d{2}-\d{2}\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\b/i.test(text)) value = 'exact';
    }
    if (value === undefined && fact.path === 'lastMeasuredWeight.representsCurrent') {
      if (uncertainty.test(around(context.source.text, fact.evidence[0].start).text)) return;
      if (/\b(no longer|changed|different now|not.*current|doesn't.*reflect|does not.*reflect)\b/i.test(text)) value = false;
      else if (/\b(still reflects|still represents|still the same|unchanged)\b/i.test(text) && !uncertainty.test(text)) value = true;
    }
    if (value === undefined && fact.path === 'lastMeasuredWeight.describedAsOld' && /\b(old|outdated|a while ago)\b/i.test(text)) {
      const local = around(context.source.text, fact.evidence[0].start, true).text;
      if (uncertainty.test(local) || negation.test(local)) return;
      value = true;
    }
    if (value === undefined && singleScoped(context, fact) && /^(yes|true|no|false)$/.test(clean)) value = /^(yes|true)$/.test(clean);
    return value !== undefined && definition.choices?.includes(value) ? { state: 'known', value, sourceIds } : undefined;
  }
}

export function conditionalReady(definition: SlotDefinition, siblings: SlotAnswers, definitions: readonly SlotDefinition[], context: AdaptiveContext): boolean {
  if (!definition.when) return true;
  // Delegate content-specific positive/estimate/uncertain semantics to the existing readiness implementation.
  const ready = evaluateSlots(definitions, siblings, { validSourceIds: new Set(context.sources.filter(source => source.role === 'patient').map(source => source.id)) }).find(result => result.id === definition.id)!;
  // A volunteered explicit detail may be retained before its anchor is settled; readiness still
  // keeps the conditional target unresolved. An explicit negative anchor must not be contradicted silently.
  return ready.state !== 'not-applicable';
}

/** Conditional branch applicability from explicit Q06 anchors. Mutates `responses` in place. */
export function activateAdaptiveBranch(responses: Record<string, TopicResponse | undefined>, t: TopicDefinition, evidence: EvidenceContext): void {
  if (t.presentation !== 'C') return;
  const anchors = t.id === 'DM' ? ['conditions.diabetes', 'conditions.prediabetes'] : t.id === 'SLEEP' ? ['conditions.sleepApnea'] : t.id === 'GI' ? ['conditions.digestive'] : [];
  if (!anchors.length) return;
  const response = (id: string) => responses[id] ?? emptyResponse();
  const answers = response('Q06').answers;
  const valid = (answer: SlotAnswer | undefined) => answer && answer.state !== 'not-asked' && answer.sourceIds?.length && answer.sourceIds.every(id => evidence.validSourceIds.has(id));
  const positive = anchors.some(path => valid(answers[path]) && answers[path]?.state === 'known' && (answers[path] as { value?: unknown }).value === true);
  const supplied = anchors.some(path => valid(answers[path]));
  if (!supplied) return; // Standalone branch contexts retain their trusted server applicability.
  const negative = anchors.every(path => valid(answers[path]) && ['negative', 'not-applicable'].includes(answers[path]!.state));
  const applicability = positive && (t.id !== 'DM' || diabetesBranchApplicability(answers, evidence) === 'applicable') ? 'applicable' : negative ? 'not-applicable' : 'unknown';
  if (applicability === 'applicable' || responses[t.id]) responses[t.id] = { ...response(t.id), applicability, applicabilitySourceIds: anchors.flatMap(path => answers[path]?.sourceIds ?? []) };
}

/** Explicit V5 bridge; legacy scope/derivation/coverage always receives semantic spans. */
function validateValueAdaptiveProposal(raw: unknown, context: AdaptiveContext): ValidatedAdaptiveTurn {
  const parsed = adaptiveValueProposalSchema.safeParse(raw);
  if (!parsed.success) throw new AdaptiveError('invalid-value-proposal');
  const proposal = parsed.data;
  const supports = new Map<string, { evidence: EvidenceSpan[]; sourceText: string[]; valueEvidence: EvidenceSpan | null }>();
  const semantic = (field: AdaptiveValueProposal['facts'][number] | AdaptiveValueProposal['newItems'][number]['fields'][number], topicId: string, path: string): AdaptiveFact => {
    const supportText = quotes(context, field.evidence);
    const { valueEvidence, evidence, ...rest } = field;
    const selected = valueEvidence === null ? evidence : [valueEvidence];
    const valueText = quotes(context, selected);
    if (valueEvidence && !evidence.some(span => span.sourceId === valueEvidence.sourceId && span.start <= valueEvidence.start && span.end >= valueEvidence.end)) throw new AdaptiveError('unsupported-value-span');
    if (valueEvidence && /(?:^|\]\.)strength$/.test(path)) {
      // Require the stated unit in the selected literal; no unit lexicon, inference or expansion.
      if (/^\d+(?:\.\d+)?$/.test(valueText[0])) throw new AdaptiveError('incomplete-strength-value');
      // A strength cannot contain the new/old comparison itself. Unsupported amount forms fail closed.
      if (!/^\d+(?:\.\d+)?\s*\p{L}+(?:\s*\/\s*\d*(?:\.\d+)?\s*\p{L}+)?$/u.test(valueText[0])) throw new AdaptiveError('invalid-strength-value');
    }
    const fact = { ...rest, topicId, path, evidence: selected } as AdaptiveFact;
    if (fact.correctsSourceIds && valueEvidence) {
      const sentence = around(context.source.text, valueEvidence.start);
      const before = context.source.text.slice(sentence.start, valueEvidence.start);
      const start = sentence.start + before.lastIndexOf(';') + 1;
      const end = context.source.text.indexOf(';', valueEvidence.end);
      const statement = context.source.text.slice(start, end < 0 ? sentence.end : Math.min(sentence.end, end));
      const cue = /\b(correction|correct that|actually|i meant|i mean|not .* but)\b/i.exec(statement);
      if (!cue || !evidence.some(span => span.start <= Math.min(start + cue.index, valueEvidence.start) && span.end >= Math.max(start + cue.index + cue[0].length, valueEvidence.end))) throw new AdaptiveError('invalid-correction-support');
    }
    supports.set(`${topicId}:${path}`, { evidence, sourceText: supportText, valueEvidence });
    return fact;
  };
  const facts = proposal.facts.map(field => semantic(field, field.topicId, field.path));
  const newItems = proposal.newItems.map((item, index) => ({ ...item, fields: item.fields.map(field => {
    const path = `${item.collection}[a${context.source.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 40)}_${index}].${field.path}`;
    const fact = semantic(field, item.topicId, path);
    const { topicId: _topicId, ...child } = fact;
    return { ...child, path: field.path };
  }) }));
  // Every source/value branch was checked before the unchanged schema-1 validator can apply anything.
  const legacy = { ...proposal, schema: 1, facts, newItems };
  const validated = validateAdaptiveProposal(legacy, context);
  const stored = validatedResults.get(validated)!;
  for (const entry of stored.outcome.provenance) {
    const support = !entry.derivedFrom && supports.get(`${entry.topicId}:${entry.path}`);
    if (support) Object.assign(entry, { supportEvidence: support.evidence, supportSourceText: support.sourceText, ...(support.valueEvidence ? { valueEvidence: support.valueEvidence } : {}), evidenceProtocol: 'contextual-values-v5' as const });
  }
  return validated;
}

/** Validate all schema/scope first; return explicit deferred ambiguity, never invented values. */
export function validateAdaptiveProposal(raw: unknown, context: AdaptiveContext): ValidatedAdaptiveTurn {
  verifyContext(context);
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as { schema?: unknown }).schema === 2) return validateValueAdaptiveProposal(raw, context);
  const parsed = adaptiveProposalSchema.safeParse(raw);
  if (!parsed.success) throw new AdaptiveError('invalid-adaptive-proposal');
  if (context.safetyPaused || escalation(context.source.text)) throw new AdaptiveError('safety-interruption');
  const proposal = parsed.data;
  for (const entry of proposal.unmapped ?? []) quotes(context, entry.evidence);
  const responses = structuredClone(context.responses) as Record<string, TopicResponse | undefined>;
  const outcome: AdaptiveOutcome = { responses, updates: [], provenance: [], clarifications: [], acts: [], sourceId: context.source.id, hasUnresolvedInterpretation: false, ...(proposal.unmapped?.length ? { unmapped: structuredClone(proposal.unmapped) } : {}) };
  const evidence = { validSourceIds: new Set(context.sources.filter(source => source.role === 'patient').map(source => source.id)) };
  const topic = (id: string) => { const found = context.topics.find(entry => entry.id === id); if (!found) throw new AdaptiveError('topic-not-allowed'); return found; };
  const response = (id: string) => responses[id] ?? emptyResponse();
  const activateExistingBranch = (t: TopicDefinition) => activateAdaptiveBranch(responses, t, evidence);
  const seen = new Set<string>();
  const checkFact = (fact: AdaptiveFact, definition: SlotDefinition) => {
    const key = `${fact.topicId}:${fact.path}`;
    if (seen.has(key)) throw new AdaptiveError('duplicate-target');
    seen.add(key);
    if (/^MH0[1-4]$/.test(definition.id) || definition.kind === 'configuration' || definition.id === 'currentWeightEstimate.statedAt') throw new AdaptiveError('model-field-forbidden');
    quotes(context, fact.evidence);
  };
  for (const fact of proposal.facts) checkFact(fact, adaptiveSlot(topic(fact.topicId), response(fact.topicId), fact.path).definition);
  const itemKeys = new Set<string>();
  for (const item of proposal.newItems) {
    if (itemKeys.has(item.key)) throw new AdaptiveError('duplicate-item-key');
    itemKeys.add(item.key);
    const definition = adaptiveSlot(topic(item.topicId), response(item.topicId), item.collection).definition;
    if (definition.kind !== 'collection') throw new AdaptiveError('collection-required');
    const fields = new Set<string>();
    for (const field of item.fields) {
      if (fields.has(field.path)) throw new AdaptiveError('duplicate-target');
      fields.add(field.path);
      const fieldDefinition = definition.fields?.find(candidate => candidate.id === field.path);
      if (!fieldDefinition || fieldDefinition.kind === 'collection' || fieldDefinition.kind === 'configuration') throw new AdaptiveError('unknown-slot-path');
      quotes(context, field.evidence);
    }
  }
  for (const list of proposal.completedLists) {
    if (adaptiveSlot(topic(list.topicId), response(list.topicId), list.path).definition.kind !== 'collection') throw new AdaptiveError('collection-required');
    quotes(context, list.evidence);
  }
  for (const act of proposal.acts) {
    const text = quotes(context, act.evidence).join(' ');
    if (act.targetTopicId) topic(act.targetTopicId);
    if (act.replyId && (act.kind !== 'question' || !['COPY-02', 'COPY-04', 'COPY-05', 'unsupported', ...(context.approvedReplies ?? []).map(reply => reply.id)].includes(act.replyId))) throw new AdaptiveError('reply-not-allowed');
    if (act.kind === 'move-on') {
      if (!act.targetTopicId || act.targetTopicId !== context.displayed?.topicId || !/\b(skip|move on|rather not|prefer not|don't want|do not want|rather discuss)\b/i.test(text)) throw new AdaptiveError('unscoped-move-on');
    }
    if (act.kind === 'topic-switch' && (!act.targetTopicId || !/\b(talk about|discuss|go back|return to|instead|first|rather)\b/i.test(text) || /\b(rather not|don't want|do not want|prefer not)\b/i.test(text))) throw new AdaptiveError('unscoped-topic-switch');
    if (act.kind === 'question' && !/[?]|\b(why|how|what|when|where|can|could|should|would|tell me|prescribe|renew|refill)\b/i.test(text)) throw new AdaptiveError('question-evidence-required');
    outcome.acts.push(act);
  }
  const stopTopics = new Set(outcome.acts.filter(act => act.kind === 'move-on').map(act => act.targetTopicId!));
  const reopenedTopics = new Set(outcome.acts.filter(act => act.kind === 'topic-switch' && !stopTopics.has(act.targetTopicId!)).map(act => act.targetTopicId!));
  for (const id of reopenedTopics) if (response(id).stopped) responses[id] = { ...response(id), stopped: undefined };
  const proposedMedicineNames = proposal.newItems.filter(item => item.collection === 'medicines').flatMap(item => item.fields.filter(field => field.path === 'name' && field.state === 'known').map(field => quotes(context, field.evidence).join(' ').toLowerCase()));
  function applyFact(fact: AdaptiveFact) {
    const t = topic(fact.topicId); activateExistingBranch(t);
    const current = response(t.id), resolved = adaptiveSlot(t, current, fact.path), sourceText = quotes(context, fact.evidence);
    const deferred = (reason: AdaptiveClarification['reason'], proposed?: SlotAnswer) => outcome.clarifications.push({ topicId: t.id, path: fact.path, reason, evidence: fact.evidence, ...(resolved.answer ? { previous: resolved.answer } : {}), ...(proposed ? { proposed } : {}) });
    if (current.stopped || stopTopics.has(t.id)) { deferred('stopped-topic'); return; }
    if ((t.presentation === 'C' && current.applicability !== 'applicable') || !conditionalReady(resolved.definition, resolved.siblings, resolved.definitions, context)) { deferred('condition-unresolved'); return; }
    if (!patientConditionScopeAllowed(context, fact, current)) { deferred('ambiguous-value'); return; }
    if (!medicineScopeAllowed(context, fact, current, proposedMedicineNames)) { deferred('ambiguous-value'); return; }
    const answer = deriveAnswer(context, fact, resolved.definition, sourceText);
    if (!answer) { deferred(fact.transform === 'scoped-response' ? 'unscoped-response' : 'ambiguous-value'); return; }
    if (fact.transform === 'explicit-unit' && fact.path.endsWith('.unit') && !scoped(context, fact)) {
      const pairedPath = fact.path.replace(/\.unit$/, '.value');
      const paired = outcome.provenance.find(item => item.topicId === fact.topicId && item.path === pairedPath);
      const attached = paired?.evidence.some(valueSpan => fact.evidence.some(unitSpan => {
        const between = unitSpan.start >= valueSpan.end ? context.source.text.slice(valueSpan.end, unitSpan.start)
          : valueSpan.start >= unitSpan.end ? context.source.text.slice(unitSpan.end, valueSpan.start) : '';
        return between.length <= 12 && /^[\s:=/-]*$/.test(between);
      }));
      if (!attached) { deferred('unscoped-response', answer); return; }
    }
    const prior = resolved.answer;
    if (fact.correctsSourceIds) {
      if (!prior || prior.state === 'not-asked' || canonicalJson([...new Set(prior.sourceIds)].sort()) !== canonicalJson([...new Set(fact.correctsSourceIds)].sort()) || !correctionCueAllowed(context, fact)) throw new AdaptiveError('invalid-correction-target');
    }
    if (prior && !['not-asked', 'unknown', 'uncertain'].includes(prior.state) && !(reopenedTopics.has(t.id) && ['declined', 'skipped'].includes(prior.state)) && !sameAnswer(prior, answer) && !fact.correctsSourceIds) {
      // Do not overwrite earlier information. Keep both alternatives in explicit integration DTOs.
      const conflict: SlotAnswer = { state: 'conflicting', sourceIds: [...new Set([...(prior.sourceIds ?? []), ...(answer.sourceIds ?? [])])], note: 'Patient statements differ; clarification is needed.' };
      responses[t.id] = applyGuidedAnswer(t, current, { path: fact.path, answer: conflict }, evidence);
      outcome.updates.push({ topicId: t.id, path: fact.path, answer: conflict });
      deferred('conflict', answer);
      return;
    }
    const supported = prior && sameAnswer(prior, answer) ? { ...answer, sourceIds: [...new Set([...(prior.sourceIds ?? []), ...(answer.sourceIds ?? [])])] } as SlotAnswer : answer;
    responses[t.id] = applyGuidedAnswer(t, current, { path: fact.path, answer: supported }, evidence);
    outcome.updates.push({ topicId: t.id, path: fact.path, answer: supported });
    outcome.provenance.push({ topicId: t.id, path: fact.path, evidence: fact.evidence, transform: fact.transform, sourceText, ...(fact.correctsSourceIds ? { correctsSourceIds: fact.correctsSourceIds } : {}) });
    if (fact.path === 'height.value' && answer.state === 'known' && typeof answer.value === 'object') {
      const unit = response(t.id).answers['height.unit'];
      if (unit && unit.state === 'known' && unit.value !== 'ft-in' && !fact.correctsSourceIds) { deferred('conflict'); responses[t.id] = current; outcome.updates.pop(); outcome.provenance.pop(); return; }
      if (!proposal.facts.some(candidate => candidate.topicId === t.id && candidate.path === 'height.unit')) {
        const unitAnswer: SlotAnswer = { state: 'known', value: 'ft-in', sourceIds: [context.source.id] };
        responses[t.id] = applyGuidedAnswer(t, response(t.id), { path: 'height.unit', answer: unitAnswer }, evidence);
        outcome.updates.push({ topicId: t.id, path: 'height.unit', answer: unitAnswer });
        outcome.provenance.push({ topicId: t.id, path: 'height.unit', evidence: fact.evidence, transform: 'explicit-height-unit', sourceText });
      }
    }
    if (fact.path === 'currentWeightEstimate.value' && answer.state === 'known') {
      const timestamp: SlotAnswer = { state: 'known', value: context.source.at, sourceIds: [context.source.id] };
      responses[t.id] = { ...response(t.id), answers: { ...response(t.id).answers, 'currentWeightEstimate.statedAt': timestamp } };
      outcome.updates.push({ topicId: t.id, path: 'currentWeightEstimate.statedAt', answer: timestamp });
      outcome.provenance.push({ topicId: t.id, path: 'currentWeightEstimate.statedAt', evidence: fact.evidence, transform: 'source-timestamp', sourceText });
    }
    if (fact.state === 'declined') responses[t.id] = { ...response(t.id), stopped: 'patient-declines' };
  }
  // Anchors before conditional values, independent of the model's array order.
  const order = (fact: AdaptiveFact) => (topic(fact.topicId).presentation === 'C' ? 10 : 0) + (adaptiveSlot(topic(fact.topicId), response(fact.topicId), fact.path).definition.when ? 3 : 0) + (fact.path.endsWith('.unit') ? 1 : 0);
  const ordered = [...proposal.facts].sort((a, b) => order(a) - order(b));
  for (const fact of ordered) applyFact(fact);
  for (const t of context.topics) activateExistingBranch(t);
  proposal.newItems.forEach((item, index) => {
    const t = topic(item.topicId), current = response(t.id);
    if (current.stopped || stopTopics.has(t.id) || t.presentation === 'C' && current.applicability !== 'applicable') {
      outcome.clarifications.push({ topicId: t.id, path: item.collection, reason: current.stopped || stopTopics.has(t.id) ? 'stopped-topic' : 'condition-unresolved', evidence: item.fields.flatMap(field => field.evidence) }); return;
    }
    // Identity comes from a server source ID, never model key. Sanitized to the capture item-id schema (same as dialogue.ts).
    const itemId = `a${context.source.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 40)}_${index}`;
    responses[t.id] = addCollectionItem(t, current, { path: item.collection, itemId, sourceIds: [context.source.id] }, evidence);
    const fields = [...item.fields].sort((a, b) => (['name', 'term'].includes(a.path) ? -10 : 0) - (['name', 'term'].includes(b.path) ? -10 : 0) + Number(!!adaptiveSlot(t, response(t.id), `${item.collection}[${itemId}].${a.path}`).definition.when) - Number(!!adaptiveSlot(t, response(t.id), `${item.collection}[${itemId}].${b.path}`).definition.when));
    for (const field of fields) applyFact({ ...field, topicId: t.id, path: `${item.collection}[${itemId}].${field.path}` });
    const added = response(t.id).answers[item.collection];
    const saved = added?.state === 'known' && added.items?.find(entry => entry.id === itemId);
    if (saved && !Object.keys(saved.answers).length) {
      responses[t.id] = current;
      for (const clarification of outcome.clarifications) if (clarification.topicId === t.id && clarification.path.startsWith(`${item.collection}[${itemId}].`)) clarification.path = item.collection;
      return;
    }
    outcome.updates.push({ topicId: t.id, path: item.collection, answer: response(t.id).answers[item.collection]! });
  });
  // One coverage projection over accepted facts/acts. Never scan an unproposed source into new facts.
  // The original records remain intact; every projected target uses the same spans and normal apply guards.
  function projectEvidenceCoverage() {
    const accepted = [...outcome.provenance];
    const project = (fact: AdaptiveFact, from: NonNullable<AdaptiveProvenance['derivedFrom']>) => {
      const previous = adaptiveSlot(topic(fact.topicId), response(fact.topicId), fact.path).answer;
      if (previous?.state === fact.state && accepted.some(entry => entry.topicId === fact.topicId && entry.path === fact.path)) return;
      if (previous && ['declined', 'skipped', 'not-applicable'].includes(previous.state)) return;
      const before = outcome.provenance.length;
      applyFact(fact);
      for (const entry of outcome.provenance.slice(before)) entry.derivedFrom = from;
    };
    const q06 = context.topics.find(entry => entry.id === 'Q06');
    const recollections: AdaptiveProvenance[] = [];
    // Explicit condition names only: symptoms/medicines never identify a diagnosis for this projection.
    const conditions: Record<string, RegExp> = {
      diabetes: /\bdiabetes\b/i, prediabetes: /\bpre[- ]?diabetes\b/i,
      bloodPressure: /\b(?:high blood pressure|hypertension)\b/i, cholesterol: /\bhigh cholesterol\b/i,
      heartDisease: /\bheart disease\b/i, stroke: /\bstroke\b/i, sleepApnea: /\bsleep apn[oe]+a\b/i,
      liver: /\b(?:fatty liver|liver disease|liver condition)\b/i, kidney: /\bkidney disease\b/i,
      joint: /\b(?:arthritis|joint condition)\b/i, thyroidHormone: /\b(?:thyroid|hormone) condition\b/i,
      digestive: /\bdigestive condition\b/i,
    };
    if (q06) for (const original of accepted.filter(entry => entry.topicId === 'Q06' && (/^reportedConditions\[[^\]]+\]\.term$/.test(entry.path) || entry.path === 'uncertainDiagnosis' || entry.path.startsWith('conditions.')))) {
      const answer = adaptiveSlot(q06, response('Q06'), original.path).answer;
      if (!answer || !['known', 'uncertain'].includes(answer.state) || original.evidence.length !== 1) continue;
      if (original.path.startsWith('conditions.') && answer.state !== 'uncertain') continue;
      const text = original.sourceText[0];
      const surrounding = around(context.source.text, original.evidence[0].start).text;
      if (!uncertainty.test(text) || !/\b(?:i (?:was|have been|am|might|may|think|suspect)|i'm|i've been|my (?:doctor|clinician) (?:said|told))\b/i.test(text)
        || isQuestion(surrounding) || hypothetical.test(surrounding) || otherSubject.test(surrounding)
        || /\b(?:not|never) (?:told|diagnosed|have|had)\b|\b(?:don't|do not|didn't|did not)\b/i.test(surrounding)) continue;
      const names = Object.entries(conditions).filter(([name, pattern]) => pattern.test(name === 'diabetes' ? text.replace(/\bpre[- ]?diabetes\b/gi, '') : text)).map(([name]) => `conditions.${name}`);
      if (names.length !== 1 || !q06.slots.some(slot => slot.id === names[0])) continue;
      const named = conditions[names[0].slice('conditions.'.length)].exec(text)!;
      const clause = around(text, named.index, true);
      const beforeName = text.slice(clause.start, named.index), afterName = text.slice(named.index + named[0].length, clause.end);
      // Uncertainty about treatment, an owner or another sentence cannot change diagnosis status.
      const uncertainDiagnosis = /\b(?:(?:might|may|could) have|(?:think|suspect)(?: that)? i have|(?:not sure|unsure|uncertain)(?: that)? i have)\s+(?:(?:a|an)\s+)?$/i.test(beforeName)
        || /^\s+(?:diagnosis\s+)?(?:is|was|remains)\s+(?:uncertain|unconfirmed|not confirmed)\b/i.test(afterName);
      if (!uncertainDiagnosis) continue;
      const from = { version: 'evidence-coverage-v1' as const, kind: 'fact' as const, topicId: 'Q06', path: original.path };
      project({ topicId: 'Q06', path: names[0], state: 'uncertain', transform: 'scoped-response', evidence: original.evidence }, from);
      if (response('Q06').answers[names[0]]?.state === 'uncertain') recollections.push(original);
    }
    if (recollections.length && q06?.slots.some(slot => slot.id === 'uncertainDiagnosis')) {
      const spans = recollections.flatMap(entry => entry.evidence).sort((a, b) => a.start - b.start || b.end - a.end)
        .filter((span, index, all) => !all.slice(0, index).some(earlier => earlier.start <= span.start && earlier.end >= span.end));
      if (spans.length <= 4) project({ topicId: 'Q06', path: 'uncertainDiagnosis', state: 'known', transform: 'verbatim', evidence: spans }, {
        version: 'evidence-coverage-v1', kind: 'fact', topicId: 'Q06',
        ...(recollections.length === 1 ? { path: recollections[0].path } : { paths: recollections.map(entry => entry.path) }),
      });
    }
    // A question/request may cover refill help, but never medicine identity, directions, dose or fulfillment.
    if (context.binding.scenario === 'refill' && context.topics.some(entry => entry.id === 'W07')) {
      const requested = outcome.acts.filter(act => act.kind === 'question').flatMap(act => act.evidence).filter(span => {
        const text = quotes(context, [span])[0], surrounding = around(context.source.text, span.start).text;
        if (otherSubject.test(surrounding) || hypothetical.test(surrounding) || /\b(?:don't|do not|never|not)\b/i.test(surrounding)) return false;
        const medical = /\b(?:prescrib(?:e|ing)|prescription|refill|renew|medicine|medication|dose|pharmacy)\b/i.test(text);
        const request = /\b(?:please|tell me|i (?:need|want|would like)|(?:can|could|would|will) you .*(?:my|me|it|this)|(?:prescribe|renew|refill) (?:it|this|my)|(?:what|which|should|can) .*(?:i take|i use|my dose))\b/i.test(text);
        return medical && request;
      }).sort((a, b) => a.start - b.start || b.end - a.end).filter((span, index, all) => !all.slice(0, index).some(earlier => earlier.start <= span.start && earlier.end >= span.end));
      if (requested.length && requested.length <= 4) project({ topicId: 'W07', path: 'help', state: 'known', transform: 'verbatim', evidence: requested }, { version: 'evidence-coverage-v1', kind: 'question' });
    }
    // Only two typed redundancies are suppressed. Actual conflicts/unsafe assertions remain clarifications.
    outcome.clarifications = outcome.clarifications.filter(candidate => {
      if (!['ambiguous-value', 'unscoped-response'].includes(candidate.reason)) return true;
      const contains = (outer: readonly EvidenceSpan[], inner: readonly EvidenceSpan[]) => inner.every(span => outer.some(enclosing => enclosing.sourceId === span.sourceId && enclosing.start <= span.start && enclosing.end >= span.end));
      const root = proposal.facts.find(fact => fact.topicId === candidate.topicId && fact.path === candidate.path && fact.state === 'known' && canonicalJson(fact.evidence) === canonicalJson(candidate.evidence));
      let itemEvidence: EvidenceSpan[] = [];
      if (root && adaptiveSlot(topic(root.topicId), response(root.topicId), root.path).definition.kind === 'collection') {
        const itemFields = accepted.filter(entry => entry.topicId === root.topicId && entry.path.startsWith(`${root.path}[`));
        const itemPaths = [...new Set(itemFields.map(entry => entry.path.slice(0, entry.path.lastIndexOf('].') + 1)))];
        for (const itemPath of itemPaths) {
          const fields = itemFields.filter(entry => entry.path.startsWith(`${itemPath}.`));
          const spans = fields.flatMap(entry => entry.evidence);
          // Full candidate spans must already be recorded; one contained child does not cover other entities.
          const fullSpan = contains(spans, root.evidence);
          const relationship = fields.find(entry => entry.path === `${itemPath}.relationship`);
          const condition = fields.find(entry => entry.path === `${itemPath}.condition`);
          const familyRestatement = root.topicId === 'Q10' && root.path === 'familyHistory' && root.evidence.length === 1
            && relationship && condition && contains(root.evidence, [...relationship.evidence, ...condition.evidence])
            && normalize(quotes(context, root.evidence)[0]) === normalize(`My ${relationship.sourceText.join(' ')} has ${condition.sourceText.join(' ')}`);
          if (fullSpan || familyRestatement) { itemEvidence = spans; break; }
        }
      }
      const uncertainCandidate = candidate.topicId === 'Q06' && (
        proposal.facts.some(fact => fact.topicId === 'Q06' && fact.path === candidate.path && fact.path.startsWith('conditions.') && fact.state === 'uncertain' && canonicalJson(fact.evidence) === canonicalJson(candidate.evidence))
        || candidate.path === 'reportedConditions' && proposal.newItems.some(item => item.topicId === 'Q06' && item.collection === candidate.path && item.fields.length === 1 && item.fields[0].path === 'term' && item.fields[0].state === 'uncertain' && canonicalJson(item.fields[0].evidence) === canonicalJson(candidate.evidence)));
      const question = uncertainCandidate && outcome.acts.find(act => act.kind === 'question' && contains(act.evidence, candidate.evidence) && candidate.evidence.every(span => isQuestion(around(context.source.text, span.start).text)));
      const coverage = itemEvidence.length ? { kind: 'collection-item' as const, evidence: itemEvidence } : question ? { kind: 'question' as const, evidence: question.evidence } : undefined;
      if (!coverage) return true;
      (outcome.coveredCandidates ??= []).push({ ...candidate, coverage });
      return false;
    });
  }
  projectEvidenceCoverage();
  for (const t of context.topics) activateExistingBranch(t);
  for (const list of proposal.completedLists) {
    const text = normalize(quotes(context, list.evidence).join(' '));
    const allowed = context.displayed?.topicId === list.topicId && context.displayed.targetPaths.some(path => path === list.path || path.startsWith(`${list.path}[`));
    const listed = proposal.newItems.some(item => item.topicId === list.topicId && item.collection === list.path);
    const completion = /\b(that's all|that is all|nothing else|no others|no other|finished listing|all of them)\b/;
    const full = quotes(context, list.evidence).join(' ') + ' ' + list.evidence.map(span => around(context.source.text, span.start).text).join(' ') + ' ' + context.source.text.slice(Math.max(...list.evidence.map(span => span.end)));
    const withdrawn = /[?]|\b(not all|isn't all|is not all|aren't all|are not all|there (?:are|is) (?:other|more)|there's more|cannot remember|can't remember|maybe|not sure)\b/i.test(full);
    if (!(allowed || listed) || !completion.test(text) || withdrawn) { outcome.clarifications.push({ topicId: list.topicId, path: list.path, reason: 'unscoped-response', evidence: list.evidence }); continue; }
    if (response(list.topicId).stopped || stopTopics.has(list.topicId)) continue;
    const collection = adaptiveSlot(topic(list.topicId), response(list.topicId), list.path).answer;
    if (collection?.state !== 'known' || !collection.items?.length) { outcome.clarifications.push({ topicId: list.topicId, path: list.path, reason: 'ambiguous-value', evidence: list.evidence }); continue; }
    responses[list.topicId] = finishCollection(topic(list.topicId), response(list.topicId), { path: list.path, sourceIds: [context.source.id] }, evidence);
    outcome.updates.push({ topicId: list.topicId, path: list.path, answer: response(list.topicId).answers[list.path]! });
    outcome.provenance.push({ topicId: list.topicId, path: list.path, evidence: list.evidence, transform: 'explicit-list-completion', sourceText: quotes(context, list.evidence) });
  }
  for (const id of stopTopics) responses[id] = { ...response(id), presented: true, stopped: 'patient-moves-on' };
  // Composite and scalar heights must agree with the explicitly supplied unit.
  const q04 = responses.Q04;
  if (q04) {
    const value = q04.answers['height.value'], unit = q04.answers['height.unit'];
    if (value?.state === 'known' && unit?.state === 'known' && (typeof value.value === 'object') !== (unit.value === 'ft-in')) throw new AdaptiveError('height-unit-conflict');
  }
  if (proposal.next) {
    const t = topic(proposal.next.topicId);
    for (const path of proposal.next.targetPaths) {
      const field = guidedFieldForPath(t, response(t.id), path);
      if (!field.promptIds.includes(proposal.next.promptId)) throw new AdaptiveError('probe-not-allowed');
    }
    outcome.nomination = proposal.next; // Dialogue selection must additionally check current readiness.
  }
  // Source-level question coverage is independent of model-selected acts. Retain omissions explicitly.
  const omitted = regions(context.source.text).filter(region => isQuestion(region.text) || /^\s*(?:tell me|please explain|i wonder)\b/i.test(region.text)).filter(region => !outcome.acts.some(act => act.kind === 'question' && act.evidence.some(span => span.start <= region.start + region.text.search(/\S/) && span.end >= region.end - (/[^\w]$/.test(region.text) ? 1 : 0))));
  if (omitted.length) {
    outcome.unresolvedQuestions = omitted.length <= 32 ? omitted.map(region => ({ sourceId: context.source.id, start: region.start, end: region.end })) : [{ sourceId: context.source.id, start: 0, end: context.source.text.length }];
    const text = omitted.map(region => region.text).join(' ');
    const replyId = /\b(dose|double|skip|repeat|take more|take less|stop taking)\b/i.test(text) ? 'COPY-05' : /\b(eligible|eligibility|prescrib|treatment|medication)\b/i.test(text) ? 'COPY-04' : 'unsupported';
    outcome.acts.push({ kind: 'question', replyId, evidence: outcome.unresolvedQuestions.slice(0, 4) });
  }
  outcome.hasUnresolvedInterpretation = !!outcome.unmapped?.length || !!outcome.unresolvedQuestions?.length || outcome.clarifications.length > 0 || outcome.acts.some(act => act.kind === 'unclear') || outcome.updates.length === 0 && !outcome.acts.some(act => ['question', 'move-on', 'topic-switch'].includes(act.kind));
  const validated = Object.freeze({ binding: Object.freeze({ ...context.binding }), sourceId: context.source.id }) as ValidatedAdaptiveTurn;
  validatedResults.set(validated, { fingerprint: signature(context), outcome });
  return validated;
}

/** Returns content-native values only. Persistence/confirmation/delivery stay with the API. */
export function applyValidatedTurn(context: AdaptiveContext, turn: ValidatedAdaptiveTurn): AdaptiveOutcome {
  const stored = validatedResults.get(turn);
  if (!stored || stored.fingerprint !== signature(context)) throw new AdaptiveError('stale-adaptive-context');
  return structuredClone(stored.outcome);
}
