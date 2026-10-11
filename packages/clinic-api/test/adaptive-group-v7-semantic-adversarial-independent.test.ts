import { describe, expect, it } from 'vitest';
import { createAdaptiveSourceGroupManifest, expandAdaptiveSourceGroupProposal, issuedAdaptiveSourceGroupManifest } from '../src/adaptive-group-v7.js';
import { validateAdaptiveGroupProposal } from '../src/adaptive-group-compile.js';
import { context } from './fixtures/adaptive.js';

// Independent offline challenge. No historical artifact writes or provider reads.
function setup(text: string, topic = 'Q04', target?: string) {
  const ctx = context(text, [topic]);
  if (target) ctx.displayed!.targetPaths = [target];
  const manifest = createAdaptiveSourceGroupManifest(ctx);
  const { handles } = issuedAdaptiveSourceGroupManifest(manifest, ctx);
  const support = (needle: string) => {
    const statement = handles.statements.find(statement => statement.text.includes(needle));
    if (!statement) throw new Error(`Missing independent support: ${needle}`);
    return statement.ref;
  };
  const state = (r: string, s: string, needle: string) => ({ r, s, v: null, p: [support(needle)] });
  const known = (r: string, q: string, needle = q) => ({ r, s: 'known', v: { q }, p: [support(needle)] });
  const patient = (fields: unknown[]) => ({ kind: topic, key: 'patient', scope: 'patient', fields });
  const medicine = (key: string, identity: string, fields: unknown[] = []) => ({
    kind: 'Q08.medicines', key, scope: { mode: 'new', anchor: known('name', identity, `I take ${identity}.`) }, fields,
  });
  const run = (groups: unknown[], rest: Record<string, unknown> = {}) => {
    const expanded = expandAdaptiveSourceGroupProposal({ schema: 7, context: manifest.id, groups, ...rest }, ctx, manifest);
    // This runs compilation, the combined unchanged semantic guard, and application.
    return validateAdaptiveGroupProposal(expanded.raw, ctx, expanded.manifest);
  };
  return { state, known, patient, medicine, support, run };
}

describe('independent V7 semantic admission adversarial contract', () => {
  it('does not assert uncertainty explicitly negated by the patient', () => {
    const x = setup('My height is not uncertain.');
    const result = x.run([x.patient([x.state('height.value', 'uncertain', 'height')])]);
    expect(result.outcome.responses.Q04?.answers['height.value']).toBeUndefined();
    expect(result.hasInterpretationGaps).toBe(true);
  });

  it('does not treat a clinic lacking information as the patient lacking it', () => {
    const x = setup('My height is unknown to the clinic, but I know it is 172 cm.');
    const result = x.run([x.patient([x.state('height.value', 'unknown', 'height')])]);
    expect(result.outcome.responses.Q04?.answers['height.value']).toBeUndefined();
    expect(result.hasInterpretationGaps).toBe(true);
  });

  it('does not let an omitted source medicine donate uncertainty to a proposed medicine', () => {
    const x = setup('I take Metformin. Metformin strength is 500 mg whereas iron strength is unknown.', 'Q08');
    const result = x.run([x.medicine('m', 'Metformin', [x.state('strength', 'unknown', 'whereas')])]);
    const item = result.outcome.responses.Q08?.answers.medicines?.items?.find(item => item.answers.name?.value === 'Metformin');
    expect(item?.answers.name?.value).toBe('Metformin');
    expect(item?.answers.strength).toBeUndefined();
    expect(result.hasInterpretationGaps).toBe(true);
  });

  it('does not let label uncertainty erase an explicit medicine strength', () => {
    const x = setup('I take Metformin. Metformin strength is 500 mg while its label directions are unknown.', 'Q08');
    const result = x.run([x.medicine('m', 'Metformin', [x.state('strength', 'unknown', 'while')])]);
    const item = result.outcome.responses.Q08?.answers.medicines?.items?.find(item => item.answers.name?.value === 'Metformin');
    expect(item?.answers.name?.value).toBe('Metformin');
    expect(item?.answers.strength).toBeUndefined();
    expect(result.hasInterpretationGaps).toBe(true);
  });

  it('does not resolve either against a proposal universe that omits a source medicine', () => {
    const x = setup('I take Metformin. I take iron. I take aspirin. No concerns with either.', 'Q08');
    const result = x.run([x.medicine('m', 'Metformin'), x.medicine('i', 'iron')], {
      sharedConcerns: [{ family: 'Q08.medicines', entities: ['m', 'i'], answer: { s: 'negative', v: null, p: [x.support('No concerns')] } }],
    });
    const items = result.outcome.responses.Q08?.answers.medicines?.items;
    expect(items?.map(item => item.answers.name?.value)).toEqual(['Metformin', 'iron']);
    expect(items?.every(item => !item.answers.concerns)).toBe(true);
    expect(result.hasInterpretationGaps).toBe(true);
  });

  it('does not convert an alternative date into an exact single date', () => {
    const x = setup('The scale read 230 pounds on August 12 or August 13, 2025.');
    const result = x.run([x.patient([x.known('lastMeasuredWeight.measuredWhen', 'August 12')])]);
    expect(result.outcome.responses.Q04?.answers['lastMeasuredWeight.measuredWhen']).toBeUndefined();
    expect(result.hasInterpretationGaps).toBe(true);
  });

  it('does not drop a supplied year separated by of', () => {
    const x = setup('The scale read 230 pounds on August 12 of 2025.');
    const result = x.run([x.patient([x.known('lastMeasuredWeight.measuredWhen', 'August 12')])]);
    expect(result.outcome.responses.Q04?.answers['lastMeasuredWeight.measuredWhen']).toBeUndefined();
    expect(result.hasInterpretationGaps).toBe(true);
  });

  it('retains scoped uncertainty, one displayed direct answer, and a complete approximate period', () => {
    const scoped = setup('My height is uncertain.');
    expect(scoped.run([scoped.patient([scoped.state('height.value', 'uncertain', 'height')])])
      .outcome.responses.Q04?.answers['height.value']?.state).toBe('uncertain');
    const direct = setup("I don't know.", 'Q04', 'height.value');
    expect(direct.run([direct.patient([direct.state('height.value', 'unknown', "don't know")])])
      .outcome.responses.Q04?.answers['height.value']?.state).toBe('unknown');
    const temporal = setup('The scale read 230 pounds about three months ago.');
    expect(temporal.run([temporal.patient([temporal.known('lastMeasuredWeight.measuredWhen', 'about three months ago')])])
      .outcome.responses.Q04?.answers['lastMeasuredWeight.measuredWhen']).toMatchObject({ state: 'known', value: 'about three months ago' });
  });
});
