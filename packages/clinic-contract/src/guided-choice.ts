import type { PromptView, SourceChannel } from './index.js';
import { exactSpokenChoice, type VoiceChoiceCandidate } from './choice-voice.js';
import { promptAllowsFreeText } from './prompt-input.js';

export const chooseOptionInstruction = 'Please choose one of the options';
export const isScreeningChoicePrompt = (prompt: Pick<PromptView, 'id'>) => /^Q16:MH0[1-4](?:$|:)/.test(prompt.id);
export const isGuidedChoicePrompt = (prompt: PromptView) => Boolean(prompt.choices?.length && !prompt.fields?.length && !promptAllowsFreeText(prompt));

/** Button values and typed labels can be identical. The composer tracks button selection separately. */
export function typedGuidedChoice(prompt: PromptView, text: string): VoiceChoiceCandidate | undefined {
  if (!isGuidedChoicePrompt(prompt) || isScreeningChoicePrompt(prompt)) return;
  const choice = exactSpokenChoice(prompt, text);
  return choice && { ...choice, optionTranscript: text };
}

/** Editing recognition creates typed words; retain the original recognition separately. */
export function editGuidedChoiceDraft(previousText: string, previousChannel: SourceChannel, retainedSpeech?: string) {
  return { channel: 'text' as const, retainedSpeech: retainedSpeech ?? (previousChannel !== 'text' && previousText.trim() ? previousText : undefined) };
}
