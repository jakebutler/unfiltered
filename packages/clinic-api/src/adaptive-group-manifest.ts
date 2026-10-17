import { scenarioForWorkflowTopic } from '../../clinic-content/src/scenarios.js';
import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { canonicalJson } from '../../clinical-core/src/domain.js';
import { createClinicContent, type SlotAnswer, type SlotAnswers, type SlotDefinition, type TopicDefinition } from '../../clinic-content/src/index.js';
import { AdaptiveError, type AdaptiveContext, type AdaptiveFact } from './adaptive-validation.js';
import { adaptiveSourceSegments, type SourceSegment } from './adaptive-source.js';
import { adaptiveGroupInstruction, adaptiveGroupProtocol, adaptiveGroupGuidanceRevision } from './adaptive-group-guidance.js';
import { adaptiveGroupNativeSchemaRevision, draft7AdaptiveGroupNativeSchemaRevision, normalizeAdaptiveGroupNativeSchema, type AdaptiveGroupNativeSchemaRevision } from './adaptive-group-native-schema.js';
import { assertAdaptiveSourceHandles, type AdaptiveSourceHandles } from './adaptive-group-source-handles.js';

export const adaptiveGroupSchemaName = 'adaptive_scoped_groups_v6';
type State = AdaptiveFact['state'];
export type GroupAdmission = 'admitted' | 'scenario-candidate' | 'branch-candidate';
export interface GroupRole { readonly role: string; readonly definition: SlotDefinition; readonly states: readonly State[]; }
export interface GroupFamily { readonly kind: string; readonly topicId: string; readonly collection?: string; readonly roles: readonly GroupRole[]; readonly anchorRoles: readonly string[]; readonly admission: GroupAdmission; readonly acceptsNegative: boolean; }
export interface GroupEntity { readonly ref: string; readonly family: string; readonly itemId: string; readonly answers: SlotAnswers; }
export interface AdaptiveGroupManifestOptions { readonly candidateTopics?: readonly TopicDefinition[]; readonly nativeSchemaRevision?: AdaptiveGroupNativeSchemaRevision; readonly sourceHandles?: AdaptiveSourceHandles; }
export interface AdaptiveGroupManifest { readonly protocol: typeof adaptiveGroupProtocol; readonly nativeSchemaRevision?: typeof draft7AdaptiveGroupNativeSchemaRevision; readonly id: string; readonly sha256: string; readonly instruction: string; readonly jsonSchema: Record<string, unknown>; readonly payloads: readonly unknown[]; }
export interface IssuedAdaptiveGroupManifest { readonly contextSignature: string; readonly families: readonly GroupFamily[]; readonly entities: readonly GroupEntity[]; readonly segments: readonly SourceSegment[]; readonly wire: z.ZodType; }
const issued = new WeakMap<AdaptiveGroupManifest, IssuedAdaptiveGroupManifest>();
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const freeze = <T>(value: T): T => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export const adaptiveGroupAnchorRoles: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'Q03.majorChanges': ['change'], 'Q05.approaches': ['approach'], 'Q06.reportedConditions': ['term'], 'Q07.events': ['event'],
  'Q08.medicines': ['name'], 'Q09.reactions': ['substance'], 'Q10.familyHistory': ['condition', 'relationship'],
  'Q11.occasions': ['time', 'foods', 'drinks'], 'Q17.substances': ['substance'], 'Q19.clinicians': ['owner'], 'Q19.records': ['record'], W07: ['medicine'],
});
const forbidden = (definition: SlotDefinition, topic: string) => definition.kind === 'configuration' || /^MH0[1-4]$/.test(definition.id) || definition.id === 'currentWeightEstimate.statedAt'
  || !!scenarioForWorkflowTopic(topic)?.behaviour?.extractionBlockedSlotIds?.includes(definition.id);
const states = (definition: SlotDefinition): State[] => ['known', 'unknown', 'declined', 'uncertain', ...(definition.acceptsNegative ? ['negative' as const] : []), ...(definition.acceptsNotApplicable ? ['not-applicable' as const] : [])];
const enumeration = (values: string[]) => values.length ? z.enum(values as [string, ...string[]]) : z.never();
const alternatives = (values: z.ZodType[]) => values.length === 1 ? values[0] : values.length ? z.union(values as [z.ZodType, z.ZodType, ...z.ZodType[]]) : z.never();
const addressSchema = z.strictObject({ segment: z.string().regex(/^s\d+$/), quote: z.string().min(1).max(8000) });
const supportSchema = z.array(addressSchema).min(1).max(4);
const answerSchema = z.union([
  z.strictObject({ state: z.literal('known'), value: addressSchema, support: supportSchema }),
  z.strictObject({ state: z.enum(['negative', 'unknown', 'declined', 'uncertain', 'not-applicable']), value: z.null(), support: supportSchema }),
]);
const keySchema = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const correctionSchema = z.array(z.number().int().min(0).max(31)).max(8);
const profile = (role: GroupRole) => `${role.states.includes('negative') ? 'n' : ''}${role.states.includes('not-applicable') ? 'a' : ''}` || 'base';
function compact(answer: SlotAnswer): unknown {
  return structuredClone([answer.state, answer.state === 'known' ? answer.value ?? null : null, 'note' in answer ? answer.note ?? null : null]);
}

/** Complete finite mapping, sourced from reviewed slots; no provider-selected paths or chart IDs. */
export function adaptiveGroupFamilies(topics: readonly TopicDefinition[], admitted: ReadonlySet<string>): GroupFamily[] {
  const families: GroupFamily[] = [];
  for (const topic of topics) {
    const admission: GroupAdmission = admitted.has(topic.id) ? 'admitted' : topic.presentation === 'C' ? 'branch-candidate' : 'scenario-candidate';
    const add = (kind: string, definitions: readonly SlotDefinition[], collection?: SlotDefinition) => {
      const roles = definitions.filter(definition => !forbidden(definition, topic.id)).map(definition => ({ role: definition.id, definition: structuredClone(definition), states: states(definition) }));
      if (!roles.length) return;
      const anchorRoles = adaptiveGroupAnchorRoles[kind] ?? [];
      if (collection && !anchorRoles.length || roles.some(role => role.definition.kind === 'collection')) throw new AdaptiveError('unsupported-group-family');
      if (anchorRoles.some(role => !roles.some(entry => entry.role === role))) throw new AdaptiveError('invalid-group-anchor-policy');
      families.push({ kind, topicId: topic.id, ...(collection ? { collection: collection.id } : {}), roles, anchorRoles, admission, acceptsNegative: !!collection?.acceptsNegative });
    };
    add(topic.id, topic.slots.filter(definition => definition.kind !== 'collection'));
    for (const collection of topic.slots.filter(definition => definition.kind === 'collection')) add(`${topic.id}.${collection.id}`, collection.fields ?? [], collection);
  }
  return families;
}

/** Native grammar enforces family ownership; role-state compatibility is strict locally, explicit in payload. */
export function createAdaptiveGroupManifest(context: AdaptiveContext, options: AdaptiveGroupManifestOptions = {}): AdaptiveGroupManifest {
  const nativeRevision = adaptiveGroupNativeSchemaRevision(options.nativeSchemaRevision);
  const nativeSelection = nativeRevision === draft7AdaptiveGroupNativeSchemaRevision ? { nativeSchemaRevision: nativeRevision } : {};
  if (options.sourceHandles) assertAdaptiveSourceHandles(context, options.sourceHandles);
  const contextSignature = canonicalJson(context), segments = options.sourceHandles ? [] : adaptiveSourceSegments(context);
  const register = createClinicContent({ mentalHealth: 'phq4' }), scenario = register.scenarios[context.binding.scenario];
  if (!scenario) throw new AdaptiveError('invalid-group-scenario');
  const permitted = new Map([...register.topics.filter(topic => scenario.reusableTopicIds.includes(topic.id as never)), ...scenario.additionalTopics,
    ...(scenario.reusableTopicIds.includes('Q06') ? Object.values(register.branches).map(branch => branch.topic) : [])].map(topic => [topic.id, topic]));
  const topics = [...context.topics], ids = new Set(topics.map(topic => topic.id));
  if (ids.size !== topics.length) throw new AdaptiveError('duplicate-group-topic');
  for (const candidate of options.candidateTopics ?? []) {
    if (!permitted.has(candidate.id) || canonicalJson(candidate) !== canonicalJson(permitted.get(candidate.id))) throw new AdaptiveError('group-candidate-not-permitted');
    if (ids.has(candidate.id)) { if (canonicalJson(topics.find(topic => topic.id === candidate.id)) !== canonicalJson(candidate)) throw new AdaptiveError('group-topic-definition-conflict'); continue; }
    topics.push(candidate); ids.add(candidate.id);
  }
  const families = adaptiveGroupFamilies(topics, new Set(context.topics.map(topic => topic.id)));
  const entities: GroupEntity[] = [];
  for (const family of families.filter(family => family.anchorRoles.length)) {
    const response = context.responses[family.topicId];
    if (!family.collection) {
      if (response && family.anchorRoles.some(role => response.answers[role]?.state === 'known')) entities.push({ ref: `e${entities.length}`, family: family.kind, itemId: '', answers: structuredClone(response.answers) });
      continue;
    }
    const answer = response?.answers[family.collection];
    if (answer?.state === 'known') for (const item of answer.items ?? []) entities.push({ ref: `e${entities.length}`, family: family.kind, itemId: item.id, answers: structuredClone(item.answers) });
  }
  const replies = [
    { id: 'COPY-02', purpose: 'Capability/diagnostic limits.' }, { id: 'COPY-04', purpose: 'Treatment/prescribing/eligibility belongs to clinician review.' },
    { id: 'COPY-05', purpose: 'Dose/taking/change/skip/repeat belongs to prescriber/pharmacist review.' }, { id: 'unsupported', purpose: 'No approved answer; retain question for human review.' }, ...(context.approvedReplies ?? []),
  ];
  if (new Set(replies.map(reply => reply.id)).size !== replies.length) throw new AdaptiveError('duplicate-approved-reply');
  const id = hash({ protocol: adaptiveGroupProtocol, guidance: adaptiveGroupGuidanceRevision, context, topics, ...nativeSelection }).slice(0, 24);
  const groupShapes: z.ZodType[] = families.flatMap((family): z.ZodType[] => {
    const field = z.strictObject({ role: enumeration(family.roles.map(role => role.role)), answer: answerSchema });
    const common = { kind: z.literal(family.kind), key: keySchema, fields: z.array(field).max(family.collection ? 12 : 16) };
    if (!family.anchorRoles.length) return [z.strictObject({ ...common, scope: z.literal('patient'), correct: correctionSchema })];
    const prior = entities.filter(entity => entity.family === family.kind);
    return [z.strictObject({ ...common, scope: z.strictObject({ mode: z.literal('new'), anchor: z.strictObject({ role: enumeration([...family.anchorRoles]), answer: answerSchema }) }), correct: z.array(z.never()).max(0) }),
      ...(prior.length ? [z.strictObject({ ...common, scope: z.strictObject({ mode: z.literal('existing'), ref: enumeration(prior.map(entity => entity.ref)), anchor: supportSchema }), correct: correctionSchema })] : [])];
  });
  const collections = families.filter(family => family.collection), negativeCollections = collections.filter(family => family.acceptsNegative);
  const wire = z.strictObject({
    schema: z.literal(6), context: z.literal(id), groups: z.array(alternatives(groupShapes)).max(32),
    completedLists: z.array(z.strictObject({ family: enumeration(collections.map(family => family.kind)), support: supportSchema })).max(collections.length ? 8 : 0),
    absentLists: z.array(z.strictObject({ family: enumeration(negativeCollections.map(family => family.kind)), support: supportSchema })).max(negativeCollections.length ? 8 : 0),
    sharedConcerns: z.array(z.strictObject({ family: z.literal('Q08.medicines'), entities: z.array(keySchema).min(2).max(8), answer: answerSchema })).max(families.some(family => family.kind === 'Q08.medicines') ? 4 : 0),
    acts: z.array(z.union([z.strictObject({ kind: z.literal('question'), support: supportSchema, reply: enumeration(replies.map(reply => reply.id)) }),
      z.strictObject({ kind: z.enum(['move-on', 'topic-switch']), support: supportSchema, topic: enumeration([...ids]) })])).max(4),
    unmapped: z.array(z.strictObject({ support: supportSchema, reason: z.enum(['ambiguous', 'unsupported-target', 'capacity']) })).max(8),
  });
  const originalSchema = nativeSchema(families, entities, id, replies.map(reply => reply.id));
  const jsonSchema = nativeRevision === draft7AdaptiveGroupNativeSchemaRevision ? normalizeAdaptiveGroupNativeSchema(originalSchema) : originalSchema;
  const stateProfiles = Object.fromEntries(families.flatMap(family => family.roles.map(role => [profile(role), role.states])));
  const payloads: unknown[] = [
    { context: id, scenario: context.binding.scenario, source: context.source.text, segments: segments.map((segment, index) => [ `s${index}`, segment.kind, segment.start, segment.end ]), displayed: structuredClone(context.displayed ?? null), activeTopic: context.dialogue?.activeTopicId ?? null, suspended: structuredClone(context.dialogue?.suspended ?? null) },
    { stateProfiles, families: families.map(family => ({ kind: family.kind, admission: family.admission, anchors: family.anchorRoles, roles: family.roles.map(role => ({ role: role.role, label: role.definition.label, kind: role.definition.kind, states: profile(role), ...(role.definition.choices ? { choices: role.definition.choices } : {}), ...(role.definition.when ? { when: role.definition.when } : {}) })) })),
      entities: entities.map(entity => ({ ref: entity.ref, family: entity.family, fields: Object.fromEntries(Object.entries(entity.answers).filter(([,answer]) => answer).map(([role, answer]) => [role, compact(answer!)])) })),
      currentFacts: Object.fromEntries(context.topics.map(topic => { const response = context.responses[topic.id]; return [topic.id, response ? { applicability: response.applicability, stopped: response.stopped, answers: Object.fromEntries(Object.entries(response.answers).filter(([,answer]) => answer).map(([path,answer]) => [path, answer!.state === 'known' && answer!.items ? { state: answer!.state, complete: answer!.complete ?? false, entities: entities.filter(entity => entity.family === `${topic.id}.${path}`).map(entity => entity.ref) } : compact(answer!)])) } : null]; })), replies },
  ];
  const manifest = freeze({ protocol: adaptiveGroupProtocol, ...nativeSelection, id, sha256: hash({ id, payloads, jsonSchema, instruction: adaptiveGroupInstruction }), instruction: adaptiveGroupInstruction, jsonSchema, payloads });
  issued.set(manifest, { contextSignature, families: freeze(families), entities: freeze(entities), segments, wire });
  return manifest;
}

/** Issued capability check; rebuilding/cloning a manifest never grants a binding. */
export function issuedAdaptiveGroupManifest(manifest: AdaptiveGroupManifest, context: AdaptiveContext): IssuedAdaptiveGroupManifest {
  const found = issued.get(manifest);
  if (!found || found.contextSignature !== canonicalJson(context)) throw new AdaptiveError('stale-group-manifest');
  return found;
}

function nativeSchema(families: readonly GroupFamily[], entities: readonly GroupEntity[], id: string, replies: string[]): Record<string, unknown> {
  const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
  const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
  const array = (items: unknown, maxItems: number, minItems = 0) => ({ type: 'array', items, minItems, maxItems });
  const enumeration = (values: readonly string[]) => values.length ? { type: 'string', enum: values } : false;
  const definitions: Record<string, unknown> = {
    Address: object({ segment: { type: 'string', pattern: '^s[0-9]+$' }, quote: { type: 'string', minLength: 1, maxLength: 8000 } }),
    Support: array(ref('Address'), 4, 1), Key: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,40}$' }, Corrections: array({ type: 'integer', minimum: 0, maximum: 31 }, 8),
    Answer: { anyOf: [object({ state: { const: 'known' }, value: ref('Address'), support: ref('Support') }), object({ state: enumeration(['negative', 'unknown', 'declined', 'uncertain', 'not-applicable']), value: { type: 'null' }, support: ref('Support') })] },
  };
  const groups = families.map(family => {
    const fieldId = `Field_${family.kind.replaceAll('.', '_')}`, groupId = `Group_${family.kind.replaceAll('.', '_')}`;
    definitions[fieldId] = object({ role: enumeration(family.roles.map(role => role.role)), answer: ref('Answer') });
    const common = { kind: { const: family.kind }, key: ref('Key'), fields: array(ref(fieldId), family.collection ? 12 : 16) };
    const prior = entities.filter(entity => entity.family === family.kind);
    definitions[groupId] = { anyOf: family.anchorRoles.length ? [object({ ...common, scope: object({ mode: { const: 'new' }, anchor: object({ role: enumeration(family.anchorRoles), answer: ref('Answer') }) }), correct: array(false, 0) }),
      ...(prior.length ? [object({ ...common, scope: object({ mode: { const: 'existing' }, ref: enumeration(prior.map(entity => entity.ref)), anchor: ref('Support') }), correct: ref('Corrections') })] : [])]
      : [object({ ...common, scope: { const: 'patient' }, correct: ref('Corrections') })] };
    return ref(groupId);
  });
  const collectionNames = families.filter(family => family.collection).map(family => family.kind), absentNames = families.filter(family => family.collection && family.acceptsNegative).map(family => family.kind);
  return { ...object({ schema: { const: 6 }, context: { const: id }, groups: array({ anyOf: groups }, 32),
    completedLists: array(object({ family: enumeration(collectionNames), support: ref('Support') }), collectionNames.length ? 8 : 0),
    absentLists: array(object({ family: enumeration(absentNames), support: ref('Support') }), absentNames.length ? 8 : 0),
    sharedConcerns: array(object({ family: { const: 'Q08.medicines' }, entities: array(ref('Key'), 8, 2), answer: ref('Answer') }), families.some(family => family.kind === 'Q08.medicines') ? 4 : 0),
    acts: array({ anyOf: [object({ kind: { const: 'question' }, support: ref('Support'), reply: enumeration(replies) }), object({ kind: enumeration(['move-on', 'topic-switch']), support: ref('Support'), topic: enumeration([...new Set(families.map(family => family.topicId))]) })] }, 4),
    unmapped: array(object({ support: ref('Support'), reason: enumeration(['ambiguous', 'unsupported-target', 'capacity']) }), 8),
  }), $defs: definitions };
}
