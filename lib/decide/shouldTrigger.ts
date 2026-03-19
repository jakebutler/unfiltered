import type { SignalResult } from "@/lib/signals/extractor";
import { hasConfusionFeedback, hasNoMoreToAdd, hasPositiveFeedback } from "@/lib/decide/transcriptHeuristics";

export function shouldTriggerDecide(
  signals: SignalResult,
  friction0to100: number,
  transcriptTail = "",
): boolean {
  return (
    friction0to100 >= 40 ||
    signals.negAffectCount >= 1 ||
    signals.explicitUncertaintyCount >= 1 ||
    signals.clarificationCount >= 1 ||
    signals.repeatAttemptLoopFlag ||
    hasConfusionFeedback(transcriptTail) ||
    hasPositiveFeedback(transcriptTail) ||
    hasNoMoreToAdd(transcriptTail)
  );
}
