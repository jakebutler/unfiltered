import { describe, expect, it } from 'vitest';
import { buildNativeQuestionnaireCapture } from '../src/questionnaire-response.js';

describe('native questionnaire capture projection', () => {
  it('settles when an unreviewed routing anchor moves to history', async () => {
    const unreviewed = crypto.randomUUID(), reviewed = crypto.randomUUID();
    const topics = {
      Q06: { presented: true, answers: { 'conditions.prediabetes': { state: 'known' as const, value: true, sourceIds: [reviewed, unreviewed] } } },
      DM: { presented: true, answers: {}, applicability: 'unknown' as const, applicabilitySourceIds: [reviewed, unreviewed] },
    };
    const capture = await buildNativeQuestionnaireCapture({ scenario: 'first-intake', topics, validSourceIds: new Set([reviewed, unreviewed]), unreviewedSourceIds: [unreviewed] });
    expect(capture.topics.Q06?.answers['conditions.prediabetes']).toBeUndefined();
    expect(capture.topics.DM).toMatchObject({ applicability: 'unknown', applicabilitySourceIds: [] });
  });
});
