import { describe, expect, it } from 'vitest';
import { packToFhirQuestionnaire, PACK_FHIR_EXTENSION, PACK_SCALAR_SYSTEM, type PackFhirItem, type PackFhirQuestionnaire } from '../src/pack-fhir.js';
import { questionnairePackSchema, type PackItem, type QuestionnairePack } from '../src/pack.js';
import { adultIntakePack } from '../src/packs/adult-intake.js';
import { PHQ4_RESPONSE_SYSTEM } from '../src/mental-health.js';

const slot = (linkId: string, type: PackItem['type'] = 'text'): PackItem => ({ linkId, type, text: `Authored ${linkId}`, corvo: { promptIds: ['open'] } });
function minimal(): QuestionnairePack {
  return {
    schemaVersion: 1, id: 'new-pack', url: 'https://example.test/Questionnaire/new', version: '1', title: 'New pack', provenance: { clinicalProtocolApproval: false },
    prompts: [{ id: 'open', text: 'An authored opening question?', origin: 'test', wordingStatus: 'proposed-detail' }],
    topics: [], branches: [], workflows: [{ id: 'test-flow', workflowId: 'W99', patientSummary: 'Authored summary', openingPromptId: 'open', contextRequirement: 'No appointment required.', reusableTopicIds: [], additionalTopics: [{ linkId: 'T', openingPromptId: 'open', presentation: 'R', minimumDetailText: 'Authored target', stopWhen: ['target-met', 'patient-declines'], item: [slot('answer')], corvo: { wordingStatus: 'proposed-detail' } }], owners: ['medical'], completion: 'Human review', detailStatus: 'proposed-detail' }],
    lockedInstruments: [], mentalHealth: { options: {}, slots: {} },
  };
}
const flatten = (items: PackFhirItem[]): PackFhirItem[] => items.flatMap(item => [item, ...flatten(item.item ?? [])]);
const extension = (item: { extension?: { url: string; valueString?: string; valueBoolean?: boolean }[] }, name: string) => item.extension?.find(value => value.url === PACK_FHIR_EXTENSION + name);
const authored = (result: PackFhirQuestionnaire, id: string): PackFhirItem[] => flatten(result.item).filter(item => extension(item, 'slot-id')?.valueString === JSON.stringify(id));
const metadata = (item: PackFhirItem, name: string) => JSON.parse(extension(item, name)!.valueString!);

/**
 * @medplum/core and @medplum/fhirtypes are absent from the offline root install.
 * Allowed T2.7 fallback: validate the R4 elements emitted here independently of the
 * exporter, including R4 value[x] alternatives and invariants qst-1/4/7/9/12.
 */
function assertR4(questionnaire: PackFhirQuestionnaire): void {
  expect(questionnaire.resourceType).toBe('Questionnaire');
  expect(questionnaire.status).toBe('draft');
  expect(new URL(questionnaire.url).protocol).toBe('https:');
  expect(questionnaire.url).not.toMatch(/\s/);
  expect(questionnaire.version).toBeTruthy();
  const checkPrimitives = (value: unknown): void => {
    if (Array.isArray(value)) { expect(value.length).toBeGreaterThan(0); value.forEach(checkPrimitives); return; }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (typeof child === 'string' && ['valueString', 'display', 'text', 'title', 'version', 'url', 'linkId', 'code', 'system'].includes(key)) expect(child.length).toBeGreaterThan(0);
        checkPrimitives(child);
      }
    }
  };
  checkPrimitives(questionnaire);
  const items = flatten(questionnaire.item);
  const ids = items.map(item => item.linkId);
  expect(new Set(ids).size).toBe(ids.length);
  for (const item of items) {
    expect(item.linkId.length).toBeGreaterThan(0);
    expect(item.linkId.length).toBeLessThanOrEqual(255);
    expect(['group', 'display', 'string', 'decimal', 'integer', 'choice', 'boolean']).toContain(item.type);
    if (item.type === 'group') expect(item.item?.length).toBeGreaterThan(0);
    if (item.type === 'display') {
      expect(item.item).toBeUndefined();
      expect(item.required).toBeUndefined();
      expect(item.repeats).toBeUndefined();
    }
    if (item.type === 'group' || item.type === 'display') expect(item.readOnly).toBeUndefined();
    if ((item.enableWhen?.length ?? 0) > 1) expect(['any', 'all']).toContain(item.enableBehavior);
    for (const condition of item.enableWhen ?? []) {
      expect(ids).toContain(condition.question);
      expect(condition.question).not.toBe(item.linkId);
      expect(condition.operator).toBe('=');
      expect(Object.keys(condition).filter(key => key.startsWith('answer'))).toHaveLength(1);
      const target = items.find(candidate => candidate.linkId === condition.question)!;
      if (condition.answerString !== undefined) {
        expect(['choice', 'string']).toContain(target.type);
        if (target.answerOption) expect(target.answerOption).toContainEqual({ valueString: condition.answerString });
      }
    }
    if (item.answerOption) {
      expect(item.type).toBe('choice');
      for (const option of item.answerOption) {
        const keys = Object.keys(option).filter(key => key.startsWith('value'));
        expect(keys).toHaveLength(1);
        expect(['valueInteger', 'valueString', 'valueCoding', 'valueDate', 'valueTime', 'valueReference']).toContain(keys[0]);
        if (option.valueInteger !== undefined) {
          expect(Number.isInteger(option.valueInteger)).toBe(true);
          expect(option.valueInteger).toBeGreaterThanOrEqual(-2147483648);
          expect(option.valueInteger).toBeLessThanOrEqual(2147483647);
        }
        if (option.valueCoding) {
          expect(option.valueCoding.system).toBeTruthy();
          expect(option.valueCoding.code).toBeTruthy();
        }
      }
    }
  }
}

describe('new pack FHIR R4 draft export', () => {
  it('exports a draft for exactly one workflow and preserves authored wording governance', () => {
    const pack = minimal();
    const result = packToFhirQuestionnaire(pack, 'W99');
    assertR4(result);
    expect(result).toMatchObject({ url: pack.url + '/W99', version: '1', title: 'New pack', status: 'draft' });
    expect(result.item[0]).toMatchObject({ linkId: 'T', type: 'group', text: pack.prompts[0].text });
    const item = authored(result, 'answer')[0];
    expect(item).toMatchObject({ type: 'string', text: 'Authored answer', required: true });
    expect(metadata(item, 'prompts')[0]).toMatchObject({ text: pack.prompts[0].text, wordingStatus: 'proposed-detail' });
    expect(extension(result, 'standalone-supported')?.valueBoolean).toBe(false);
    expect(extension(result, 'incomplete-remains-unresolved')?.valueBoolean).toBe(true);
    expect(packToFhirQuestionnaire(pack, 'test-flow').url).toBe(pack.url + '/test-flow');
    expect(packToFhirQuestionnaire(pack, 'W99')).toStrictEqual(result);
  });

  it('uses collision-free scoped ids for repeated names and nested paths', () => {
    const pack = minimal();
    pack.workflows[0].additionalTopics[0].item = [
      slot('name'), { ...slot('a', 'collection'), item: [slot('name'), slot('b.c')] },
      { ...slot('a.b', 'collection'), item: [slot('c')] },
    ];
    pack.topics.push({ ...structuredClone(pack.workflows[0].additionalTopics[0]), linkId: 'T2' });
    pack.workflows[0].reusableTopicIds.push('T2');
    const result = packToFhirQuestionnaire(pack, 'W99');
    assertR4(result);
    expect(authored(result, 'name')).toHaveLength(4);
    expect(authored(result, 'a')).toHaveLength(2);
    expect(authored(result, 'c')).toHaveLength(2);
    expect(flatten(result.item).filter(item => extension(item, 'slot-id'))).toHaveLength(12);
    expect(authored(result, 'a').every(item => item.type === 'group' && item.repeats)).toBe(true);
  });

  it('retains topic/workflow/missing-context prompt wording and provenance even without slot references', () => {
    const pack = minimal();
    pack.prompts.push(...['workflow-open', 'missing-context'].map(id => ({ id, text: `Authored ${id}?`, origin: 'workflow', wordingStatus: 'proposed-detail' as const })));
    pack.workflows[0].openingPromptId = 'workflow-open';
    pack.workflows[0].missingContextPromptId = 'missing-context';
    pack.workflows[0].additionalTopics[0].item[0].corvo.promptIds = [];
    const result = packToFhirQuestionnaire(pack, 'W99');
    assertR4(result);
    expect(JSON.parse(extension(result, 'prompts')!.valueString!)).toStrictEqual(pack.prompts);
  });

  it('preserves optional-topic completeness semantics while retaining child slot requirements', () => {
    const pack = minimal();
    const topic = pack.workflows[0].additionalTopics[0];
    topic.presentation = 'O';
    pack.topics.push({ ...structuredClone(topic), linkId: 'optional-reusable' });
    pack.workflows[0].reusableTopicIds.push('optional-reusable');
    const result = packToFhirQuestionnaire(pack, 'W99');
    assertR4(result);
    expect(result.item.filter(item => item.type === 'group').map(item => item.required)).toEqual([false, false]);
    expect(authored(result, 'answer').every(item => item.required === true)).toBe(true);
  });

  it('maps R4 string/integer choices and retains typed boolean/fractional/large integer choices', () => {
    const pack = minimal();
    pack.workflows[0].additionalTopics[0].item = [
      { ...slot('choice', 'choice'), answerOption: [{ value: 'a', display: 'Authored A' }, { value: 2 }, { value: false, display: 'Authored no' }, { value: 0.5 }, { value: 2147483648 }] },
      { ...slot('positive', 'positive-number'), required: false }, slot('presence', 'presence'), slot('config', 'configuration'),
    ];
    const result = packToFhirQuestionnaire(pack, 'W99');
    assertR4(result);
    const options = authored(result, 'choice')[0].answerOption!;
    expect(options[0]).toMatchObject({ valueString: 'a', _valueString: { extension: [{ valueString: 'Authored A' }] } });
    expect(options[1]).toEqual({ valueInteger: 2 });
    expect(options[2]).toMatchObject({ valueCoding: { system: PACK_SCALAR_SYSTEM, code: 'boolean:false', display: 'Authored no' }, extension: [{ valueBoolean: false }] });
    expect(options[3]).toMatchObject({ valueCoding: { system: PACK_SCALAR_SYSTEM, code: 'number:0.5' }, extension: [{ valueDecimal: 0.5 }] });
    expect(options[4]).toMatchObject({ valueCoding: { code: 'number:2147483648' }, extension: [{ valueDecimal: 2147483648 }] });
    expect(authored(result, 'presence')[0].type).toBe('boolean');
    expect(authored(result, 'config')).toHaveLength(0);
    expect(authored(result, 'positive')[0]).toMatchObject({ type: 'decimal', required: false, extension: expect.arrayContaining([{ url: 'http://hl7.org/fhir/StructureDefinition/minValue', valueDecimal: 0 }]) });
    expect(extension(authored(result, 'positive')[0], 'minimum-exclusive')?.valueBoolean).toBe(true);
  });

  it('keeps condition scope, uncertain OR and estimate alternate trigger without equating absence with uncertainty', () => {
    const pack = minimal();
    pack.workflows[0].additionalTopics[0].item = [slot('anchor', 'presence'), slot('other', 'presence'),
      { ...slot('positive'), enableWhen: { question: 'anchor', operator: 'positive' } },
      { ...slot('uncertain'), enableWhen: { question: 'anchor', operator: 'uncertain', orQuestions: ['other'] } },
      { ...slot('estimate'), enableWhen: { question: 'anchor', operator: 'estimate-needed', alsoWhenTrue: 'other' } },
      { ...slot('nested', 'collection'), item: [slot('anchor'), { ...slot('positive'), enableWhen: { question: 'anchor', operator: 'positive' } }] },
    ];
    const result = packToFhirQuestionnaire(pack, 'W99');
    assertR4(result);
    for (const item of authored(result, 'positive')) {
      expect(item.enableWhen).toHaveLength(1);
      const control = flatten(result.item).find(candidate => candidate.linkId === item.enableWhen![0].question)!;
      const rule = metadata(control, 'app-owned-rule');
      expect(rule).toMatchObject({ operator: 'positive', semantics: 'evidenced-valid-known-answer' });
      expect(authored(result, 'anchor').map(anchor => anchor.linkId)).toContain(rule.question);
    }
    const rules = flatten(result.item).filter(item => extension(item, 'app-owned-rule')).map(item => metadata(item, 'app-owned-rule'));
    expect(rules.find(rule => rule.operator === 'uncertain')).toMatchObject({ combination: 'any', orQuestions: [authored(result, 'other')[0].linkId], semantics: 'any-evidenced-uncertain-anchor' });
    expect(rules.find(rule => rule.operator === 'estimate-needed')).toMatchObject({ combination: 'any', alsoWhenTrue: authored(result, 'other')[0].linkId });
    expect(JSON.stringify(result)).not.toContain('"operator":"exists"');
  });

  it('requires relevance AND applicability for conditional reusable topics and retains branch named rules', () => {
    const pack = minimal();
    pack.topics.push({ ...structuredClone(pack.workflows[0].additionalTopics[0]), linkId: 'Q06', presentation: 'C', item: [slot('conditions.sleepApnea', 'presence')] });
    pack.workflows[0].reusableTopicIds.push('Q06');
    pack.branches.push({ id: 'sleep', topic: { ...structuredClone(pack.topics[0]), linkId: 'branch', item: [slot('detail')] }, trigger: 'Authored trigger', rule: { id: 'slot-positive', slot: 'conditions.sleepApnea' }, requirementStatus: 'accepted-user-direction', detailStatus: 'proposed-detail', sourceIds: ['plan'], lead: 'medical' });
    const result = packToFhirQuestionnaire(pack, 'W99');
    assertR4(result);
    const rules = flatten(result.item).filter(item => extension(item, 'app-owned-rule')).map(item => metadata(item, 'app-owned-rule'));
    expect(rules.find(rule => rule.topic === 'Q06')).toMatchObject({ relevanceRequired: true, applicabilityRequired: true, combination: 'all', unknown: 'unresolved' });
    expect(rules.find(rule => rule.topic === 'branch')).toMatchObject({ kind: 'branch-applicability', rule: { id: 'slot-positive', slot: 'conditions.sleepApnea' }, unknown: 'unresolved' });
    expect(authored(result, 'detail')).toHaveLength(1);
  });

  it('mirrors native height scalar and feet/inches representation with scoped unit conditions', () => {
    const pack = minimal();
    pack.workflows[0].additionalTopics[0].item = [{ ...slot('height.value', 'height-value'), required: true }, { ...slot('height.unit', 'choice'), answerOption: ['cm', 'm', 'in', 'ft', 'ft-in'].map(value => ({ value })) }];
    const result = packToFhirQuestionnaire(pack, 'W99');
    assertR4(result);
    const height = authored(result, 'height.value')[0];
    expect(height.type).toBe('group');
    expect(height.item!.map(item => item.type)).toEqual(['decimal', 'integer', 'decimal']);
    expect(height.item![0].enableBehavior).toBe('any');
    expect(height.item![0].enableWhen?.map(condition => condition.answerString)).toEqual(['cm', 'm', 'in', 'ft']);
    expect(height.item![1].enableWhen).toEqual([{ question: authored(result, 'height.unit')[0].linkId, operator: '=', answerString: 'ft-in' }]);
    expect(height.item!.every(item => item.required)).toBe(true);
  });

  it('keeps PHQ-4 locked, coded and buttons-only while ordinary numeric options stay ordinary', () => {
    const pack = questionnairePackSchema.parse(adultIntakePack);
    pack.id = 'new-phq-pack';
    pack.url = 'https://example.test/Questionnaire/new-phq';
    pack.workflows = [{ ...pack.workflows[0], reusableTopicIds: ['Q16'], additionalTopics: [] }];
    const q16 = pack.topics.find(topic => topic.linkId === 'Q16')!;
    q16.item.push({ ...slot('ordinary', 'choice'), corvo: { promptIds: [] }, answerOption: [{ value: 1 }, { value: 2 }] });
    const result = packToFhirQuestionnaire(pack, 'W01');
    assertR4(result);
    expect(result.item.find(item => item.linkId === 'Q16')!.code).toEqual([{ system: 'http://loinc.org', code: '69724-3' }]);
    for (const id of ['MH01', 'MH02', 'MH03', 'MH04']) {
      const item = authored(result, id)[0];
      expect(item.text).toBe(pack.prompts.find(prompt => prompt.id === id)!.text);
      expect(item.answerOption).toEqual(pack.mentalHealth.options.phq4!.choices.map(choice => ({ valueCoding: { system: PHQ4_RESPONSE_SYSTEM, code: String(choice.value), display: choice.label } })));
      expect(extension(item, 'buttons-only')?.valueBoolean).toBe(true);
      expect(extension(item, 'free-text-answerable')?.valueBoolean).toBe(false);
      expect(item.readOnly).toBeUndefined(); // Lock the wording, allow explicit buttons.
      expect(item).not.toHaveProperty('initial');
    }
    expect(flatten(result.item).filter(item => item.type === 'display').map(item => item.text)).toContain(pack.prompts.find(prompt => prompt.id === 'MH.stem')!.text);
    expect(authored(result, 'ordinary')[0].answerOption).toEqual([{ valueInteger: 1 }, { valueInteger: 2 }]);
  });

  it('fails explicitly for adult publication, invalid references and unsupported semantics', () => {
    expect(() => packToFhirQuestionnaire(questionnairePackSchema.parse(adultIntakePack), 'W01')).toThrow('pack-fhir-native-adult-intake-excluded');
    expect(() => packToFhirQuestionnaire(minimal(), 'missing')).toThrow('pack-fhir-workflow-missing');
    const invalid = minimal(); invalid.workflows[0].additionalTopics[0].corvo.wordingStatus = 'approved' as never;
    expect(() => packToFhirQuestionnaire(invalid, 'W99')).toThrow();
    const conditions = minimal(); conditions.workflows[0].additionalTopics[0].item = [slot('anchor'), { ...slot('detail'), enableWhen: { question: 'anchor', operator: 'positive', orQuestions: ['anchor'] } }];
    expect(() => packToFhirQuestionnaire(conditions, 'W99')).toThrow('pack-fhir-condition-combination-unsupported');
    conditions.workflows[0].additionalTopics[0].item[0].type = 'configuration';
    expect(() => packToFhirQuestionnaire(conditions, 'W99')).toThrow('pack-fhir-condition-reference-omitted');
    const height = minimal(); height.workflows[0].additionalTopics[0].item = [slot('height.value', 'height-value')];
    expect(() => packToFhirQuestionnaire(height, 'W99')).toThrow('pack-fhir-height-unit-unsupported');
    const long = minimal(); long.workflows[0].additionalTopics[0].item = [slot('a'.repeat(250))];
    expect(() => packToFhirQuestionnaire(long, 'W99')).toThrow('pack-fhir-link-id-too-long');
    const empty = minimal(); empty.workflows[0].additionalTopics = [];
    expect(() => packToFhirQuestionnaire(empty, 'W99')).toThrow('pack-fhir-empty-workflow');
    for (const key of ['workflowId', 'id'] as const) {
      const whitespace = minimal(); whitespace.workflows[0][key] = 'W 99';
      expect(questionnairePackSchema.safeParse(whitespace).success).toBe(true);
      expect(() => packToFhirQuestionnaire(whitespace, 'W 99')).toThrow('pack-fhir-canonical-uri-whitespace');
    }
  });

  it('preserves canonical PHQ text over scoped workflow copy for direct base placement', () => {
    const pack = questionnairePackSchema.parse(adultIntakePack);
    pack.id = 'new-direct-phq';
    pack.workflows = [{ ...pack.workflows[0], reusableTopicIds: ['Q16'], additionalTopics: [] }];
    const q16 = pack.topics.find(topic => topic.linkId === 'Q16')!;
    q16.item.splice(3, 0, ...pack.mentalHealth.slots.phq4!);
    delete pack.mentalHealth.slots.phq4;
    q16.corvo.scopedQuestions = { MH01: 'Altered scoped wording' };
    const result = packToFhirQuestionnaire(pack, 'W01');
    assertR4(result);
    expect(authored(result, 'MH01')[0].text).toBe(pack.prompts.find(prompt => prompt.id === 'MH01')!.text);
  });

  it('rejects schema-valid empty strings that would create invalid R4 primitives', () => {
    const title = minimal(); title.title = '';
    expect(questionnairePackSchema.safeParse(title).success).toBe(true);
    expect(() => packToFhirQuestionnaire(title, 'W99')).toThrow('pack-fhir-empty-title');
    const opening = minimal(); opening.prompts[0].text = '';
    expect(() => packToFhirQuestionnaire(opening, 'W99')).toThrow('pack-fhir-empty-topic-text');
    const item = minimal(); item.workflows[0].additionalTopics[0].item[0].text = '';
    expect(() => packToFhirQuestionnaire(item, 'W99')).toThrow('pack-fhir-empty-item-text');
    for (const option of [{ value: '' }, { value: 'a', display: '' }, { value: false, display: '' }]) {
      const pack = minimal();
      pack.workflows[0].additionalTopics[0].item = [{ ...slot('choice', 'choice'), answerOption: [option] }];
      expect(questionnairePackSchema.safeParse(pack).success).toBe(true);
      expect(() => packToFhirQuestionnaire(pack, 'W99')).toThrow('pack-fhir-empty-option-string');
    }
  });
});
