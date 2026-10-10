import { z } from 'zod';
import { addCollectionItem, applyGuidedAnswer, diabetesBranchApplicability, evaluateSlots, finishCollection, guidedFieldForPath, type ScenarioId, type SlotAnswer, type SlotAnswers, type SlotDefinition, type TopicDefinition, type TopicResponse } from '../../clinic-content/src/index.js';
import { canonicalJson } from '../../clinical-core/src/domain.js';
import { escalation } from './safety.js';

export class AdaptiveError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'AdaptiveError'; }
}
export interface AdaptiveSource { id: string; role: 'patient' | 'assistant'; text: string; at: string; }
export interface AdaptiveBinding {
  operationId: string; sessionId: string; patient: string; scenario: ScenarioId;
  revision: number; contentVersion: string; snapshotDigest: string;
}
export interface DisplayedPrompt { topicId: string; promptId: string; targetPaths: readonly string[]; }
export interface DialogueState { activeTopicId?: string; suspended?: DisplayedPrompt; }
export interface AdaptiveContext {
  /** Trusted server data. Binding and patient/session identity must never enter the provider prompt. */
  binding: AdaptiveBinding;
  source: AdaptiveSource;
  sources: readonly AdaptiveSource[];
  topics: readonly TopicDefinition[];
  responses: Readonly<Record<string, TopicResponse | undefined>>;
  displayed?: DisplayedPrompt;
  dialogue?: DialogueState;
  safetyPaused?: boolean;
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
export const adaptiveProposalSchema = z.object({
  schema: z.literal(1),
  facts: z.array(factSchema).max(32),
  newItems: z.array(z.object({ topicId: z.string().min(1).max(40), collection: pathSchema, key: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), fields: z.array(itemFieldSchema).min(1).max(12) }).strict()).max(8),
  completedLists: z.array(z.object({ topicId: z.string().min(1).max(40), path: pathSchema, evidence: spansSchema }).strict()).max(8),
  acts: z.array(z.object({ kind: z.enum(['answer', 'question', 'correction', 'move-on', 'topic-switch', 'unclear']), evidence: spansSchema, targetTopicId: z.string().min(1).max(40).optional(), replyId: z.string().min(1).max(120).optional() }).strict()).max(4),
  next: z.object({ topicId: z.string().min(1).max(40), promptId: z.string().min(1).max(120), targetPaths: z.array(pathSchema).min(1).max(12) }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.facts.length + value.newItems.reduce((n, item) => n + item.fields.length, 0) > 32) ctx.addIssue({ code: 'custom', message: 'candidate-limit' });
});
export type AdaptiveProposal = z.infer<typeof adaptiveProposalSchema>;
export type EvidenceSpan = z.infer<typeof spanSchema>;
export type AdaptiveFact = z.infer<typeof factSchema>;
export type ValidatedAct = AdaptiveProposal['acts'][number];
export interface AdaptiveUpdate { topicId: string; path: string; answer: SlotAnswer; }
export interface AdaptiveProvenance {
  topicId: string; path: string; evidence: EvidenceSpan[]; transform: string; sourceText: string[];
  correctsSourceIds?: string[];
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
  acts: ValidatedAct[];
  nomination?: AdaptiveProposal['next'];
  sourceId: string;
  /** Empty/failed interpretation is not a fully mapped patient statement. */
  hasUnresolvedInterpretation: boolean;
}
declare const validatedBrand: unique symbol;
export interface ValidatedAdaptiveTurn { readonly [validatedBrand]: true; readonly binding: AdaptiveBinding; readonly sourceId: string; }
const validatedResults = new WeakMap<ValidatedAdaptiveTurn, { fingerprint: string; outcome: AdaptiveOutcome }>();
const emptyResponse = (): TopicResponse => ({ presented: false, answers: {} });
const signature = (context: AdaptiveContext) => canonicalJson(context);
const sameAnswer = (a: SlotAnswer, b: SlotAnswer) => canonicalJson({ ...a, sourceIds: [] }) === canonicalJson({ ...b, sourceIds: [] });
const normalize = (text: string) => text.trim().toLowerCase().replace(/[’]/g, "'").replace(/[.!?]+$/, '').trim();
const uncertainty = /\b(maybe|might|possibly|not sure|unsure|uncertain|think|suspect)\b/i;
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
function explicitConditionMention(path: string, text: string) {
  if (path === 'conditions.diabetes' && /\bpre[- ]?diabetes\b/i.test(text) && !/\bdiabetes\b/i.test(text.replace(/\bpre[- ]?diabetes\b/gi, ''))) return false;
  const names: Record<string, RegExp> = {
    diabetes: /\bdiabetes\b/i, prediabetes: /\bpre[- ]?diabetes\b/i, bloodPressure: /\bhigh blood pressure|hypertension\b/i,
    cholesterol: /\bhigh cholesterol\b/i, heartDisease: /\bheart disease\b/i, stroke: /\bstroke\b/i,
    sleepApnea: /\bsleep apn[oe]+a\b/i, liver: /\bliver\b/i, kidney: /\bkidney\b/i, joint: /\barthritis|joint\b/i,
    thyroidHormone: /\bthyroid|hormone\b/i, digestive: /\bdigestive\b/i,
  };
  return names[path.replace('conditions.', '')]?.test(text) ?? false;
}

function deriveAnswer(context: AdaptiveContext, fact: AdaptiveFact, definition: SlotDefinition, sourceText: string[]): SlotAnswer | undefined {
  const text = sourceText.join(' '), clean = normalize(text), sourceIds = [context.source.id];
  if (fact.state !== 'known') {
    const stateMatch = fact.state === 'negative' ? /^(no|none|none that i know of|none known|no concerns|no changes)$/.test(clean) || negation.test(clean)
      : fact.state === 'unknown' ? /\b(don't know|do not know|don't remember|cannot recall|can't recall|unknown)\b/.test(clean)
      : fact.state === 'uncertain' ? uncertainty.test(clean)
      : fact.state === 'declined' ? /\b(prefer not|rather not|don't want|do not want|rather discuss|skip|move on)\b/.test(clean)
      : /\b(not applicable|doesn't apply|does not apply)\b/.test(clean);
    if (!stateMatch || (fact.state === 'negative' && !definition.acceptsNegative) || (fact.state === 'not-applicable' && !definition.acceptsNotApplicable)) return;
    if (fact.path.startsWith('conditions.') && !explicitConditionMention(fact.path, text) && !(scoped(context, fact) && /^(no|none|none that i know of|none known)$/.test(clean))) return;
    if (fact.state === 'negative' && uncertainty.test(clean)) return;
    // Unscoped single-word negatives/refusals cannot populate arbitrary unrelated fields.
    if (sourceText.length === 1 && /^(no|none|unknown|not sure|skip|move on|not applicable|i don't know|i do not know|i don't remember|i cannot recall|i prefer not to answer)$/.test(clean) && !scoped(context, fact)) return;
    return { state: fact.state, sourceIds, note: text };
  }
  if (definition.kind === 'configuration' || definition.kind === 'collection') return;
  if (fact.transform === 'verbatim') {
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
    if (!Number.isFinite(value) || value <= 0) return;
    const before = context.source.text.slice(Math.max(0, fact.evidence[0].start - 24), fact.evidence[0].start);
    const after = context.source.text.slice(fact.evidence[0].end, fact.evidence[0].end + 16);
    if (/\b(?:not|or)\s*$/i.test(before) || /^\s*or\s+\d/i.test(after)) return;
    const clauseBefore = context.source.text.slice(0, fact.evidence[0].start).split(/[;,\n]/).at(-1)!.slice(-100);
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
    if (fact.path.startsWith('conditions.') && explicitConditionMention(fact.path, text) && /\b(have|diagnosed|told)\b/i.test(text)) return { state: 'known', value: true, sourceIds };
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
      if (/\b(no longer|changed|different now|not.*current|doesn't.*reflect|does not.*reflect)\b/i.test(text)) value = false;
      else if (/\b(still reflects|still represents|still the same|unchanged)\b/i.test(text) && !uncertainty.test(text)) value = true;
    }
    if (value === undefined && fact.path === 'lastMeasuredWeight.describedAsOld' && /\b(old|outdated|a while ago)\b/i.test(text)) value = true;
    if (value === undefined && singleScoped(context, fact) && /^(yes|true|no|false)$/.test(clean)) value = /^(yes|true)$/.test(clean);
    return value !== undefined && definition.choices?.includes(value) ? { state: 'known', value, sourceIds } : undefined;
  }
}

function conditionalReady(definition: SlotDefinition, siblings: SlotAnswers, definitions: readonly SlotDefinition[], context: AdaptiveContext): boolean {
  if (!definition.when) return true;
  // Delegate content-specific positive/estimate/uncertain semantics to the existing readiness implementation.
  const ready = evaluateSlots(definitions, siblings, { validSourceIds: new Set(context.sources.filter(source => source.role === 'patient').map(source => source.id)) }).find(result => result.id === definition.id)!;
  // A volunteered explicit detail may be retained before its anchor is settled; readiness still
  // keeps the conditional target unresolved. An explicit negative anchor must not be contradicted silently.
  return ready.state !== 'not-applicable';
}

/** Validate all schema/scope first; return explicit deferred ambiguity, never invented values. */
export function validateAdaptiveProposal(raw: unknown, context: AdaptiveContext): ValidatedAdaptiveTurn {
  verifyContext(context);
  const parsed = adaptiveProposalSchema.safeParse(raw);
  if (!parsed.success) throw new AdaptiveError('invalid-adaptive-proposal');
  if (context.safetyPaused || escalation(context.source.text)) throw new AdaptiveError('safety-interruption');
  const proposal = parsed.data;
  const responses = structuredClone(context.responses) as Record<string, TopicResponse | undefined>;
  const outcome: AdaptiveOutcome = { responses, updates: [], provenance: [], clarifications: [], acts: [], sourceId: context.source.id, hasUnresolvedInterpretation: false };
  const evidence = { validSourceIds: new Set(context.sources.filter(source => source.role === 'patient').map(source => source.id)) };
  const topic = (id: string) => { const found = context.topics.find(entry => entry.id === id); if (!found) throw new AdaptiveError('topic-not-allowed'); return found; };
  const response = (id: string) => responses[id] ?? emptyResponse();
  const activateExistingBranch = (t: TopicDefinition) => {
    if (t.presentation !== 'C' || response(t.id).applicability === 'applicable') return;
    const answers = response('Q06').answers;
    const anchor = t.id === 'DM' ? ['conditions.diabetes', 'conditions.prediabetes'] : t.id === 'SLEEP' ? ['conditions.sleepApnea'] : t.id === 'GI' ? ['conditions.digestive'] : [];
    const positive = anchor.some(path => answers[path]?.state === 'known' && (answers[path] as { value?: unknown }).value === true && answers[path]!.sourceIds?.every(id => evidence.validSourceIds.has(id)));
    if (positive && (t.id !== 'DM' || diabetesBranchApplicability(answers, evidence) === 'applicable')) responses[t.id] = { ...response(t.id), applicability: 'applicable', applicabilitySourceIds: anchor.flatMap(path => answers[path]?.sourceIds ?? []) };
  };
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
    if (act.kind === 'question' && !/[?]|\b(why|how|what|when|where|can|could|should|would|tell me)\b/i.test(text)) throw new AdaptiveError('question-evidence-required');
    outcome.acts.push(act);
  }
  const stopTopics = new Set(outcome.acts.filter(act => act.kind === 'move-on').map(act => act.targetTopicId!));
  const reopenedTopics = new Set(outcome.acts.filter(act => act.kind === 'topic-switch' && !stopTopics.has(act.targetTopicId!)).map(act => act.targetTopicId!));
  for (const id of reopenedTopics) if (response(id).stopped) responses[id] = { ...response(id), stopped: undefined };
  function applyFact(fact: AdaptiveFact) {
    const t = topic(fact.topicId); activateExistingBranch(t);
    const current = response(t.id), resolved = adaptiveSlot(t, current, fact.path), sourceText = quotes(context, fact.evidence);
    const deferred = (reason: AdaptiveClarification['reason'], proposed?: SlotAnswer) => outcome.clarifications.push({ topicId: t.id, path: fact.path, reason, evidence: fact.evidence, ...(resolved.answer ? { previous: resolved.answer } : {}), ...(proposed ? { proposed } : {}) });
    if (current.stopped || stopTopics.has(t.id)) { deferred('stopped-topic'); return; }
    if ((t.presentation === 'C' && current.applicability !== 'applicable') || !conditionalReady(resolved.definition, resolved.siblings, resolved.definitions, context)) { deferred('condition-unresolved'); return; }
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
      if (!prior || prior.state === 'not-asked' || canonicalJson([...new Set(prior.sourceIds)].sort()) !== canonicalJson([...new Set(fact.correctsSourceIds)].sort()) || !/\b(correction|correct that|actually|i meant|i mean|not .* but)\b/i.test(context.source.text)) throw new AdaptiveError('invalid-correction-target');
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
  proposal.newItems.forEach((item, index) => {
    const t = topic(item.topicId), current = response(t.id);
    if (current.stopped || stopTopics.has(t.id) || t.presentation === 'C' && current.applicability !== 'applicable') {
      outcome.clarifications.push({ topicId: t.id, path: item.collection, reason: current.stopped || stopTopics.has(t.id) ? 'stopped-topic' : 'condition-unresolved', evidence: item.fields.flatMap(field => field.evidence) }); return;
    }
    // Codepoints avoid lossy sanitization collisions. Identity comes from a server source ID, never model key.
    const itemId = `a${Array.from(context.source.id).map(char => char.codePointAt(0)!.toString(16)).join('_')}_${index}`;
    responses[t.id] = addCollectionItem(t, current, { path: item.collection, itemId, sourceIds: [context.source.id] }, evidence);
    const fields = [...item.fields].sort((a, b) => Number(!!adaptiveSlot(t, response(t.id), `${item.collection}[${itemId}].${a.path}`).definition.when) - Number(!!adaptiveSlot(t, response(t.id), `${item.collection}[${itemId}].${b.path}`).definition.when));
    for (const field of fields) applyFact({ ...field, topicId: t.id, path: `${item.collection}[${itemId}].${field.path}` });
    outcome.updates.push({ topicId: t.id, path: item.collection, answer: response(t.id).answers[item.collection]! });
  });
  for (const list of proposal.completedLists) {
    const text = normalize(quotes(context, list.evidence).join(' '));
    const allowed = context.displayed?.topicId === list.topicId && context.displayed.targetPaths.some(path => path === list.path || path.startsWith(`${list.path}[`));
    const listed = proposal.newItems.some(item => item.topicId === list.topicId && item.collection === list.path);
    if (!(allowed || listed) || !/\b(that's all|that is all|nothing else|no others|no other|finished listing|all of them)\b/.test(text)) { outcome.clarifications.push({ topicId: list.topicId, path: list.path, reason: 'unscoped-response', evidence: list.evidence }); continue; }
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
  outcome.hasUnresolvedInterpretation = outcome.clarifications.length > 0 || outcome.acts.some(act => act.kind === 'unclear') || outcome.updates.length === 0 && !outcome.acts.some(act => ['question', 'move-on', 'topic-switch'].includes(act.kind));
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
