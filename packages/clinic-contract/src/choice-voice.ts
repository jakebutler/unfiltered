import type { PromptView } from './index.js';

/** Whole-utterance matching only: no substring, number/score or narrative inference. */
export function normalizeChoiceUtterance(text: string): string {
  return text.trim().toLowerCase().replace(/[.!?]+$/, '').trim();
}
export function exactSpokenChoice(prompt: PromptView, text: string): NonNullable<PromptView['choices']>[number] | undefined {
  const normalized = normalizeChoiceUtterance(text);
  if (!normalized) return;
  const matches = prompt.choices?.filter(choice => normalizeChoiceUtterance(choice.label) === normalized);
  return matches?.length === 1 ? matches[0] : undefined;
}
export function exactChoiceConfirmation(text: string): 'confirm' | 'retry' | 'text' | 'stop' | undefined {
  const normalized = normalizeChoiceUtterance(text);
  if (['yes', 'confirm'].includes(normalized)) return 'confirm';
  if (['no', 'retry'].includes(normalized)) return 'retry';
  if (['use text', 'switch to text'].includes(normalized)) return 'text';
  if (normalized === 'stop') return 'stop';
}
export interface VoiceChoiceCandidate {
  value: string; label: string; optionTranscript: string;
}

export function choiceConfirmationSpeech(prompt: PromptView, value: string): string | undefined {
  const choice = prompt.choices?.find(choice => choice.value === value);
  if (!choice) return;
  return `${prompt.text}\nYou chose: ${choice.label}. Say Yes or Confirm to save this choice. Say Retry to choose again, Switch to text, or Stop.`;
}
