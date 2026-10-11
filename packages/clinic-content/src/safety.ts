/** Bounded E-0.1 synthetic-demo interruption, not a validated triage classifier. */
export const escalationCopy = {
  E01: "This could need emergency help. If this is happening to you now, call 911 in the U.S. or your local emergency number now. Don't wait for a reply here. This fictional demo cannot provide emergency care or contact help for you.",
  E02: "This needs prompt medical attention. If this is happening to you now, contact a medical professional now; if you can't reach one, seek urgent medical care. If you feel seriously unwell or think this may be an emergency, call 911 in the U.S. or your local emergency number. Don't wait for a reply in this demo.",
  E03: "If you may have been exposed to something poisonous, taken an extra dose, or taken the wrong medicine, contact Poison Help now at 1-800-222-1222 in the U.S. If you have serious symptoms such as trouble breathing, collapse, or a seizure, call 911 in the U.S. or your local emergency number now. Outside the U.S., contact your local poison service. Don't wait for a reply in this demo.",
  E04: "I'm sorry you're going through this. If you might act on these thoughts now, have already hurt yourself, or are in immediate danger, call 911 in the U.S. or your local emergency number now. In the U.S., you can also call or text 988, or visit 988lifeline.org, for crisis support. This demo is not monitored for care, so please don't wait for a reply here.",
  E05: "Thank you for telling me. Concerns about eating deserve support. I can include what you've shared for both the medical clinician and dietitian to review; you don't need to give more detail here. If this is a real concern, please contact your health care professional rather than waiting for this demo.",
} as const;
export type EscalationRule = keyof typeof escalationCopy;
/** The exact existing classifier predicates are data so they bind the authored definition. */
export const safetyHistoricalGuard = {
  historical:
    /\b(last year|years ago|in the past|hypothetical|a movie|used to)\b/,
  current: /\b(now|today|tonight|currently|again)\b/,
} as const;
export const safetyRules: ReadonlyArray<{
  id: EscalationRule;
  pattern: RegExp;
  unless?: RegExp;
}> = [
  {
    id: "E01",
    pattern:
      /\b(can't breathe|cannot breathe|struggling to breathe|medical emergency|severe (abdominal |chest |stomach )?pain|vomiting blood|uncontrolled bleeding|collapsed|fainted|confused and|sudden severe)\b/,
  },
  {
    id: "E04",
    pattern:
      /\b(hurt myself|harm myself|kill myself|suicid|end my life|don't want to live|do not want to live)/,
    unless: /\b(no|not having|don't have|do not have) (suicidal|thoughts of)/,
  },
  {
    id: "E03",
    pattern:
      /\b(extra dose|double dose|twice by accident|injection twice|wrong medicine|wrong medication|poison|swallowed.*cleaning|overdose)\b/,
  },
  {
    id: "E02",
    pattern:
      /\b(can't keep (liquids|fluids|water) down|cannot keep (liquids|fluids|water) down|haven't urinated|have not urinated|no urination|barely eating|unable to (eat|drink))\b/,
  },
  {
    id: "E05",
    pattern:
      /\b(make myself (throw up|vomit)|purging|binge|out of control.*eat|restricting.*food|undo eating|distress.*(food|body))\b/,
  },
];
export function escalation(text: string): EscalationRule | undefined {
  const value = text.toLowerCase().replace(/[’‘]/g, "'");
  if (
    safetyHistoricalGuard.historical.test(value) &&
    !safetyHistoricalGuard.current.test(value)
  )
    return;
  return safetyRules.find(
    (rule) => rule.pattern.test(value) && !rule.unless?.test(value),
  )?.id;
}
/** Stable regex source, independent of bundler/transpiler output. */
export const safetyDefinition = {
  version: "E-0.1",
  copies: escalationCopy,
  historicalGuard: {
    historical: safetyHistoricalGuard.historical.source,
    current: safetyHistoricalGuard.current.source,
  },
  rules: safetyRules.map((rule) => ({
    id: rule.id,
    pattern: rule.pattern.source,
    ...(rule.unless ? { unless: rule.unless.source } : {}),
  })),
  interruptionPrecedesCollection: true,
} as const;
