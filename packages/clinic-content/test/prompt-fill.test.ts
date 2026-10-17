import { describe, expect, it } from 'vitest';
import { promptText, supplementalPromptText } from '../src/content.js';
import { fillPrompt } from '../src/prompt-fill.js';
import type { NativeRoutingContext } from '../src/native-questionnaire.js';

const context: NativeRoutingContext = {
  appointment: { reference: 'Appointment/synthetic', version: '1', startsAt: '2026-10-20T15:00:00.000Z', timezone: 'America/New_York', priorUpdateAt: '2026-10-01T12:00:00.000Z' },
  plan: { reference: 'DocumentReference/synthetic-plan', version: '2', author: 'Synthetic clinician', recordedAt: '2026-10-02T12:00:00.000Z', text: 'Synthetic plan text.', truncated: true },
  priorSubmission: { reference: 'QuestionnaireResponse/synthetic-prior', version: '1', recordedAt: '2026-10-01T12:00:00.000Z', sourceDocumentReference: 'DocumentReference/synthetic-sources/_history/1', topicId: 'Q02', path: 'concern', item: 'My knees hurt when I walk.' },
};
describe('pure trusted prompt filling', () => {
  for (const prompt of [...promptText, ...supplementalPromptText].filter(prompt => prompt.text.includes('['))) {
    it(`${prompt.id}: resolves all known placeholders or explicitly reports an incomplete fill`, () => {
      const before = structuredClone(context), result = fillPrompt(prompt.text, context);
      expect(result.complete).toBe(!result.text.includes('['));
      if (['S01', 'S03', 'W02.followup.1'].includes(prompt.id)) expect(result.complete).toBe(true);
      expect(fillPrompt(prompt.text, {}).complete).toBe(false);
      expect(context).toEqual(before);
      expect(result.text).not.toContain('(truncated)');
    });
  }
  it('uses the plan date for S03 and the prior submission date for changes when both are present', () => {
    expect(fillPrompt('Recorded by [demo author/role] on [date].', context).text).toBe('Recorded by Synthetic clinician on 2026-10-02T12:00:00.000Z.');
    expect(fillPrompt('What has changed about [previously reported item] since [date]?', context).text).toBe('What has changed about My knees hurt when I walk. since 2026-10-01T12:00:00.000Z?');
  });
  it('accepts an explicit trusted prior argument and never expands bracket text inside record values', () => {
    expect(fillPrompt('[previously reported item] on [date]', {}, { item: 'Exact patient phrase', date: '2026-10-01' })).toEqual({ text: 'Exact patient phrase on 2026-10-01', complete: true });
    const result = fillPrompt('[previously reported item] on [date]', context, { item: 'I wrote [date] in a note.', date: '2026-10-03' });
    expect(result).toEqual({ text: 'I wrote [date] in a note. on 2026-10-03', complete: false });
    expect(fillPrompt('Unmatched [', context).complete).toBe(false);
    expect(fillPrompt('Unknown [placeholder]', context).complete).toBe(false);
  });
});
