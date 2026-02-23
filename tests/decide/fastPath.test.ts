import { describe, expect, it } from "vitest";
import { shouldUseDeterministicFastPath } from "@/lib/decide/fastPath";
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

describe("shouldUseDeterministicFastPath", () => {
  it("returns true for explicit uncertainty", () => {
    expect(shouldUseDeterministicFastPath({ ...baseSignals, explicitUncertaintyCount: 1 }, "")).toBe(true);
  });

  it("returns true for clarification cues", () => {
    expect(shouldUseDeterministicFastPath({ ...baseSignals, clarificationCount: 1 }, "")).toBe(true);
  });

  it("returns true for negative affect", () => {
    expect(shouldUseDeterministicFastPath({ ...baseSignals, negAffectCount: 1 }, "")).toBe(true);
  });

  it("returns true for confusion language in transcript tail", () => {
    expect(shouldUseDeterministicFastPath(baseSignals, "this is confusing")).toBe(true);
  });

  it("returns false for neutral signals", () => {
    expect(shouldUseDeterministicFastPath(baseSignals, "looks good")).toBe(false);
  });
});
