import { describe, expect, it } from 'vitest';
import { questionnairePackSchema, PACK_SCHEMA_VERSION, type PackItem, type QuestionnairePack } from '../src/pack.js';
import { branchRuleIds, branchRules } from '../src/pack-rules.js';
import { conditionBranches } from '../src/branches.js';
import { documentProvenance, topicText } from '../src/content.js';
import { createClinicContent, mentalHealthOptions, promptsById } from '../src/register.js';
import { mentalHealthSlots, coreSlots } from '../src/slots.js';
import { scenarios, scenarioTopics } from '../src/scenarios.js';
import { deriveNativeRoutingContext, evaluateNativeRule, nativeRoutingRules, nativeScenarioTopics } from '../src/native-questionnaire.js';
import type { EvidenceContext, SlotAnswer, SlotDefinition, TopicDefinition, TopicResponse } from '../src/types.js';

const item = (linkId: string): PackItem => ({ linkId, text: linkId, type: 'text', corvo: { promptIds: ['open'] } });
function minimal(): QuestionnairePack {
  return {
    schemaVersion: PACK_SCHEMA_VERSION, id: 'test', url: 'https://example.test/Questionnaire/test', version: '1', title: 'Test', provenance: {},
    prompts: [{ id: 'open', text: 'Existing authored question', origin: 'test', wordingStatus: 'proposed-detail' }],
    topics: [{ linkId: 'test', openingPromptId: 'open', presentation: 'R', minimumDetailText: 'A detail', stopWhen: ['target-met'], item: [item('answer')], corvo: { wordingStatus: 'proposed-detail' } }],
    branches: [], workflows: [], lockedInstruments: [], mentalHealth: { options: {}, slots: {} },
  };
}
const slotItem = (slot: SlotDefinition): PackItem => ({
  linkId: slot.id, text: slot.label, type: slot.kind,
  ...(slot.optional === undefined ? {} : { required: !slot.optional }),
  ...(slot.choices ? { answerOption: slot.choices.map(value => ({ value })) } : {}),
  ...(slot.when ? { enableWhen: { question: slot.when.slotId, operator: slot.when.condition, ...(slot.when.alsoWhenTrue ? { alsoWhenTrue: slot.when.alsoWhenTrue } : {}), ...(slot.when.orSlotIds ? { orQuestions: [...slot.when.orSlotIds] } : {}) } } : {}),
  ...(slot.fields ? { item: slot.fields.map(slotItem) } : {}),
  corvo: {
    promptIds: [...slot.promptIds],
    ...(slot.acceptsNegative === undefined ? {} : { acceptsNegative: slot.acceptsNegative }),
    ...(slot.acceptsNotApplicable === undefined ? {} : { acceptsNotApplicable: slot.acceptsNotApplicable }),
    ...(slot.acceptsUncertain === undefined ? {} : { acceptsUncertain: slot.acceptsUncertain }),
    ...(slot.extractionNegativeScope ? { extractionNegativeScope: slot.extractionNegativeScope } : {}),
  },
});
function phq(): QuestionnairePack {
  const value = minimal();
  value.topics[0].linkId = 'Q16';
  value.mentalHealth = { options: { phq4: structuredClone(mentalHealthOptions.phq4) }, slots: { phq4: mentalHealthSlots.phq4.map(slotItem) } };
  value.prompts.push(...['MH.stem', 'COPY-10', 'MH01', 'MH02', 'MH03', 'MH04'].map(id => ({ ...promptsById[id], wordingStatus: promptsById[id].wordingStatus as QuestionnairePack['prompts'][number]['wordingStatus'] })));
  value.lockedInstruments = [{ id: 'phq4', topicLinkId: 'Q16', itemLinkIds: ['MH01', 'MH02', 'MH03', 'MH04'], attribution: mentalHealthOptions.phq4.attribution, presentation: 'buttons-only', freeTextAnswerable: false }];
  return value;
}
function rejectsAt(value: unknown, path: (string | number)[]) {
  const result = questionnairePackSchema.safeParse(value);
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues.map(issue => issue.path)).toContainEqual(path);
}

describe('questionnaire pack schema', () => {
  it('parses a minimal pack without inventing clinical choices or approval', () => {
    expect(questionnairePackSchema.parse(minimal())).toEqual(minimal());
    expect(questionnairePackSchema.parse(phq())).toEqual(phq());
  });

  it('accepts the complete current authoring metadata without dropping nested data', () => {
    const register = createClinicContent({ mentalHealth: 'pending' });
    const packTopic = (definition: TopicDefinition, wording: typeof topicText[number] | undefined = undefined) => ({
      linkId: definition.id, openingPromptId: definition.openingPromptId, presentation: definition.presentation,
      minimumDetailText: definition.minimumDetailText, stopWhen: [...definition.stopWhen], item: definition.slots.map(slotItem),
      corvo: wording ? Object.fromEntries(Object.entries(wording).filter(([key]) => ['wordingVersion', 'wordingStatus', 'purpose', 'branchAndClarification', 'workAccountability'].includes(key))) : { wordingStatus: 'proposed-detail', ...definition.corvo },
    });
    const authored = {
      ...minimal(), provenance: documentProvenance, prompts: Object.values(promptsById),
      topics: register.topics.map(definition => packTopic({ ...definition, slots: coreSlots[definition.id as keyof typeof coreSlots] }, topicText.find(topic => topic.id === definition.id))),
      branches: Object.entries(conditionBranches).map(([id, branch]) => ({ ...branch, id, topic: packTopic(branch.topic), ...('optionalSlots' in branch ? { optionalSlots: branch.optionalSlots.map(slotItem) } : {}) })),
      workflows: Object.values(scenarios).map(scenario => ({ ...scenario, additionalTopics: scenario.additionalTopics.map(topic => packTopic(topic)) })),
      mentalHealth: { options: mentalHealthOptions, slots: { phq4: mentalHealthSlots.phq4.map(slotItem), unscored: mentalHealthSlots.unscored.map(slotItem) } },
      lockedInstruments: phq().lockedInstruments,
    };
    expect(questionnairePackSchema.parse(authored)).toEqual(authored);
  });

  it('rejects duplicate prompt and topic ids including workflow and branch topics', () => {
    const value = minimal(); value.prompts.push({ ...value.prompts[0] }); rejectsAt(value, ['prompts', 1, 'id']);
    const duplicate = minimal(); duplicate.topics.push(structuredClone(duplicate.topics[0])); rejectsAt(duplicate, ['topics', 1, 'linkId']);
    const nested = minimal(); nested.workflows.push({ id: 'flow', workflowId: 'W01', patientSummary: '', openingPromptId: 'open', contextRequirement: '', reusableTopicIds: [], additionalTopics: [structuredClone(nested.topics[0])], owners: ['medical'], completion: '', detailStatus: 'proposed-detail' });
    rejectsAt(nested, ['workflows', 0, 'additionalTopics', 0, 'linkId']);
  });

  it('checks every nested prompt and each enableWhen sibling reference', () => {
    const value = minimal();
    value.topics[0].item[0].item = [item('nested')];
    value.topics[0].item[0].item[0].corvo.promptIds = ['missing'];
    rejectsAt(value, ['topics', 0, 'item', 0, 'item', 0, 'corvo', 'promptIds', 0]);
    value.topics[0].openingPromptId = 'missing'; rejectsAt(value, ['topics', 0, 'openingPromptId']);
    const nested = minimal(); nested.topics[0].item[0].item = [{ ...item('child'), enableWhen: { question: 'answer', operator: 'uncertain', alsoWhenTrue: 'missing', orQuestions: ['missing'] } }];
    for (const suffix of [['question'], ['alsoWhenTrue'], ['orQuestions', 0]]) rejectsAt(nested, ['topics', 0, 'item', 0, 'item', 0, 'enableWhen', ...suffix]);
    nested.topics[0].item[0].item.push(item('child')); rejectsAt(nested, ['topics', 0, 'item', 0, 'item', 1, 'linkId']);
    const merged = minimal(); merged.topics[0].linkId = 'Q16'; merged.mentalHealth.slots.unscored = [item('answer')];
    rejectsAt(merged, ['mentalHealth', 'slots', 'unscored', 0, 'linkId']);
    merged.mentalHealth.slots.unscored[0].linkId = 'different';
    merged.mentalHealth.slots.unscored[0].enableWhen = { question: 'answer', operator: 'positive' };
    expect(questionnairePackSchema.safeParse(merged).success).toBe(true);
    const orphan = minimal(); orphan.mentalHealth.slots.unscored = [item('variant')];
    orphan.branches.push({ id: 'branch', topic: { ...structuredClone(orphan.topics[0]), linkId: 'Q16' }, trigger: '', requirementStatus: 'accepted-user-direction', detailStatus: 'proposed-detail', sourceIds: [], lead: 'medical' });
    rejectsAt(orphan, ['mentalHealth', 'slots', 'unscored']);
  });

  it('checks workflow prompts, reusable topics and all behaviour references', () => {
    const value = minimal();
    value.workflows.push({ id: 'flow', workflowId: 'W01', patientSummary: '', openingPromptId: 'bad', missingContextPromptId: 'bad', contextRequirement: '', reusableTopicIds: ['bad'], additionalTopics: [], owners: ['admin'], completion: '', detailStatus: 'proposed-detail', behaviour: { dateSlotIds: ['bad'], alwaysOwners: ['medical'], logistics: { kind: 'billing', slotIds: ['bad'] }, contextPrompts: { slotId: 'bad', verifiedPromptId: 'bad', missingPromptId: 'bad', requires: 'plan' }, extractionBlockedSlotIds: ['bad'] } });
    for (const suffix of [['openingPromptId'], ['missingContextPromptId'], ['reusableTopicIds', 0], ['behaviour', 'dateSlotIds', 0], ['behaviour', 'logistics', 'slotIds', 0], ['behaviour', 'contextPrompts', 'slotId'], ['behaviour', 'contextPrompts', 'verifiedPromptId'], ['behaviour', 'contextPrompts', 'missingPromptId'], ['behaviour', 'extractionBlockedSlotIds', 0]]) rejectsAt(value, ['workflows', 0, ...suffix]);
    value.topics[0].corvo.scopedQuestions = { bad: 'A question' }; rejectsAt(value, ['topics', 0, 'corvo', 'scopedQuestions', 'bad']);
  });

  it('rejects self-approval, unknown nested fields, executable provenance, and unregistered branch rules', () => {
    const value = minimal(); rejectsAt({ ...value, prompts: [{ ...value.prompts[0], wordingStatus: 'approved' }] }, ['prompts', 0, 'wordingStatus']);
    rejectsAt({ ...value, topics: [{ ...value.topics[0], corvo: { wordingStatus: 'approved' } }] }, ['topics', 0, 'corvo', 'wordingStatus']);
    rejectsAt({ ...value, prompts: [{ ...value.prompts[0], wordingStatus: 'accepted-targeted-choice' }] }, ['prompts', 0, 'wordingStatus']);
    rejectsAt({ ...value, topics: [{ ...value.topics[0], corvo: { wordingStatus: 'accepted-targeted-choice' } }] }, ['topics', 0, 'corvo', 'wordingStatus']);
    rejectsAt({ ...value, mentalHealth: { ...value.mentalHealth, surprise: true } }, ['mentalHealth']);
    rejectsAt({ ...value, provenance: { execute: () => true } }, ['provenance', 'execute']);
    rejectsAt({ ...value, branches: [{ id: 'branch', topic: { ...value.topics[0], linkId: 'branch' }, trigger: '', requirementStatus: 'accepted-user-direction', detailStatus: 'proposed-detail', sourceIds: [], lead: 'medical', rule: { id: 'custom-js' } }] }, ['branches', 0, 'rule', 'id']);
    expect(branchRuleIds).toEqual(['diabetes-explicit-status', 'slot-positive']);
  });

  it('rejects reworded PHQ items/prompts/stem and altered choices or option labels', () => {
    const itemWording = phq(); itemWording.mentalHealth.slots.phq4![0].text = 'Reworded'; rejectsAt(itemWording, ['mentalHealth', 'slots', 'phq4', 0, 'text']);
    for (const id of ['MH01', 'MH.stem', 'COPY-10']) {
      const promptWording = phq(), index = promptWording.prompts.findIndex(prompt => prompt.id === id); promptWording.prompts[index].text = 'Reworded'; rejectsAt(promptWording, ['prompts', index, 'text']);
    }
    const choices = phq(); choices.mentalHealth.slots.phq4![0].answerOption!.push({ value: 4 }); rejectsAt(choices, ['mentalHealth', 'slots', 'phq4', 0, 'answerOption']);
    const labels = phq(); labels.mentalHealth.options.phq4!.choices[0].label = 'Never'; rejectsAt(labels, ['mentalHealth', 'options', 'phq4', 'choices']);
    const displays = phq(); displays.mentalHealth.slots.phq4![0].answerOption![0].display = 'Never'; rejectsAt(displays, ['mentalHealth', 'slots', 'phq4', 0, 'answerOption']);
  });

  it('rejects missing, duplicated, nested, rebound or unlocked PHQ items', () => {
    const missing = phq(); missing.mentalHealth.slots.phq4!.shift(); rejectsAt(missing, ['lockedInstruments', 0, 'itemLinkIds', 0]);
    const outside = phq(); outside.topics.push({ ...structuredClone(outside.topics[0]), linkId: 'outside', item: [structuredClone(outside.mentalHealth.slots.phq4![0])] }); rejectsAt(outside, ['topics', 1, 'item', 0, 'linkId']);
    const nested = phq(); nested.topics[0].item[0].item = [nested.mentalHealth.slots.phq4!.shift()!]; rejectsAt(nested, ['topics', 0, 'item', 0, 'item', 0, 'linkId']);
    const unlocked = phq(); unlocked.lockedInstruments = []; rejectsAt(unlocked, ['lockedInstruments']);
    const rebound = phq(); rebound.topics[0].item[0].corvo.promptIds = ['MH01']; rejectsAt(rebound, ['topics', 0, 'item', 0, 'corvo', 'promptIds', 0]);
    const wrongBinding = phq(); wrongBinding.mentalHealth.slots.phq4![0].corvo.promptIds = ['open']; rejectsAt(wrongBinding, ['mentalHealth', 'slots', 'phq4', 0, 'corvo', 'promptIds']);
    const conditional = phq(); conditional.mentalHealth.slots.phq4![0].enableWhen = { question: 'MH02', operator: 'positive' }; rejectsAt(conditional, ['mentalHealth', 'slots', 'phq4', 0]);
    const freeText = phq(); rejectsAt({ ...freeText, lockedInstruments: [{ ...freeText.lockedInstruments[0], freeTextAnswerable: true }] }, ['lockedInstruments', 0, 'freeTextAnswerable']);
  });
});

describe('named branch applicability', () => {
  const evidence = { validSourceIds: new Set(['patient']) };
  const known = { state: 'known' as const, value: true, sourceIds: ['patient'] };
  const responses = { Q06: { presented: true, answers: { 'conditions.diabetes': known, 'conditions.sleepApnea': known, 'conditions.digestive': known } } satisfies TopicResponse };

  it('keeps the fixed push order and skips branches without rules in both runtimes', () => {
    const register = createClinicContent();
    expect(scenarioTopics(register, 'first-intake', { responses, evidence }).slice(-3).map(topic => topic.id)).toEqual(['DM', 'SLEEP', 'GI']);
    expect(nativeScenarioTopics(register, 'first-intake', { responses, evidence }).slice(-3).map(topic => topic.id)).toEqual(['DM', 'SLEEP', 'GI']);
    expect(scenarioTopics(register, 'first-intake', { responses, evidence }).some(topic => topic.id === 'COND')).toBe(false);
    expect('rule' in conditionBranches.otherCondition).toBe(false);
  });

  it('requires an explicit positive fact with valid evidence', () => {
    expect(branchRules['slot-positive']({ slot: known }, evidence, 'slot')).toBe(true);
    expect(branchRules['slot-positive']({ slot: { ...known, sourceIds: ['untrusted'] } }, evidence, 'slot')).toBe(false);
    expect(branchRules['slot-positive']({ slot: { ...known, value: false } }, evidence, 'slot')).toBe(false);
    expect(branchRules['diabetes-explicit-status']({ 'conditions.prediabetes': known }, evidence)).toBe(true);
    expect(branchRules['diabetes-explicit-status']({}, evidence)).toBe(false);
  });

  it('preserves the published native tri-state decisions and reviewed-fact authority', () => {
    const register = createClinicContent();
    const cases: (SlotAnswer | undefined)[] = [
      known, { ...known, value: false }, { state: 'negative', sourceIds: ['patient'] },
      { state: 'uncertain', sourceIds: ['patient'] }, { state: 'unknown', sourceIds: ['patient'] }, undefined,
      { ...known, sourceIds: [] }, { ...known, sourceIds: ['foreign'] },
    ];
    for (const answer of cases) for (const includeUnresolvedBranches of [false, true]) for (const reviewed of [false, true]) {
      const topics = { Q06: { presented: true, answers: Object.fromEntries(['conditions.diabetes', 'conditions.prediabetes', 'conditions.sleepApnea', 'conditions.digestive'].map(id => [id, answer])) } };
      const authority: EvidenceContext = { ...evidence, ...(reviewed ? { reviewedFact: (topicId, path, current) => topicId === 'Q06' && path.startsWith('conditions.') && current === answer } : {}) };
      const expected = nativeRoutingRules().filter(rule => ['DM', 'SLEEP', 'GI'].includes(rule.target)).filter(rule => {
        const outcome = evaluateNativeRule(rule, { topics }, authority).outcome;
        return outcome === 'applicable' || includeUnresolvedBranches && outcome === 'unknown';
      }).map(rule => rule.target);
      const actual = nativeScenarioTopics(register, 'first-intake', { responses: topics, evidence: authority, includeUnresolvedBranches }).filter(topic => ['DM', 'SLEEP', 'GI'].includes(topic.id)).map(topic => topic.id);
      expect(actual).toEqual(expected);
    }
  });

  it('preserves native source-qualified apnea and surgery context independently of Q06', () => {
    const topics = {
      Q15: { presented: true, answers: { condition: { ...known, value: 'sleep apnea' } } },
      Q07: { presented: true, answers: { events: { state: 'known' as const, sourceIds: ['patient'], complete: true, items: [{ id: 'one', answers: { event: { ...known, value: 'reported surgery' }, effects: { ...known, value: 'It affects eating now' } } }] } } },
    };
    const context = deriveNativeRoutingContext(topics, evidence);
    expect(context.sleepApnea).toBeDefined(); expect(context.surgeryEatingEffect).toBeDefined();
    expect(nativeScenarioTopics(createClinicContent(), 'first-intake', { responses: topics, evidence, context }).filter(topic => ['DM', 'SLEEP', 'GI'].includes(topic.id)).map(topic => topic.id)).toEqual(['SLEEP', 'GI']);
    expect(nativeScenarioTopics(createClinicContent(), 'first-intake', { responses: topics, evidence: { validSourceIds: new Set() }, context }).filter(topic => ['DM', 'SLEEP', 'GI'].includes(topic.id))).toEqual([]);
  });
});
