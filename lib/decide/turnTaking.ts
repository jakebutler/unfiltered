import type { Action } from "@/lib/decide/types";

export const DEFAULT_MIN_PARTICIPANT_SILENCE_MS = 4000;
export const DEFAULT_MIN_PROMPT_GAP_MS = 14000;
export const DEFAULT_INTERRUPTION_ACK_COOLDOWN_MS = 12000;
const MIN_PARTICIPANT_WORDS_FOR_INTERRUPTION = 2;

interface ThrottlePromptInput {
  nowMs: number;
  lastPromptAtMs: number;
  lastParticipantSpeechAtMs: number;
  action: Action;
  minParticipantSilenceMs?: number;
  minPromptGapMs?: number;
}

export function shouldThrottleInterviewerPrompt(input: ThrottlePromptInput): boolean {
  if (input.action === "move_to_next_task") return false;
  return computePromptDelayMs(input) > 0;
}

export function computePromptDelayMs(input: ThrottlePromptInput): number {
  if (input.action === "move_to_next_task") return 0;
  const silenceMs = input.nowMs - input.lastParticipantSpeechAtMs;
  const promptGapMs = input.nowMs - input.lastPromptAtMs;
  const minParticipantSilenceMs = input.minParticipantSilenceMs ?? DEFAULT_MIN_PARTICIPANT_SILENCE_MS;
  const minPromptGapMs = input.minPromptGapMs ?? DEFAULT_MIN_PROMPT_GAP_MS;
  const silenceDelayMs = Math.max(0, minParticipantSilenceMs - silenceMs);
  const promptGapDelayMs = Math.max(0, minPromptGapMs - promptGapMs);
  return Math.max(silenceDelayMs, promptGapDelayMs);
}

interface AcknowledgeInterruptionInput {
  isInterviewerSpeaking: boolean;
  participantWordCount: number;
  nowMs: number;
  lastInterruptionAckAtMs: number;
  cooldownMs?: number;
}

export function shouldAcknowledgeInterruption(input: AcknowledgeInterruptionInput): boolean {
  if (!input.isInterviewerSpeaking) return false;
  if (input.participantWordCount < MIN_PARTICIPANT_WORDS_FOR_INTERRUPTION) return false;

  const cooldownMs = input.cooldownMs ?? DEFAULT_INTERRUPTION_ACK_COOLDOWN_MS;
  return input.nowMs - input.lastInterruptionAckAtMs >= cooldownMs;
}
