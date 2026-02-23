export const LATENCY_STAGES = [
  "participant_last_word_end",
  "decide_trigger",
  "policy_start",
  "policy_end",
  "prompt_selected",
  "tts_request_start",
  "tts_first_audio_byte",
  "audio_play_start",
  "timing_config_resolved",
] as const;

export type LatencyStage = (typeof LATENCY_STAGES)[number];
