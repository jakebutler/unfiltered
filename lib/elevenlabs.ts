export interface ElevenLabsVoiceSettings {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
}

export type VoiceStyleProfile =
  | "default"
  | "intro"
  | "instruction"
  | "followup"
  | "empathy"
  | "transition";

export interface ElevenLabsRequestConfig {
  voiceId: string;
  modelId: string;
  outputFormat: string;
  styleProfile: VoiceStyleProfile;
  body: {
    text: string;
    model_id: string;
    voice_settings: ElevenLabsVoiceSettings;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function readNumber(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, min, max);
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return fallback;
}

const VOICE_STYLE_OVERRIDES: Record<VoiceStyleProfile, Partial<ElevenLabsVoiceSettings>> = {
  default: {},
  intro: { stability: 0.42, similarity_boost: 0.8, style: 0.32 },
  instruction: { stability: 0.68, similarity_boost: 0.74, style: 0.08 },
  followup: { stability: 0.5, similarity_boost: 0.78, style: 0.24 },
  empathy: { stability: 0.44, similarity_boost: 0.84, style: 0.42 },
  transition: { stability: 0.58, similarity_boost: 0.76, style: 0.16 },
};

export function normalizeVoiceStyleProfile(rawValue?: string): VoiceStyleProfile {
  const value = rawValue?.trim().toLowerCase();
  if (
    value === "default" ||
    value === "intro" ||
    value === "instruction" ||
    value === "followup" ||
    value === "empathy" ||
    value === "transition"
  ) {
    return value;
  }
  return "default";
}

export function resolveVoiceSettingsForProfile(
  profile: VoiceStyleProfile,
  env: Record<string, string | undefined>,
): ElevenLabsVoiceSettings {
  const base: ElevenLabsVoiceSettings = {
    stability: readNumber(env.ELEVENLABS_STABILITY, 0.45, 0, 1),
    similarity_boost: readNumber(env.ELEVENLABS_SIMILARITY_BOOST, 0.75, 0, 1),
    style: readNumber(env.ELEVENLABS_STYLE, 0.2, 0, 1),
    use_speaker_boost: readBoolean(env.ELEVENLABS_USE_SPEAKER_BOOST, true),
  };

  const override = VOICE_STYLE_OVERRIDES[profile];
  return {
    ...base,
    ...override,
  };
}

export function normalizeSpeechText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function buildElevenLabsRequestConfig(
  text: string,
  env: Record<string, string | undefined>,
  profile: VoiceStyleProfile = "default",
): ElevenLabsRequestConfig {
  const voiceId = env.ELEVENLABS_VOICE_ID?.trim();
  if (!voiceId) {
    throw new Error("ELEVENLABS_VOICE_ID is not set");
  }

  const modelId = env.ELEVENLABS_MODEL_ID?.trim() || "eleven_multilingual_v2";
  const outputFormat = env.ELEVENLABS_OUTPUT_FORMAT?.trim() || "mp3_44100_128";
  const normalizedText = normalizeSpeechText(text);
  const styleProfile = normalizeVoiceStyleProfile(profile);

  return {
    voiceId,
    modelId,
    outputFormat,
    styleProfile,
    body: {
      text: normalizedText,
      model_id: modelId,
      voice_settings: resolveVoiceSettingsForProfile(styleProfile, env),
    },
  };
}
