import { AdaptiveError, adaptiveValueProposalSchema, parseExplicitHeight, validateAdaptiveProposal, applyValidatedTurn, type AdaptiveContext, type AdaptiveFact, type AdaptiveValueProposal, type EvidenceSpan, type AdaptiveOutcome, type AdaptiveClarification } from './adaptive-validation.js';
import { issuedAdaptiveGroupManifest, type AdaptiveGroupManifest, type GroupEntity, type GroupFamily, type GroupRole } from './adaptive-group-manifest.js';
import { resolveSegmentQuote } from './adaptive-source.js';
import type { SlotAnswer } from '../../clinic-content/src/index.js';
import { canonicalJson } from '../../clinical-core/src/domain.js';
import { issuedAdaptiveSourceExpansion } from './adaptive-group-v7.js';

type State = AdaptiveFact['state'];
interface Address { segment: string; quote: string; }
interface Answer { state: State; value: Address | null; support: Address[]; }
interface Field { role: string; answer: Answer; }
interface Group { kind: string; key: string; scope: 'patient' | { mode: 'new'; anchor: Field } | { mode: 'existing'; ref: string; anchor: Address[] }; fields: Field[]; correct: number[]; }
interface Wire {
  groups: Group[];
  completedLists: { family: string; support: Address[] }[];
  absentLists: { family: string; support: Address[] }[];
  sharedConcerns: { family: 'Q08.medicines'; entities: string[]; answer: Answer }[];
  acts: ({ kind: 'question'; support: Address[]; reply: string } | { kind: 'move-on' | 'topic-switch'; support: Address[]; topic: string })[];
  unmapped: { support: Address[]; reason: 'ambiguous' | 'unsupported-target' | 'capacity' }[];
}
interface ResolvedAnswer { state: State; evidence: EvidenceSpan[]; valueEvidence: EvidenceSpan | null; }
interface ResolvedField { role: string; answer: ResolvedAnswer; }
interface ResolvedGroup extends Omit<Group, 'scope' | 'fields'> {
  scope: 'patient' | { mode: 'new'; anchor: ResolvedField } | { mode: 'existing'; ref: string; anchor: EvidenceSpan[] };
  fields: ResolvedField[];
}
export type GroupRejectionReason = 'unsupported-role-state' | 'requires-topic-admission' | 'entity-anchor-unresolved' | 'ambiguous-entity-anchor' | 'invalid-correction-target' | 'invalid-value-shape' | 'dependent-anchor-rejected' | 'semantic-rejection' | 'source-quote-rejection';
export interface AdaptiveGroupCandidate {
  readonly id: string; readonly family: string; readonly role: string; readonly kind: 'field' | 'completion' | 'absence' | 'act' | 'unmapped';
  readonly topicId?: string; readonly path?: string; readonly evidence: readonly EvidenceSpan[]; readonly dependencies: readonly string[];
}
export interface AdaptiveGroupRejection extends AdaptiveGroupCandidate { readonly reason: GroupRejectionReason; readonly guardCode?: string; }
export interface CompiledAdaptiveGroups {
  readonly sourceProtocol?: 'scoped-groups-v7';
  readonly proposal: AdaptiveValueProposal;
  readonly candidates: readonly AdaptiveGroupCandidate[];
  readonly rejectedCandidates: readonly AdaptiveGroupRejection[];
  /** No assertion about unproposed source meaning or complete capture. */
  readonly hasInterpretationGaps: boolean;
}
export interface ValidatedAdaptiveGroups extends CompiledAdaptiveGroups {
  /** Legacy guard outcome is retained for audit; callers must not treat every guard rejection as patient ambiguity. */
  readonly outcome: AdaptiveOutcome;
  readonly patientClarifications: readonly AdaptiveClarification[];
  readonly semanticRejections: readonly AdaptiveClarification[];
}
const validatedGroupResults = new WeakMap<ValidatedAdaptiveGroups, { context: string; result: string }>();
/** Only locally validated, unchanged dispositions may control the V6 dialogue bridge. */
export function assertValidatedAdaptiveGroups(context: AdaptiveContext, result: ValidatedAdaptiveGroups): void {
  const issued = validatedGroupResults.get(result);
  if (!issued || issued.context !== canonicalJson(context) || issued.result !== canonicalJson(result)) throw new AdaptiveError('untrusted-group-result');
}

/** Pure compile boundary. All addresses/refs/duplicates resolve before any semantic candidate can survive. */
export function compileAdaptiveGroupProposal(raw: unknown, context: AdaptiveContext, manifest: AdaptiveGroupManifest): CompiledAdaptiveGroups {
  const bound = issuedAdaptiveGroupManifest(manifest, context), parsed = bound.wire.safeParse(raw);
  if (!parsed.success) throw new AdaptiveError('invalid-group-proposal');
  const wire = parsed.data as Wire;
  const expansion = issuedAdaptiveSourceExpansion(raw, context, manifest);
  const resolve = (address: Address) => {
    if (expansion) { const span = expansion.addresses[`${address.segment}\0${address.quote}`]; if (!span) throw new AdaptiveError('invalid-source-expansion-address'); return span; }
    const segment = bound.segments[Number(address.segment.slice(1))];
    if (!segment) throw new AdaptiveError('invalid-source-segment');
    return resolveSegmentQuote(context, bound.segments, { segmentId: segment.id, quote: address.quote });
  };
  const support = (entries: Address[]) => entries.map(resolve);
  const answer = (value: Answer): ResolvedAnswer => {
    const evidence = support(value.support), valueEvidence = value.value === null ? null : resolve(value.value);
    if ((value.state === 'known') !== !!valueEvidence) throw new AdaptiveError('group-value-state-mismatch');
    if (valueEvidence && !evidence.some(span => span.sourceId === valueEvidence.sourceId && span.start <= valueEvidence.start && span.end >= valueEvidence.end)) throw new AdaptiveError('unsupported-value-span');
    return { state: value.state, evidence, valueEvidence };
  };
  const field = (value: Field): ResolvedField => ({ role: value.role, answer: answer(value.answer) });
  const groups: ResolvedGroup[] = wire.groups.map(group => ({ ...group, fields: group.fields.map(field), scope: group.scope === 'patient' ? group.scope : group.scope.mode === 'new'
    ? { mode: 'new', anchor: field(group.scope.anchor) } : { mode: 'existing', ref: group.scope.ref, anchor: support(group.scope.anchor) } }));
  const completed = wire.completedLists.map(entry => ({ ...entry, evidence: support(entry.support) }));
  const absent = wire.absentLists.map(entry => ({ ...entry, evidence: support(entry.support) }));
  const shared = wire.sharedConcerns.map(entry => ({ ...entry, answer: answer(entry.answer) }));
  const acts = wire.acts.map(entry => ({ ...entry, evidence: support(entry.support) }));
  const unmapped = wire.unmapped.map(entry => ({ reason: entry.reason, evidence: support(entry.support) }));
  // Every branch above is resolved first. A bad auxiliary quote rejects the whole envelope.
  const unique = (values: readonly string[], code: string) => { if (new Set(values).size !== values.length) throw new AdaptiveError(code); };
  unique(groups.map(group => group.key), 'duplicate-group-key');
  if (groups.some(group => bound.entities.some(entity => entity.ref === group.key))) throw new AdaptiveError('group-key-entity-collision');
  const total = groups.reduce((n, group) => n + group.fields.length + Number(group.scope !== 'patient' && group.scope.mode === 'new'), 0) + shared.reduce((n, entry) => n + entry.entities.length, 0) + absent.length;
  if (total > 32 || groups.filter(group => group.scope !== 'patient' && group.scope.mode === 'new' && bound.families.find(family => family.kind === group.kind)!.collection).length > 8) throw new AdaptiveError('group-candidate-limit');
  for (const group of groups) {
    unique([...group.fields.map(field => field.role), ...(group.scope !== 'patient' && group.scope.mode === 'new' ? [group.scope.anchor.role] : [])], 'duplicate-group-role');
    unique(group.correct.map(String), 'duplicate-group-correction');
    if (group.correct.some(index => index >= group.fields.length)) throw new AdaptiveError('invalid-group-correction-index');
    if (group.scope === 'patient' || group.scope.mode === 'existing') if (!group.fields.length) throw new AdaptiveError('empty-group');
  }
  unique(completed.map(entry => entry.family), 'duplicate-list-completion');
  unique(absent.map(entry => entry.family), 'duplicate-list-absence');
  if (absent.some(entry => completed.some(closure => closure.family === entry.family) || groups.some(group => group.kind === entry.family))) throw new AdaptiveError('contradictory-list-claims');
  const targets = new Set<string>();
  const claimTarget = (topic: string, path: string) => { const key = `${topic}:${path}`; if (targets.has(key)) throw new AdaptiveError('duplicate-target'); targets.add(key); };
  const entityFor = (group: ResolvedGroup) => { const scope = group.scope; return scope !== 'patient' && scope.mode === 'existing' ? bound.entities.find(entity => entity.ref === scope.ref) : undefined; };
  const pathOf = (family: GroupFamily, group: ResolvedGroup, role: string) => !family.collection ? role : entityFor(group)
    ? `${family.collection}[${entityFor(group)!.itemId}].${role}` : `${family.collection}[new:${group.key}].${role}`;
  for (const group of groups) {
    const family = bound.families.find(family => family.kind === group.kind)!;
    for (const value of [...(group.scope !== 'patient' && group.scope.mode === 'new' ? [group.scope.anchor] : []), ...group.fields]) claimTarget(family.topicId, pathOf(family, group, value.role));
  }
  const sharedTargets = shared.map(entry => {
    unique(entry.entities, 'duplicate-shared-entity');
    return entry.entities.map(reference => {
      const group = groups.find(group => group.key === reference), entity = bound.entities.find(entity => entity.ref === reference);
      if ((!group && !entity) || group && group.kind !== entry.family || entity && entity.family !== entry.family) throw new AdaptiveError('invalid-shared-entity');
      const family = bound.families.find(family => family.kind === entry.family)!;
      const path = group ? pathOf(family, group, 'concerns') : `${family.collection}[${entity!.itemId}].concerns`;
      claimTarget(family.topicId, path);
      return { group, entity, family, path };
    });
  });
  const proposal: AdaptiveValueProposal = { schema: 2, facts: [], newItems: [], completedLists: [], acts: [] };
  const candidates: AdaptiveGroupCandidate[] = [], rejectedCandidates: AdaptiveGroupRejection[] = [], rejectedGroups = new Set<string>();
  const newItems = new Map<string, AdaptiveValueProposal['newItems'][number]>();
  let index = 0;
  const candidate = (family: string, role: string, kind: AdaptiveGroupCandidate['kind'], evidence: EvidenceSpan[], topicId?: string, path?: string, dependencies: string[] = []): AdaptiveGroupCandidate => {
    const value = { id: `c${index++}`, family, role, kind, evidence, dependencies, ...(topicId ? { topicId } : {}), ...(path ? { path } : {}) }; candidates.push(value); return value;
  };
  const reject = (value: AdaptiveGroupCandidate, reason: GroupRejectionReason) => rejectedCandidates.push({ ...value, reason });
  const transform = (role: GroupRole, value: ResolvedAnswer): AdaptiveFact['transform'] | undefined => {
    if (value.state !== 'known') return 'scoped-response';
    const quote = context.source.text.slice(value.valueEvidence!.start, value.valueEvidence!.end), definition = role.definition;
    if (definition.kind === 'positive-number') return /^\d+(?:\.\d+)?$/.test(quote) ? 'explicit-number' : undefined;
    if (definition.kind === 'height-value') return /^\d+(?:\.\d+)?$/.test(quote) ? 'explicit-number' : parseExplicitHeight(quote) ? 'explicit-height' : undefined;
    if (definition.kind === 'choice') return definition.id.endsWith('.unit') ? 'explicit-unit' : 'explicit-choice';
    if (definition.kind === 'presence') return 'explicit-choice';
    return 'verbatim';
  };
  const put = (family: GroupFamily, group: ResolvedGroup | undefined, role: GroupRole, value: ResolvedAnswer, declaration: AdaptiveGroupCandidate, correction: boolean, entity?: GroupEntity) => {
    const sourceRejection = group && expansion?.rejections[`${group.key}:${role.role}`];
    if (sourceRejection) { rejectedCandidates.push({ ...declaration, reason: 'source-quote-rejection', guardCode: sourceRejection }); return false; }
    if (family.admission !== 'admitted') { reject(declaration, 'requires-topic-admission'); return false; }
    if (!role.states.includes(value.state)) { reject(declaration, 'unsupported-role-state'); return false; }
    const derived = transform(role, value);
    if (!derived) { reject(declaration, 'invalid-value-shape'); return false; }
    let prior: SlotAnswer | undefined;
    if (correction) {
      prior = entity?.answers[role.role] ?? context.responses[family.topicId]?.answers[role.role];
      if (!prior || prior.state === 'not-asked' || !prior.sourceIds?.length || prior.sourceIds.length > 8) { reject(declaration, 'invalid-correction-target'); return false; }
    }
    const compiled = { ...value, transform: derived, ...(prior ? { correctsSourceIds: [...prior.sourceIds!] } : {}) };
    if (group && family.collection && group.scope !== 'patient' && group.scope.mode === 'new') {
      let item = newItems.get(group.key);
      if (!item) { item = { topicId: family.topicId, collection: family.collection, key: group.key, fields: [] }; newItems.set(group.key, item); proposal.newItems.push(item); }
      item.fields.push({ path: role.role, ...compiled });
    } else proposal.facts.push({ topicId: family.topicId, path: entity && family.collection ? `${family.collection}[${entity.itemId}].${role.role}` : role.role, ...compiled });
    return true;
  };
  for (const group of groups) {
    const family = bound.families.find(family => family.kind === group.kind)!;
    const entity = entityFor(group);
    let anchorCandidate: AdaptiveGroupCandidate | undefined, anchorOkay = true;
    if (group.scope !== 'patient' && group.scope.mode === 'new') {
      const anchor = group.scope.anchor, role = family.roles.find(role => role.role === anchor.role)!;
      anchorCandidate = candidate(family.kind, anchor.role, 'field', anchor.answer.evidence, family.topicId, pathOf(family, group, anchor.role));
      anchorOkay = put(family, group, role, anchor.answer, anchorCandidate, false);
    } else if (entity && group.scope !== 'patient' && group.scope.mode === 'existing') {
      const identity = family.anchorRoles.flatMap(role => { const answer = entity.answers[role]; return answer?.state === 'known' && typeof answer.value === 'string' ? [answer.value.toLowerCase()] : []; });
      const quoted = group.scope.anchor.map(span => context.source.text.slice(span.start, span.end).toLowerCase());
      const own = identity.some(value => quoted.some(quote => quote.includes(value)));
      const peer = bound.entities.filter(other => other.family === family.kind && other.ref !== entity.ref).some(other => family.anchorRoles.some(role => { const answer = other.answers[role]; const value = answer?.state === 'known' && typeof answer.value === 'string' ? answer.value.toLowerCase() : undefined; return value !== undefined && quoted.some(quote => quote.includes(value)); }));
      anchorCandidate = candidate(family.kind, '__entity', 'field', group.scope.anchor, family.topicId);
      const sourceRejection = expansion?.rejections[`${group.key}:__entity`];
      if (sourceRejection) { rejectedCandidates.push({ ...anchorCandidate, reason: 'source-quote-rejection', guardCode: sourceRejection }); anchorOkay = false; }
      else if (!own || peer) { reject(anchorCandidate, own ? 'ambiguous-entity-anchor' : 'entity-anchor-unresolved'); anchorOkay = false; }
    }
    if (!anchorOkay) rejectedGroups.add(group.key);
    group.fields.forEach((field, fieldIndex) => {
      const declaration = candidate(family.kind, field.role, 'field', field.answer.evidence, family.topicId, pathOf(family, group, field.role), anchorCandidate ? [anchorCandidate.id] : []);
      if (!anchorOkay) { reject(declaration, 'dependent-anchor-rejected'); return; }
      put(family, group, family.roles.find(role => role.role === field.role)!, field.answer, declaration, group.correct.includes(fieldIndex), entity);
    });
  }
  shared.forEach((entry, sharedIndex) => sharedTargets[sharedIndex].forEach(({ group, entity, family, path }) => {
    const declaration = candidate(family.kind, 'concerns', 'field', entry.answer.evidence, family.topicId, path);
    const sourceRejection = expansion?.rejections[`shared:${sharedIndex}`];
    if (sourceRejection) { rejectedCandidates.push({ ...declaration, reason: 'source-quote-rejection', guardCode: sourceRejection }); return; }
    if (group && rejectedGroups.has(group.key)) { reject(declaration, 'dependent-anchor-rejected'); return; }
    // Fan-out still needs explicit shared-negative source scope in the existing semantic validator.
    put(family, group, family.roles.find(role => role.role === 'concerns')!, entry.answer, declaration, false, entity ?? (group ? entityFor(group) : undefined));
  }));
  for (const entry of completed) {
    const family = bound.families.find(family => family.kind === entry.family)!;
    const declaration = candidate(entry.family, '__complete', 'completion', entry.evidence, family.topicId, family.collection);
    if (family.admission !== 'admitted') reject(declaration, 'requires-topic-admission');
    else proposal.completedLists.push({ topicId: family.topicId, path: family.collection!, evidence: entry.evidence });
  }
  for (const entry of absent) {
    const family = bound.families.find(family => family.kind === entry.family)!;
    const declaration = candidate(entry.family, '__absent', 'absence', entry.evidence, family.topicId, family.collection);
    if (family.admission !== 'admitted') reject(declaration, 'requires-topic-admission');
    else proposal.facts.push({ topicId: family.topicId, path: family.collection!, state: 'negative', valueEvidence: null, transform: 'scoped-response', evidence: entry.evidence });
  }
  for (const act of acts) {
    const declaration = candidate('__acts', act.kind, 'act', act.evidence, act.kind === 'question' ? undefined : act.topic);
    if (act.kind !== 'question' && !context.topics.some(topic => topic.id === act.topic)) { reject(declaration, 'requires-topic-admission'); continue; }
    proposal.acts.push({ kind: act.kind, evidence: act.evidence, ...(act.kind === 'question' ? { replyId: act.reply } : { targetTopicId: act.topic }) });
  }
  if (unmapped.length) { proposal.unmapped = unmapped; for (const value of unmapped) candidate('__unmapped', value.reason, 'unmapped', value.evidence); }
  const checked = adaptiveValueProposalSchema.safeParse(proposal);
  if (!checked.success) throw new AdaptiveError('invalid-group-canonical-proposal');
  return { ...(expansion ? { sourceProtocol: 'scoped-groups-v7' as const } : {}), proposal: checked.data, candidates, rejectedCandidates, hasInterpretationGaps: rejectedCandidates.length > 0 || unmapped.length > 0 };
}

/** Offline guard bridge only: no persistence, delivery, dialogue mutation, provider or trusted-answer shortcut. */
export function validateAdaptiveGroupProposal(raw: unknown, context: AdaptiveContext, manifest: AdaptiveGroupManifest): ValidatedAdaptiveGroups {
  const compiled = compileAdaptiveGroupProposal(raw, context, manifest);
  const guard = (proposal: AdaptiveValueProposal) => applyValidatedTurn(context, validateAdaptiveProposal(proposal, context));
  const parsed = issuedAdaptiveGroupManifest(manifest, context).wire.parse(raw) as Wire;
  const dependentRejections: AdaptiveGroupRejection[] = [], semanticCandidateRejections: AdaptiveGroupRejection[] = [];
  let proposal = structuredClone(compiled.proposal);
  // V5 deliberately throws for these declaration-local semantics. Probe only the
  // affected field (and its new-entity anchor) against the full trusted context.
  // Structural/address failures have already been checked for every declaration;
  // all other guard exceptions, including safety and combined invariants, stay fatal.
  const keep = (field: AdaptiveValueProposal['facts'][number] | AdaptiveValueProposal['newItems'][number]['fields'][number], topicId: string, path: string, probe: AdaptiveValueProposal) => {
    const strength = /(?:^|\]\.)strength$/.test(path), correction = 'correctsSourceIds' in field && !!field.correctsSourceIds;
    if (!strength && !correction) return true;
    try { validateAdaptiveProposal(probe, context); return true; }
    catch (error) {
      const permitted = error instanceof AdaptiveError && (strength && ['incomplete-strength-value', 'invalid-strength-value'].includes(error.code)
        || correction && ['invalid-correction-support', 'invalid-correction-target'].includes(error.code));
      if (!permitted) throw error;
      const declaration = compiled.candidates.find(candidate => candidate.topicId === topicId && candidate.path === path);
      if (!declaration) throw new AdaptiveError('missing-group-candidate');
      semanticCandidateRejections.push({ ...declaration, reason: 'semantic-rejection', guardCode: (error as AdaptiveError).code });
      return false;
    }
  };
  proposal.facts = proposal.facts.filter(fact => keep(fact, fact.topicId, fact.path, { schema: 2, facts: [fact], newItems: [], completedLists: [], acts: [] }));
  for (const item of proposal.newItems) {
    const group = parsed.groups.find(group => group.key === item.key)!;
    const scope = group.scope;
    const anchor = scope !== 'patient' && scope.mode === 'new' ? item.fields.find(field => field.path === scope.anchor.role) : undefined;
    item.fields = item.fields.filter(field => keep(field, item.topicId, `${item.collection}[new:${item.key}].${field.path}`,
      { schema: 2, facts: [], newItems: [{ ...item, fields: anchor && anchor !== field ? [anchor, field] : [field] }], completedLists: [], acts: [] }));
  }
  // Always run the unchanged guard over the combined surviving proposal: isolated
  // preflights are not acceptance, coverage, or a substitute for conflict checks.
  let outcome = guard(proposal);
  const sourceCode = Array.from(context.source.id).map(char => char.codePointAt(0)!.toString(16)).join('_');
  const failed = new Map<string, string>();
  for (const group of parsed.groups) {
    if (group.scope === 'patient' || group.scope.mode !== 'new') continue;
    const family = issuedAdaptiveGroupManifest(manifest, context).families.find(family => family.kind === group.kind)!;
    const itemIndex = proposal.newItems.findIndex(item => item.key === group.key);
    const path = family.collection ? itemIndex < 0 ? undefined : `${family.collection}[a${sourceCode}_${itemIndex}].${group.scope.anchor.role}` : group.scope.anchor.role;
    if (path && !outcome.provenance.some(provenance => provenance.topicId === family.topicId && provenance.path === path)) failed.set(group.key, group.scope.anchor.role);
  }
  if (failed.size) {
    // Re-run the unchanged pure guard after removing dependent children; never expose the speculative first outcome.
    proposal = structuredClone(proposal);
    for (const group of parsed.groups.filter(group => failed.has(group.key))) {
      const family = issuedAdaptiveGroupManifest(manifest, context).families.find(family => family.kind === group.kind)!;
      const anchorRole = failed.get(group.key)!;
      if (family.collection) { const item = proposal.newItems.find(item => item.key === group.key); if (item) item.fields = item.fields.filter(field => field.path === anchorRole); }
      else proposal.facts = proposal.facts.filter(fact => fact.topicId !== family.topicId || !group.fields.some(field => field.role === fact.path));
      for (const declaration of compiled.candidates.filter(candidate => candidate.family === family.kind && candidate.role !== anchorRole && candidate.path && (family.collection ? candidate.path.startsWith(`${family.collection}[new:${group.key}].`) : group.fields.some(field => field.role === candidate.path)))) {
        dependentRejections.push({ ...declaration, reason: 'dependent-anchor-rejected' });
      }
    }
    outcome = guard(proposal);
  }
  const patientClarifications = outcome.clarifications.filter(candidate => candidate.reason === 'conflict');
  const semanticRejections = outcome.clarifications.filter(candidate => candidate.reason !== 'conflict');
  const result = { ...compiled, proposal, outcome, patientClarifications, semanticRejections, rejectedCandidates: [...compiled.rejectedCandidates, ...semanticCandidateRejections, ...dependentRejections], hasInterpretationGaps: compiled.hasInterpretationGaps || semanticCandidateRejections.length > 0 || dependentRejections.length > 0 || outcome.hasUnresolvedInterpretation };
  validatedGroupResults.set(result, { context: canonicalJson(context), result: canonicalJson(result) });
  return result;
}
