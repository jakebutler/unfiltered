import { canonicalJson, type ConfirmedSubmission } from '../../clinical-core/src/domain.js';
import { REPRESENTATION_POLICY, representationDigest, sourceDigestMap, type RepresentationFact, type TrustedRepresentationAuthority } from '../../clinical-core/src/representation-review.js';
import { nativeResolveSlot, nativeTopics, type NativeRepresentationAuthority } from '../../clinic-content/src/native-questionnaire.js';
import type { SlotAnswers, TopicDefinition } from '../../clinic-content/src/types.js';
import { policyQualified, projectProvisional, typedPolicyRevision, type ProvisionalQualification } from './provisional-projection.js';
import { typedCaptureBound, gapAffectsUnit } from './provisional-draft.js';
import type { Draft } from './types.js';

/** Separate opt-in qualification: extraction qualification alone is insufficient. */
export interface FinalRepresentationQualification { policy: typeof REPRESENTATION_POLICY; status: 'qualified'; evidenceDigest: string; extractionSchema?: typeof typedPolicyRevision.schema; }
/** Persistence/readback callers compare against server configuration, never the
 * persisted record's own claim that its interpretation policy was qualified. */
export function requireFinalRepresentationAuthority(confirmation: ConfirmedSubmission, extraction?: ProvisionalQualification, finalQualification?: FinalRepresentationQualification) {
  if (!confirmation.submission.representationReview) return;
  if (!(policyQualified(extraction) || policyQualified(extraction, typedPolicyRevision)) || (policyQualified(extraction, typedPolicyRevision) && finalQualification?.extractionSchema !== typedPolicyRevision.schema) || !finalQualification || finalQualification.status !== 'qualified' || finalQualification.policy !== REPRESENTATION_POLICY
    || canonicalJson(confirmation.representationAuthority?.qualification) !== canonicalJson(extraction)
    || canonicalJson(confirmation.representationAuthority?.representationQualification) !== canonicalJson(finalQualification)) throw new Error('representation-server-qualification-mismatch');
}
export async function prepareFinalRepresentation(draft: Draft, definitions: readonly TopicDefinition[], extraction?: ProvisionalQualification, finalQualification?: FinalRepresentationQualification) {
  const typed = policyQualified(extraction, typedPolicyRevision);
  if (!(policyQualified(extraction) || typed) || typed && finalQualification?.extractionSchema !== typedPolicyRevision.schema || finalQualification?.policy !== REPRESENTATION_POLICY || finalQualification.status !== 'qualified' || !/^[a-f0-9]{64}$/.test(finalQualification.evidenceDigest)) return;
  const projection = projectProvisional(draft, definitions, { qualified: true, ...(typed ? { qualificationProfile: 'turn-bound-typed-v1' as const } : {}) });
  const sources = draft.turns.filter(t => t.role === 'patient').map(t => ({ id: t.id, patient: draft.patient, kind: t.corrects ? 'patient-correction' as const : 'patient-statement' as const, text: t.text, capturedAt: t.at, ...(t.channel ? { channel: t.channel } : {}), ...(t.corrects ? { corrects: t.corrects } : {}), ...(t.displayedPromptId ? { displayedPromptId: t.displayedPromptId } : {}) }));
  const digests = await sourceDigestMap(sources), rawIds = new Set(sources.filter(s => s.channel === 'unreviewed-transcript').map(s => s.id));
  const eligible = Object.values(draft.adaptive?.operations ?? {}).filter(op => op.status === 'applied' && op.stream?.capture === 'saved' && op.stream.provisional?.policy === extraction!.policy && typedCaptureBound(draft,op)
    && (typed ? op.stream.provisional.interpretationProfile === 'turn-bound-typed-v1' : !op.stream.provisional.interpretationProfile && !op.stream.sourceInterpretation)
    && (typed || !op.stream.provisional.gaps.some(g => g.reason !== 'recognition-unreviewed')
    && !projection.gaps.some(g => g.sourceId === op.sourceId && g.reason !== 'recognition-unreviewed')));
  const unitEligible=(sourceId:string,topicId:string,path:string)=>!typed||!projection.gaps.some(g=>g.sourceId===sourceId&&gapAffectsUnit(g,topicId,path));
  const collectionEligible=(sourceId:string,topicId:string,path:string)=>unitEligible(sourceId,topicId,path)&&(!typed||!projection.gaps.some(g=>g.sourceId===sourceId&&g.topicId===topicId&&g.reason!=='recognition-unreviewed'&&g.path?.startsWith(path+'[')));
  const eligibleIds = new Set(eligible.map(op => op.sourceId)), captures = eligible.map(op => op.stream!.provisional!), facts: RepresentationFact[] = [];
  const walk = (topicId: string, answers: SlotAnswers, prefix = '') => {
    for (const [slot, answer] of Object.entries(answers)) {
      if (!answer || ['not-asked', 'conflicting'].includes(answer.state)) continue;
      const path = prefix + slot;
      if (answer.state === 'known' && answer.items) for (const item of answer.items) walk(topicId, item.answers, `${path}[${item.id}].`);
      if (!answer.sourceIds?.some(id => rawIds.has(id)) || answer.sourceIds.some(id => rawIds.has(id) && !eligibleIds.has(id)) || /^MH0[1-4]$/.test(path)) continue;
      const claims = projection.claims.filter(c => c.topicId === topicId && c.path === path && c.status === 'proposed' && eligibleIds.has(c.sourceId) && unitEligible(c.sourceId,c.topicId,c.path));
      const items = captures.flatMap(c => (c.items ?? []).filter(i => i.topicId === topicId && i.collection === path && collectionEligible(c.sourceId,topicId,path)));
      const closures = captures.flatMap(c => (c.closures ?? []).filter(i => i.topicId === topicId && i.collection === path && collectionEligible(c.sourceId,topicId,path)));
      const derived = topicId === 'Q04' && path === 'currentWeightEstimate.statedAt' ? projection.claims.filter(c => c.topicId === topicId && c.path === 'currentWeightEstimate.value' && c.status === 'proposed' && eligibleIds.has(c.sourceId) && unitEligible(c.sourceId,c.topicId,c.path)) : [];
      if (!claims.length && !items.length && !derived.length) continue;
      if (answer.state === 'known' && answer.items && (answer.items.some(item => Object.entries(item.answers).some(([child, value]) => value?.state !== 'not-asked' && value?.sourceIds?.some(id => rawIds.has(id)) && !facts.some(f => f.topicId === topicId && f.path === `${path}[${item.id}].${child}`))) || answer.complete && !closures.length)) continue;
      const evidence = [...claims.flatMap(c => [...c.evidence, ...(c.scope.predicate ? [c.scope.predicate] : []), ...(c.valueEvidence ? [c.valueEvidence] : [])]), ...items.flatMap(i => i.evidence), ...closures.flatMap(c => c.evidence), ...derived.flatMap(c => c.evidence)]
        .filter((span, index, all) => all.findIndex(s => canonicalJson(s) === canonicalJson(span)) === index);
      if (!answer.sourceIds.every(id => evidence.some(s => s.sourceId === id))) continue;
      facts.push({ topicId, path, answer: structuredClone(answer), evidence: evidence.map(span => ({ ...span, sourceDigest: digests.get(span.sourceId)! })), claimIds: [...new Set([...claims, ...derived].map(c => c.id))], correctsSourceIds: [...new Set(claims.flatMap(c => c.correctsSourceIds))], origin: items.length ? 'collection' : derived.length ? 'derived-source-time' : 'claim' });
    }
  };
  for (const [topicId, topic] of Object.entries(projection.responses)) walk(topicId, topic.answers);
  if (!facts.length) return;
  facts.sort((a, b) => `${a.topicId}:${a.path}`.localeCompare(`${b.topicId}:${b.path}`));
  const accountedSourceIds = [...rawIds].filter(id => (!typed || !projection.gaps.some(g=>g.sourceId===id&&g.reason!=='recognition-unreviewed')) && eligibleIds.has(id) && facts.some(f => f.evidence.some(span => span.sourceId === id) || f.correctsSourceIds.includes(id)) && projection.claims.filter(c => c.sourceId === id).every(c => c.status === 'superseded' ? facts.some(f => f.correctsSourceIds.includes(id)) : c.status === 'proposed' && facts.some(f => f.claimIds.includes(c.id)))).sort();
  const preparingAuthority: NativeRepresentationAuthority = { binding: '0'.repeat(64), reviewedFact: (topicId, path, answer) => facts.some(f => f.topicId === topicId && f.path === path && canonicalJson(f.answer) === canonicalJson(answer)), reviewedSourceAccountedFor: id => accountedSourceIds.includes(id) };
  return { projection, facts, sources, accountedSourceIds, preparingAuthority, extraction: extraction!, finalQualification,
    async bind(contentVersion: string, capture: import('../../clinic-content/src/native-questionnaire.js').NativeQuestionnaireCapture): Promise<TrustedRepresentationAuthority | undefined> {
      const projectedCapture = structuredClone(capture); delete projectedCapture.reviewBinding;
      const currentFacts = facts.filter(fact => { try { return canonicalJson(nativeResolveSlot(nativeTopics().find(t => t.id === fact.topicId)!, capture.topics[fact.topicId], fact.path).answer) === canonicalJson(fact.answer); } catch { return false; } });
      if (!currentFacts.length) return;
      const currentAccounted = accountedSourceIds.filter(id => currentFacts.some(f => f.evidence.some(span => span.sourceId === id) || f.correctsSourceIds.includes(id)) && projection.claims.filter(c => c.sourceId === id).every(c => c.status === 'superseded' ? currentFacts.some(f => f.correctsSourceIds.includes(id)) : c.status === 'proposed' && currentFacts.some(f => f.claimIds.includes(c.id))));
      const base = { policy: REPRESENTATION_POLICY, patient: draft.patient, submissionId: draft.id, version: draft.version, contentVersion, nativeDefinition: capture.definition, qualification: extraction!, representationQualification: finalQualification, captureDigest: await representationDigest(projectedCapture), sourceInventoryDigest: await representationDigest(sources), facts: currentFacts, accountedSourceIds: currentAccounted };
      const expected = { ...base, digest: await representationDigest(base) };
      return { expected, qualification: extraction!, representationQualification: finalQualification };
    },
  };
}
