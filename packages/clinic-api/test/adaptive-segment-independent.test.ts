import { describe, expect, it } from 'vitest';
import { adaptiveSourceSegments, resolveSegmentQuote } from '../src/adaptive-source.js';
import { resolveSegmentedAdaptiveProposal } from '../src/adaptive-wire.js';
import { applyValidatedTurn, validateAdaptiveProposal } from '../src/adaptive-validation.js';
import { context } from './fixtures/adaptive.js';

describe('independent segmented source boundaries', () => {
  it('addresses repeated numeric literals without confusing the corresponding source locations', () => {
    const ctx = context('My height is 172 cm; my old note also says 172 cm.');
    const segments = adaptiveSourceSegments(ctx);
    const numbers = segments.filter(segment => segment.kind === 'literal' && segment.text === '172');
    expect(numbers).toHaveLength(2);
    expect(numbers[0].id).not.toBe(numbers[1].id);
    for (const segment of numbers) expect(resolveSegmentQuote(ctx, segments, { segmentId: segment.id, quote: '172' }))
      .toEqual({ sourceId: ctx.source.id, start: segment.start, end: segment.end });
    const sentence = segments.find(segment => segment.kind === 'sentence')!;
    expect(() => resolveSegmentQuote(ctx, segments, { segmentId: sentence.id, quote: '172' })).toThrow('ambiguous-source-quote');
  });

  it('rejects a foreign or reconstructed segment and mutation of its underlying source', () => {
    const ctx = context('A café visit 🙂 matters to me.', ['Q01']);
    const segments = adaptiveSourceSegments(ctx), segment = segments[0];
    const citation = { segmentId: segment.id, quote: 'café visit 🙂' };
    expect(() => resolveSegmentQuote(ctx, structuredClone(segments), citation)).toThrow('invalid-source-segment');
    const other = { ...ctx, source: { ...ctx.source, id: 'another-source' } };
    expect(() => resolveSegmentQuote(other, segments, citation)).toThrow('invalid-source-segment');
    ctx.source.text = 'Changed source';
    expect(() => resolveSegmentQuote(ctx, segments, citation)).toThrow('invalid-source-segment');
  });

  it('does not let a valid segment hide that a condition was reported about a family member', () => {
    const ctx = context('My mother has diabetes. I do not know whether I have diabetes.', ['Q06', 'DM']);
    const segment = adaptiveSourceSegments(ctx).find(value => value.text.includes('mother'))!;
    const canonical = resolveSegmentedAdaptiveProposal({ schema: 3, facts: [{
      topicId: 'Q06', path: 'conditions.diabetes', state: 'known', transform: 'explicit-choice',
      evidence: [{ segmentId: segment.id, quote: 'diabetes' }], correctsSourceIds: [],
    }], newItems: [], completedLists: [], acts: [], next: null }, ctx);
    const result = applyValidatedTurn(ctx, validateAdaptiveProposal(canonical, ctx));
    expect(result.responses.Q06?.answers['conditions.diabetes']?.state).not.toBe('known');
    expect(result.responses.DM?.applicability).not.toBe('applicable');
  });

  it('rejects undeclared wire fields instead of repairing a provider response', () => {
    const ctx = context('A detail.', ['Q01']);
    const raw = { schema: 3, facts: [], newItems: [], completedLists: [], acts: [], next: null, newItemsNote: 'extra' };
    expect(() => resolveSegmentedAdaptiveProposal(raw, ctx)).toThrow('invalid-adaptive-segment-proposal');
    expect(raw.newItemsNote).toBe('extra');
  });
});
