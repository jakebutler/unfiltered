import { describe, expect, it } from 'vitest';
import { createAdaptiveSourceGroupManifest, expandAdaptiveSourceGroupProposal, issuedAdaptiveSourceGroupManifest } from '../src/adaptive-group-v7.js';
import { validateAdaptiveGroupProposal } from '../src/adaptive-group-compile.js';
import { context } from './fixtures/adaptive.js';

function setup(text: string, topic: string, target?: string) {
  const ctx = context(text, [topic]);
  if (target) ctx.displayed!.targetPaths = [target];
  const manifest = createAdaptiveSourceGroupManifest(ctx);
  const { handles } = issuedAdaptiveSourceGroupManifest(manifest, ctx);
  const support = (needle: string) => {
    const found = handles.statements.find(statement => statement.text.includes(needle));
    if (!found) throw new Error(`Missing closeout support: ${needle}`);
    return found.ref;
  };
  const known = (r: string, q: string, needle = q) => ({ r, s: 'known', v: { q }, p: [support(needle)] });
  const state = (r: string, s: string, needle: string) => ({ r, s, v: null, p: [support(needle)] });
  const medicine = (key: string, identity: string, fields: unknown[] = []) => ({ kind: 'Q08.medicines', key,
    scope: { mode: 'new', anchor: known('name', identity, `I take ${identity}.`) }, fields });
  const run = (groups: unknown[], rest: Record<string, unknown> = {}) => {
    const expanded = expandAdaptiveSourceGroupProposal({ schema: 7, context: manifest.id, groups, ...rest }, ctx, manifest);
    return validateAdaptiveGroupProposal(expanded.raw, ctx, expanded.manifest);
  };
  return { known, state, medicine, support, run };
}

describe('independent closeout of V7 positive admission grammar', () => {
  it('preserves exact medicine uncertainty while rejecting role and entity transfers from that same support', () => {
    const x = setup('I take Metformin. Metformin strength is unknown. I take iron.', 'Q08');
    const result = x.run([
      x.medicine('m', 'Metformin', [x.state('strength', 'unknown', 'strength'), x.state('labelDirections', 'unknown', 'strength')]),
      x.medicine('i', 'iron', [x.state('strength', 'unknown', 'strength')]),
    ]);
    const items = result.outcome.responses.Q08?.answers.medicines?.items;
    const metformin = items?.find(item => item.answers.name?.value === 'Metformin');
    const iron = items?.find(item => item.answers.name?.value === 'iron');
    expect(metformin?.answers.strength?.state).toBe('unknown');
    expect(metformin?.answers.labelDirections).toBeUndefined();
    expect(iron?.answers.name?.value).toBe('iron');
    expect(iron?.answers.strength).toBeUndefined();
    expect(result.rejectedCandidates).toHaveLength(2);
    expect(result.hasInterpretationGaps).toBe(true);
  });

  it('requires the whole indirect concern assertion, preserving an exact pair and rejecting a qualified negative', () => {
    for (const [phrase, accepted] of [['No concerns with either.', true], ['No concerns with either, apart from nausea.', false]] as const) {
      const x = setup(`I take Metformin. I take iron. ${phrase}`, 'Q08');
      const result = x.run([x.medicine('m', 'Metformin'), x.medicine('i', 'iron')], {
        sharedConcerns: [{ family: 'Q08.medicines', entities: ['m', 'i'], answer: { s: 'negative', v: null, p: [x.support('No concerns')] } }],
      });
      const items = result.outcome.responses.Q08?.answers.medicines?.items;
      expect(items?.map(item => item.answers.name?.value)).toEqual(['Metformin', 'iron']);
      expect(items?.every(item => item.answers.concerns?.state === 'negative')).toBe(accepted);
      expect(result.hasInterpretationGaps).toBe(!accepted);
    }
  });

  it('requires full temporal meaning even for one displayed target and preserves the complete alternative', () => {
    const phrase = 'August 12 or August 13, 2025';
    const x = setup(`${phrase}.`, 'Q04', 'lastMeasuredWeight.measuredWhen');
    const group = (quote: string) => [{ kind: 'Q04', key: 'q', scope: 'patient', fields: [x.known('lastMeasuredWeight.measuredWhen', quote)] }];
    const cropped = x.run(group('August 12'));
    expect(cropped.outcome.responses.Q04?.answers['lastMeasuredWeight.measuredWhen']).toBeUndefined();
    expect(cropped.hasInterpretationGaps).toBe(true);
    const complete = x.run(group(phrase));
    expect(complete.outcome.responses.Q04?.answers['lastMeasuredWeight.measuredWhen']).toMatchObject({ state: 'known', value: phrase });
    expect(complete.hasInterpretationGaps).toBe(false);
  });
});
