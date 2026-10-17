import { describe, expect, it } from 'vitest';
import { createAdaptiveSourceGroupManifest, expandAdaptiveSourceGroupProposal, issuedAdaptiveSourceGroupManifest } from '../src/adaptive-group-v7.js';
import { validateAdaptiveGroupProposal } from '../src/adaptive-group-compile.js';
import { context } from './fixtures/adaptive.js';

function setup(text: string, topic = 'Q04', target?: string) {
  const ctx = context(text, [topic]);
  if (target) ctx.displayed!.targetPaths = [target];
  const manifest = createAdaptiveSourceGroupManifest(ctx), { handles } = issuedAdaptiveSourceGroupManifest(manifest, ctx);
  const support = (needle: string) => handles.statements.find(statement => statement.text.includes(needle))!.ref;
  const known = (r: string, q: string, needle = q) => ({ r, s: 'known', v: { q }, p: [support(needle)] });
  const state = (r: string, s: string, needle: string) => ({ r, s, v: null, p: [support(needle)] });
  const patient = (fields: unknown[]) => ({ kind: topic, key: 'patient', scope: 'patient', fields });
  const medicine = (key: string, identity: string, fields: unknown[] = []) => ({ kind: 'Q08.medicines', key,
    scope: { mode: 'new', anchor: known('name', identity, `I take ${identity}.`) }, fields });
  const run = (groups: unknown[], rest = {}) => {
    const expanded = expandAdaptiveSourceGroupProposal({ schema: 7, context: manifest.id, groups, ...rest }, ctx, manifest);
    return validateAdaptiveGroupProposal(expanded.raw, ctx, expanded.manifest);
  };
  return { support, known, state, patient, medicine, run };
}

describe('V7 closed positive admission grammar', () => {
  it.each([
    'My height is not unknown.', 'My height is uncertain to the observer.',
    'My height is unknown to my doctor.', 'My height is unknown unless I remember it.',
    'My height is unknown and my current weight is 80 kg.',
    'I doubt that my height is unknown.', 'The clinic says my height is unknown.',
  ])('keeps an unparsed polarity, experiencer or coordinated assertion unresolved: %s', text => {
    const x = setup(text), result = x.run([x.patient([x.state('height.value', 'unknown', 'height')])]);
    expect(result.outcome.responses.Q04?.answers['height.value']).toBeUndefined();
    expect(result.hasInterpretationGaps).toBe(true);
  });
  it.each([
    ['My height is unknown.', 'unknown'], ["I don't know my height.", 'unknown'],
    ['My height is uncertain.', 'uncertain'], ['I prefer not to answer about my height.', 'declined'],
  ])('preserves a complete positively scoped patient declaration: %s', (text, s) => {
    const x = setup(text), result = x.run([x.patient([x.state('height.value', s, 'height')])]);
    expect(result.outcome.responses.Q04?.answers['height.value']?.state).toBe(s);
    expect(result.hasInterpretationGaps).toBe(false);
  });
  it('does not admit deictic reading uncertainty without a bounded source measurement', () => {
    const text = "I'm not sure whether that still reflects my weight.", x = setup(text),
      result = x.run([x.patient([x.state('lastMeasuredWeight.representsCurrent', 'uncertain', 'not sure')])]);
    expect(result.outcome.responses.Q04?.answers['lastMeasuredWeight.representsCurrent']).toBeUndefined();
    expect(result.hasInterpretationGaps).toBe(true);
  });
  it('preserves a named medicine predicate independently of a second source entity', () => {
    const x = setup('I take Metformin. I take iron. Metformin strength is unknown.', 'Q08'),
      result = x.run([x.medicine('m', 'Metformin', [x.state('strength', 'unknown', 'strength')])]);
    expect(result.outcome.responses.Q08?.answers.medicines?.items?.[0].answers.strength?.state).toBe('unknown');
    expect(result.hasInterpretationGaps).toBe(false);
  });
  it('admits indirect either only for a complete source pair', () => {
    const x = setup('I take Metformin. I take iron. No concerns with either.', 'Q08'),
      result = x.run([x.medicine('m', 'Metformin'), x.medicine('i', 'iron')], {
        sharedConcerns: [{ family: 'Q08.medicines', entities: ['m', 'i'], answer: { s: 'negative', v: null, p: [x.support('No concerns')] } }],
      });
    expect(result.outcome.responses.Q08?.answers.medicines?.items?.every(item => item.answers.concerns?.state === 'negative')).toBe(true);
    expect(result.hasInterpretationGaps).toBe(false);
  });
  it.each([
    'I take aspirin.', 'Aspirin every day.', 'I also use a supplement.',
    'I take Metformin and iron.', 'I take aspirin if needed.',
  ])('cannot establish an exhaustive pair while an additional source sentence remains: %s', additional => {
    const x = setup(`I take Metformin. I take iron. ${additional} No concerns with either.`, 'Q08'),
      result = x.run([x.medicine('m', 'Metformin'), x.medicine('i', 'iron')], {
        sharedConcerns: [{ family: 'Q08.medicines', entities: ['m', 'i'], answer: { s: 'negative', v: null, p: [x.support('No concerns')] } }],
      });
    expect(result.outcome.responses.Q08?.answers.medicines?.items?.every(item => !item.answers.concerns)).toBe(true);
    expect(result.hasInterpretationGaps).toBe(true);
  });
  it('retains explicit named negatives even when the source universe is outside the closed indirect grammar', () => {
    const x = setup('I take Metformin. No concerns with Metformin. I take iron. No concerns with iron. Aspirin every day.', 'Q08'),
      result = x.run([x.medicine('m', 'Metformin', [x.state('concerns', 'negative', 'with Metformin')]),
        x.medicine('i', 'iron', [x.state('concerns', 'negative', 'with iron')])]);
    expect(result.outcome.responses.Q08?.answers.medicines?.items?.every(item => item.answers.concerns?.state === 'negative')).toBe(true);
  });
  it('retains the unchanged semantic guard gap when another proposed medicine precedes named nonknown support', () => {
    const x = setup('I take Metformin. I take iron. No concerns with Metformin. No concerns with iron.', 'Q08'),
      result = x.run([x.medicine('m', 'Metformin', [x.state('concerns', 'negative', 'with Metformin')]),
        x.medicine('i', 'iron', [x.state('concerns', 'negative', 'with iron')])]);
    expect(result.outcome.responses.Q08?.answers.medicines?.items?.find(item => item.answers.name?.value === 'Metformin')?.answers.concerns).toBeUndefined();
    expect(result.hasInterpretationGaps).toBe(true);
  });
  it.each([
    'August 12 or August 13, 2025', 'August 12 of 2025',
    'about three months ago', 'between August 12 and September 14, 2025',
  ])('preserves a complete supplied attached temporal phrase: %s', phrase => {
    const x = setup(`The scale read 230 pounds on ${phrase}.`),
      result = x.run([x.patient([x.known('lastMeasuredWeight.measuredWhen', phrase)])]);
    expect(result.outcome.responses.Q04?.answers['lastMeasuredWeight.measuredWhen']).toMatchObject({ state: 'known', value: phrase });
    expect(result.hasInterpretationGaps).toBe(false);
  });
  it.each([
    'August 12 if my memory is correct', 'August 12, possibly in another year',
    'August 12 after an event I cannot identify', 'August 12 except on another scale',
  ])('retains a gap for an unparsed temporal qualification even when the selected date is recognized: %s', phrase => {
    const x = setup(`The scale read 230 pounds on ${phrase}.`),
      result = x.run([x.patient([x.known('lastMeasuredWeight.measuredWhen', 'August 12')])]);
    expect(result.outcome.responses.Q04?.answers['lastMeasuredWeight.measuredWhen']).toBeUndefined();
    expect(result.hasInterpretationGaps).toBe(true);
  });
  it('admits a closed coordination of sibling unknowns only when every conjunct is a proposed field of the same item', () => {
    const run = (text: string) => {
      const x = setup(text, 'Q11');
      return x.run([{ kind: 'Q11.occasions', key: 'breakfast', scope: { mode: 'new', anchor: x.known('foods', 'oatmeal') }, fields: [
        x.known('drinks', 'coffee'), x.state('foodAmounts', 'unknown', "don't remember"), x.state('drinkAdditions', 'unknown', "don't remember"),
      ] }]);
    };
    const admitted = run("Yesterday at 8 am I had oatmeal and coffee. I don't remember the oatmeal portion or what was added to the coffee.");
    const item = admitted.outcome.responses.Q11?.answers.occasions?.items?.[0];
    expect(item?.answers.foodAmounts?.state).toBe('unknown');
    expect(item?.answers.drinkAdditions?.state).toBe('unknown');
    // An unrelated conjunct is not a sibling field: neither unknown is admitted.
    const unrelated = run("Yesterday at 8 am I had oatmeal and coffee. I don't remember the oatmeal portion or what I did after.");
    expect(unrelated.outcome.responses.Q11?.answers.occasions?.items?.[0]?.answers.foodAmounts).toBeUndefined();
    expect(unrelated.hasInterpretationGaps).toBe(true);
  });
  it('documents a conservative miss for coordinated food/drink uncertainty without discarding its source', () => {
    const text = "Yesterday at 8 am I had oatmeal and coffee. I don't remember the oatmeal portion or what was added to the coffee.", x = setup(text, 'Q11'),
      result = x.run([{ kind: 'Q11.occasions', key: 'breakfast', scope: { mode: 'new', anchor: x.known('foods', 'oatmeal') }, fields: [
        x.state('foodAmounts', 'unknown', "don't remember"), x.state('drinkAdditions', 'unknown', "don't remember"),
      ] }]);
    const item = result.outcome.responses.Q11?.answers.occasions?.items?.[0];
    expect(item?.answers.foods?.value).toBe('oatmeal');
    expect(item?.answers.foodAmounts).toBeUndefined();
    expect(item?.answers.drinkAdditions).toBeUndefined();
    expect(result.rejectedCandidates).toHaveLength(2);
    expect(result.hasInterpretationGaps).toBe(true);
  });
});
