import type { SignalResult } from "@/lib/signals/extractor";

export function shouldTriggerDecide(signals: SignalResult, friction0to100: number): boolean {
  return (
    friction0to100 >= 40 ||
    signals.negAffectCount >= 1 ||
    signals.explicitUncertaintyCount >= 1 ||
    signals.clarificationCount >= 1 ||
    signals.repeatAttemptLoopFlag
  );
}
