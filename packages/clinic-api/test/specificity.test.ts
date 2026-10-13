import { describe, expect, it } from 'vitest';
import { assessSpecificity, specificityBudget, specificityContract, specificityContracts, specificityQuestion } from '../../clinic-content/src/specificity.js';
import { guardNativePrompt } from '../../clinic-content/src/native-questionnaire.js';
import { lookupReference, scanReference } from '../../clinic-reference/src/index.js';
import { eligibleAdaptiveProbes } from '../src/dialogue.js';
import { countSpecificityAsk, settleSpecificityReply, specificityFindings, specificityGaps, specificityNote } from '../src/specificity.js';
import type { TopicResponse } from '../../clinic-content/src/index.js';
import { context, register, withPrior } from './fixtures/adaptive.js';

/** One real but non-specific answer for every contracted field. */
const vague: Record<string, string> = {
  'Q02:concern': 'stomach issues', 'Q02:onset': 'a while ago', 'Q03:majorChanges.timing': 'years ago', 'Q04:lastMeasuredWeight.measuredWhen': 'a while back',
  'Q05:approaches.approach': 'a diet', 'Q05:approaches.period': 'a few years ago', 'Q06:reportedConditions.term': 'heart problems', 'Q07:events.event': 'a surgery',
  'Q07:events.when': 'a long time ago', 'Q08:medicines.name': 'pills for my heart', 'Q08:medicines.actualUse': 'sometimes', 'Q09:reactions.substance': 'some antibiotic',
  'Q10:familyHistory.condition': 'sugar issues', 'Q10:familyHistory.relationship': 'someone in my family', 'Q11:occasions.foods': 'snacks', 'Q11:occasions.drinks': 'a drink',
  'Q11:occasions.foodAmounts': 'a lot', 'Q11:occasions.drinkAmounts': 'some', 'Q14:frequency': 'sometimes', 'Q15:quality': 'not great', 'Q17:substances.frequencyAmount': 'socially',
  'Q19:clinicians.owner': 'my doctor',
};
const known = (value: string) => ({ state: 'known' as const, value, sourceIds: ['prior'] });
/** Detail fields asked only once their parent answer exists. */
const parents: Record<string, Record<string, string>> = { 'Q02:onset': { concern: 'headaches' }, 'Q11:occasions.foodAmounts': { foods: 'toast' }, 'Q11:occasions.drinkAmounts': { drinks: 'coffee' } };
/** A response holding one vague answer at the contract's path (one list item for collection fields). */
function answering(path: string, value: string, topicId = ''): { answers: TopicResponse['answers']; concrete: string } {
  const parent = Object.fromEntries(Object.entries(parents[`${topicId}:${path}`] ?? {}).map(([key, text]) => [key, known(text)]));
  const topic = register.topics.find(candidate => candidate.id === topicId);
  if (!path.includes('.') || topic?.slots.some(slot => slot.id === path)) return { answers: { ...parent, [path]: known(value) }, concrete: path };
  const [list, field] = path.split('.');
  return { answers: { [list!]: { state: 'known', complete: false, sourceIds: ['prior'], items: [{ id: 'item1', answers: { ...parent, [field!]: known(value) } }] } }, concrete: `${list}[item1].${field}` };
}

describe('specificity contracts', () => {
  it('cover every contracted field with a vague example that is a gap', () => {
    expect(Object.keys(vague).sort()).toEqual(specificityContracts.map(contract => `${contract.topicId}:${contract.path}`).sort());
    for (const contract of specificityContracts) expect(assessSpecificity(contract, vague[`${contract.topicId}:${contract.path}`]!, lookupReference).level, `${contract.topicId}:${contract.path}`).not.toBe('specific');
  });
  it.each(specificityContracts.map(contract => [`${contract.topicId}:${contract.path}`, contract] as const))('%s: the authored follow-up is eligible and passes the native prompt guard', (_, contract) => {
    const { answers, concrete } = answering(contract.path, vague[`${contract.topicId}:${contract.path}`]!, contract.topicId);
    const ctx = withPrior(context('Next answer', [contract.topicId]), contract.topicId, answers);
    ctx.specificity = {};
    const probe = eligibleAdaptiveProbes(ctx).find(candidate => candidate.specificity?.key === `${contract.topicId}:${concrete}`);
    expect(probe?.text).toBe(specificityQuestion(contract, vague[`${contract.topicId}:${contract.path}`]!));
    expect(probe!.optional).toBe(contract.kind !== 'entity' || register.topics.find(topic => topic.id === contract.topicId)!.presentation === 'O');
    // Templated wording is bounded, never exact-wording content, and targets the field it asks about.
    const responses = { [contract.topicId]: { presented: true, answers } };
    expect(() => guardNativePrompt({ promptId: probe!.promptId, topicId: contract.topicId, path: concrete, text: probe!.text, scenario: 'first-intake', relevantTopicIds: [contract.topicId as never], topics: responses, repeatResolutionTopics: responses }, { validSourceIds: new Set(['prior']) })).not.toThrow();
  });
  it('ask nothing without the opt-in state, and nothing for specific answers', () => {
    const ctx = withPrior(context('Next', ['Q08']), 'Q08', answering('medicines.name', 'pills for my heart').answers);
    expect(eligibleAdaptiveProbes(ctx).some(probe => probe.specificity)).toBe(false);
    const named = withPrior(context('Next', ['Q08']), 'Q08', answering('medicines.name', 'Lisinopril 10 mg').answers);
    named.specificity = {};
    expect(eligibleAdaptiveProbes(named).some(probe => probe.specificity)).toBe(false);
  });
  it('put a naming follow-up before the topic\'s core questions and detail follow-ups after them', () => {
    const answers = answering('medicines.name', 'pills for my heart').answers as Record<string, { items: { answers: Record<string, unknown> }[] }>;
    answers.medicines!.items[0]!.answers.actualUse = known('sometimes');
    const ctx = withPrior(context('Next', ['Q08']), 'Q08', answers as TopicResponse['answers']);
    ctx.specificity = {};
    const probes = eligibleAdaptiveProbes(ctx).map(probe => probe.specificity?.key.split('.').at(-1) ?? 'core');
    expect(probes[0]).toBe('name');
    expect(probes.at(-1)).toBe('actualUse');
    expect(probes.filter(kind => kind === 'core').length).toBeGreaterThan(0);
  });
});

describe('specificity state', () => {
  const findings = (states = {}) => specificityFindings({ Q08: { presented: true, answers: answering('medicines.name', 'pills for my heart').answers } }, states);
  it('respects the per-field budget and keeps the gap visible afterwards', () => {
    const key = findings()[0]!.key;
    let states = {};
    for (let i = 0; i < specificityBudget.perField; i++) states = countSpecificityAsk(states, { key });
    const ctx = withPrior(context('Next', ['Q08']), 'Q08', answering('medicines.name', 'pills for my heart').answers);
    ctx.specificity = states;
    expect(eligibleAdaptiveProbes(ctx).some(probe => probe.specificity)).toBe(false);
    expect(specificityGaps(findings(states))).toHaveLength(1);
  });
  it.each([
    ["I'll bring the bottle to my appointment", 'will-provide'], ['I can check the label later', 'will-provide'], ["I don't remember", 'unknown'], ['no idea', 'unknown'], ["I'd rather not say", 'declined'],
  ])('"%s" settles the follow-up as %s', (text, terminal) => {
    const key = findings()[0]!.key;
    expect(settleSpecificityReply({}, { key }, { sourceId: 's2', text, updatedPath: false })[key]).toMatchObject({ terminal, terminalSourceId: 's2' });
  });
  it('a reply that added detail is not a terminal, even with "not sure" in it', () => {
    const key = findings()[0]!.key;
    expect(settleSpecificityReply({}, { key }, { sourceId: 's2', text: "Not sure, maybe lisinopril", updatedPath: true })[key]?.terminal).toBeUndefined();
  });
  it('a spelling question is asked once; only a plain yes confirms it', () => {
    const spelling = { system: 'rxnorm', code: '6809', display: 'metformin' };
    expect(settleSpecificityReply({}, { key: 'k', spelling }, { sourceId: 's', text: 'Yes, that one', updatedPath: false }).k).toMatchObject({ spellingAsked: true, confirmed: { code: '6809', sourceId: 's' } });
    expect(settleSpecificityReply({}, { key: 'k', spelling }, { sourceId: 's', text: 'No, it is something else', updatedPath: false }).k).toEqual({ asked: 0, spellingAsked: true });
  });
  it.each(['Yes, but I am not sure that is the right medicine', 'Yes? Maybe', 'yes no I mean the other one'])('a qualified "%s" does not confirm a spelling', text => {
    const spelling = { system: 'rxnorm', code: '6809', display: 'metformin' };
    expect(settleSpecificityReply({}, { key: 'k', spelling }, { sourceId: 's', text, updatedPath: false }).k?.confirmed).toBeUndefined();
  });
  it('a changed answer drops the earlier confirmation and settlement but keeps the follow-up count', () => {
    const at = (value: string, states = {}) => specificityFindings({ Q08: { presented: true, answers: answering('medicines.name', value).answers } }, states)[0]!;
    const key = at('metfromin').key, spelling = { system: 'rxnorm', code: '6809', display: 'metformin' };
    const states = settleSpecificityReply(countSpecificityAsk({}, { key, spelling }, 'metfromin'), { key, spelling }, { sourceId: 's', text: 'Yes', updatedPath: false, value: 'metfromin' });
    expect(specificityNote(at('metfromin', states))?.code).toMatchObject({ code: '6809', basis: 'patient-confirmed' });
    const edited = at('my tiny blue medicine', states);
    expect(edited.state).toEqual({ asked: 0 });
    expect(specificityNote(edited)).toEqual({ needsDetail: 'Name of the medicine' });
    const settled = settleSpecificityReply({ [key]: { asked: 1 } }, { key }, { sourceId: 's2', text: "I don't know", updatedPath: false, value: 'pills for my heart' });
    expect(at('pills for my heart', settled).state?.terminal).toBe('unknown');
    expect(at('heart pills', settled).state).toEqual({ asked: 1 });
  });
});

describe('specificity assessment', () => {
  const at = (topicId: string, path: string) => specificityContract(topicId, path)!;
  it.each([
    ['Q08', 'medicines[a].name', 'pills for my heart', 'descriptive'], ['Q08', 'medicines[a].name', 'arthritis meds', 'descriptive'], ['Q08', 'medicines[a].name', 'the shot', 'descriptive'],
    ['Q08', 'medicines[a].name', 'water pill', 'descriptive'], ['Q08', 'medicines[a].name', 'the little white one', 'descriptive'], ['Q08', 'medicines[a].name', 'gummies', 'descriptive'],
    ['Q08', 'medicines[a].name', 'metformin', 'specific'], ['Q08', 'medicines[a].name', 'Metformin 500 mg', 'specific'], ['Q08', 'medicines[a].name', 'fish oil', 'specific'],
    ['Q08', 'medicines[a].name', 'multivitamin', 'specific'], ['Q08', 'medicines[a].name', 'pills for my heart; metformin', 'specific'], ['Q08', 'medicines[a].name', 'metfromin', 'specific'],
    ['Q06', 'reportedConditions[a].term', 'heart problems', 'category'], ['Q06', 'reportedConditions[a].term', 'thyroid', 'category'], ['Q06', 'reportedConditions[a].term', 'type 2 diabetes', 'specific'],
    ['Q10', 'familyHistory[a].relationship', 'my mom', 'specific'], ['Q10', 'familyHistory[a].relationship', 'someone', 'category'],
    ['Q07', 'events[a].when', '2019', 'specific'], ['Q07', 'events[a].when', 'when I was 30', 'specific'], ['Q07', 'events[a].when', 'a while ago', 'unanchored'],
    ['Q17', 'substances[a].frequencyAmount', 'two glasses of wine on weekends', 'specific'], ['Q17', 'substances[a].frequencyAmount', 'socially', 'approximate'],
    ['Q11', 'occasions[a].foods', 'turkey sandwich', 'specific'], ['Q11', 'occasions[a].foods', 'snacks', 'category'], ['Q11', 'occasions[a].foodAmounts', 'a handful', 'specific'],
    ['Q19', 'clinicians[a].owner', 'Dr. Patel at Northside', 'specific'], ['Q19', 'clinicians[a].owner', 'my heart doctor', 'category'],
    // Numbers only count with the detail they qualify; pharmacies and colours never name a medicine.
    ['Q14', 'frequency', '2 pills sometimes', 'approximate'], ['Q14', 'frequency', '3 times a week', 'specific'], ['Q07', 'events[a].when', 'a while ago, before my 2 surgeries', 'unanchored'],
    ['Q07', 'events[a].when', '5 years ago', 'specific'], ['Q08', 'medicines[a].name', 'The blue one I got at CVS', 'descriptive'], ['Q08', 'medicines[a].name', 'lisinopril from Walgreens', 'specific'],
  ])('%s %s "%s" is %s', (topicId, path, value, level) => {
    expect(assessSpecificity(at(topicId, path), value, lookupReference).level).toBe(level);
  });
  it('a reference match attaches a code; a close spelling is only a suggestion', () => {
    expect(assessSpecificity(at('Q08', 'medicines.name'), 'Ozempic', lookupReference)).toMatchObject({ level: 'specific', match: { code: '1991307', kind: 'exact' } });
    expect(assessSpecificity(at('Q06', 'reportedConditions.term'), 'high blood pressure', lookupReference)).toMatchObject({ match: { system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'I10' } });
    expect(assessSpecificity(at('Q06', 'reportedConditions.term'), 'fibromyalga', lookupReference)).toMatchObject({ level: 'specific', spelling: { display: 'fibromyalgia' } });
    // Plain "diabetes" has no type; it is never coded as one.
    expect(assessSpecificity(at('Q06', 'reportedConditions.term'), 'diabetes', lookupReference).match).toBeUndefined();
    // Condition terms never infer a more specific diagnosis than the patient named.
    expect(assessSpecificity(at('Q06', 'reportedConditions.term'), 'skin cancer', lookupReference).match).toMatchObject({ code: 'C44.90' });
    expect(assessSpecificity(at('Q06', 'reportedConditions.term'), 'arrhythmia', lookupReference).match).toMatchObject({ code: 'I49.9' });
    expect(assessSpecificity(at('Q06', 'reportedConditions.term'), 'colitis', lookupReference).match).toBeUndefined();
  });
  it('the message scan finds known names and skips everyday words', () => {
    expect(scanReference('I take metformin and Ozempic for my type 2 diabetes, plus water and some air.').map(item => item.mention)).toEqual(['metformin', 'ozempic', 'type 2 diabetes']);
  });
  it('every authored template quotes only the patient and never names a drug or diagnosis itself', () => {
    for (const contract of specificityContracts) {
      for (const text of [specificityQuestion(contract, 'XYZ'), specificityQuestion(contract, 'XYZ', 'XYZ')]) {
        expect(text).toMatch(/“XYZ”|^What|^Did you mean/);
        // No medicine or condition name of its own: the only name in a follow-up is the patient's (or their spelling).
        expect(scanReference(text), text).toEqual([]);
      }
    }
    expect(register.promptsById).toBeDefined();
  });
});
