import { describe, expect, it } from "vitest";
import { shouldTriggerDecide } from "@/lib/decide/shouldTrigger";
import type { SignalResult } from "@/lib/signals/extractor";

const baseSignals: SignalResult = {
  filledPausePer100w: 0,
  hedgesPer100w: 0,
  explicitUncertaintyCount: 0,
  longPauseCount: 0,
  veryLongPauseCount: 0,
  pauseTimeRatio: 0,
  repairsPer100w: 0,
  repetitionsPer100w: 0,
  clarificationCount: 0,
  negAffectCount: 0,
  clarityIndex: 0,
  backtrackCount: 0,
  repeatAttemptLoopFlag: false,
};

describe("shouldTriggerDecide", () => {
  it("returns false for low-friction windows without high-priority cues", () => {
    expect(shouldTriggerDecide(baseSignals, 20)).toBe(false);
  });

  it("returns true when clarification is detected even if friction is low", () => {
    expect(
      shouldTriggerDecide({ ...baseSignals, clarificationCount: 1 }, 20),
    ).toBe(true);
  });

  it("returns true when explicit uncertainty is detected", () => {
    expect(
      shouldTriggerDecide({ ...baseSignals, explicitUncertaintyCount: 1 }, 20),
    ).toBe(true);
  });
});
