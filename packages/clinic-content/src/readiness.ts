import type { EvidenceContext, SlotAnswer, SlotAnswers, SlotDefinition, SlotReadiness, TopicDefinition, TopicReadiness, TopicResponse } from './types.js';

export function hasValidEvidence(answer: SlotAnswer | undefined, context: EvidenceContext, path?: string): boolean {
  return !!answer?.sourceIds?.length && (answer.sourceIds.every(id => context.validSourceIds.has(id)) || !!(context.topicId && path && !/^MH0[1-4]$/.test(path) && context.reviewedFact?.(context.topicId, path, answer)));
}

function valueValid(slot: SlotDefinition, answer: SlotAnswer): boolean {
  if (answer.state !== 'known' || answer.items) return false;
  const v = answer.value;
  switch (slot.kind) {
    case 'text': return typeof v === 'string' && v.trim().length > 0;
    case 'positive-number': return typeof v === 'number' && Number.isFinite(v) && v > 0;
    case 'height-value': return typeof v === 'number' ? Number.isFinite(v) && v > 0 : typeof v === 'object' && v !== null && Number.isInteger(v.feet) && v.feet >= 0 && Number.isFinite(v.inches) && v.inches >= 0 && v.inches < 12 && v.feet * 12 + v.inches > 0;
    case 'choice': return slot.choices?.some(choice => choice === v) === true;
    case 'presence': return v === true; // Explicit negatives use their own state, never false/unchecked.
    case 'collection': return false;
    case 'configuration': return false;
  }
}

export function evaluateSlots(definitions: readonly SlotDefinition[], answers: SlotAnswers, context: EvidenceContext, prefix = ''): SlotReadiness[] {
  const results: SlotReadiness[] = [];
  for (const slot of definitions) {
    const answer = answers[slot.id];
    const id = prefix + slot.id;
    const base = { id, answerState: answer?.state ?? 'not-asked', sourceIds: answer?.sourceIds ?? [], promptIds: slot.promptIds } as const;
    if (slot.optional && (!answer || answer.state === 'not-asked')) { results.push({...base,state:'not-applicable'}); continue; }
    if (slot.when) {
      if (slot.when.condition === 'uncertain') {
        const anchorIds = [slot.when.slotId,...(slot.when.orSlotIds ?? [])], anchors = anchorIds.map(id=>answers[id]);
        const uncertain = anchors.some((anchor,index)=>anchor?.state === 'uncertain' && hasValidEvidence(anchor,context,prefix + anchorIds[index]));
        if (!uncertain) {
          const settled = anchors.every((anchor,index)=>hasValidEvidence(anchor,context,prefix + anchorIds[index]) && (anchor?.state === 'known' || anchor?.state === 'negative'));
          results.push({...base,state:settled ? 'not-applicable' : 'unresolved',...(settled ? {} : {reason:'condition-unresolved' as const}),sourceIds:settled ? [...new Set(anchors.flatMap(anchor=>anchor?.sourceIds??[]))] : base.sourceIds,promptIds:[]});
          continue;
        }
      } else {
      const anchor = answers[slot.when.slotId];
      const anchorDefinition = definitions.find(d => d.id === slot.when!.slotId);
      const extra = slot.when.alsoWhenTrue ? answers[slot.when.alsoWhenTrue] : undefined;
      const additionalTrigger = extra?.state === 'known' && extra.value === true && hasValidEvidence(extra, context, prefix + slot.when.alsoWhenTrue);
      const valid = hasValidEvidence(anchor, context, prefix + slot.when.slotId);
      const negative = valid && anchor?.state === 'negative' && anchorDefinition?.acceptsNegative === true;
      const positive = valid && anchor?.state === 'known' && !!anchorDefinition && valueValid(anchorDefinition, anchor);
      if ((slot.when.condition === 'positive' && negative) || (slot.when.condition === 'estimate-needed' && !additionalTrigger && positive && anchor?.state === 'known' && anchor.value === true)) {
        results.push({ ...base, state: 'not-applicable', sourceIds: anchor!.sourceIds! });
        continue;
      }
      const applicable = slot.when.condition === 'positive' ? positive : additionalTrigger || valid && ((positive && anchor?.state === 'known' && anchor.value === false) || anchor?.state === 'uncertain' || anchor?.state === 'unknown');
      if (!applicable) { results.push({ ...base, state: 'unresolved', reason: 'condition-unresolved', promptIds: [] }); continue; }
      }
    }
    if (!answer || answer.state === 'not-asked') { results.push({ ...base, state: 'unresolved', reason: 'missing' }); continue; }
    if (!hasValidEvidence(answer, context, id)) { results.push({ ...base, state: 'unresolved', reason: 'invalid-evidence', promptIds: [] }); continue; }
    if (answer.state === 'negative') { results.push({ ...base, state: slot.acceptsNegative ? 'sufficient' : 'unresolved', ...(slot.acceptsNegative ? {} : { reason: 'negative-not-allowed' as const }) }); continue; }
    if (answer.state === 'not-applicable') { results.push({ ...base, state: slot.acceptsNotApplicable ? 'not-applicable' : 'unresolved', ...(slot.acceptsNotApplicable ? {} : { reason: 'not-applicable-not-allowed' as const }) }); continue; }
    if (answer.state === 'uncertain' && slot.acceptsUncertain) { results.push({ ...base, state: 'sufficient' }); continue; }
    if (answer.state !== 'known') { results.push({ ...base, state: 'unresolved', reason: 'unanswered', promptIds: [] }); continue; }
    if (slot.kind === 'collection') {
      const items = answer.items;
      if (!items?.length || new Set(items.map(item => item.id)).size !== items.length || items.some(item => !/^[A-Za-z0-9_-]+$/.test(item.id))) {
        results.push({ ...base, state: 'unresolved', reason: 'invalid-value' }); continue;
      }
      const children = items.flatMap(item => evaluateSlots(slot.fields ?? [], item.answers, context, `${id}[${item.id}].`));
      const sufficient = answer.complete === true && children.every(child => child.state !== 'unresolved');
      results.push({ ...base, sourceIds: [...new Set([...base.sourceIds, ...children.flatMap(child => child.sourceIds)])], state: sufficient ? 'sufficient' : 'unresolved', reason: sufficient ? undefined : answer.complete !== true ? 'collection-open' : 'unanswered' }, ...children);
      continue;
    }
    results.push({ ...base, state: valueValid(slot, answer) ? 'sufficient' : 'unresolved', ...(valueValid(slot, answer) ? {} : { reason: 'invalid-value' as const }) });
  }
  return results;
}

export function evaluateTopic(topic: TopicDefinition, response: TopicResponse, context: EvidenceContext): TopicReadiness {
  // A conditional topic cannot be activated or suppressed by a missing/unchecked answer.
  if (topic.presentation === 'C' && response.applicability !== 'applicable') {
    const sourceIds = response.applicabilitySourceIds ?? [];
    const notApplicable = response.applicability === 'not-applicable' && sourceIds.length > 0 && sourceIds.every(id=>context.validSourceIds.has(id));
    const slots: SlotReadiness[] = topic.slots.filter(slot=>!slot.optional).map(slot=>({id:slot.id,answerState:'not-asked',state:notApplicable ? 'not-applicable' : 'unresolved',...(notApplicable ? {} : {reason:'condition-unresolved' as const}),sourceIds:[...sourceIds],promptIds:[]}));
    return {topicId:topic.id,presentedOrAccountedFor:notApplicable || response.presented,sufficient:notApplicable,collection:notApplicable ? 'not-applicable' : response.stopped ? 'stopped' : 'awaiting-information',slots,unresolvedSlotIds:notApplicable ? [] : slots.map(slot=>slot.id),nextPromptIds:[],partialHandoffAllowed:true};
  }
  context = { ...context, topicId: topic.id };
  let slots = evaluateSlots(topic.slots, response.answers, context);
  if (topic.id === 'Q04') slots = checkHeightUnitPair(slots, response.answers);
  if (topic.id === 'Q06' && response.answers.reportedConditions?.state === 'negative' && topic.slots.some(slot=>slot.id.startsWith('conditions.') && response.answers[slot.id]?.state === 'known' && (response.answers[slot.id] as {value?:unknown}).value === true && hasValidEvidence(response.answers[slot.id],context,slot.id))) {
    slots = slots.map(slot=>slot.id === 'reportedConditions' ? {...slot,state:'unresolved',reason:'invalid-value'} : slot);
  }
  const unresolved = slots.filter(slot => slot.state === 'unresolved');
  const blocking = unresolved.filter(result=>!topic.slots.find(definition=>definition.id === result.id)?.optional || ['invalid-value','invalid-evidence'].includes(result.reason ?? ''));
  const sufficient = blocking.length === 0 && !(topic.presentation === 'C' && response.applicability !== 'applicable');
  const stopped = !!response.stopped;
  const nextPromptIds = stopped || sufficient ? [] : [...new Set(unresolved.flatMap(slot => slot.promptIds))];
  return {
    topicId: topic.id, presentedOrAccountedFor: response.presented || slots.some(slot => slot.answerState !== 'not-asked'), sufficient,
    collection: sufficient ? 'complete' : stopped ? 'stopped' : nextPromptIds.length ? 'continue' : 'awaiting-information',
    slots, unresolvedSlotIds: unresolved.map(slot => slot.id), nextPromptIds, partialHandoffAllowed: true,
  };
}

function checkHeightUnitPair(slots: SlotReadiness[], answers: SlotAnswers): SlotReadiness[] {
  const value = answers['height.value']; const unit = answers['height.unit'];
  if (value?.state !== 'known' || value.items || unit?.state !== 'known' || unit.items) return slots;
  const objectValue = typeof value.value === 'object';
  if (objectValue !== (unit.value === 'ft-in')) return slots.map(slot => slot.id === 'height.value' ? { ...slot, state: 'unresolved', reason: 'invalid-value' } : slot);
  return slots;
}

/** Mechanical target results only. The caller still validates source ownership and attests trusted assessment. */
export function aggregateTargets(topic: TopicDefinition, readiness: TopicReadiness) {
  if (topic.id !== readiness.topicId) throw new Error('topic-readiness-mismatch');
  return topic.slots.filter(definition=>!definition.optional).map(definition => {
    const slot = readiness.slots.find(result => result.id === definition.id);
    return { id: definition.id, state: slot && slot.state !== 'unresolved' ? 'sufficient' as const : 'unresolved' as const, sourceIds: [...(slot?.sourceIds ?? [])] };
  });
}
