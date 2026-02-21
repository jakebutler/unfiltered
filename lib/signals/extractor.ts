export interface Word {
  text: string;
  startTime: number;
  duration: number;
}

export interface SignalResult {
  filledPausePer100w: number;
  hedgesPer100w: number;
  explicitUncertaintyCount: number;
  longPauseCount: number;
  veryLongPauseCount: number;
  pauseTimeRatio: number;
  repairsPer100w: number;
  repetitionsPer100w: number;
  clarificationCount: number;
  negAffectCount: number;
  clarityIndex: number;
  backtrackCount: number;
  repeatAttemptLoopFlag: boolean;
}

const FILLED_PAUSES = new Set(["uh", "um", "er", "erm", "uhm", "umm"]);

const HEDGE_PHRASES = ["maybe", "probably", "i think", "i guess", "kind of", "sort of", "not really"];

const UNCERTAINTY_PHRASES = [
  "i don't know", "i dont know", "not sure", "no idea",
  "can't tell", "cant tell", "i'm confused", "im confused", "i don't understand", "i dont understand",
  "confusing", "unclear", "not clear", "doesn't make sense", "doesnt make sense", "i'm lost", "im lost",
];

const REPAIR_MARKERS = ["wait", "actually", "i mean", "sorry", "let me rephrase"];

const CLARIFICATION_PHRASES = [
  "what do you mean", "huh", "can you repeat", "which one",
  "where is", "what was the task",
];

const NEG_AFFECT_PHRASES = [
  "annoying", "frustrating", "hate", "angry",
  "doesn't work", "doesnt work", "broken", "stuck", "won't let me", "wont let me",
];

const CONFIRM_WORDS = new Set([
  "got", "okay", "ok", "right", "yes", "yep", "yup", "sure",
]);

const CERTAINTY_WORDS = new Set(["definitely", "exactly", "clearly", "absolutely", "obviously"]);

const BACKTRACK_PHRASES = ["back", "go back", "undo", "cancel", "start over", "try again"];

const ACTION_VERBS = new Set(["click", "tap", "press", "submit", "open", "select", "scroll", "search", "type"]);

function countPhrase(text: string, phrases: string[]): number {
  return phrases.reduce((acc, p) => acc + (text.includes(p) ? 1 : 0), 0);
}

export function extractSignals(words: Word[], windowSec: number): SignalResult {
  if (words.length === 0) {
    return {
      filledPausePer100w: 0, hedgesPer100w: 0, explicitUncertaintyCount: 0,
      longPauseCount: 0, veryLongPauseCount: 0, pauseTimeRatio: 0,
      repairsPer100w: 0, repetitionsPer100w: 0, clarificationCount: 0,
      negAffectCount: 0, clarityIndex: 0, backtrackCount: 0,
      repeatAttemptLoopFlag: false,
    };
  }

  const tokens = words.map((w) => w.text.toLowerCase().replace(/[^a-z']/g, ""));
  const wordCount = Math.max(1, tokens.length);
  const text = tokens.join(" ");

  // 1. Filled pauses
  const filledPauseCount = tokens.filter((t) => FILLED_PAUSES.has(t)).length;
  const filledPausePer100w = (100 * filledPauseCount) / wordCount;

  // 2. Hedges
  const hedgeCount = countPhrase(text, HEDGE_PHRASES);
  const hedgesPer100w = (100 * hedgeCount) / wordCount;

  // 3. Explicit uncertainty
  const explicitUncertaintyCount = countPhrase(text, UNCERTAINTY_PHRASES);

  // 4. Silent pauses
  let longPauseCount = 0;
  let veryLongPauseCount = 0;
  let pauseTimeTotal = 0;
  for (let i = 1; i < words.length; i++) {
    const prevEnd = words[i - 1].startTime + words[i - 1].duration;
    const gap = words[i].startTime - prevEnd;
    if (gap >= 0.25) pauseTimeTotal += gap;
    if (gap >= 1.5) longPauseCount++;
    if (gap >= 3.0) veryLongPauseCount++;
  }
  const pauseTimeRatio = windowSec > 0 ? pauseTimeTotal / windowSec : 0;

  // 5. Self-repairs
  const repairCount = countPhrase(text, REPAIR_MARKERS);
  const repairsPer100w = (100 * repairCount) / wordCount;

  // 6. Repetitions / false starts (same token within 0.3s)
  let repetitionCount = 0;
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].startTime - (words[i - 1].startTime + words[i - 1].duration);
    if (tokens[i] === tokens[i - 1] && gap <= 0.3) repetitionCount++;
  }
  const repetitionsPer100w = (100 * repetitionCount) / wordCount;

  // 7. Clarification initiators
  const clarificationCount = countPhrase(text, CLARIFICATION_PHRASES);

  // 8. Negative affect
  const negAffectCount = countPhrase(text, NEG_AFFECT_PHRASES);

  // 9. Clarity index
  const confirmCount = tokens.filter((t) => CONFIRM_WORDS.has(t)).length;
  const certaintyCount = tokens.filter((t) => CERTAINTY_WORDS.has(t)).length;
  const clarityIndex = confirmCount + certaintyCount - hedgeCount;

  // 10. Backtracking
  const backtrackCount = countPhrase(text, BACKTRACK_PHRASES);

  // 11. Repeat attempt loops — action verb appears 2+ times within window
  const actionTimestamps: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (ACTION_VERBS.has(tokens[i])) actionTimestamps.push(words[i].startTime);
  }
  let repeatAttemptLoopFlag = false;
  for (let i = 1; i < actionTimestamps.length; i++) {
    if (actionTimestamps[i] - actionTimestamps[0] <= 15 && actionTimestamps.length >= 2) {
      repeatAttemptLoopFlag = true;
      break;
    }
  }

  return {
    filledPausePer100w, hedgesPer100w, explicitUncertaintyCount,
    longPauseCount, veryLongPauseCount, pauseTimeRatio,
    repairsPer100w, repetitionsPer100w, clarificationCount,
    negAffectCount, clarityIndex, backtrackCount, repeatAttemptLoopFlag,
  };
}
