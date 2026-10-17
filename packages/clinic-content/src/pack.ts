import { z } from 'zod';
import { PHQ4_ITEM_IDS, PHQ4_TOPIC_ID } from './mental-health.js';
import { mentalHealthOptions, promptsById } from './content-constants.js';
import { mentalHealthSlots } from './slots.js';
import { branchRuleIds } from './pack-rules.js';

export { branchRuleIds } from './pack-rules.js';
export const PACK_SCHEMA_VERSION = 1 as const;

/**
 * This format preserves the authoring source; it does not replace the native publisher.
 * Remaining code-level rules: W07 medication label/actual-use role checks and refill help
 * projection, plus billing phrase synonyms, remain in clinic-api/adaptive-validation.ts.
 * Workflow scoped question copy is data under additionalTopics[].corvo.scopedQuestions.
 * mentalHealth.options preserves mentalHealthOptions; mentalHealth.slots preserves the
 * variant slots (logically under Q16), without duplicating them in the base topic item list.
 */
const wordingStatus = z.enum(['retained-approved-plan', 'accepted-user-direction', 'proposed-detail', 'locked-instrument']);
const id = z.string().min(1);
const answerOption = z.object({ value: z.union([z.string(), z.number().finite(), z.boolean()]), display: z.string().optional() }).strict();
const enableWhen = z.object({ question: id, operator: z.enum(['positive', 'estimate-needed', 'uncertain']), alsoWhenTrue: id.optional(), orQuestions: z.array(id).optional() }).strict();
const itemCorvo = z.object({
  promptIds: z.array(id), acceptsNegative: z.boolean().optional(), acceptsNotApplicable: z.boolean().optional(),
  acceptsUncertain: z.boolean().optional(), extractionNegativeScope: z.literal('composite').optional(),
}).strict();

export interface PackItem {
  linkId: string;
  text: string;
  type: 'text' | 'positive-number' | 'height-value' | 'choice' | 'presence' | 'collection' | 'configuration';
  required?: boolean;
  answerOption?: z.infer<typeof answerOption>[];
  enableWhen?: z.infer<typeof enableWhen>;
  item?: PackItem[];
  corvo: z.infer<typeof itemCorvo>;
}

export const packItemSchema: z.ZodType<PackItem> = z.lazy(() => z.object({
  linkId: id, text: z.string(), type: z.enum(['text', 'positive-number', 'height-value', 'choice', 'presence', 'collection', 'configuration']),
  required: z.boolean().optional(), answerOption: z.array(answerOption).optional(), enableWhen: enableWhen.optional(),
  item: z.array(packItemSchema).optional(), corvo: itemCorvo,
}).strict());

const topic = z.object({
  linkId: id, openingPromptId: id, presentation: z.enum(['R', 'R-value', 'O', 'C']), minimumDetailText: z.string(),
  stopWhen: z.array(z.enum(['target-met', 'does-not-know', 'not-applicable', 'patient-declines', 'patient-moves-on', 'resistance-after-purpose', 'safety-interruption'])),
  item: z.array(packItemSchema),
  corvo: z.object({
    wordingVersion: z.number().int().optional(), wordingStatus, purpose: z.string().optional(),
    branchAndClarification: z.string().optional(), workAccountability: z.string().optional(),
    scopedQuestions: z.record(z.string()).optional(),
  }).strict(),
}).strict();
// The retained PHQ-4 source uses this fifth status. Preserve it verbatim for parity;
// cross-reference validation confines it to the exact pre-existing locked prompts.
const prompt = z.object({ id, text: z.string(), origin: z.string(), wordingStatus: z.enum([...wordingStatus.options, 'accepted-targeted-choice']) }).strict();
const lockedInstrument = z.object({
  id: z.literal('phq4'), topicLinkId: id, itemLinkIds: z.array(id), attribution: z.string(),
  presentation: z.literal('buttons-only'), freeTextAnswerable: z.literal(false),
}).strict();
const branchRule = z.discriminatedUnion('id', [
  z.object({ id: z.literal(branchRuleIds[0]) }).strict(),
  z.object({ id: z.literal(branchRuleIds[1]), slot: id }).strict(),
]);
const branch = z.object({
  id, topic, trigger: z.string(), rule: branchRule.optional(), requirementStatus: wordingStatus,
  detailStatus: wordingStatus, sourceIds: z.array(id), lead: z.enum(['medical', 'nutrition', 'admin']),
  optionalFacts: z.array(z.object({ id, promptId: id, fields: z.array(id), separateFrom: id }).strict()).optional(),
  optionalSlots: z.array(packItemSchema).optional(),
}).strict();
const workflow = z.object({
  id, workflowId: id, patientSummary: z.string(), openingPromptId: id, missingContextPromptId: id.optional(),
  contextRequirement: z.string(), reusableTopicIds: z.array(id), additionalTopics: z.array(topic),
  owners: z.array(z.enum(['medical', 'nutrition', 'admin'])), missingContextOwner: z.enum(['medical', 'admin']).optional(),
  completion: z.string(), detailStatus: wordingStatus,
  behaviour: z.object({
    dateSlotIds: z.array(id).optional(), alwaysOwners: z.array(z.enum(['medical', 'nutrition'])).optional(),
    logistics: z.object({ kind: z.enum(['billing', 'scheduling']), slotIds: z.array(id) }).strict().optional(),
    contextPrompts: z.object({ slotId: id, verifiedPromptId: id, missingPromptId: id, requires: z.enum(['appointment', 'plan']) }).strict().optional(),
    extractionBlockedSlotIds: z.array(id).optional(),
  }).strict().optional(),
}).strict();
const pendingOption = z.object({ status: z.literal('unselected'), scoring: z.literal('disabled'), instruction: z.string() }).strict();
const phq4Option = z.object({
  status: z.literal('accepted-targeted-choice'), scoring: z.literal('explicit-complete-only-helper'), stemPromptId: id,
  introPromptId: id, itemIds: z.array(id), choices: z.array(z.object({ value: z.number().finite(), label: z.string() }).strict()),
  attribution: z.string(), source: z.string().url(), instruction: z.string(),
}).strict();
const unscoredOption = z.object({ status: z.literal('proposed-detail'), scoring: z.literal('disabled'), promptId: id, instruction: z.string() }).strict();
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const json: z.ZodType<Json> = z.lazy(() => z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(json), z.record(json)]));
const pack = z.object({
  schemaVersion: z.literal(PACK_SCHEMA_VERSION), id, url: z.string().url(), version: id, title: z.string(),
  provenance: z.record(json), prompts: z.array(prompt), topics: z.array(topic), branches: z.array(branch),
  workflows: z.array(workflow), lockedInstruments: z.array(lockedInstrument),
  mentalHealth: z.object({
    options: z.object({ pending: pendingOption.optional(), phq4: phq4Option.optional(), unscored: unscoredOption.optional() }).strict(),
    slots: z.object({ phq4: z.array(packItemSchema).optional(), unscored: z.array(packItemSchema).optional() }).strict(),
  }).strict(),
}).strict();

type Path = (string | number)[];
type UncheckedPack = z.infer<typeof pack>;

function crossReferenceChecks(value: UncheckedPack, ctx: z.RefinementCtx): void {
  const issue = (path: Path, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  const promptIds = new Set<string>();
  value.prompts.forEach((entry, index) => {
    if (promptIds.has(entry.id)) issue(['prompts', index, 'id'], 'Duplicate prompt id');
    promptIds.add(entry.id);
    if (entry.wordingStatus === 'accepted-targeted-choice' &&
      (!['MH.stem', ...PHQ4_ITEM_IDS].some(id => id === entry.id) || promptsById[entry.id]?.wordingStatus !== entry.wordingStatus)) issue(['prompts', index, 'wordingStatus'], 'Targeted-choice status is reserved for retained PHQ-4 prompts');
  });
  const checkPrompt = (reference: string, path: Path) => { if (!promptIds.has(reference)) issue(path, 'Unknown prompt id'); };
  const topics = [
    ...value.topics.map((entry, index) => ({ entry, path: ['topics', index] as Path })),
    ...value.branches.map((entry, index) => ({ entry: entry.topic, path: ['branches', index, 'topic'] as Path })),
    ...value.workflows.flatMap((entry, index) => entry.additionalTopics.map((entry, child) => ({ entry, path: ['workflows', index, 'additionalTopics', child] as Path }))),
  ];
  const topicIds = new Set<string>();
  topics.forEach(({ entry, path }) => {
    if (topicIds.has(entry.linkId)) issue([...path, 'linkId'], 'Duplicate topic id');
    topicIds.add(entry.linkId);
  });
  const declarations: { item: PackItem; topicId: string; path: Path; variant?: string; nested: boolean }[] = [];
  const checkItems = (items: PackItem[], path: Path, topicId: string, variant?: string, nested = false, baseSiblings: string[] = []): void => {
    const siblings = new Set<string>(baseSiblings);
    items.forEach((entry, index) => {
      if (siblings.has(entry.linkId)) issue([...path, index, 'linkId'], 'Duplicate sibling item id');
      siblings.add(entry.linkId);
    });
    items.forEach((entry, index) => {
      const at = [...path, index];
      declarations.push({ item: entry, topicId, path: at, variant, nested });
      entry.corvo.promptIds.forEach((reference, child) => checkPrompt(reference, [...at, 'corvo', 'promptIds', child]));
      if (entry.enableWhen) {
        const checkSibling = (reference: string, suffix: Path) => { if (!siblings.has(reference)) issue([...at, 'enableWhen', ...suffix], 'enableWhen must reference a sibling item'); };
        checkSibling(entry.enableWhen.question, ['question']);
        if (entry.enableWhen.alsoWhenTrue) checkSibling(entry.enableWhen.alsoWhenTrue, ['alsoWhenTrue']);
        entry.enableWhen.orQuestions?.forEach((reference, child) => checkSibling(reference, ['orQuestions', child]));
      }
      if (entry.item) checkItems(entry.item, [...at, 'item'], topicId, variant, true);
    });
  };
  topics.forEach(({ entry, path }) => {
    checkPrompt(entry.openingPromptId, [...path, 'openingPromptId']);
    checkItems(entry.item, [...path, 'item'], entry.linkId);
    for (const reference of Object.keys(entry.corvo.scopedQuestions ?? {})) {
      if (!entry.item.some(item => item.linkId === reference)) issue([...path, 'corvo', 'scopedQuestions', reference], 'Unknown scoped question slot');
    }
  });
  for (const variant of ['phq4', 'unscored'] as const) {
    const slots = value.mentalHealth.slots[variant];
    if (slots) {
      if (!value.topics.some(topic => topic.linkId === PHQ4_TOPIC_ID)) issue(['mentalHealth', 'slots', variant], 'Mental health slots require their base Q16 topic');
      checkItems(slots, ['mentalHealth', 'slots', variant], PHQ4_TOPIC_ID, variant, false,
        value.topics.find(topic => topic.linkId === PHQ4_TOPIC_ID)?.item.map(item => item.linkId));
    }
  }
  const unique = (entries: { id: string }[], path: string): void => {
    const seen = new Set<string>();
    entries.forEach((entry, index) => { if (seen.has(entry.id)) issue([path, index, 'id'], 'Duplicate id'); seen.add(entry.id); });
  };
  unique(value.branches, 'branches'); unique(value.workflows, 'workflows'); unique(value.lockedInstruments, 'lockedInstruments');
  const workflowIds = new Set<string>();
  value.workflows.forEach((entry, index) => {
    const at: Path = ['workflows', index];
    if (workflowIds.has(entry.workflowId)) issue([...at, 'workflowId'], 'Duplicate workflow id');
    workflowIds.add(entry.workflowId);
    checkPrompt(entry.openingPromptId, [...at, 'openingPromptId']);
    if (entry.missingContextPromptId) checkPrompt(entry.missingContextPromptId, [...at, 'missingContextPromptId']);
    entry.reusableTopicIds.forEach((reference, child) => { if (!value.topics.some(topic => topic.linkId === reference)) issue([...at, 'reusableTopicIds', child], 'Unknown reusable topic id'); });
    const checkSlot = (reference: string, suffix: Path) => { if (!entry.additionalTopics.some(topic => topic.item.some(item => item.linkId === reference))) issue([...at, 'behaviour', ...suffix], 'Unknown workflow slot'); };
    entry.behaviour?.dateSlotIds?.forEach((reference, child) => checkSlot(reference, ['dateSlotIds', child]));
    entry.behaviour?.logistics?.slotIds.forEach((reference, child) => checkSlot(reference, ['logistics', 'slotIds', child]));
    entry.behaviour?.extractionBlockedSlotIds?.forEach((reference, child) => checkSlot(reference, ['extractionBlockedSlotIds', child]));
    if (entry.behaviour?.contextPrompts) {
      const context = entry.behaviour.contextPrompts;
      checkSlot(context.slotId, ['contextPrompts', 'slotId']);
      checkPrompt(context.verifiedPromptId, [...at, 'behaviour', 'contextPrompts', 'verifiedPromptId']);
      checkPrompt(context.missingPromptId, [...at, 'behaviour', 'contextPrompts', 'missingPromptId']);
    }
  });
  value.branches.forEach((entry, index) => {
    entry.optionalFacts?.forEach((fact, child) => checkPrompt(fact.promptId, ['branches', index, 'optionalFacts', child, 'promptId']));
    // optionalSlots are mirrors of topic items, not second declarations of those items.
    entry.optionalSlots?.forEach((slot, child) => {
      const at: Path = ['branches', index, 'optionalSlots', child];
      const original = entry.topic.item.find(item => item.linkId === slot.linkId);
      if (!original || JSON.stringify(original) !== JSON.stringify(slot)) issue(at, 'optionalSlots must mirror a branch topic item');
    });
    const rule = entry.rule;
    if (rule?.id === 'slot-positive' && !value.topics.find(topic => topic.linkId === 'Q06')?.item.some(item => item.linkId === rule.slot)) issue(['branches', index, 'rule', 'slot'], 'Unknown Q06 branch rule slot');
  });
  const options = value.mentalHealth.options;
  if (options.unscored) checkPrompt(options.unscored.promptId, ['mentalHealth', 'options', 'unscored', 'promptId']);
  if (options.phq4) {
    checkPrompt(options.phq4.stemPromptId, ['mentalHealth', 'options', 'phq4', 'stemPromptId']);
    checkPrompt(options.phq4.introPromptId, ['mentalHealth', 'options', 'phq4', 'introPromptId']);
    options.phq4.itemIds.forEach((reference, index) => checkPrompt(reference, ['mentalHealth', 'options', 'phq4', 'itemIds', index]));
  }
  checkPhq4(value, declarations, issue);
}

function checkPhq4(value: UncheckedPack, declarations: { item: PackItem; topicId: string; path: Path; variant?: string; nested: boolean }[], issue: (path: Path, message: string) => void): void {
  const ids: readonly string[] = PHQ4_ITEM_IDS;
  const lock = value.lockedInstruments[0];
  const isPhqPrompt = (id: string) => [...ids, 'MH.stem', mentalHealthOptions.phq4.introPromptId].includes(id);
  const usesPhq = !!value.mentalHealth.options.phq4 || !!value.mentalHealth.slots.phq4 || declarations.some(entry => ids.includes(entry.item.linkId)) || value.prompts.some(prompt => isPhqPrompt(prompt.id));
  if (!lock && usesPhq) issue(['lockedInstruments'], 'PHQ-4 content requires its locked instrument');
  if (!lock) return;
  if (lock.topicLinkId !== PHQ4_TOPIC_ID || !value.topics.some(topic => topic.linkId === lock.topicLinkId)) issue(['lockedInstruments', 0, 'topicLinkId'], 'PHQ-4 requires its Q16 topic');
  if (JSON.stringify(lock.itemLinkIds) !== JSON.stringify(ids)) issue(['lockedInstruments', 0, 'itemLinkIds'], 'PHQ-4 requires the exact ordered item ids');
  if (lock.attribution !== mentalHealthOptions.phq4.attribution) issue(['lockedInstruments', 0, 'attribution'], 'PHQ-4 attribution is locked');
  if (!value.mentalHealth.options.phq4) issue(['mentalHealth', 'options', 'phq4'], 'PHQ-4 options are required');
  else for (const key of Object.keys(mentalHealthOptions.phq4) as (keyof typeof mentalHealthOptions.phq4)[]) {
    if (JSON.stringify(value.mentalHealth.options.phq4[key]) !== JSON.stringify(mentalHealthOptions.phq4[key])) issue(['mentalHealth', 'options', 'phq4', key], 'PHQ-4 options are locked');
  }
  if (value.mentalHealth.slots.phq4 && JSON.stringify(value.mentalHealth.slots.phq4.map(item => item.linkId)) !== JSON.stringify(ids)) issue(['mentalHealth', 'slots', 'phq4'], 'PHQ-4 variant requires exactly the ordered locked items');
  const baseTopicIndex = value.topics.findIndex(topic => topic.linkId === lock.topicLinkId);
  const baseItemIds = value.topics[baseTopicIndex]?.item.filter(item => ids.includes(item.linkId)).map(item => item.linkId) ?? [];
  if (baseItemIds.length && JSON.stringify(baseItemIds) !== JSON.stringify(ids)) {
    issue(['topics', baseTopicIndex, 'item'], 'PHQ-4 base items require the exact ordered locked item ids');
  }
  declarations.forEach(({ item, path }) => item.corvo.promptIds.forEach((reference, index) => {
    if (ids.includes(reference) && item.linkId !== reference) issue([...path, 'corvo', 'promptIds', index], 'PHQ-4 item prompts may only bind their locked item');
  }));
  for (const promptId of [...ids, 'MH.stem', mentalHealthOptions.phq4.introPromptId]) {
    const index = value.prompts.findIndex(prompt => prompt.id === promptId);
    if (index < 0) issue(['prompts'], `Missing locked PHQ-4 prompt ${promptId}`);
    else {
      const actual = value.prompts[index], expected = promptsById[promptId];
      if (actual.text !== expected.text) issue(['prompts', index, 'text'], 'PHQ-4 prompt wording is locked');
      if (actual.wordingStatus !== expected.wordingStatus) issue(['prompts', index, 'wordingStatus'], 'PHQ-4 prompt status is locked');
    }
  }
  ids.forEach((itemId, index) => {
    const found = declarations.filter(entry => entry.item.linkId === itemId);
    if (!found.length) issue(['lockedInstruments', 0, 'itemLinkIds', index], 'Missing locked PHQ-4 item');
    if (found.length > 1) found.slice(1).forEach(entry => issue([...entry.path, 'linkId'], 'Duplicate locked PHQ-4 item'));
    found.forEach(({ item, topicId, path, variant, nested }) => {
      if (topicId !== lock.topicLinkId || nested || (variant !== undefined && variant !== 'phq4')) issue([...path, 'linkId'], 'PHQ-4 item outside its locked instrument');
      const expected = mentalHealthSlots.phq4[index];
      if (item.text !== expected.label) issue([...path, 'text'], 'PHQ-4 item wording is locked');
      const answerOptions = expected.choices!.map(value => ({ value }));
      const labelledOptions = mentalHealthOptions.phq4.choices.map(({ value, label }) => ({ value, display: label }));
      if (![answerOptions, labelledOptions].some(options => JSON.stringify(item.answerOption) === JSON.stringify(options))) issue([...path, 'answerOption'], 'PHQ-4 answer options are locked');
      if (item.type !== 'choice') issue([...path, 'type'], 'PHQ-4 items must remain choices');
      if (JSON.stringify(item.corvo.promptIds) !== JSON.stringify(expected.promptIds)) issue([...path, 'corvo', 'promptIds'], 'PHQ-4 prompt binding is locked');
      if (item.enableWhen || item.item || item.required === false || item.corvo.acceptsNegative || item.corvo.acceptsNotApplicable || item.corvo.acceptsUncertain) issue(path, 'PHQ-4 items cannot bypass explicit complete button responses');
    });
  });
}

export const questionnairePackSchema = pack.superRefine(crossReferenceChecks);
export type QuestionnairePack = z.infer<typeof questionnairePackSchema>;
