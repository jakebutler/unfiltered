import { addCollectionItem, applyGuidedAnswer, finishCollection, diabetesBranchApplicability, type SlotAnswer, type TopicDefinition, type TopicResponse } from '../../clinic-content/src/index.js';
import { canonicalJson } from '../../clinical-core/src/domain.js';
import { adaptiveSlot, type EvidenceSpan } from './adaptive-validation.js';
import { fullProvisionalPolicy, typedCaptureBound, gapAffectsUnit, type ProvisionalCapture, type ProvisionalClaim, type ProvisionalGap } from './provisional-draft.js';
import type { Draft } from './types.js';

/** A qualification receipt must pin all four interpretation boundaries. Only
 * trusted server construction supplies it; never accepted from draft/client data. */
export const fullPolicyRevision = Object.freeze({ policy: fullProvisionalPolicy, schema: 'readable-domain-source-v6', normalization: 'typed-context-v5', catalog: 'applicable-scenario-slots-v3', projection: 'merge-source-review-diagnostic-v4' } as const);
export const focusedPolicyRevision = Object.freeze({ ...fullPolicyRevision, schema: 'source-first-focused-v1', catalog: 'dependency-complete-held-v1', projection: 'atomic-dependent-admission-v1' } as const);
export const typedPolicyRevision = Object.freeze({ ...fullPolicyRevision, schema: 'turn-bound-typed-v1', normalization: 'typed-native-record-v1', catalog: 'all-authored-descriptors-v1', projection: 'independent-units-atomic-v1' } as const);
export type ProvisionalQualification = (typeof fullPolicyRevision | typeof focusedPolicyRevision | typeof typedPolicyRevision) & { status: 'qualified'; evidenceDigest: string };
export function policyQualified(receipt?: ProvisionalQualification, revision: typeof fullPolicyRevision | typeof focusedPolicyRevision | typeof typedPolicyRevision = fullPolicyRevision): boolean {
  return !!receipt && /^[a-f0-9]{64}$/.test(receipt.evidenceDigest) && receipt.status === 'qualified'
    && Object.entries(revision).every(([key, value]) => receipt[key as keyof typeof revision] === value);
}
export interface EffectiveProjection {
  responses: Record<string, TopicResponse>;
  claims: ProvisionalClaim[];
  gaps: (ProvisionalGap & { sourceId: string })[];
  provenance: { topicId: string; path: string; evidence: EvidenceSpan[]; sourceIds: string[]; supersededEvidence?: EvidenceSpan[] }[];
  creditedSourceIds: Set<string>;
}
const empty = (): TopicResponse => ({ presented: false, answers: {} });
const key = (claim: ProvisionalClaim) => `${claim.topicId}:${claim.path}`;
const sameMeaning = (a: ProvisionalClaim, b: ProvisionalClaim) => a.state === b.state && canonicalJson(a.value) === canonicalJson(b.value)
  && a.scope.subject === b.scope.subject && a.scope.entity === b.scope.entity && a.scope.period === b.scope.period;
function directAt(draft: Draft, topic: TopicDefinition, path: string): SlotAnswer | undefined {
  try { return adaptiveSlot(topic, draft.topics[topic.id] ?? empty(), path).answer; } catch { return; }
}

/** Display and readiness use the same merge. Unqualified calls return useful
 * proposed display values; the caller must separately select direct readiness. */
export function projectProvisional(draft: Draft, definitions: readonly TopicDefinition[], options: { qualified?: boolean; qualificationProfile?: 'source-first-focused-v1' | 'turn-bound-typed-v1'; readinessOnly?: boolean } = {}): EffectiveProjection {
  const topics = new Map(definitions.map(topic => [topic.id, topic]));
  const evidence = { validSourceIds: new Set(draft.turns.filter(turn => turn.role === 'patient').map(turn => turn.id)) };
  const sourceOrder = new Map(draft.turns.filter(turn => turn.role === 'patient').map((turn, index) => [turn.id, index]));
  const order = (sourceId: string) => sourceOrder.get(sourceId) ?? -1;
  const fullOperations = Object.values(draft.adaptive?.operations ?? {}).filter(operation => operation.status !== 'discarded' && operation.stream?.provisional?.policy === fullProvisionalPolicy)
    .sort((a, b) => a.binding.revision - b.binding.revision);
  const admitted = (operation: typeof fullOperations[number]) => options.qualified === true && (operation.stream?.provisional?.interpretationProfile ?? operation.stream?.sourceInterpretation?.protocol) === options.qualificationProfile;
  const captures: ProvisionalCapture[] = fullOperations.filter(operation => operation.status === 'applied' && operation.stream?.capture === 'saved' && typedCaptureBound(draft, operation) && (!options.readinessOnly || admitted(operation))).map(operation => operation.stream!.provisional!);
  const qualifiedSources = new Set(fullOperations.filter(admitted).map(operation => operation.sourceId));
  const result: EffectiveProjection = { responses: structuredClone(draft.topics), claims: [], gaps: [], provenance: [], creditedSourceIds: new Set() };
  for (const operation of fullOperations) { if (!typedCaptureBound(draft, operation)) { result.gaps.push({sourceId:operation.sourceId,reason:'ownership',evidence:[]}); continue; } result.gaps.push(...operation.stream!.provisional!.gaps.map(gap => ({ ...structuredClone(gap), sourceId: operation.sourceId }))); }
  const grouped = new Map<string, ProvisionalClaim[]>();
  for (const capture of captures) {
    for (const original of capture.claims) {
      const claim = structuredClone(original); result.claims.push(claim);
      if(capture.interpretationProfile==='turn-bound-typed-v1'&&capture.gaps.some(g=>gapAffectsUnit(g,claim.topicId,claim.path))) { claim.status='conflicting'; continue; }
      const topic = topics.get(claim.topicId);
      if (!topic || /^MH0[1-4]$/.test(claim.path)) { claim.status = 'conflicting'; result.gaps.push({ sourceId: claim.sourceId, reason: 'unsupported-target', topicId:claim.topicId, path:claim.path, evidence: claim.evidence }); continue; }
      const direct = directAt(draft, topic, claim.path);
      const parent = claim.path.includes('[') ? directAt(draft, topic, claim.path.slice(0, claim.path.indexOf('['))) : undefined;
      if (direct && direct.state !== 'not-asked' || parent && parent.state !== 'known' && parent.state !== 'not-asked') { claim.status = 'superseded'; continue; }
      if (claim.status !== 'proposed') continue;
      const previous = grouped.get(key(claim)) ?? [];
      if (claim.correctsSourceIds.length) {
        const corrected = previous.filter(item => claim.correctsSourceIds.includes(item.sourceId) && item.status !== 'superseded');
        // Linking an unrelated source does not authorize last-write-wins.
        if (!corrected.length || claim.correctsSourceIds.some(id => !corrected.some(item => item.sourceId === id)) || capture.interpretationProfile==='turn-bound-typed-v1' && corrected.some(item=>claim.scope.subject!==item.scope.subject||claim.scope.entity!==item.scope.entity||claim.scope.period!==item.scope.period)) {
          claim.status = 'conflicting'; result.gaps.push({ sourceId: claim.sourceId, reason: 'conflict', topicId:claim.topicId, path:claim.path, evidence: claim.evidence });
        } else if (previous.filter(item => item.status !== 'superseded').every(item => item.status === 'proposed' && sameMeaning(item, claim))) {
          // Exact unchanged active meaning is a reaffirmation. Preserve both sources
          // and remove the no-op link only from this cloned projection.
          claim.correctsSourceIds = [];
        } else corrected.forEach(item => { item.status = 'superseded'; });
      }
      previous.push(claim); grouped.set(key(claim), previous);
    }
  }
  // A whole-list response and reported item fields share a meaning boundary,
  // even though their slot paths differ. Do not let root replacement erase an
  // unlinked item report (or accidentally credit both sources as resolved).
  const collectionConflicts = new Map<string, ProvisionalClaim[]>();
  for (const claims of grouped.values()) {
    const root = claims.find(claim => claim.status !== 'superseded' && ['negative', 'not-applicable'].includes(claim.state));
    if (!root) continue;
    // Issued child paths identify their collection root without relying on
    // projected parent items having been installed yet.
    const descendants = [...grouped.values()].flat().filter(claim => claim.status !== 'superseded' && claim.topicId === root.topicId && claim.path.startsWith(`${root.path}[`));
    if (!descendants.length) continue;
    const activeRoot = claims.filter(claim => claim.status !== 'superseded');
    const conflict = [...activeRoot, ...descendants];
    conflict.forEach(claim => { claim.status = 'conflicting'; });
    collectionConflicts.set(key(root), conflict);
  }
  // Build only server-issued items. Identical named new entities are deliberately
  // not silently joined across sources; the next extraction can target the
  // existing stable ID. Ambiguous duplicates remain visible.
  const entities = new Map<string, { id: string; evidence: EvidenceSpan[]; sourceId: string }>();
  const blockedCollections = new Set<string>();
  for (const capture of captures) for (const item of capture.items ?? []) {
    const topic = topics.get(item.topicId); if (!topic) continue;
    const direct = directAt(draft, topic, item.collection);
    if (direct && direct.state !== 'known' && direct.state !== 'not-asked') continue;
    const entityKey = `${item.topicId}:${item.collection}:${item.entity.trim().toLocaleLowerCase()}`;
    const prior = entities.get(entityKey);
    if (prior && prior.id !== item.id) {
      blockedCollections.add(`${item.topicId}:${item.collection}`);
      result.gaps.push({ sourceId: capture.sourceId, reason: 'conflict', topicId:item.topicId, path:item.collection, evidence: [...prior.evidence, ...item.evidence] });
    } else entities.set(entityKey, { id: item.id, evidence: item.evidence, sourceId: capture.sourceId });
    try {
      const response = result.responses[item.topicId] ?? empty();
      const answer = adaptiveSlot(topic, response, item.collection).answer;
      if (!(answer?.state === 'known' && answer.items?.some(existing => existing.id === item.id))) {
        result.responses[item.topicId] = addCollectionItem(topic, response, { path: item.collection, itemId: item.id, sourceIds: [capture.sourceId] }, evidence);
        // Reconstructing an older proposed item is not a new listing event.
        // Preserve a later explicit direct finish, while genuinely later item
        // sources still reopen the collection through addCollectionItem.
        if (direct?.state === 'known' && direct.items && direct.complete && direct.sourceIds.some(id => order(id) > order(capture.sourceId)))
          result.responses[item.topicId] = finishCollection(topic, result.responses[item.topicId], { path: item.collection, sourceIds: direct.sourceIds }, evidence);
      }
    } catch { result.gaps.push({ sourceId: capture.sourceId, reason: 'conflict', topicId:item.topicId, path:item.collection, evidence: item.evidence }); }
  }
  for (const claims of grouped.values()) {
    const active = claims.filter(claim => claim.status !== 'superseded'); if (!active.length) continue;
    const representative = active[0], topic = topics.get(representative.topicId)!;
    const conflict = active.some(claim => claim.status === 'conflicting' || !sameMeaning(representative, claim));
    if (conflict) {
      active.forEach(claim => { claim.status = 'conflicting'; });
      result.gaps.push(...active.map(claim => ({ sourceId: claim.sourceId, reason: 'conflict' as const, topicId:claim.topicId, path:claim.path, evidence: claim.evidence })));
    }
    const sourceIds = [...new Set(active.map(claim => claim.sourceId))];
    const answer: SlotAnswer = conflict ? { state: 'conflicting', sourceIds, note: 'These saved answers differ. Both source statements remain available.' }
      : representative.state === 'known' && representative.value !== null ? { state: 'known', value: representative.value, sourceIds }
      : { state: representative.state === 'known' ? 'uncertain' : representative.state, sourceIds };
    try {
      result.responses[topic.id] = applyGuidedAnswer(topic, result.responses[topic.id] ?? empty(), { path: representative.path, answer }, evidence);
      const correctedIds = new Set(active.flatMap(claim => claim.correctsSourceIds));
      const corrected = claims.filter(claim => claim.status === 'superseded' && correctedIds.has(claim.sourceId));
      result.provenance.push({ topicId: topic.id, path: representative.path, evidence: active.flatMap(claim => claim.evidence), supersededEvidence: corrected.flatMap(claim => claim.evidence), sourceIds: [...new Set([...sourceIds, ...corrected.map(claim => claim.sourceId)])] });
    } catch { result.gaps.push({ sourceId: representative.sourceId, reason: 'conflict', topicId:representative.topicId, path:representative.path, evidence: representative.evidence }); }
  }
  for (const capture of captures) for (const closure of capture.closures ?? []) {
    const topic = topics.get(closure.topicId); if (!topic || blockedCollections.has(`${closure.topicId}:${closure.collection}`)) continue;
    // A later declaration of new items reopens the list via addCollectionItem.
    // Do not allow an earlier close to close those later items.
    const laterItem = captures.slice(captures.indexOf(capture) + 1).some(next => next.items?.some(item => item.topicId === closure.topicId && item.collection === closure.collection));
    const direct = directAt(draft, topic, closure.collection);
    const laterDirect = direct?.sourceIds?.some(id => order(id) > order(capture.sourceId));
    if (laterItem || laterDirect || collectionConflicts.has(`${closure.topicId}:${closure.collection}`) || direct && direct.state !== 'known' && direct.state !== 'not-asked') continue;
    try { result.responses[topic.id] = finishCollection(topic, result.responses[topic.id] ?? empty(), { path: closure.collection, sourceIds: [capture.sourceId] }, evidence); }
    catch { result.gaps.push({ sourceId: capture.sourceId, reason: 'conflict', topicId:closure.topicId, path:closure.collection, evidence: closure.evidence }); }
  }
  for (const collectionKey of blockedCollections) {
    const [topicId, collection] = collectionKey.split(':');
    const response = result.responses[topicId], answer = response?.answers[collection];
    if (response && answer?.state === 'known' && answer.items) result.responses[topicId] = { ...response, answers: { ...response.answers, [collection]: { ...answer, complete: false } } };
  }
  for (const [collectionKey, claims] of collectionConflicts) {
    const topicId = claims[0].topicId, path = collectionKey.slice(topicId.length + 1);
    const sourceIds = [...new Set(claims.map(claim => claim.sourceId))], topic = topics.get(topicId)!;
    try { result.responses[topicId] = applyGuidedAnswer(topic, result.responses[topicId] ?? empty(), { path, answer: { state: 'conflicting', sourceIds, note: 'A list response conflicts with reported items. Both source statements remain available.' } }, evidence); }
    catch { /* Parent conflict already makes this nested collection unresolved. */ }
    result.gaps.push(...claims.map(claim => ({ sourceId: claim.sourceId, reason: 'conflict' as const, topicId:claim.topicId, path:claim.path, evidence: claim.evidence })));
    result.provenance.push({ topicId, path, evidence: claims.flatMap(claim => claim.evidence), sourceIds });
  }
  const estimate = result.responses.Q04?.answers['currentWeightEstimate.value'];
  if (estimate?.state === 'known' && !result.gaps.some(g=>estimate.sourceIds.includes(g.sourceId)&&gapAffectsUnit(g,'Q04','currentWeightEstimate.value')) && !draft.topics.Q04?.answers['currentWeightEstimate.statedAt']) {
    const source = draft.turns.filter(turn => estimate.sourceIds.includes(turn.id)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    if (source && Number.isFinite(Date.parse(source.at))) {
      result.responses.Q04 = { ...result.responses.Q04, answers: { ...result.responses.Q04.answers, 'currentWeightEstimate.statedAt': { state: 'known', value: source.at, sourceIds: [source.id] } } };
      result.provenance.push({ topicId: 'Q04', path: 'currentWeightEstimate.statedAt', evidence: result.claims.filter(claim => claim.path === 'currentWeightEstimate.value' && claim.status === 'proposed').flatMap(claim => claim.evidence), sourceIds: [source.id] });
    }
  }
  if (options.qualified) {
    // Only the explicitly qualified turn-bound profile admits typed navigation acts.
    if (options.qualificationProfile === 'turn-bound-typed-v1') for (const capture of captures) for(const act of capture.acts ?? []) {
      if(act.kind==='move-on'&&act.attribution==='direct-patient-command'&&!result.gaps.some(g=>g.sourceId===capture.sourceId&&(!g.topicId||g.topicId===act.topicId))) result.responses[act.topicId]={...(result.responses[act.topicId]??empty()),stopped:'patient-moves-on'};
    }
    // Legacy interpretation controls cannot grant patient stop authority. Direct responses retain it.
    for (const capture of captures) if (qualifiedSources.has(capture.sourceId) && !result.gaps.some(gap => gap.sourceId === capture.sourceId)) result.creditedSourceIds.add(capture.sourceId);
  }
  {
    const answers = (options.qualified ? result.responses : draft.topics).Q06?.answers;
    if (answers) {
      const dm = diabetesBranchApplicability(answers, evidence);
      if (dm === 'applicable') result.responses.DM = { ...(result.responses.DM ?? empty()), applicability: 'applicable', applicabilitySourceIds: [...new Set(['conditions.diabetes', 'conditions.prediabetes'].flatMap(path => answers[path]?.sourceIds ?? []))] };
      for (const [path, id] of [['conditions.sleepApnea', 'SLEEP'], ['conditions.digestive', 'GI']]) {
        const anchor = answers[path]; if (anchor?.state === 'known' && anchor.value === true) result.responses[id] = { ...(result.responses[id] ?? empty()), applicability: 'applicable', applicabilitySourceIds: [...anchor.sourceIds] };
      }
    }
  }
  return result;
}
