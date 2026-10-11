import type { PromptView } from '../../../packages/clinic-contract/src/index';
/** Negative/not-applicable are alternatives to a scalar/list answer, not an exhaustive choice set. */
export function promptAllowsFreeText(prompt: PromptView, adaptive = false) {
  if (adaptive) return true;
  if (prompt.fields?.length) return false;
  return !prompt.choices?.length || prompt.choices.every(choice => ['__negative', '__not-applicable'].includes(choice.value));
}
