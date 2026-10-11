import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { context, withPrior } from './fixtures/adaptive.js';
import { createAdaptiveSourceGroupManifest, issuedAdaptiveSourceGroupManifest, expandAdaptiveSourceGroupProposal } from '../src/adaptive-group-v7.js';
import { validateAdaptiveGroupProposal } from '../src/adaptive-group-compile.js';
import { adaptiveGroupRejectedTargets, eligibleAdaptiveProbes, selectAdaptiveGroupDialogue } from '../src/dialogue.js';
import type { AdaptiveContext } from '../src/adaptive-validation.js';

function fixture(ctx: AdaptiveContext) {
  const manifest = createAdaptiveSourceGroupManifest(ctx);
  const { handles } = issuedAdaptiveSourceGroupManifest(manifest, ctx);
  const packet = (groups: unknown[], rest = {}) => ({ schema: 7, context: manifest.id, groups, ...rest });
  const validate = (raw: unknown) => {
    const expanded = expandAdaptiveSourceGroupProposal(raw, ctx, manifest);
    return validateAdaptiveGroupProposal(expanded.raw, ctx, expanded.manifest);
  };
  return { manifest, handles, packet, validate };
}

describe('V7 independent source and routing boundaries', () => {
  it.each(["I don't remember the last five years.", 'I don’t remember the last five years.', 'I can’t recall the last five years.', "In the last five years, I don't remember my weight."])(
    'keeps an explicitly unavailable requested window blocked: %s',
    (unavailable) => {
      const ctx = context(`In the past 18 months I don't remember my weight. ${unavailable}`, ['Q03']);
      ctx.displayed!.targetPaths = ['lastFiveYears'];
      const x = fixture(ctx);
      const groups = x.validate(x.packet([{
        kind: 'Q03', key: 'history', scope: 'patient',
        fields: ['past18Months', 'lastFiveYears'].map(r => ({ r, s: 'unknown', v: null, p: ['p0'] })),
      }]));
      expect(groups.hasInterpretationGaps).toBe(true);
      expect(groups.outcome.responses.Q03?.answers.past18Months?.state).toBe('unknown');
      expect(groups.outcome.responses.Q03?.answers.lastFiveYears).toBeUndefined();
      expect(eligibleAdaptiveProbes({ ...ctx, responses: groups.outcome.responses }, adaptiveGroupRejectedTargets(ctx, groups))
        .flatMap(probe => probe.targetPaths)).not.toContain('lastFiveYears');
    },
  );

  it('permits an exact repeated quote only inside its selected statement, retaining that occurrence provenance', () => {
    const ctx = context('I want more energy. I want more energy.', ['Q01']);
    const x = fixture(ctx);
    const groups = x.validate(x.packet([{
      kind: 'Q01', key: 'reason', scope: 'patient',
      fields: [{ r: 'reason', s: 'known', v: { q: 'more energy' }, p: ['p1'] }],
    }]));
    expect(groups.rejectedCandidates).toEqual([]);
    expect(groups.outcome.provenance[0].evidence[0].start).toBe(ctx.source.text.lastIndexOf('more energy'));
  });

  it('does not find a quote in secondary support and does not grant list closure after an anchor rejection', () => {
    const ctx = context('I take Amlodipine 5 mg. I take iron 18 mg.', ['Q08']);
    const x = fixture(ctx);
    const groups = x.validate(x.packet([{
      kind: 'Q08.medicines', key: 'medicine',
      scope: { mode: 'new', anchor: { r: 'name', s: 'known', v: { q: 'iron' }, p: ['p0', 'p1'] } },
      fields: [{ r: 'strength', s: 'known', v: { q: '18 mg' }, p: ['p1'] }],
    }], { completedLists: [{ family: 'Q08.medicines', p: ['p0'] }] }));
    expect(groups.rejectedCandidates.map(rejection => rejection.reason)).toEqual(['source-quote-rejection', 'dependent-anchor-rejected']);
    expect(groups.outcome.responses.Q08?.answers.medicines).toBeUndefined();
    expect(groups.hasInterpretationGaps).toBe(true);
  });

  it('does not let a correction borrow the other medicine identity and keeps trusted dialogue dispositions immutable', () => {
    const known = (value: string) => ({ state: 'known' as const, value, sourceIds: ['prior'] });
    const ctx = withPrior(context('Correction: iron is 20 mg. Should I double my dose?', ['Q08']), 'Q08', {
      medicines: { state: 'known', sourceIds: ['prior'], items: [
        { id: 'amlodipine', answers: { name: known('Amlodipine'), strength: known('5 mg') } },
        { id: 'iron', answers: { name: known('iron'), strength: known('18 mg') } },
      ] },
    });
    const x = fixture(ctx);
    const groups = x.validate(x.packet([{
      kind: 'Q08.medicines', key: 'm', scope: { mode: 'existing', ref: 'e0', anchor: { v: { q: 'iron' }, p: ['p0'] } },
      fields: [{ r: 'strength', s: 'known', v: { q: '20 mg' }, p: ['p0'] }], correct: [0],
    }], { acts: [{ kind: 'question', reply: 'COPY-05', p: ['p1'] }] }));
    expect(groups.rejectedCandidates.map(rejection => rejection.reason)).toEqual(['entity-anchor-unresolved', 'dependent-anchor-rejected']);
    expect(selectAdaptiveGroupDialogue(ctx, groups).reply?.id).toBe('COPY-05');
    (groups as { hasInterpretationGaps: boolean }).hasInterpretationGaps = false;
    expect(() => selectAdaptiveGroupDialogue(ctx, groups)).toThrow('untrusted-group-result');
  });

  it('rejects a malformed optional array natively and locally even beside a supported field', () => {
    const ctx = context('My height is 172 cm.');
    const x = fixture(ctx);
    const value = x.handles.lexical.find(handle => handle.kind === 'number')!;
    const raw = x.packet([{ kind: 'Q04', key: 'height', scope: 'patient', fields: [{ r: 'height.value', s: 'known', v: value.ref, p: ['p0'] }] }], { unmapped: null });
    expect(new Ajv().compile(x.manifest.jsonSchema)(raw)).toBe(false);
    expect(() => x.validate(raw)).toThrow('invalid-group-proposal');
  });
});
