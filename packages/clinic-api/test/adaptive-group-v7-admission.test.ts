import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAdaptiveSourceGroupManifest, expandAdaptiveSourceGroupProposal, issuedAdaptiveSourceGroupManifest, sourceGroupAdmissionRevision } from '../src/adaptive-group-v7.js';
import { validateAdaptiveGroupProposal } from '../src/adaptive-group-compile.js';
import { adaptiveGroupRejectedTargets, selectAdaptiveGroupDialogue } from '../src/dialogue.js';
import type { AdaptiveContext } from '../src/adaptive-validation.js';
import { context } from './fixtures/adaptive.js';

function setup(ctx: AdaptiveContext) {
  const manifest = createAdaptiveSourceGroupManifest(ctx), { handles } = issuedAdaptiveSourceGroupManifest(manifest, ctx);
  const support = (text: string) => handles.statements.find(statement => statement.text.includes(text))!.ref;
  const known = (r: string, quote: string, statement = quote) => ({ r, s: 'known', v: { q: quote }, p: [support(statement)] });
  const state = (r: string, s: string, statement: string) => ({ r, s, v: null, p: [support(statement)] });
  const group = (kind: string, fields: unknown[]) => ({ kind, key: 'g', scope: 'patient', fields });
  const item = (key: string, identity: string, fields: unknown[]) => ({ kind: 'Q08.medicines', key, scope: { mode: 'new', anchor: known('name', identity, `I take ${identity}.`) }, fields });
  const validate = (groups: unknown[], rest = {}) => {
    const expanded = expandAdaptiveSourceGroupProposal({ schema: 7, context: manifest.id, groups, ...rest }, ctx, manifest);
    return validateAdaptiveGroupProposal(expanded.raw, ctx, expanded.manifest);
  };
  return { manifest, handles, support, known, state, group, item, validate };
}

describe('V7 versioned scoped state and temporal admission', () => {
  it('replays the A20 raw packet without changing its receipt and retains independently supported meanings', () => {
    const path = new URL('../../../docs/implementation/evidence/DO-A20.json', import.meta.url), before = readFileSync(path),
      recorded = JSON.parse(before.toString()).results[0], ctx: AdaptiveContext = recorded.context,
      manifest = createAdaptiveSourceGroupManifest(ctx), raw = structuredClone(recorded.rawProviderProposal);
    // Bind unchanged historical declarations to this newly issued admission revision.
    raw.context = manifest.id;
    expect(manifest.admissionRevision).toBe(sourceGroupAdmissionRevision);
    const expanded = expandAdaptiveSourceGroupProposal(raw, ctx, manifest), groups = validateAdaptiveGroupProposal(expanded.raw, ctx, expanded.manifest), answers = groups.outcome.responses.Q04!.answers;
    expect(answers['height.value']).toBeUndefined();
    expect(answers['lastMeasuredWeight.measuredWhen']).toBeUndefined();
    expect(answers['lastMeasuredWeight.value']).toMatchObject({ state: 'known', value: 230 });
    expect(answers['lastMeasuredWeight.unit']).toMatchObject({ state: 'known', value: 'lb' });
    expect(answers['height.unit']).toMatchObject({ state: 'known', value: 'ft-in' });
    expect(answers['lastMeasuredWeight.representsCurrent']).toMatchObject({ state: 'uncertain' });
    expect(answers['currentWeightEstimate.value']).toMatchObject({ state: 'known', value: 235 });
    expect(groups.rejectedCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'height.value', guardCode: 'unscoped-state-evidence' }),
      expect.objectContaining({ role: 'lastMeasuredWeight.measuredWhen', guardCode: 'temporal-lexical-selector' }),
    ]));
    expect(groups.hasInterpretationGaps).toBe(true);
    expect(adaptiveGroupRejectedTargets(ctx, groups).map(target => target.path)).toEqual(expect.arrayContaining(['height.value', 'lastMeasuredWeight.measuredWhen']));
    expect(selectAdaptiveGroupDialogue(ctx, groups).status).toBe('interpretation-review');
    expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(createHash('sha256').update(before).digest('hex'));
  });

  it.each([
    ['unknown', "I don't know my current weight."],
    ['uncertain', 'My current weight is uncertain.'],
    ['declined', 'I prefer not to answer about my current weight.'],
  ])('cannot import %s from another role, including secondary support', (state, statement) => {
    const x = setup(context(`My height is 172 cm. ${statement}`));
    const declaration = x.state('height.value', state, statement);
    declaration.p.push(x.support('My height'));
    const groups = x.validate([x.group('Q04', [declaration])]);
    expect(groups.outcome.responses.Q04?.answers['height.value']).toBeUndefined();
    expect(groups.rejectedCandidates[0]).toMatchObject({ guardCode: 'unscoped-state-evidence' });
    expect(groups.hasInterpretationGaps).toBe(true);
  });
  it.each([
    "My height is 172 cm and my current weight is unknown.",
    "My height is 172 cm, my current weight is unknown.",
    "My height is 172 cm but I don't know my current weight.",
    "My height is 172 cm, I don't know my current weight.",
    "My height is 172 cm and unknown current weight.",
    "My height is 172 cm I don't know my current weight.",
  ])('keeps predicates isolated within one statement: %s', text => {
    const x = setup(context(text)), groups = x.validate([x.group('Q04', [x.state('height.value', 'unknown', text)])]);
    expect(groups.outcome.responses.Q04?.answers['height.value']).toBeUndefined();
    expect(groups.rejectedCandidates[0].guardCode).toBe('unscoped-state-evidence');
  });
  it.each([
    ["I don't know my height.", 'unknown'],
    ['My height is uncertain.', 'uncertain'],
    ['I prefer not to answer about my height.', 'declined'],
  ])('retains positively scoped state: %s', (text, s) => {
    const x = setup(context(text)), groups = x.validate([x.group('Q04', [x.state('height.value', s, text)])]);
    expect(groups.outcome.responses.Q04?.answers['height.value']?.state).toBe(s);
    expect(groups.hasInterpretationGaps).toBe(false);
  });
  it.each([
    ['height.value', "I don't know my height units."],
    ['lastMeasuredWeight.value', "I don't know the date of my weight reading."],
    ['currentWeightEstimate.value', "I don't know my estimated weight units."],
    ['lastMeasuredWeight.measuredWhen', "I don't know whether the date of my weight reading is exact."],
  ])('keeps a detail-specific unknown separate from %s', (role, text) => {
    const x = setup(context(text)), groups = x.validate([x.group('Q04', [x.state(role, 'unknown', text)])]);
    expect(groups.outcome.responses.Q04?.answers[role]).toBeUndefined();
    expect(groups.rejectedCandidates[0].guardCode).toBe('unscoped-state-evidence');
  });
  it.each([
    ["I don't know.", 'unknown', 'Q04', 'height.value'],
    ["I'm not sure.", 'uncertain', 'Q04', 'height.value'],
    ['I prefer not to answer.', 'declined', 'Q04', 'height.value'],
    ['No.', 'negative', 'Q06', 'conditions.diabetes'],
    ['Not applicable.', 'not-applicable', 'Q03', 'afterSchool'],
  ])('preserves an unambiguous direct single-target reply: %s', (text, s, topic, role) => {
    const ctx = context(text, [topic]); ctx.displayed!.targetPaths = [role];
    const x = setup(ctx), groups = x.validate([x.group(topic, [x.state(role, s, text)])]);
    expect(groups.outcome.responses[topic]?.answers[role]?.state).toBe(s);
    expect(groups.hasInterpretationGaps).toBe(false);
  });
  it.each(["I don't know.", "My mother's height is unknown.", 'Is my height unknown?', 'His height is unknown.', 'It is unknown.', 'If my height is unknown, ask again.'])('rejects ambiguous subject, question or multi-target state: %s', text => {
    const ctx = context(text); ctx.displayed!.targetPaths = ['height.value', 'height.unit'];
    const x = setup(ctx), groups = x.validate([x.group('Q04', [x.state('height.value', 'unknown', text)])]);
    expect(groups.outcome.responses.Q04?.answers['height.value']).toBeUndefined();
    expect(groups.hasInterpretationGaps).toBe(true);
  });
  it('does not combine an unavailable predicate with another history period in one statement', () => {
    const text = "In the past 18 months I don't remember my weight, but in the last five years my weight was stable.", x = setup(context(text, ['Q03'])),
      groups = x.validate([x.group('Q03', [x.state('past18Months', 'unknown', text), x.state('lastFiveYears', 'unknown', text)])]);
    expect(groups.outcome.responses.Q03?.answers.past18Months?.state).toBe('unknown');
    expect(groups.outcome.responses.Q03?.answers.lastFiveYears).toBeUndefined();
    expect(groups.rejectedCandidates).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'lastFiveYears', guardCode: 'unscoped-state-evidence' })]));
  });
  it('permutes each named history period against another predicate in the same original statement', () => {
    const windows = { childhood: 'As a child', teenage: 'In my teens', afterSchool: 'After high school', lastFiveYears: 'In the last five years', past18Months: 'In the past 18 months' };
    for (const [own, label] of Object.entries(windows)) for (const [other, otherLabel] of Object.entries(windows)) {
      if (own === other) continue;
      const text = `${label} I don't remember my weight, but ${otherLabel.toLowerCase()} my weight was stable.`, x = setup(context(text, ['Q03'])),
        groups = x.validate([x.group('Q03', [x.state(own, 'unknown', text), x.state(other, 'unknown', text)])]);
      expect(groups.outcome.responses.Q03?.answers[own]?.state).toBe('unknown');
      expect(groups.outcome.responses.Q03?.answers[other]).toBeUndefined();
      expect(groups.hasInterpretationGaps).toBe(true);
    }
  });
  it('binds negative condition reports and not-applicable periods to their own target', () => {
    const text = 'I do not have diabetes. My thyroid condition is uncertain.', x = setup(context(text, ['Q06'])),
      groups = x.validate([x.group('Q06', [x.state('conditions.diabetes', 'negative', 'diabetes'), x.state('conditions.thyroidHormone', 'negative', 'diabetes')])]);
    expect(groups.outcome.responses.Q06?.answers['conditions.diabetes']?.state).toBe('negative');
    expect(groups.outcome.responses.Q06?.answers['conditions.thyroidHormone']).toBeUndefined();
    const history = 'After high school my weight was stable, but primary school is not applicable.', y = setup(context(history, ['Q03'])),
      invalid = y.validate([y.group('Q03', [y.state('afterSchool', 'not-applicable', history)])]);
    expect(invalid.outcome.responses.Q03?.answers.afterSchool).toBeUndefined();
    expect(invalid.hasInterpretationGaps).toBe(true);
  });
  it('binds unavailable details to the named medicine and rejects another medicine without erasing its anchor', () => {
    const text = "I take Metformin. I take iron. I don't know the strength of iron.", x = setup(context(text, ['Q08'])),
      groups = x.validate([x.item('m', 'Metformin', [x.state('strength', 'unknown', "don't know")]), x.item('i', 'iron', [x.state('strength', 'unknown', "don't know")])]);
    const medicines = groups.outcome.responses.Q08?.answers.medicines?.items!;
    expect(medicines.find(item => item.answers.name?.value === 'Metformin')?.answers.strength).toBeUndefined();
    expect(medicines.find(item => item.answers.name?.value === 'iron')?.answers.strength?.state).toBe('unknown');
    expect(groups.hasInterpretationGaps).toBe(true);
  });
  it('rejects an unsupported nonknown identity anchor and all its dependent fields', () => {
    const text = "I don't know my height. My medicine strength is unknown.", x = setup(context(text, ['Q08']));
    const groups = x.validate([{ kind: 'Q08.medicines', key: 'm', scope: { mode: 'new', anchor: x.state('name', 'unknown', "don't know") }, fields: [x.state('strength', 'unknown', 'strength')] }]);
    expect(groups.outcome.responses.Q08?.answers.medicines).toBeUndefined();
    expect(groups.rejectedCandidates.map(candidate => candidate.reason)).toEqual(['source-quote-rejection', 'dependent-anchor-rejected']);
    expect(groups.hasInterpretationGaps).toBe(true);
  });
  it('requires the shared medicine predicate to concern the declared role', () => {
    const text = 'I take Metformin. I take iron. No foods with either.', x = setup(context(text, ['Q08'])),
      groups = x.validate([x.item('m', 'Metformin', []), x.item('i', 'iron', [])], {
        sharedConcerns: [{ family: 'Q08.medicines', entities: ['m', 'i'], answer: { s: 'negative', v: null, p: [x.support('No foods')] } }],
      });
    expect(groups.outcome.responses.Q08?.answers.medicines?.items?.every(item => !item.answers.concerns)).toBe(true);
    expect(groups.rejectedCandidates.filter(candidate => candidate.role === 'concerns')).toHaveLength(2);
    expect(groups.hasInterpretationGaps).toBe(true);
  });
  it.each([
    ['August 12', '12'], ['August 12, 2025', 'August 12'], ['around August 12, 2025', 'August 12, 2025'],
    ['early August 2025', 'August 2025'], ['August 12–14, 2025', 'August 12'],
    ['between August 12 and September 14, 2025', 'September 14, 2025'],
    ['about three months ago', 'three months ago'], ['last three months', 'three months'],
    ['approximately 2025-08-12', '2025-08-12'], ['around 8 am', '8 am'],
    ['after my surgery', 'my surgery'], ['during pregnancy', 'pregnancy'],
  ])('rejects cropped temporal meaning from %s to %s', (date, cropped) => {
    const text = `The scale read 230 pounds on ${date}.`, x = setup(context(text)),
      groups = x.validate([x.group('Q04', [x.known('lastMeasuredWeight.measuredWhen', cropped)])]);
    expect(groups.outcome.responses.Q04?.answers['lastMeasuredWeight.measuredWhen']).toBeUndefined();
    expect(groups.rejectedCandidates[0]).toMatchObject({ guardCode: 'temporal-meaning-not-covered' });
  });
  it.each(['August 12', 'August 12, 2025', 'around August 12, 2025', 'early August 2025', 'August 12–14, 2025', 'between August 12 and September 14, 2025', 'about three months ago', 'last three months', 'approximately 2025-08-12', 'after my surgery', 'during pregnancy'])('preserves the exact supplied temporal expression: %s', date => {
    const text = `The scale read 230 pounds on ${date}.`, x = setup(context(text)),
      groups = x.validate([x.group('Q04', [x.known('lastMeasuredWeight.measuredWhen', date)])]);
    expect(groups.outcome.responses.Q04?.answers['lastMeasuredWeight.measuredWhen']).toMatchObject({ state: 'known', value: date });
    expect(groups.hasInterpretationGaps).toBe(false);
  });
  it('rejects generic number and unit handles for temporal roles, without dropping a supported measurement', () => {
    const x = setup(context('The scale read 230 pounds on August 12.'));
    for (const kind of ['number', 'unit']) {
      const selected = x.handles.lexical.find(value => value.kind === kind)!, groups = x.validate([x.group('Q04', [
        { r: 'lastMeasuredWeight.value', s: 'known', v: x.handles.lexical.find(value => value.text === '230')!.ref, p: ['p0'] },
        { r: 'lastMeasuredWeight.measuredWhen', s: 'known', v: selected.ref, p: ['p0'] },
      ])]);
      expect(groups.outcome.responses.Q04?.answers['lastMeasuredWeight.value']?.value).toBe(230);
      expect(groups.outcome.responses.Q04?.answers['lastMeasuredWeight.measuredWhen']).toBeUndefined();
      expect(groups.rejectedCandidates[0].guardCode).toBe('temporal-lexical-selector');
    }
  });
});
