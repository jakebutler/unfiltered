import type { NativeRoutingContext } from './native-questionnaire.js';

/** Fill trusted record placeholders without interpreting or recursively expanding values. */
export function fillPrompt(text: string, context: NativeRoutingContext, prior?: { item?: string; date?: string }): { text: string; complete: boolean } {
  const appointment = context.appointment, plan = context.plan;
  const values: Record<string, string | undefined> = {
    '[verified date/time/timezone]': appointment ? `${appointment.startsAt} ${appointment.timezone}` : undefined,
    '[dated prior update]': appointment?.priorUpdateAt,
    '[demo author/role]': plan?.author,
    '[previously reported item]': prior?.item ?? context.priorSubmission?.item,
    '[date]': text.includes('[previously reported item]') ? prior?.date ?? context.priorSubmission?.recordedAt : plan?.recordedAt ?? prior?.date ?? context.priorSubmission?.recordedAt,
  };
  const filled = text.replace(/\[[^\]]*\]/g, placeholder => values[placeholder] ?? placeholder);
  return { text: filled, complete: !filled.includes('[') };
}
