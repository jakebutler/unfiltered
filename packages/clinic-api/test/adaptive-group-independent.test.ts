import { describe, expect, it } from 'vitest';
import { createAdaptiveGroupManifest, issuedAdaptiveGroupManifest } from '../src/adaptive-group-manifest.js';
import { compileAdaptiveGroupProposal, validateAdaptiveGroupProposal } from '../src/adaptive-group-compile.js';
import { context, withPrior } from './fixtures/adaptive.js';
import type { AdaptiveContext } from '../src/adaptive-validation.js';

function packet(ctx: AdaptiveContext) {
  const manifest = createAdaptiveGroupManifest(ctx);
  const segments = issuedAdaptiveGroupManifest(manifest, ctx).segments;
  const address = (quote: string) => {
    const index = segments.findIndex(segment => segment.text.includes(quote) && segment.text.indexOf(quote, segment.text.indexOf(quote) + 1) < 0);
    if (index < 0) throw new Error(`Missing unique quote: ${quote}`);
    return { segment: `s${index}`, quote };
  };
  const answer = (value: string, support = value) => ({ state: 'known', value: address(value), support: [address(support)] });
  const wire = (groups: unknown[], other: object = {}) => ({ schema: 6, context: manifest.id, groups, completedLists: [], absentLists: [], sharedConcerns: [], acts: [{ kind: 'question', reply: 'COPY-05', support: [address('Should I double my dose?')] }], unmapped: [], ...other });
  return { manifest, address, answer, wire };
}

describe('independent scoped-group semantic isolation', () => {
  it('retains an independent approved question when selected medicine strength omits its unit', () => {
    const ctx = context('Amlodipine 5 mg. Should I double my dose?', ['Q08']);
    const x = packet(ctx);
    const raw = x.wire([{ kind: 'Q08.medicines', key: 'medicine', scope: { mode: 'new', anchor: { role: 'name', answer: x.answer('Amlodipine') } }, fields: [{ role: 'strength', answer: x.answer('5', 'Amlodipine 5 mg.') }], correct: [] }]);
    const result = validateAdaptiveGroupProposal(raw, ctx, x.manifest);
    expect(result.outcome.acts).toMatchObject([{ kind: 'question', replyId: 'COPY-05' }]);
    expect(result.patientClarifications).toEqual([]);
    expect(result.hasInterpretationGaps).toBe(true);
    expect(result.rejectedCandidates).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'strength' })]));
    const medicines = result.outcome.responses.Q08?.answers.medicines;
    if (medicines?.state === 'known') expect(medicines.items?.[0].answers.strength).toBeUndefined();
  });

  it('retains an independent approved question when a correction has no local correction cue', () => {
    const known = (value: string) => ({ state: 'known' as const, value, sourceIds: ['prior'] });
    const ctx = withPrior(context('Amlodipine is 10 mg. Should I double my dose?', ['Q08']), 'Q08', { medicines: { state: 'known', complete: true, sourceIds: ['prior'], items: [{ id: 'a', answers: { name: known('Amlodipine'), strength: known('5 mg') } }] } });
    const x = packet(ctx);
    const raw = x.wire([{ kind: 'Q08.medicines', key: 'change', scope: { mode: 'existing', ref: 'e0', anchor: [x.address('Amlodipine')] }, fields: [{ role: 'strength', answer: x.answer('10 mg', 'Amlodipine is 10 mg.') }], correct: [0] }]);
    const result = validateAdaptiveGroupProposal(raw, ctx, x.manifest);
    expect(result.outcome.acts).toMatchObject([{ kind: 'question', replyId: 'COPY-05' }]);
    expect(result.patientClarifications).toEqual([]);
    expect(result.hasInterpretationGaps).toBe(true);
    expect(result.rejectedCandidates).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'strength' })]));
    const medicines = result.outcome.responses.Q08?.answers.medicines;
    if (medicines?.state === 'known') expect(medicines.items?.[0].answers.strength).toMatchObject({ state: 'known', value: '5 mg', sourceIds: ['prior'] });
  });

  it('still rejects the whole envelope for a foreign address or malformed auxiliary entry', () => {
    const ctx = context('Amlodipine 5 mg. Should I double my dose?', ['Q08']);
    const x = packet(ctx);
    const valid = x.wire([{ kind: 'Q08.medicines', key: 'medicine', scope: { mode: 'new', anchor: { role: 'name', answer: x.answer('Amlodipine') } }, fields: [{ role: 'strength', answer: x.answer('5 mg') }], correct: [] }]);
    const foreign = { ...valid, unmapped: [{ reason: 'ambiguous', support: [{ segment: 's999', quote: 'Amlodipine' }] }] };
    expect(() => compileAdaptiveGroupProposal(foreign, ctx, x.manifest)).toThrow('invalid-source-segment');
    expect(() => validateAdaptiveGroupProposal(foreign, ctx, x.manifest)).toThrow('invalid-source-segment');
    const malformed = { ...valid, unmapped: [{ reason: 'ambiguous', support: [x.address('Amlodipine')], unauthorized: true }] };
    expect(() => validateAdaptiveGroupProposal(malformed, ctx, x.manifest)).toThrow('invalid-group-proposal');
    expect(ctx.responses).toEqual({});
  });
});
