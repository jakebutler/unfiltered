import { evaluateSlots, evaluateTopic, hasValidEvidence } from './readiness.js';
import { ContentConfigurationError, type EvidenceContext, type Scalar, type SlotAnswer, type SlotAnswers, type SlotDefinition, type TopicDefinition, type TopicResponse } from './types.js';

export interface GuidedField {
  readonly path: string;
  readonly label: string;
  readonly kind: SlotDefinition['kind'];
  readonly promptIds: readonly string[];
  readonly choices?: readonly (string|number|boolean)[];
  readonly acceptsNegative: boolean;
  readonly acceptsNotApplicable: boolean;
  readonly action: 'answer'|'start-collection'|'finish-or-add';
  readonly allowedStates: readonly string[];
}

function resolve(definitions: readonly SlotDefinition[], answers: SlotAnswers, path: string): {definition:SlotDefinition;answer:SlotAnswer|undefined} {
  for (const definition of definitions) {
    if (path === definition.id) return { definition, answer:answers[definition.id] };
    if (definition.kind !== 'collection' || !path.startsWith(`${definition.id}[`)) continue;
    const rest = path.slice(definition.id.length);
    const match = /^\[([A-Za-z0-9_-]+)\]\.(.+)$/.exec(rest);
    if (!match) break;
    const collection = answers[definition.id];
    const item = collection?.state === 'known' && collection.items?.find(item=>item.id === match[1]);
    if (!item) break;
    return resolve(definition.fields ?? [],item.answers,match[2]);
  }
  throw new ContentConfigurationError('unknown-slot-path');
}

function replace(definitions: readonly SlotDefinition[], answers: SlotAnswers, path: string, answer: SlotAnswer): SlotAnswers {
  const exact = definitions.find(definition=>definition.id === path);
  if (exact) return { ...answers,[path]:answer };
  for (const definition of definitions) {
    if (definition.kind !== 'collection' || !path.startsWith(`${definition.id}[`)) continue;
    const match = /^\[([A-Za-z0-9_-]+)\]\.(.+)$/.exec(path.slice(definition.id.length));
    const collection = answers[definition.id];
    if (!match || collection?.state !== 'known' || !collection.items?.some(item=>item.id === match[1])) break;
    return { ...answers,[definition.id]:{...collection,items:collection.items.map(item=>item.id === match[1] ? {...item,answers:replace(definition.fields ?? [],item.answers,match[2],answer)} : item)} };
  }
  throw new ContentConfigurationError('unknown-slot-path');
}

/** One actual missing field. The exact multi-part source prompt is paired with a focused structured field label. */
export function nextGuidedField(topic: TopicDefinition, response: TopicResponse, evidence: EvidenceContext): GuidedField | undefined {
  const result = evaluateTopic(topic,response,evidence);
  if (response.stopped || result.sufficient || result.collection === 'not-applicable' || (topic.presentation === 'C' && response.applicability !== 'applicable')) return undefined;
  for (const slot of result.slots) {
    if (slot.state !== 'unresolved' || !slot.promptIds.length || ['unanswered','invalid-evidence','condition-unresolved'].includes(slot.reason ?? '')) continue;
    const {definition,answer} = resolve(topic.slots,response.answers,slot.id);
    if (definition.kind === 'configuration') continue;
    if (definition.kind === 'collection' && answer?.state === 'known' && answer.items) {
      if (result.slots.some(child=>child.id.startsWith(`${slot.id}[`) && child.state === 'unresolved' && child.promptIds.length)) continue;
    }
    return guidedFieldForPath(topic,response,slot.id);
  }
  return undefined;
}

/** Resolve a previously answered slot for a precise correction without changing its source history. */
export function guidedFieldForPath(topic: TopicDefinition, response: TopicResponse, path: string): GuidedField {
  const {definition,answer} = resolve(topic.slots,response.answers,path);
  const action = definition.kind !== 'collection' ? 'answer' : answer?.state === 'known' && answer.items?.length ? 'finish-or-add' : 'start-collection';
  return {path,label:definition.label,kind:definition.kind,promptIds:definition.promptIds,choices:definition.choices,acceptsNegative:!!definition.acceptsNegative,acceptsNotApplicable:!!definition.acceptsNotApplicable,action,allowedStates:['known',...(definition.acceptsNegative ? ['negative'] : []),'unknown','declined','uncertain','skipped',...(definition.acceptsNotApplicable ? ['not-applicable'] : [])]};
}

/** Strict structured parsing; never extracts a clinical fact or units from conversational prose. */
export function parseGuidedValue(field: Pick<GuidedField,'kind'|'choices'>, input: string | {feet:string;inches:string}): Scalar {
  if (field.kind === 'height-value' && typeof input === 'object') {
    if (!input.feet.trim() || !input.inches.trim()) throw new ContentConfigurationError('invalid-value');
    if (!/^\d+$/.test(input.feet.trim()) || !/^\d+(?:\.\d+)?$/.test(input.inches.trim())) throw new ContentConfigurationError('invalid-value');
    const feet = Number(input.feet); const inches = Number(input.inches);
    if (!Number.isSafeInteger(feet) || inches >= 12 || feet * 12 + inches <= 0) throw new ContentConfigurationError('invalid-value');
    return {feet,inches};
  }
  if (typeof input !== 'string' || !input.trim()) throw new ContentConfigurationError('invalid-value');
  if (field.kind === 'text') return input.trim();
  if (field.kind === 'positive-number' || field.kind === 'height-value') {
    if (!/^\d+(?:\.\d+)?$/.test(input.trim())) throw new ContentConfigurationError('invalid-value');
    const value = Number(input);
    if (!Number.isFinite(value) || value <= 0) throw new ContentConfigurationError('invalid-value');
    return value;
  }
  if (field.kind === 'presence') {
    if (input !== 'true') throw new ContentConfigurationError('explicit-presence-required');
    return true;
  }
  if (field.kind === 'choice') {
    const choice = field.choices?.find(choice=>String(choice) === input);
    if (choice === undefined) throw new ContentConfigurationError('invalid-value');
    return choice;
  }
  throw new ContentConfigurationError('structured-collection-or-configuration-action-required');
}

export function applyGuidedAnswer(topic: TopicDefinition, response: TopicResponse, input: {path:string;answer:SlotAnswer}, evidence: EvidenceContext): TopicResponse {
  const {definition} = resolve(topic.slots,response.answers,input.path);
  if (definition.kind === 'configuration' || (definition.kind === 'collection' && input.answer.state === 'known')) throw new ContentConfigurationError('structured-collection-or-configuration-action-required');
  const result = evaluateSlots([{...definition,when:undefined}],{[definition.id]:input.answer},evidence)[0];
  if (['invalid-value','invalid-evidence','negative-not-allowed','not-applicable-not-allowed'].includes(result.reason ?? '')) throw new ContentConfigurationError(result.reason!);
  return {...response,presented:true,answers:replace(topic.slots,response.answers,input.path,input.answer)};
}

/** A patient explicitly starts/adds an item; no item is inferred from a single free-text topic answer. */
export function addCollectionItem(topic: TopicDefinition, response: TopicResponse, input: {path:string;itemId:string;sourceIds:readonly string[]}, evidence: EvidenceContext): TopicResponse {
  const {definition,answer} = resolve(topic.slots,response.answers,input.path);
  if (definition.kind !== 'collection' || !/^[A-Za-z0-9_-]+$/.test(input.itemId)) throw new ContentConfigurationError('invalid-collection-item');
  const items = answer?.state === 'known' && answer.items ? answer.items : [];
  if (items.some(item=>item.id === input.itemId)) throw new ContentConfigurationError('duplicate-collection-item');
  const collection: SlotAnswer = {state:'known',items:[...items,{id:input.itemId,answers:{}}],complete:false,sourceIds:[...new Set([...(answer?.sourceIds ?? []),...input.sourceIds])]};
  if (!hasValidEvidence(collection,evidence) || !input.sourceIds.length || !input.sourceIds.every(id=>evidence.validSourceIds.has(id))) throw new ContentConfigurationError('invalid-evidence');
  return {...response,presented:true,answers:replace(topic.slots,response.answers,input.path,collection)};
}

/** Finished listing is distinct from sufficient detail; unresolved child fields remain unresolved. */
export function finishCollection(topic: TopicDefinition, response: TopicResponse, input: {path:string;sourceIds:readonly string[]}, evidence: EvidenceContext): TopicResponse {
  const {definition,answer} = resolve(topic.slots,response.answers,input.path);
  if (definition.kind !== 'collection' || answer?.state !== 'known' || !answer.items?.length) throw new ContentConfigurationError('collection-not-started');
  if (!input.sourceIds.length || !input.sourceIds.every(id=>evidence.validSourceIds.has(id))) throw new ContentConfigurationError('invalid-evidence');
  const complete = {...answer,complete:true,sourceIds:[...new Set([...answer.sourceIds,...input.sourceIds])]};
  return {...response,presented:true,answers:replace(topic.slots,response.answers,input.path,complete)};
}
