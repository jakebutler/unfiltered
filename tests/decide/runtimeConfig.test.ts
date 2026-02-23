import { describe, expect, it } from "vitest";
import { resolveTimingConfig } from "@/lib/decide/runtimeConfig";

describe("resolveTimingConfig", () => {
  it("reads valid numeric values from env", () => {
    const { values, warnings } = resolveTimingConfig({
      NEXT_PUBLIC_INTERVIEWER_MIN_PARTICIPANT_SILENCE_MS: "1200",
      NEXT_PUBLIC_INTERVIEWER_MIN_PROMPT_GAP_MS: "1500",
      NEXT_PUBLIC_INTERVIEWER_INTERRUPTION_ACK_COOLDOWN_MS: "9000",
    });

    expect(values.minParticipantSilenceMs).toBe(1200);
    expect(values.minPromptGapMs).toBe(1500);
    expect(values.interruptionAckCooldownMs).toBe(9000);
    expect(warnings.length).toBe(0);
  });

  it("falls back with warnings when values are missing or invalid", () => {
    const { values, warnings } = resolveTimingConfig({
      NEXT_PUBLIC_INTERVIEWER_MIN_PARTICIPANT_SILENCE_MS: "oops",
      NEXT_PUBLIC_INTERVIEWER_MIN_PROMPT_GAP_MS: undefined,
      NEXT_PUBLIC_INTERVIEWER_INTERRUPTION_ACK_COOLDOWN_MS: "100000",
    });

    expect(values.minParticipantSilenceMs).toBeGreaterThanOrEqual(1000);
    expect(values.minPromptGapMs).toBeGreaterThanOrEqual(1000);
    expect(values.interruptionAckCooldownMs).toBeLessThanOrEqual(30000);
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });
});
