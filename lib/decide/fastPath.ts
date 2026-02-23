import { hasConfusionFeedback } from "@/lib/decide/transcriptHeuristics";
import type { SignalResult } from "@/lib/signals/extractor";

/**
 * High-priority friction cues should not wait on remote policy calls.
 * Use deterministic policy immediately for these cases.
 */
export function shouldUseDeterministicFastPath(signals: SignalResult, transcriptTail: string): boolean {
  return (
    signals.negAffectCount >= 1 ||
    signals.explicitUncertaintyCount >= 1 ||
    signals.clarificationCount >= 1 ||
    signals.repeatAttemptLoopFlag ||
    hasConfusionFeedback(transcriptTail)
  );
}
