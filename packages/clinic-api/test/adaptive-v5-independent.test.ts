import { describe, expect, it } from 'vitest';
import { createAdaptiveValueManifest, resolveAdaptiveValueProposal, type AdaptiveValueManifest } from '../src/adaptive-value-manifest.js';
import { applyValidatedTurn, validateAdaptiveProposal, type AdaptiveContext } from '../src/adaptive-validation.js';
import { context, withPrior } from './fixtures/adaptive.js';

interface Projection {
  sourceSegments: string[][];
  topics: { topicId: string; targets: { ref: string; path: string }[] }[];
}
const projection = (manifest: AdaptiveValueManifest) => Object.assign({}, ...manifest.payloads) as Projection;
function candidate(manifest: AdaptiveValueManifest, topicId: string, path: string, value: string, support: string, operation = 'assert') {
  const payload = projection(manifest);
  const address = (quote: string) => ({ source: payload.sourceSegments.find(row => row[1] === 'sentence' && row[2].includes(quote))![0], quote });
  return {
    target: payload.topics.find(topic => topic.topicId === topicId)!.targets.find(target => target.path === path)!.ref,
    state: 'known', value: address(value), evidence: [address(support)], operation,
  };
}
function apply(ctx: AdaptiveContext, manifest: AdaptiveValueManifest, facts: unknown[]) {
  const wire = { schema: 5, context: manifest.id, facts, newItems: [], completedLists: [], interruptions: [], unmapped: [] };
  return applyValidatedTurn(ctx, validateAdaptiveProposal(resolveAdaptiveValueProposal(wire, ctx, manifest), ctx));
}
function medicine(text: string) {
  return withPrior(context(text, ['Q08']), 'Q08', {
    medicines: { state: 'known', complete: true, sourceIds: ['prior'], items: [{ id: 'product', answers: {
      name: { state: 'known', value: 'Synthetic product', sourceIds: ['prior'] },
      strength: { state: 'known', value: '2 mg', sourceIds: ['prior'] },
    } }] },
  }, 'Synthetic product 2 mg.');
}

describe('independent V5 value/support counterexamples', () => {
  it.each(['g', 'mL', 'µg', 'units'])('refuses a bare strength value when its stated unit is %s', unit => {
    const text = `Synthetic product 5 ${unit}.`, ctx = medicine(text), manifest = createAdaptiveValueManifest(ctx);
    expect(() => apply(ctx, manifest, [candidate(manifest, 'Q08', 'medicines[product].strength', '5', text)])).toThrow('incomplete-strength-value');
    expect(ctx.responses.Q08?.answers.medicines).toMatchObject({ items: [{ answers: { strength: { value: '2 mg' } } }] });
  });

  it('requires complete postfix correction cue in support, rather than an uncited or partial cue', () => {
    const text = 'Synthetic product is 5 mg, actually.', ctx = medicine(text), manifest = createAdaptiveValueManifest(ctx);
    for (const support of ['5 mg', '5 mg, act']) {
      expect(() => apply(ctx, manifest, [candidate(manifest, 'Q08', 'medicines[product].strength', '5 mg', support, 'correct')])).toThrow('invalid-correction-support');
    }
    const result = apply(ctx, manifest, [candidate(manifest, 'Q08', 'medicines[product].strength', '5 mg', text, 'correct')]);
    expect(result.responses.Q08?.answers.medicines).toMatchObject({ items: [{ answers: { strength: { value: '5 mg', sourceIds: [ctx.source.id] } } }] });
    expect(result.provenance[0]).toMatchObject({ sourceText: ['5 mg'], supportSourceText: [text], correctsSourceIds: ['prior'] });
  });

  it('does not attach a remote unit through shared wide support', () => {
    const text = 'The scale read 80 pounds; I estimate 90 kg.', ctx = context(text, ['Q04']), manifest = createAdaptiveValueManifest(ctx);
    const result = apply(ctx, manifest, [
      candidate(manifest, 'Q04', 'lastMeasuredWeight.value', '80', text),
      candidate(manifest, 'Q04', 'lastMeasuredWeight.unit', 'kg', text),
    ]);
    expect(result.responses.Q04?.answers['lastMeasuredWeight.value']).toMatchObject({ state: 'known', value: 80 });
    expect(result.responses.Q04?.answers['lastMeasuredWeight.unit']).toBeUndefined();
    expect(result.clarifications).toContainEqual(expect.objectContaining({ path: 'lastMeasuredWeight.unit', reason: 'unscoped-response' }));
    expect(result.hasUnresolvedInterpretation).toBe(true);
  });
});
