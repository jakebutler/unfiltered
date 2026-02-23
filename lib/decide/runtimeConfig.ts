import {
  DEFAULT_INTERRUPTION_ACK_COOLDOWN_MS,
  DEFAULT_MIN_PARTICIPANT_SILENCE_MS,
  DEFAULT_MIN_PROMPT_GAP_MS,
} from "@/lib/decide/turnTaking";

type EnvMap = Record<string, string | undefined>;

export interface ResolvedTimingConfig {
  minParticipantSilenceMs: number;
  minPromptGapMs: number;
  interruptionAckCooldownMs: number;
}

export interface TimingResolution {
  values: ResolvedTimingConfig;
  warnings: string[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function readNumericEnv(
  env: EnvMap,
  key: string,
  fallback: number,
  min: number,
  max: number,
  warnings: string[],
): number {
  const raw = env[key];
  if (!raw) {
    warnings.push(`${key}: missing; using fallback ${fallback}`);
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    warnings.push(`${key}: invalid value "${raw}"; using fallback ${fallback}`);
    return fallback;
  }
  const clamped = clamp(parsed, min, max);
  if (clamped !== parsed) {
    warnings.push(`${key}: clamped ${parsed} -> ${clamped}`);
  }
  return clamped;
}

export function resolveTimingConfig(env: EnvMap): TimingResolution {
  const warnings: string[] = [];
  const values: ResolvedTimingConfig = {
    minParticipantSilenceMs: readNumericEnv(
      env,
      "NEXT_PUBLIC_INTERVIEWER_MIN_PARTICIPANT_SILENCE_MS",
      DEFAULT_MIN_PARTICIPANT_SILENCE_MS,
      1000,
      15000,
      warnings,
    ),
    minPromptGapMs: readNumericEnv(
      env,
      "NEXT_PUBLIC_INTERVIEWER_MIN_PROMPT_GAP_MS",
      DEFAULT_MIN_PROMPT_GAP_MS,
      1000,
      30000,
      warnings,
    ),
    interruptionAckCooldownMs: readNumericEnv(
      env,
      "NEXT_PUBLIC_INTERVIEWER_INTERRUPTION_ACK_COOLDOWN_MS",
      DEFAULT_INTERRUPTION_ACK_COOLDOWN_MS,
      4000,
      30000,
      warnings,
    ),
  };
  return { values, warnings };
}
