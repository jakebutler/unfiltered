import { questionnairePackSchema, type PackItem, type QuestionnairePack } from './pack.js';
import { PHQ4_RESPONSE_SYSTEM } from './mental-health.js';

export const PACK_FHIR_EXTENSION = 'https://corvo.example/fhir/StructureDefinition/';
export const PACK_SCALAR_SYSTEM = 'urn:corvo:pack-scalar';

/** Offline R4 subset. No dependency on a provider or the published native adapter. */
export interface PackFhirExtension {
  url: string;
  valueString?: string;
  valueBoolean?: boolean;
  valueInteger?: number;
  valueDecimal?: number;
  valueCode?: string;
}
export interface PackFhirAnswerOption {
  valueString?: string;
  valueInteger?: number;
  valueCoding?: { system: string; code: string; display?: string };
  _valueString?: { extension: PackFhirExtension[] };
  _valueInteger?: { extension: PackFhirExtension[] };
  extension?: PackFhirExtension[];
}
export interface PackFhirItem {
  linkId: string;
  type: 'group' | 'display' | 'string' | 'decimal' | 'integer' | 'choice' | 'boolean';
  text?: string;
  required?: boolean;
  repeats?: boolean;
  readOnly?: boolean;
  code?: { system: string; code: string }[];
  item?: PackFhirItem[];
  answerOption?: PackFhirAnswerOption[];
  enableWhen?: { question: string; operator: '='; answerString?: string; answerBoolean?: boolean }[];
  enableBehavior?: 'any' | 'all';
  extension?: PackFhirExtension[];
}
export interface PackFhirQuestionnaire {
  resourceType: 'Questionnaire';
  url: string;
  version: string;
  status: 'draft';
  title: string;
  item: PackFhirItem[];
  extension: PackFhirExtension[];
}

type Topic = QuestionnairePack['topics'][number];
const jsonExtension = (name: string, value: unknown): PackFhirExtension => ({ url: PACK_FHIR_EXTENSION + name, valueString: JSON.stringify(value) });
const flag = (name: string, value: boolean): PackFhirExtension => ({ url: PACK_FHIR_EXTENSION + name, valueBoolean: value });
// Length framing, unlike dot concatenation, remains injective for arbitrary authored ids.
const scopedId = (parts: string[]): string => parts.map(part => `${part.length}:${part}`).join('/');
const hidden = { url: 'http://hl7.org/fhir/StructureDefinition/questionnaire-hidden', valueBoolean: true };

function control(linkId: string, rule: unknown): PackFhirItem {
  return {
    linkId, type: 'choice', readOnly: true,
    answerOption: ['applicable', 'not-applicable', 'unknown'].map(valueString => ({ valueString })),
    extension: [{ ...hidden }, jsonExtension('app-owned-rule', rule)],
  };
}
const gate = (question: string): NonNullable<PackFhirItem['enableWhen']> => [{ question, operator: '=', answerString: 'applicable' }];

function scalarOption(value: string | number | boolean, display: string | undefined, phq: boolean): PackFhirAnswerOption {
  if (value === '' || display === '') throw new Error('pack-fhir-empty-option-string');
  if (phq) return { valueCoding: { system: PHQ4_RESPONSE_SYSTEM, code: String(value), display } };
  const label = display === undefined ? undefined : [{ url: PACK_FHIR_EXTENSION + 'display', valueString: display }];
  if (typeof value === 'string') return { valueString: value, ...(label ? { _valueString: { extension: label } } : {}) };
  if (typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) {
    return { valueInteger: value, ...(label ? { _valueInteger: { extension: label } } : {}) };
  }
  // R4 answerOption.value[x] excludes boolean and decimal. Never round or stringify away type.
  return {
    valueCoding: { system: PACK_SCALAR_SYSTEM, code: `${typeof value}:${String(value)}`, ...(display === undefined ? {} : { display }) },
    extension: [{ url: PACK_FHIR_EXTENSION + 'typed-scalar', ...(typeof value === 'boolean' ? { valueBoolean: value } : { valueDecimal: value }) }],
  };
}

/**
 * Draft authoring export only. The trusted Corvo adapter must populate the app-owned,
 * tri-state controls using evidence, answer states, relevance and verified context.
 * Missing controls keep questions disabled and MUST remain unresolved in completeness
 * assessment; a generic FHIR renderer alone cannot implement this clinical workflow.
 */
export function packToFhirQuestionnaire(input: QuestionnairePack, workflowId: string): PackFhirQuestionnaire {
  const pack = questionnairePackSchema.parse(input);
  if (pack.id === 'adult-intake') throw new Error('pack-fhir-native-adult-intake-excluded');
  if (!pack.title.trim()) throw new Error('pack-fhir-empty-title');
  const matches = pack.workflows.filter(workflow => workflow.id === workflowId || workflow.workflowId === workflowId);
  if (matches.length !== 1) throw new Error(matches.length ? 'pack-fhir-workflow-ambiguous' : 'pack-fhir-workflow-missing');
  const workflow = matches[0];
  const url = `${pack.url.replace(/\/$/, '')}/${workflowId}`;
  if (/\s/.test(url)) throw new Error('pack-fhir-canonical-uri-whitespace');
  if (new Set(workflow.reusableTopicIds).size !== workflow.reusableTopicIds.length) throw new Error('pack-fhir-duplicate-reusable-topic');
  const prompts = new Map(pack.prompts.map(prompt => [prompt.id, prompt]));
  const used = new Set<string>();
  const reserve = (id: string): string => {
    if (id.length > 255) throw new Error('pack-fhir-link-id-too-long');
    if (used.has(id)) throw new Error('pack-fhir-duplicate-link-id');
    used.add(id); return id;
  };
  // Reserve top-level authored topic ids before generated ids to detect adversarial collisions.
  const topics = [...workflow.additionalTopics, ...workflow.reusableTopicIds.map(id => pack.topics.find(topic => topic.linkId === id)!)];
  const branchTopics = topics.some(topic => topic.linkId === 'Q06') ? pack.branches : [];
  [...topics, ...branchTopics.map(branch => branch.topic)].forEach(topic => reserve(topic.linkId));

  const compileItems = (items: PackItem[], path: string[], topic: Topic): PackFhirItem[] => {
    const ids = new Map(items.filter(item => item.type !== 'configuration').map(item => [item.linkId, scopedId([...path, 'slot', item.linkId])]));
    return items.flatMap(item => {
      if (item.type === 'configuration') return [];
      const linkId = reserve(ids.get(item.linkId)!);
      const lock = pack.lockedInstruments.find(lock => lock.topicLinkId === topic.linkId && lock.itemLinkIds.includes(item.linkId));
      const references = item.enableWhen ? [item.enableWhen.question, ...(item.enableWhen.orQuestions ?? []), ...(item.enableWhen.alsoWhenTrue ? [item.enableWhen.alsoWhenTrue] : [])] : [];
      if (references.some(reference => !ids.has(reference))) throw new Error('pack-fhir-condition-reference-omitted');
      // These combinations have no meaning in the existing Corvo evaluator. Reject instead
      // of silently ignoring a modifier or converting a conjunction to a disjunction.
      if (item.enableWhen && ((item.enableWhen.operator !== 'uncertain' && item.enableWhen.orQuestions !== undefined) ||
        (item.enableWhen.operator !== 'estimate-needed' && item.enableWhen.alsoWhenTrue !== undefined))) throw new Error('pack-fhir-condition-combination-unsupported');
      const controls: PackFhirItem[] = [];
      let enableWhen: PackFhirItem['enableWhen'];
      if (item.enableWhen) {
        const { question, operator, orQuestions, alsoWhenTrue } = item.enableWhen;
        const controlId = reserve(scopedId([...path, 'condition', item.linkId]));
        controls.push(control(controlId, {
          kind: 'slot-condition', operator, question: ids.get(question),
          ...(orQuestions ? { orQuestions: orQuestions.map(id => ids.get(id)), combination: 'any' } : {}),
          ...(alsoWhenTrue ? { alsoWhenTrue: ids.get(alsoWhenTrue), combination: 'any' } : {}),
          semantics: operator === 'positive' ? 'evidenced-valid-known-answer' : operator === 'uncertain'
            ? 'any-evidenced-uncertain-anchor' : 'evidenced-unknown-or-uncertain-or-valid-false-anchor-or-evidenced-true-extra',
        }));
        enableWhen = gate(controlId);
      }
      const extension: PackFhirExtension[] = [
        jsonExtension('slot-id', item.linkId), jsonExtension('corvo', item.corvo),
        jsonExtension('authored-item', { ...item, item: undefined }),
        jsonExtension('prompts', item.corvo.promptIds.map(id => prompts.get(id))),
      ];
      if (lock) extension.push(flag('wording-read-only', true), flag('buttons-only', true), flag('free-text-answerable', false));
      const text = lock ? prompts.get(item.linkId)!.text : topic.corvo.scopedQuestions?.[item.linkId] ?? item.text;
      if (!text.trim()) throw new Error('pack-fhir-empty-item-text');
      const type: PackFhirItem['type'] = item.type === 'text' ? 'string' : item.type === 'positive-number' ? 'decimal'
        : item.type === 'presence' ? 'boolean' : ['collection', 'height-value'].includes(item.type) ? 'group' : 'choice';
      const result: PackFhirItem = {
        linkId, type, text, required: item.required ?? true,
        ...(enableWhen ? { enableWhen } : {}), extension,
      };
      if (item.type === 'positive-number') extension.push({ url: 'http://hl7.org/fhir/StructureDefinition/minValue', valueDecimal: 0 }, flag('minimum-exclusive', true));
      if (item.type === 'choice') {
        if (!item.answerOption?.length) throw new Error('pack-fhir-choice-options-required');
        result.answerOption = item.answerOption.map(option => scalarOption(option.value,
          lock ? pack.mentalHealth.options.phq4!.choices.find(choice => choice.value === option.value)!.label : option.display, !!lock));
      }
      if (item.type === 'collection') result.repeats = true;
      if (item.type === 'height-value') {
        if (item.item?.length) throw new Error('pack-fhir-height-custom-children-unsupported');
        const unit = items.find(sibling => sibling.linkId === 'height.unit');
        if (item.linkId !== 'height.value' || unit?.type !== 'choice' || unit.answerOption?.some(option => typeof option.value !== 'string' || !['cm', 'm', 'in', 'ft', 'ft-in'].includes(option.value))) {
          throw new Error('pack-fhir-height-unit-unsupported');
        }
        result.item = [
          { suffix: 'scalar', type: 'decimal' as const, units: ['cm', 'm', 'in', 'ft'] },
          { suffix: 'feet', type: 'integer' as const, units: ['ft-in'] },
          { suffix: 'inches', type: 'decimal' as const, units: ['ft-in'] },
        ].map(({ suffix, type, units }) => ({
          linkId: reserve(scopedId([...path, 'height', item.linkId, suffix])), type,
          required: item.required ?? true,
          enableWhen: units.map(answerString => ({ question: ids.get('height.unit')!, operator: '=' as const, answerString })),
          ...(units.length > 1 ? { enableBehavior: 'any' as const } : {}),
          extension: [jsonExtension('height-component', suffix)],
        }));
        extension.push(jsonExtension('height-validation', 'positive-total; integer-feet>=0; 0<=inches<12; scalar>0; unit-required'));
      } else if (item.item?.length) result.item = compileItems(item.item, [...path, 'slot', item.linkId], topic);
      if (type === 'group' && !result.item?.length) throw new Error('pack-fhir-empty-group');
      return [...controls, result];
    });
  };

  const compileTopic = (topic: Topic, branch?: QuestionnairePack['branches'][number]): PackFhirItem[] => {
    if (!prompts.get(topic.openingPromptId)!.text.trim()) throw new Error('pack-fhir-empty-topic-text');
    const lock = pack.lockedInstruments.find(lock => lock.topicLinkId === topic.linkId);
    let items = topic.item;
    if (lock && pack.mentalHealth.slots.phq4) {
      const insertion = Math.min(3, items.length);
      items = [...items.slice(0, insertion), ...pack.mentalHealth.slots.phq4, ...items.slice(insertion)];
    } else if (topic.linkId === 'Q16' && !lock && Object.keys(pack.mentalHealth.slots).length) {
      throw new Error('pack-fhir-mental-health-selection-required');
    }
    const controls: PackFhirItem[] = [];
    let enableWhen: PackFhirItem['enableWhen'];
    const additional = workflow.additionalTopics.some(candidate => candidate.linkId === topic.linkId);
    if (branch || !additional || topic.presentation === 'C') {
      const controlId = reserve(scopedId(['topic-control', topic.linkId]));
      controls.push(control(controlId, {
        kind: branch ? 'branch-applicability' : 'topic-relevance-and-applicability', topic: topic.linkId,
        ...(branch ? { branch: branch.id, rule: branch.rule ?? null, trigger: branch.trigger } : {}),
        relevanceRequired: !additional, applicabilityRequired: !!branch || topic.presentation === 'C',
        combination: 'all', unknown: 'unresolved',
      }));
      enableWhen = gate(controlId);
    }
    const children = compileItems(items, ['topic', topic.linkId], topic);
    if (lock) {
      const stem = pack.mentalHealth.options.phq4!.stemPromptId;
      const intro = pack.mentalHealth.options.phq4!.introPromptId;
      const first = children.findIndex(child => child.extension?.some(extension => extension.url === PACK_FHIR_EXTENSION + 'buttons-only'));
      children.splice(first < 0 ? 0 : first, 0, ...[intro, stem].map(id => ({
        linkId: reserve(scopedId(['topic', topic.linkId, 'instrument-prompt', id])), type: 'display' as const,
        text: prompts.get(id)!.text, extension: [jsonExtension('prompt', prompts.get(id)), flag('wording-read-only', true)],
      })));
    }
    return [...controls, {
      linkId: topic.linkId, type: 'group', text: prompts.get(topic.openingPromptId)!.text, required: topic.presentation !== 'O',
      ...(enableWhen ? { enableWhen } : {}), item: children,
      ...(lock ? { code: [{ system: 'http://loinc.org', code: '69724-3' }] } : {}),
      extension: [jsonExtension('topic', { ...topic, item: undefined }),
        ...(branch ? [jsonExtension('branch', { ...branch, topic: undefined, optionalSlots: undefined })] : []),
        ...(lock ? [jsonExtension('locked-instrument', lock), flag('wording-read-only', true), jsonExtension('instrument', pack.mentalHealth.options.phq4)] : [])],
    }];
  };
  const item = [...topics.flatMap(topic => compileTopic(topic)), ...branchTopics.flatMap(branch => compileTopic(branch.topic, branch))];
  if (!item.length) throw new Error('pack-fhir-empty-workflow');
  // All-configuration topics cannot form valid R4 groups; do not silently erase the topic.
  if (item.some(entry => entry.type === 'group' && !entry.item?.length)) throw new Error('pack-fhir-empty-group');
  return {
    resourceType: 'Questionnaire', url, version: pack.version,
    status: 'draft', title: pack.title, item,
    extension: [jsonExtension('pack-id', pack.id), jsonExtension('workflow', workflow), jsonExtension('provenance', pack.provenance),
      jsonExtension('prompts', pack.prompts),
      flag('standalone-supported', false), flag('incomplete-remains-unresolved', true),
      jsonExtension('adapter-requirements', ['trusted-evidence-and-answer-state-controls', 'relevance-and-branch-decisions', 'verified-workflow-context', 'buttons-only-phq4', 'corvo-completeness-validation'])],
  };
}
