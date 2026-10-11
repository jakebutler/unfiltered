import { createHash } from 'node:crypto';
import { canonicalJson } from '../../clinical-core/src/domain.js';
import { parseGuidedValue, type Scalar, type TopicResponse, type SlotDefinition } from '../../clinic-content/src/index.js';
import { adaptiveTargetCatalog } from './dialogue.js';
import { adaptiveSourceSegments, resolveSegmentQuote } from './adaptive-source.js';
import { parseExplicitHeight, type AdaptiveContext, type EvidenceSpan } from './adaptive-validation.js';
import type { Draft, AdaptiveOperation } from './types.js';
import type { ProposedClaim, ReplyDraft, SourceAddress } from './adaptive-reply.js';

export const provisionalPolicy = 'provisional-context-v1' as const;
/** Binds full schema, catalog, normalization and projection; not a qualification. */
export const fullProvisionalPolicy = 'provisional-intake-v2' as const;
export type ProvisionalPolicy = typeof provisionalPolicy | typeof fullProvisionalPolicy;
export interface ProvisionalClaim {
  id: string; topicId: string; path: string; sourceId: string;
  state: ProposedClaim['state']; value: Scalar | null;
  highlight?: EvidenceSpan; evidence: EvidenceSpan[]; valueEvidence: EvidenceSpan | null;
  scope: Omit<ProposedClaim['scope'], 'predicate'> & { predicate: EvidenceSpan | null }; correctsSourceIds: string[];
  attribution: 'proposed-patient-report'; policy: ProvisionalPolicy;
  status: 'proposed' | 'superseded' | 'conflicting';
  fidelity: 'literal-supported' | 'model-interpreted';
}
export interface ProvisionalGap {
  targetId?: string; topicId?: string; path?: string; recordId?: string; detail?: string; evidence: EvidenceSpan[];
  reason: 'invalid-type' | 'unsupported-state' | 'ownership' | 'unsupported-unknown' | 'value-not-in-source' | 'temporal-crop' | 'unsupported-target' | 'ambiguous' | 'capacity' | 'conflict' | 'recognition-unreviewed' | 'unaddressed-source';
}
export interface ProvisionalCapture {
  sourceId: string; policy: ProvisionalPolicy; interpretationProfile?: 'turn-bound-typed-v1'; sourceBinding?: { digest: string; bindingDigest: string }; diagnostics?: { recordId: string; reason: 'invalid-highlight'; }[]; claims: ProvisionalClaim[]; gaps: ProvisionalGap[];
  items?: { topicId: string; collection: string; id: string; entity: string; evidence: EvidenceSpan[] }[];
  closures?: { topicId: string; collection: string; evidence: EvidenceSpan[] }[];
  acts?: { kind: 'move-on' | 'topic-switch' | 'question'; attribution?: 'direct-patient-command' | 'reported-content' | 'unclear'; topicId: string; evidence: EvidenceSpan[] }[];
  /** Mechanical addressing is never a semantic completeness certificate. */
  accounting: { addressed: EvidenceSpan[]; remaining: EvidenceSpan[]; structural?: EvidenceSpan[]; semanticReview: 'qualification-required' };
}
/** Persisted typed lineage is checked before any projection or readiness credit. */
export const provisionalBindingDigest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
export function typedCaptureBound(draft: Draft, operation: AdaptiveOperation): boolean {
  const capture = operation.stream?.provisional;
  if (capture?.interpretationProfile !== 'turn-bound-typed-v1') return true;
  const turn = draft.turns.find(t => t.id === operation.sourceId && t.role === 'patient');
  const binding = operation.binding;
  const spans = [...capture.claims.flatMap(c => [...c.evidence, ...(c.highlight ? [c.highlight] : [])]), ...(capture.items ?? []).flatMap(i => i.evidence), ...(capture.closures ?? []).flatMap(c => c.evidence), ...(capture.acts ?? []).flatMap(c => c.evidence)];
  return !!turn && capture.sourceId === turn.id && binding.operationId === operation.id && binding.sessionId === draft.id && binding.patient === draft.patient && binding.scenario === draft.scenario
    && capture.sourceBinding?.digest === provisionalBindingDigest(turn) && capture.sourceBinding.bindingDigest === provisionalBindingDigest(binding)
    && capture.claims.every(c => c.sourceId === turn.id && c.scope.predicate === null && c.valueEvidence === null)
    && spans.every(s => s.sourceId === turn.id && Number.isInteger(s.start) && Number.isInteger(s.end) && s.start >= 0 && s.end > s.start && s.end <= turn.text.length);
}
export function gapAffectsUnit(gap: ProvisionalGap, topicId: string, path: string): boolean {
  return gap.reason !== 'recognition-unreviewed' && (gap.topicId === topicId && (!gap.path || gap.path === path || path.startsWith(gap.path + '[') || path.startsWith(gap.path + '.')));
}
const uncertainty = /\b(?:not sure|uncertain|unsure|don['’]?t know|do not know|can['’]?t recall|cannot recall|can['’]?t remember|cannot remember)\b/i;
const explicitUncertain = /\b(?:not sure|uncertain|unsure)\b/i;
const decline = /\b(?:prefer not|rather not|don['’]?t want to|do not want to|decline|private|skip)\b/i;
const otherPerson = /\b(?:my|his|her|their)\s+(?:mother|father|parent|sister|brother|partner|wife|husband|daughter|son|friend|patient)\b/i;
const roleUncertainty = /\b(?:my|the)\s+(?:doctor|clinician|dietitian|nurse)\s+(?:does(?:n['’]t| not)\s+know|is\s+(?:unsure|uncertain|not sure))\b/i;
const patientOnlyTargets = /^(?:height\.|lastMeasuredWeight\.|currentWeightEstimate\.|conditions\.|reportedConditions\[|medicines\[)/;
const calendar = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:\s*,?\s*\d{4})?\b/gi;
const unitSources: Record<string, RegExp> = { lb: /\b(?:pounds?|lbs?)\b/i, kg: /\b(?:kilograms?|kg)\b/i, st: /\b(?:stones?|st)\b/i, cm: /\b(?:centimet(?:er|re)s?|cm)\b/i, m: /\b(?:met(?:er|re)s?|m)\b/i, in: /\b(?:inches|inch|in)\b|"/i, ft: /\b(?:feet|foot|ft)\b|'/i, 'ft-in': /(?:\b(?:feet|foot|ft)\b|').*(?:\b(?:inches|inch|in)\b|")/i };
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
export function provisionalSubjects(path: string): ('patient' | 'other')[] {
  return /^familyHistory(?:\[|$)/.test(path) ? ['other'] : ['patient'];
}
/** Other-owned family reports stay other-owned. This permits only the family
 * list boundary with a named source anchor, never patient condition targets;
 * relationship/condition meaning still requires empirical qualification. */
export function allowsProvisionalOtherOwner(path:string,entity:string|null,predicate:string): boolean {
  return /^familyHistory\[[^\]]+\]\.(?:condition|relationship)$/.test(path)&&!!entity?.trim()&&predicate.toLowerCase().includes(entity.trim().toLowerCase());
}
/** Reuse the existing exact parser, including when evidence contains a carrier
 * sentence. Four tokens cover its existing feet/unit/inches/unit grammar. */
function explicitHeightQuantities(text: string) {
  const quantities = new Map<number, { feet: number; inches: number }>();
  const collect = (phrase: string) => { const value = parseExplicitHeight(phrase.replace(/[.,!?;:]+$/, '')); if (value) quantities.set(value.feet * 12 + value.inches,value); };
  collect(text.trim());
  const tokens = text.match(/\S+/g) ?? [];
  for (let start = 0; start < tokens.length; start++) for (let size = 1; size <= 4 && start + size <= tokens.length; size++) collect(tokens.slice(start,start + size).join(' '));
  return [...quantities.values()];
}

/** Typed normalization is independent of whether the proposed meaning is correct. */
export function normalizeProposedValue(field: { kind: string; choices: readonly (string | number | boolean)[] | null }, value: ProposedClaim['value']): Scalar {
  if (field.kind === 'height-value' && typeof value === 'string') {
    const height = parseExplicitHeight(value); if (height) return height;
  }
  if (field.kind === 'height-value' && value && typeof value === 'object') return parseGuidedValue({ kind: 'height-value', choices: undefined }, { feet: String(value.feet), inches: String(value.inches) });
  if (!['text', 'positive-number', 'height-value', 'choice', 'presence'].includes(field.kind) || value === null || typeof value === 'object') throw new Error('invalid-type');
  return parseGuidedValue({ kind: field.kind as 'text' | 'positive-number' | 'height-value' | 'choice' | 'presence', choices: field.choices ?? undefined }, String(value));
}
export function accountForSource(context: { source: Pick<AdaptiveContext['source'], 'id' | 'text'> }, evidence: EvidenceSpan[], claims: readonly ProvisionalClaim[]): { remaining: EvidenceSpan[]; structural: EvidenceSpan[] } {
  const intervals = evidence.filter(span => span.sourceId === context.source.id).map(span => [span.start, span.end]).sort((a, b) => a[0] - b[0]);
  let cursor = 0; const remaining: EvidenceSpan[] = [], structural: EvidenceSpan[] = [];
  const represented = claims.filter(claim => claim.status === 'proposed').map(claim => ({ id: claim.id, spans: [...claim.evidence, ...(claim.scope.predicate ? [claim.scope.predicate] : []), ...(claim.valueEvidence ? [claim.valueEvidence] : [])].filter(span => span.sourceId === context.source.id) }));
  for (const [start, end] of [...intervals, [context.source.text.length, context.source.text.length]]) {
    if (start > cursor && /[\p{L}\p{N}]/u.test(context.source.text.slice(cursor, start))) {
      const span = { sourceId: context.source.id, start: cursor, end: start };
      // Only a standalone coordinator between two admitted claims is structural.
      // This never accounts for a model residual or supplies evidence for a fact.
      const betweenClaims = represented.some(left => left.spans.some(s => s.end === cursor)
        && represented.some(right => right.id !== left.id && right.spans.some(s => s.start === start)));
      if (cursor > 0 && start < context.source.text.length && /^\s+and\s+$/iu.test(context.source.text.slice(cursor, start)) && betweenClaims) structural.push(span);
      else remaining.push(span);
    }
    cursor = Math.max(cursor, end);
  }
  return { remaining, structural };
}

/** Candidate policy: retain attributed self-report, never clinical verification.
 * Scope interpretation remains an empirical qualification question. These known
 * rejection guards are not a whitelist proving arbitrary-language meaning.
 */
export interface ProvisionalTarget { topicId: string; path: string; kind: string; choices: readonly (string | number | boolean)[] | null; definition: SlotDefinition }
export function prepareProvisionalCapture(context: AdaptiveContext, draft: ReplyDraft, issuedTargets?: ReadonlyMap<string, ProvisionalTarget>): ProvisionalCapture {
  const segments = adaptiveSourceSegments(context), catalog = adaptiveTargetCatalog(context.topics, context.responses);
  const targets = new Map<string, ProvisionalTarget>();
  for (const topic of catalog) topic.fields.forEach((field, index) => {
    const definition = context.topics.find(item => item.id === topic.id)?.slots.find(slot => slot.id === field[0]);
    if (definition) targets.set(`${topic.id}-${index}`, { topicId: topic.id, path: definition.id, kind: definition.kind, choices: definition.choices ?? null, definition });
  });
  if (issuedTargets) { targets.clear(); for (const [id, target] of issuedTargets) targets.set(id, target); }
  const address = (evidence: SourceAddress) => resolveSegmentQuote(context, segments, { segmentId: evidence.statementId, quote: evidence.quote, anchor: evidence.anchor });
  const claims: ProvisionalClaim[] = [], gaps: ProvisionalGap[] = [], addressed: EvidenceSpan[] = [];
  const heights = new Map<string, ReturnType<typeof explicitHeightQuantities>>();
  for (const candidate of draft.claims) {
    const target = targets.get(candidate.targetId), evidence = candidate.evidence.map(address), predicate = address(candidate.scope.predicate);
    const valueEvidence = candidate.valueEvidence ? address(candidate.valueEvidence) : null;
    const reject = (reason: ProvisionalGap['reason']) => { gaps.push({ targetId: candidate.targetId, evidence: [...evidence, predicate], reason }); };
    if (!target) { reject('unsupported-target'); continue; }
    const sentence = segments.find(segment => segment.kind === 'sentence' && segment.start <= predicate.start && segment.end >= predicate.end)?.text ?? context.source.text;
    const familyOther=candidate.scope.subject==='other'&&allowsProvisionalOtherOwner(target.path,candidate.scope.entity,candidate.scope.predicate.quote);
    if (candidate.scope.subject !== 'patient'&&!familyOther || patientOnlyTargets.test(target.path) && otherPerson.test(sentence)) { reject('ownership'); continue; }
    if (patientOnlyTargets.test(target.path) && ['unknown', 'uncertain'].includes(candidate.state) && roleUncertainty.test(candidate.scope.predicate.quote)) { reject('ownership'); continue; }
    // No finite phrase whitelist for spontaneous uncertainty/refusal. Preserve
    // nonliteral interpretations for empirical review; reject the known calendar
    // precision fabrication rather than deriving an unknown from a supplied date.
    if (candidate.state === 'unknown' && target.path.endsWith('datePrecision') && !uncertainty.test(candidate.scope.predicate.quote)
      && [...candidate.scope.predicate.quote.matchAll(calendar)].length) { reject('unsupported-unknown'); continue; }
    const definition = target.definition;
    if (candidate.state === 'negative' && (!definition?.acceptsNegative || definition.extractionNegativeScope === 'composite') || candidate.state === 'not-applicable' && !definition?.acceptsNotApplicable) { reject('unsupported-state'); continue; }
    let state = candidate.state, value: Scalar | null = null, fidelity: ProvisionalClaim['fidelity'] = 'literal-supported';
    if (['unknown', 'uncertain'].includes(state) && !uncertainty.test(candidate.scope.predicate.quote)
      || state === 'declined' && !decline.test(candidate.scope.predicate.quote)) fidelity = 'model-interpreted';
    if (candidate.state === 'known') {
      try { value = normalizeProposedValue(target, candidate.value); } catch { reject('invalid-type'); continue; }
      if ((target.topicId === 'W05' && target.path === 'serviceDate' || target.topicId === 'W06' && target.path === 'requestedDate') && typeof value === 'string'
        && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) { reject('invalid-type'); continue; }
      const text = candidate.valueEvidence?.quote ?? '';
      if (target.kind === 'height-value' && !heights.has(text)) heights.set(text,explicitHeightQuantities(text));
      const supportedHeights = target.kind === 'height-value' ? heights.get(text)! : [];
      if (supportedHeights.length > 1) { reject('ambiguous'); continue; }
      const explicitHeight = supportedHeights[0];
      if (explicitHeight) {
        const units = draft.claims.filter(claim => claim.state === 'known' && targets.get(claim.targetId)?.topicId === target.topicId
          && targets.get(claim.targetId)?.path === 'height.unit' && typeof claim.value === 'string'
          && unitSources[claim.value]?.test(claim.valueEvidence?.quote ?? '')).map(claim => String(claim.value));
        const existingUnit = context.responses[target.topicId]?.answers['height.unit'];
        if (!units.length && existingUnit?.state === 'known' && typeof existingUnit.value === 'string') units.push(existingUnit.value);
        const uniqueUnits = [...new Set(units)], factor: Record<string, number> = { in: 1, ft: 12, cm: 1 / 2.54, m: 100 / 2.54 };
        const inches = typeof value === 'object' ? value.feet * 12 + value.inches
          : typeof value === 'number' && uniqueUnits.length === 1 && factor[uniqueUnits[0]] ? value * factor[uniqueUnits[0]] : undefined;
        if (inches === undefined || Math.abs(inches - (explicitHeight.feet * 12 + explicitHeight.inches)) > 1e-8) { reject('value-not-in-source'); continue; }
      }
      if (target.path.endsWith('.unit') && typeof value === 'string' && !unitSources[value]?.test(text)) { reject('value-not-in-source'); continue; }
      if (typeof value === 'boolean' && uncertainty.test(candidate.scope.predicate.quote)) { reject('unsupported-state'); continue; }
      if (typeof value === 'number' && !explicitHeight) {
        const literals = [...text.matchAll(/\b\d+(?:\.\d+)?\b/g)].map(match => Number(match[0]));
        if (!literals.includes(value)) { if (literals.length) { reject('value-not-in-source'); continue; } fidelity = 'model-interpreted'; }
      }
      if (typeof value === 'object' && !explicitHeight) {
        const phrase = typeof candidate.value === 'string' ? candidate.value : `${value.feet} feet ${value.inches} inches`;
        if (!text.toLowerCase().includes(phrase.toLowerCase())) fidelity = 'model-interpreted';
      }
      if (typeof value === 'string' && target.kind === 'text') {
        if (!text.includes(value)) fidelity = 'model-interpreted';
        const temporalValue = value;
        if (target.path.endsWith('measuredWhen') && [...text.matchAll(calendar)].some(match => match[0].includes(temporalValue) && temporalValue !== match[0])) { reject('temporal-crop'); continue; }
      }
    } else if (candidate.state === 'unknown' && explicitUncertain.test(candidate.scope.predicate.quote)) state = 'uncertain';
    const claim: ProvisionalClaim = { id: digest({ sourceId: context.source.id, target: candidate.targetId, candidate }), topicId: target.topicId, path: target.path,
      sourceId: context.source.id, state, value, evidence, valueEvidence, scope: { ...structuredClone(candidate.scope), predicate }, correctsSourceIds: [...candidate.correctsSourceIds], attribution: 'proposed-patient-report', policy: provisionalPolicy, status: 'proposed', fidelity };
    claims.push(claim); addressed.push(...evidence, predicate, ...(valueEvidence ? [valueEvidence] : []));
  }
  for (const residual of draft.residual) gaps.push({ evidence: residual.evidence.map(address), reason: residual.reason });
  const { remaining, structural } = accountForSource(context, addressed, claims); // Remaining characters are an audit diagnostic, not a semantic omission verdict.
  if ('channel' in context.source && context.source.channel === 'unreviewed-transcript') gaps.push({ evidence: [{ sourceId: context.source.id, start: 0, end: context.source.text.length }], reason: 'recognition-unreviewed' });
  return { sourceId: context.source.id, policy: provisionalPolicy, claims, gaps, accounting: { addressed, remaining, ...(structural.length ? { structural } : {}), semanticReview: 'qualification-required' } };
}
/** Used only after pinned policy qualification; projections never change raw source. */
export function provisionalResponses(direct: AdaptiveContext['responses'], captures: readonly ProvisionalCapture[], qualification: { policy: typeof provisionalPolicy; status: 'qualified' }): Record<string, TopicResponse | undefined> {
  if (qualification?.policy !== provisionalPolicy || qualification?.status !== 'qualified') throw new Error('provisional-policy-unqualified');
  const result = structuredClone(direct) as Record<string, TopicResponse | undefined>;
  const directTargets = new Set(Object.entries(direct).flatMap(([topicId, response]) => Object.keys(response?.answers ?? {}).map(path => `${topicId}:${path}`)));
  for (const capture of captures) for (const claim of capture.claims) {
    if (claim.status !== 'proposed') continue;
    const response = result[claim.topicId] ?? { presented: true, answers: {} };
    if (directTargets.has(`${claim.topicId}:${claim.path}`)) continue; // Direct patient correction wins.
    result[claim.topicId] = { ...response, answers: { ...response.answers, [claim.path]: claim.state === 'known' && claim.value !== null ? { state: 'known', value: claim.value, sourceIds: [claim.sourceId] } : { state: claim.state === 'known' ? 'uncertain' : claim.state, sourceIds: [claim.sourceId], note: 'Proposed patient self-report; source remains available for review.' } } };
  }
  return result;
}
