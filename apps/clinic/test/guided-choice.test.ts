import { describe, expect, it } from 'vitest';
import type { PromptView } from '../../../packages/clinic-contract/src/index';
import { editGuidedChoiceDraft, isGuidedChoicePrompt, isScreeningChoicePrompt, typedGuidedChoice } from '../../../packages/clinic-contract/src/guided-choice';
const prompt: PromptView = { id: 'W06:preferredDay', topicId: 'W06', mode: 'guided', text: 'Preferred day', choices: [{ label: 'Tuesday', value: 'Tuesday' }, { label: 'Wednesday', value: 'Wednesday' }] };

describe('typed guided choice matching', () => {
  it.each(['unreviewed-transcript', 'confirmed-transcript'] as const)('recovers edited %s as typed text while retaining the original recognition', channel => {
    const original = 'Monday\nConfirmation attempt: Actually I meant Tuesday';
    const edited = editGuidedChoiceDraft(original, channel);
    expect(edited).toEqual({ channel: 'text', retainedSpeech: original });
    expect(typedGuidedChoice(prompt, 'Tuesday')).toEqual({ value: 'Tuesday', label: 'Tuesday', optionTranscript: 'Tuesday' });
    expect(editGuidedChoiceDraft('Tues', edited.channel, edited.retainedSpeech)).toEqual(edited);
  });
  it('requires exact full labels even when typed label and button value coincide', () => {
    expect(isGuidedChoicePrompt(prompt)).toBe(true);
    expect(typedGuidedChoice(prompt, ' tuesday. ')).toEqual({ label: 'Tuesday', value: 'Tuesday', optionTranscript: ' tuesday. ' });
    for (const text of ['Tues', 'Tuesday or Wednesday', 'I prefer Tuesday', 'yes']) expect(typedGuidedChoice(prompt, text)).toBeUndefined();
  });
  it('does not turn a free-text alternative or structured field into an exhaustive choice', () => {
    for (const p of [{ ...prompt, choices: [{ value: '__negative', label: 'None / no' }] }, { ...prompt, fields: [{ id: 'value', label: 'Amount', kind: 'number' as const, required: true }] }]) {
      expect(isGuidedChoicePrompt(p)).toBe(false); expect(typedGuidedChoice(p, p.choices![0].label)).toBeUndefined();
    }
  });
  it.each(['MH01', 'MH02', 'MH03', 'MH04'])('never stages typed screening %s for confirmation', item => {
    const phq = { ...prompt, id: `Q16:${item}`, topicId: 'Q16', choices: [{ label: 'Several days', value: '1' }] };
    expect(isScreeningChoicePrompt(phq)).toBe(true);
    expect(typedGuidedChoice(phq, 'Several days')).toBeUndefined(); expect(typedGuidedChoice(phq, '1')).toBeUndefined();
  });
});
