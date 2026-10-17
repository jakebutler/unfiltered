import { questionnairePackSchema, type PackItem, type QuestionnairePack } from './pack.js';
import { stopSemantics } from './content-constants.js';
import type { ClinicContent } from './register.js';
import { ContentConfigurationError, type MentalHealthChoice, type SlotDefinition, type TopicDefinition } from './types.js';

type PackTopic = QuestionnairePack['topics'][number];

/** Inverse of slotToPackItem; absent optional properties stay absent. */
export function compilePackItem(item: PackItem): SlotDefinition {
  const { promptIds, ...flags } = item.corvo;
  return {
    id: item.linkId, label: item.text, kind: item.type, promptIds, ...flags,
    ...(item.required !== undefined ? { optional: !item.required } : {}),
    ...(item.answerOption !== undefined ? { choices: item.answerOption.map(option => option.value) } : {}),
    ...(item.item !== undefined ? { fields: item.item.map(compilePackItem) } : {}),
    ...(item.enableWhen !== undefined ? { when: {
      slotId: item.enableWhen.question, condition: item.enableWhen.operator,
      ...(item.enableWhen.alsoWhenTrue !== undefined ? { alsoWhenTrue: item.enableWhen.alsoWhenTrue } : {}),
      ...(item.enableWhen.orQuestions !== undefined ? { orSlotIds: item.enableWhen.orQuestions } : {}),
    } } : {}),
  };
}

function compileTopic(topic: PackTopic, authored: boolean): TopicDefinition {
  const { scopedQuestions, ...metadata } = topic.corvo;
  return {
    id: topic.linkId, openingPromptId: topic.openingPromptId, presentation: topic.presentation,
    minimumDetailText: topic.minimumDetailText, slots: topic.item.map(compilePackItem),
    stopWhen: topic.stopWhen, visibility: 'assigned-clinical-full',
    ...(authored ? metadata : {}),
    ...(scopedQuestions !== undefined ? { corvo: { scopedQuestions } } : {}),
  };
}

/** Validate before compiling, including when callers pass a statically typed TS mirror. */
export function compilePack(input: QuestionnairePack, configuration: { mentalHealth: MentalHealthChoice }): ClinicContent {
  if (!configuration || !['phq4', 'unscored', 'pending'].includes(configuration.mentalHealth)) throw new ContentConfigurationError('mental-health-selection-required');
  const pack = questionnairePackSchema.parse(input);
  const choice = configuration.mentalHealth;
  const option = pack.mentalHealth.options[choice];
  const lock = pack.lockedInstruments.find(instrument => instrument.id === 'phq4');
  const lockedIds = new Set(lock?.itemLinkIds ?? []);
  const basePhq = pack.topics.find(topic => topic.linkId === lock?.topicLinkId)?.item.filter(item => lockedIds.has(item.linkId));
  const variantItems = choice === 'pending' ? undefined : pack.mentalHealth.slots[choice];
  const variant = choice === 'pending'
    ? [{ id: 'mentalHealth.configuration', label: 'Current depression/anxiety check selection is pending', kind: 'configuration' as const, promptIds: [] }]
    : (variantItems ?? (choice === 'phq4' ? basePhq : undefined))?.map(compilePackItem);
  if (!option || !variant) throw new ContentConfigurationError('mental-health-selection-unavailable');
  const topics = pack.topics.map(topic => {
    const compiled = compileTopic(topic, true);
    if (topic.linkId !== 'Q16') return compiled;
    // A schema-valid PHQ block can be declared directly in Q16 instead of its variant.
    // Retain that exact layout in PHQ mode, and replace it when another mode is selected.
    const firstLocked = compiled.slots.findIndex(slot => lockedIds.has(slot.id));
    const base = compiled.slots.filter(slot => !lockedIds.has(slot.id));
    const insertion = firstLocked < 0 ? Math.min(3, base.length) : firstLocked;
    const slots = choice === 'phq4' && variantItems === undefined
      ? compiled.slots
      : [...base.slice(0, insertion), ...variant, ...base.slice(insertion)];
    const ids = new Set<string>();
    for (const slot of slots) {
      if (ids.has(slot.id)) throw new ContentConfigurationError('pack-duplicate-compiled-slot-id');
      ids.add(slot.id);
    }
    // Variant selection must not leave a condition referencing a removed PHQ item.
    for (const slot of slots) {
      if (slot.when && [slot.when.slotId, ...(slot.when.alsoWhenTrue === undefined ? [] : [slot.when.alsoWhenTrue]), ...(slot.when.orSlotIds ?? [])].some(id => !ids.has(id))) {
        throw new ContentConfigurationError('pack-compiled-slot-reference-missing');
      }
    }
    return { ...compiled, slots };
  });
  const branches = Object.fromEntries(pack.branches.map(({ id, topic, optionalSlots, ...metadata }) => [id, {
    ...metadata, topic: compileTopic(topic, false),
    ...(optionalSlots !== undefined ? { optionalSlots: optionalSlots.map(compilePackItem) } : {}),
  }]));
  const scenarios = Object.fromEntries(pack.workflows.map(({ additionalTopics, ...metadata }) => [metadata.id, { ...metadata, additionalTopics: additionalTopics.map(topic => compileTopic(topic, false)) }]));
  // The legacy return type includes adult-intake literal tuples and branch keys. Keep that
  // public type during migration; runtime reconstruction is checked by strict source parity.
  return {
    provenance: pack.provenance, mentalHealth: choice, mentalHealthOption: option, topics,
    promptsById: Object.fromEntries(pack.prompts.map(prompt => [prompt.id, prompt])), branches, scenarios, stopSemantics,
  } as unknown as ClinicContent;
}
