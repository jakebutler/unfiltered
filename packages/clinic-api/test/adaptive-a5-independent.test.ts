import { describe, expect, it } from 'vitest';
import { applyValidatedTurn, validateAdaptiveProposal } from '../src/adaptive-validation.js';
import { context, evidence, fact, proposal } from './fixtures/adaptive.js';

// Independent intended-behavior guards from the bounded A5 review; no provider calls.
describe('A5 independent evidence coverage guards', () => {
  it.each([
    'I was told I have sleep apnea, but I am unsure who to call.',
    'I was told I have sleep apnea. I am unsure about the mask settings.',
  ])('does not derive uncertain diagnosis from uncertainty about another detail: %s', text => {
    const ctx = context(text, ['Q06', 'SLEEP']);
    const result = applyValidatedTurn(ctx, validateAdaptiveProposal(proposal([], {
      newItems: [{ topicId: 'Q06', collection: 'reportedConditions', key: 'condition', fields: [
        { path: 'term', state: 'known', transform: 'verbatim', evidence: evidence(ctx, text) },
      ] }],
    }), ctx));
    expect(result.responses.Q06?.answers['conditions.sleepApnea']?.state).not.toBe('uncertain');
    expect(result.provenance.filter(entry => entry.derivedFrom)).toEqual([]);
  });

  it('does not mark a whole collection statement covered by only one contained entity', () => {
    const text = 'My mother has diabetes and my father has kidney disease.';
    const ctx = context(text, ['Q10']);
    const result = applyValidatedTurn(ctx, validateAdaptiveProposal(proposal([
      fact(ctx, 'Q10', 'familyHistory', text, 'scoped-response'),
    ], { newItems: [{ topicId: 'Q10', collection: 'familyHistory', key: 'mother', fields: [
      { path: 'condition', state: 'known', transform: 'verbatim', evidence: evidence(ctx, 'diabetes') },
      { path: 'relationship', state: 'known', transform: 'verbatim', evidence: evidence(ctx, 'mother') },
    ] }] }), ctx));
    expect(result.clarifications.some(item => item.path === 'familyHistory')).toBe(true);
    expect(result.coveredCandidates).toBeUndefined();
    expect(result.hasUnresolvedInterpretation).toBe(true);
  });
});
