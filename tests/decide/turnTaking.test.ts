import { describe, expect, it } from "vitest";
import {
  computePromptDelayMs,
  DEFAULT_INTERRUPTION_ACK_COOLDOWN_MS,
  DEFAULT_MIN_PARTICIPANT_SILENCE_MS,
  shouldAcknowledgeInterruption,
  shouldThrottleInterviewerPrompt,
} from "@/lib/decide/turnTaking";

describe("turnTaking", () => {
  it("throttles follow-up prompts when participant has not been silent long enough", () => {
    expect(
      shouldThrottleInterviewerPrompt({
        nowMs: 10_000,
        lastPromptAtMs: 0,
        lastParticipantSpeechAtMs: 8_000,
        action: "ask_followup",
      }),
    ).toBe(true);
  });

  it("does not throttle move-to-next-task action for cadence alone", () => {
    expect(
      shouldThrottleInterviewerPrompt({
        nowMs: 10_000,
        lastPromptAtMs: 9_000,
        lastParticipantSpeechAtMs: 9_500,
        action: "move_to_next_task",
      }),
    ).toBe(false);
  });

  it("acknowledges interruption when participant speaks while interviewer is speaking", () => {
    expect(
      shouldAcknowledgeInterruption({
        isInterviewerSpeaking: true,
        participantWordCount: 3,
        nowMs: 30_000,
        lastInterruptionAckAtMs: 0,
      }),
    ).toBe(true);
  });

  it("skips interruption acknowledgment during cooldown", () => {
    expect(
      shouldAcknowledgeInterruption({
        isInterviewerSpeaking: true,
        participantWordCount: 4,
        nowMs: 30_000,
        lastInterruptionAckAtMs: 30_000 - DEFAULT_INTERRUPTION_ACK_COOLDOWN_MS + 1000,
      }),
    ).toBe(false);
  });

  it("exports default timing constants with conservative values", () => {
    expect(DEFAULT_MIN_PARTICIPANT_SILENCE_MS).toBeGreaterThanOrEqual(3000);
    expect(DEFAULT_INTERRUPTION_ACK_COOLDOWN_MS).toBeGreaterThanOrEqual(8000);
  });

  it("computes remaining delay based on silence and prompt gap requirements", () => {
    const delayMs = computePromptDelayMs({
      nowMs: 20_000,
      lastPromptAtMs: 12_000,
      lastParticipantSpeechAtMs: 18_000,
      action: "ask_followup",
      minParticipantSilenceMs: 4_000,
      minPromptGapMs: 14_000,
    });
    expect(delayMs).toBe(6_000);
  });

  it("returns zero delay when cadence requirements are already satisfied", () => {
    const delayMs = computePromptDelayMs({
      nowMs: 30_000,
      lastPromptAtMs: 10_000,
      lastParticipantSpeechAtMs: 20_000,
      action: "ask_followup",
    });
    expect(delayMs).toBe(0);
  });
});
