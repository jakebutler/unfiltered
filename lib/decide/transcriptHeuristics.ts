const POSITIVE_FEEDBACK_PATTERNS = [
  /\bi like\b/i,
  /\bi love\b/i,
  /\bi liked\b/i,
  /\binteresting\b/i,
  /\bthat was interesting\b/i,
  /\blooks good\b/i,
  /\bthis is good\b/i,
  /\bthat's good\b/i,
  /\bnice\b/i,
  /\bgreat\b/i,
];

const CONFUSION_PATTERNS = [
  /\bi(?:'| a)?m confused\b/i,
  /\bconfusing\b/i,
  /\bunclear\b/i,
  /\bnot sure\b/i,
  /\bi don't understand\b/i,
  /\bi dont understand\b/i,
];

const NEXT_STEP_CONFUSION_PATTERNS = [
  /\bnot sure\b.{0,30}\bnext\b/i,
  /\bwhat(?:\s+should|\s+do)\s+i\s+do\s+next\b/i,
  /\bwhat(?:'s| is)\s+next\b/i,
  /\bnot sure what to do next\b/i,
  /\bdon'?t know what to do next\b/i,
];

const NO_MORE_PATTERNS = [
  /\bnothing else\b/i,
  /\bthat'?s all\b/i,
  /\bthat is all\b/i,
  /\bno(?:pe)?\b/i,
  /\bnot really\b/i,
  /\bno more\b/i,
  /\bi think that'?s it\b/i,
];

function normalizeTail(text: string): string {
  return text.slice(-300).trim();
}

function pickVariation(options: string[], lastPrompt = ""): string {
  const normalizedLast = lastPrompt.trim().toLowerCase();
  const nonRepeating = options.find((option) => option.trim().toLowerCase() !== normalizedLast);
  return nonRepeating ?? options[0];
}

export function hasPositiveFeedback(text: string): boolean {
  const tail = normalizeTail(text);
  return POSITIVE_FEEDBACK_PATTERNS.some((pattern) => pattern.test(tail));
}

export function hasConfusionFeedback(text: string): boolean {
  const tail = normalizeTail(text);
  return CONFUSION_PATTERNS.some((pattern) => pattern.test(tail));
}

export function hasNextStepConfusion(text: string): boolean {
  const tail = normalizeTail(text);
  return NEXT_STEP_CONFUSION_PATTERNS.some((pattern) => pattern.test(tail));
}

export function hasNoMoreToAdd(text: string): boolean {
  const tail = normalizeTail(text);
  return NO_MORE_PATTERNS.some((pattern) => pattern.test(tail));
}

const EXPECTATION_PROBES = [
  "What did you expect would happen there, and why?",
  "What outcome were you expecting at that moment?",
  "Before you clicked that, what did you think would happen next?",
  "What result made the most sense to you there?",
];

const POSITIVE_PROBES = [
  "Can you tell me more about what you liked about that?",
  "Can you tell me more about why that was interesting to you?",
  "What specifically worked well for you there?",
  "What stood out as especially useful in that part?",
];

const CONFUSION_PROBES = [
  "I heard you say you were confused. Is there any more detail you wanted to share about that?",
  "What part feels most unclear right now?",
  "Can you walk me through what felt confusing in that step?",
];

const NEXT_STEP_CONFUSION_PROBES = [
  "Are you not sure what to do next? What do you think the next step should be?",
  "It sounds like you're unsure about the next step. What would you expect to do next?",
];

export function buildExpectationProbe(lastPrompt = ""): string {
  return pickVariation(EXPECTATION_PROBES, lastPrompt);
}

export function buildPositiveProbe(lastPrompt = ""): string {
  return pickVariation(POSITIVE_PROBES, lastPrompt);
}

export function buildConfusionProbe(transcriptTail: string, lastPrompt = ""): string {
  if (hasNextStepConfusion(transcriptTail)) {
    return pickVariation(NEXT_STEP_CONFUSION_PROBES, lastPrompt);
  }
  return pickVariation(CONFUSION_PROBES, lastPrompt);
}
