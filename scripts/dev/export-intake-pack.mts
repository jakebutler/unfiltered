import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { documentProvenance, promptText, supplementalPromptText, topicText } from '../../packages/clinic-content/src/content.js';
import { conditionBranches } from '../../packages/clinic-content/src/branches.js';
import { scenarios } from '../../packages/clinic-content/src/scenarios.js';
import { coreSlots, mentalHealthSlots } from '../../packages/clinic-content/src/slots.js';
import { approvedMentalHealthSelection, mentalHealthOptions, promptsById, stopSemantics } from '../../packages/clinic-content/src/content-constants.js';
import { PACK_SCHEMA_VERSION, questionnairePackSchema, type PackItem, type QuestionnairePack } from '../../packages/clinic-content/src/pack.js';
import { ContentConfigurationError, type MentalHealthChoice, type SlotDefinition, type TopicDefinition } from '../../packages/clinic-content/src/types.js';
import type { ClinicContent } from '../../packages/clinic-content/src/register.js';

/** Frozen legacy assembly oracle: read authoring modules, never compile the generated pack. */
export function createAuthoredClinicContent(configuration: { mentalHealth: MentalHealthChoice } = approvedMentalHealthSelection) {
  if (!configuration || !['phq4','unscored','pending'].includes(configuration.mentalHealth)) throw new ContentConfigurationError('mental-health-selection-required');
  const choice = configuration.mentalHealth;
  const topics: readonly TopicDefinition[] = topicText.map(text => ({
    ...text, slots: text.id === 'Q16' ? [...coreSlots.Q16.slice(0,3), ...(choice === 'pending' ? [{ id:'mentalHealth.configuration',label:'Current depression/anxiety check selection is pending',kind:'configuration' as const,promptIds:[] }] : mentalHealthSlots[choice]), ...coreSlots.Q16.slice(3)] : coreSlots[text.id],
    stopWhen:stopSemantics.reasons, visibility:'assigned-clinical-full' as const,
  }));
  return { provenance:documentProvenance, mentalHealth:choice, mentalHealthOption:mentalHealthOptions[choice], topics, promptsById, branches:conditionBranches, scenarios, stopSemantics } as const satisfies ClinicContent;
}

/** Preserve explicit false and optional:false separately from absent properties. */
export function slotToPackItem(slot: SlotDefinition): PackItem {
  const { id, label, kind, optional, choices, fields, when, ...corvo } = slot;
  return {
    linkId: id, text: label, type: kind,
    ...(optional !== undefined ? { required: !optional } : {}),
    ...(choices !== undefined ? { answerOption: choices.map(value => ({ value })) } : {}),
    ...(when !== undefined ? { enableWhen: {
      question: when.slotId, operator: when.condition,
      ...(when.alsoWhenTrue !== undefined ? { alsoWhenTrue: when.alsoWhenTrue } : {}),
      ...(when.orSlotIds !== undefined ? { orQuestions: [...when.orSlotIds] } : {}),
    } } : {}),
    ...(fields !== undefined ? { item: fields.map(slotToPackItem) } : {}),
    corvo: { ...corvo, promptIds: [...corvo.promptIds] },
  };
}

function topicToPackTopic(topic: TopicDefinition, metadata: QuestionnairePack['topics'][number]['corvo'] = { wordingStatus: 'proposed-detail' }): QuestionnairePack['topics'][number] {
  return {
    linkId: topic.id, openingPromptId: topic.openingPromptId, presentation: topic.presentation,
    minimumDetailText: topic.minimumDetailText, stopWhen: [...topic.stopWhen], item: topic.slots.map(slotToPackItem),
    corvo: { ...metadata, ...topic.corvo },
  };
}

/** Read the authoring modules directly: never export from the runtime wrapper or mirror. */
export function buildAdultIntakePack(): QuestionnairePack {
  return questionnairePackSchema.parse({
    schemaVersion: PACK_SCHEMA_VERSION, id: 'adult-intake', url: 'https://corvo.example/Questionnaire/adult-intake',
    version: documentProvenance.version, title: 'Adult intake', provenance: documentProvenance,
    prompts: [...promptText, ...supplementalPromptText],
    topics: topicText.map(({ id, openingPromptId, presentation, minimumDetailText, ...metadata }) => topicToPackTopic({
      id, openingPromptId, presentation, minimumDetailText, slots: coreSlots[id], stopWhen: stopSemantics.reasons, visibility: 'assigned-clinical-full',
    }, metadata)),
    branches: Object.entries(conditionBranches).map(([id, branch]) => ({ ...branch, id, topic: topicToPackTopic(branch.topic), ...('optionalSlots' in branch ? { optionalSlots: branch.optionalSlots.map(slotToPackItem) } : {}) })),
    workflows: Object.values(scenarios).map(scenario => ({ ...scenario, additionalTopics: scenario.additionalTopics.map(topic => topicToPackTopic(topic)) })),
    lockedInstruments: [{ id: 'phq4', topicLinkId: 'Q16', itemLinkIds: mentalHealthOptions.phq4.itemIds, attribution: mentalHealthOptions.phq4.attribution, presentation: 'buttons-only', freeTextAnswerable: false }],
    mentalHealth: { options: mentalHealthOptions, slots: { phq4: mentalHealthSlots.phq4.map(slotToPackItem), unscored: mentalHealthSlots.unscored.map(slotToPackItem) } },
  });
}

export function serializeAdultIntakePack() {
  const json = JSON.stringify(buildAdultIntakePack(), null, 2) + '\n';
  const typescript = "// Generated by scripts/dev/export-intake-pack.mts; edit the authoring source and re-export.\nimport type { QuestionnairePack } from '../pack.js';\n\nexport const adultIntakePack = " + json.trimEnd() + ' as const satisfies QuestionnairePack;\n';
  return { json, typescript };
}

export async function exportAdultIntakePack(root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')) {
  const { json, typescript } = serializeAdultIntakePack();
  const jsonPath = resolve(root, 'packages/clinic-content/packs/adult-intake.pack.json');
  const tsPath = resolve(root, 'packages/clinic-content/src/packs/adult-intake.ts');
  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(tsPath), { recursive: true });
  await writeFile(jsonPath, json);
  await writeFile(tsPath, typescript);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await exportAdultIntakePack();
