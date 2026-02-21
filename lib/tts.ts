import type { VoiceStyleProfile } from "@/lib/elevenlabs";

type VoiceCandidate = Pick<SpeechSynthesisVoice, "name" | "lang" | "localService" | "default">;
export type TtsProvider = "auto" | "elevenlabs" | "browser";
export interface SpeakOptions {
  styleProfile?: VoiceStyleProfile;
}

const NATURAL_VOICE_MARKERS = [
  "neural",
  "natural",
  "premium",
  "studio",
  "wavenet",
  "journey",
  "enhanced",
  "samantha",
  "alloy",
  "nova",
  "aria",
  "jenny",
  "rachel",
  "serena",
];

const ROBOTIC_VOICE_MARKERS = ["espeak", "robot", "compact", "legacy"];

let activeSpeechToken = 0;
let activeAudio: HTMLAudioElement | null = null;
let activeAudioUrl: string | null = null;
const STYLE_TWEAKS: Record<VoiceStyleProfile, { rateDelta: number; pitchDelta: number; pauseDeltaMs: number }> = {
  default: { rateDelta: 0, pitchDelta: 0, pauseDeltaMs: 0 },
  intro: { rateDelta: -0.04, pitchDelta: 0.02, pauseDeltaMs: 20 },
  instruction: { rateDelta: -0.08, pitchDelta: -0.02, pauseDeltaMs: 50 },
  followup: { rateDelta: -0.02, pitchDelta: 0.01, pauseDeltaMs: 15 },
  empathy: { rateDelta: -0.06, pitchDelta: 0.03, pauseDeltaMs: 40 },
  transition: { rateDelta: 0.03, pitchDelta: 0.01, pauseDeltaMs: 10 },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function readNumericEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, min, max);
}

export function normalizeTtsProvider(rawValue?: string): TtsProvider {
  const value = rawValue?.trim().toLowerCase();
  if (value === "browser" || value === "elevenlabs" || value === "auto") {
    return value;
  }
  return "auto";
}

export function shouldFallbackToBrowser(provider: TtsProvider): boolean {
  return provider === "browser";
}

function scoreVoice(voice: VoiceCandidate, preferredVoiceName?: string): number {
  const name = voice.name.toLowerCase();
  const preferred = preferredVoiceName?.trim().toLowerCase();
  let score = 0;

  if (preferred) {
    if (name === preferred) score += 1200;
    else if (name.includes(preferred)) score += 700;
  }

  if (voice.lang === "en-US") score += 260;
  else if (voice.lang.toLowerCase().startsWith("en-")) score += 190;

  if (NATURAL_VOICE_MARKERS.some((marker) => name.includes(marker))) score += 280;
  if (ROBOTIC_VOICE_MARKERS.some((marker) => name.includes(marker))) score -= 450;

  if (voice.default) score += 30;
  if (voice.localService === false) score += 40;

  return score;
}

export function pickPreferredVoice(
  voices: SpeechSynthesisVoice[],
  preferredVoiceName?: string,
): SpeechSynthesisVoice | undefined {
  if (!voices.length) return undefined;
  const scored = voices
    .map((voice) => ({ voice, score: scoreVoice(voice, preferredVoiceName) }))
    .sort((a, b) => b.score - a.score);
  return scored[0]?.voice;
}

function splitChunkByWords(text: string, maxChunkLength: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChunkLength) {
      current = next;
      continue;
    }
    if (current) chunks.push(current);
    current = word;
  }

  if (current) chunks.push(current);
  return chunks;
}

export async function runSequentially<TInput, TOutput>(
  items: TInput[],
  worker: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  const output: TOutput[] = [];
  for (let index = 0; index < items.length; index += 1) {
    output.push(await worker(items[index], index));
  }
  return output;
}

export function splitSpeechIntoChunks(text: string, maxChunkLength = 140): string[] {
  const normalized = normalizeTextForSpeech(text);
  if (!normalized) return [];
  const safeMax = Math.max(40, maxChunkLength);
  const sentenceParts = normalized.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = "";

  const pushPart = (part: string) => {
    const trimmed = part.trim();
    if (!trimmed) return;

    if (trimmed.length > safeMax) {
      const brokenByWords = splitChunkByWords(trimmed, safeMax);
      for (const wordChunk of brokenByWords) pushPart(wordChunk);
      return;
    }

    const next = current ? `${current} ${trimmed}` : trimmed;
    if (next.length <= safeMax) {
      current = next;
      return;
    }

    if (current) chunks.push(current);
    current = trimmed;
  };

  for (const sentence of sentenceParts) {
    if (sentence.length <= safeMax) {
      pushPart(sentence);
      continue;
    }
    for (const clause of sentence.split(/(?<=[,;:])\s+/)) pushPart(clause);
  }

  if (current) chunks.push(current);
  return chunks;
}

function clearActiveAudio(): void {
  if (activeAudio) {
    activeAudio.onended = null;
    activeAudio.onerror = null;
    activeAudio.onplay = null;
    activeAudio.pause();
    activeAudio.src = "";
    activeAudio.load();
    activeAudio = null;
  }
  if (activeAudioUrl) {
    URL.revokeObjectURL(activeAudioUrl);
    activeAudioUrl = null;
  }
}

export function normalizeTextForSpeech(text: string): string {
  return text
    .replace(/\s*[—–]\s*/g, ". ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/([.!?])(?=[^\s])/g, "$1 ")
    .replace(/([.!?]\s+)([a-z])/g, (_match, punctuation, letter: string) => `${punctuation}${letter.toUpperCase()}`)
    .trim();
}

async function speakWithElevenLabs(
  text: string,
  speechToken: number,
  onStart?: () => void,
  onEnd?: () => void,
  options?: SpeakOptions,
): Promise<boolean> {
  if (typeof window === "undefined") return false;

  const normalizedText = normalizeTextForSpeech(text);
  if (!normalizedText) return false;
  const styleProfile = options?.styleProfile ?? "default";
  const chunkLength = readNumericEnv("NEXT_PUBLIC_INTERVIEWER_ELEVENLABS_CHUNK_LENGTH", 110, 60, 220);
  const basePauseMs = readNumericEnv("NEXT_PUBLIC_INTERVIEWER_ELEVENLABS_PAUSE_MS", 130, 0, 500);
  const pauseMs = clamp(basePauseMs + STYLE_TWEAKS[styleProfile].pauseDeltaMs, 0, 600);
  const chunks = splitSpeechIntoChunks(normalizedText, chunkLength);
  if (!chunks.length) return false;

  const blobs = await runSequentially(chunks, async (chunk) => {
    const maxAttempts = 3;
    let attempt = 0;
    while (attempt < maxAttempts) {
      attempt += 1;

      let response: Response;
      try {
        response = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: chunk,
            profile: styleProfile,
          }),
        });
      } catch {
        return null;
      }

      if (response.ok) {
        try {
          const blob = await response.blob();
          return blob.size ? blob : null;
        } catch {
          return null;
        }
      }

      let detail = "";
      try {
        detail = await response.text();
      } catch {
        detail = "";
      }

      const isConcurrencyLimit =
        detail.includes("concurrent_limit_exceeded") || detail.includes("rate_limit_error");
      if (!isConcurrencyLimit || attempt >= maxAttempts) {
        console.warn(`[TTS] ElevenLabs chunk request failed status=${response.status} attempt=${attempt}`);
        return null;
      }

      await new Promise((resolve) => window.setTimeout(resolve, 220 * attempt));
    }

    return null;
  });
  if (blobs.some((blob) => !blob)) return false;
  if (speechToken !== activeSpeechToken) return true;

  let started = false;
  const playbackRate = readNumericEnv("NEXT_PUBLIC_INTERVIEWER_AUDIO_PLAYBACK_RATE", 1, 0.85, 1.15);
  for (let index = 0; index < blobs.length; index += 1) {
    if (speechToken !== activeSpeechToken) return true;
    const blob = blobs[index];
    if (!blob) return false;

    const played = await new Promise<boolean>((resolve) => {
      clearActiveAudio();
      const objectUrl = URL.createObjectURL(blob);
      const audio = new Audio(objectUrl);
      audio.preload = "auto";
      audio.playbackRate = playbackRate;
      activeAudio = audio;
      activeAudioUrl = objectUrl;
      let settled = false;

      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (activeAudio === audio) activeAudio = null;
        if (activeAudioUrl === objectUrl) {
          URL.revokeObjectURL(objectUrl);
          activeAudioUrl = null;
        }
        audio.onended = null;
        audio.onerror = null;
        audio.onplay = null;
        resolve(ok);
      };

      audio.onplay = () => {
        if (speechToken !== activeSpeechToken || started) return;
        started = true;
        onStart?.();
      };

      audio.onended = () => finish(true);
      audio.onerror = () => finish(false);

      void audio.play().catch(() => {
        finish(false);
      });
    });

    if (!played) return false;
    if (index < blobs.length - 1 && pauseMs > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, pauseMs));
      if (speechToken !== activeSpeechToken) return true;
    }
  }

  if (speechToken === activeSpeechToken) {
    onEnd?.();
  }
  return true;
}

function speakWithBrowserVoices(
  text: string,
  speechToken: number,
  onStart?: () => void,
  onEnd?: () => void,
  options?: SpeakOptions,
): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    onEnd?.();
    return;
  }

  const synth = window.speechSynthesis;
  const chunks = splitSpeechIntoChunks(text);
  if (!chunks.length) {
    onEnd?.();
    return;
  }

  const preferredVoiceName = process.env.NEXT_PUBLIC_INTERVIEWER_VOICE_NAME;
  const baseRate = readNumericEnv("NEXT_PUBLIC_INTERVIEWER_VOICE_RATE", 0.9, 0.75, 1.05);
  const basePitch = readNumericEnv("NEXT_PUBLIC_INTERVIEWER_VOICE_PITCH", 1.0, 0.85, 1.15);
  const basePauseMs = readNumericEnv("NEXT_PUBLIC_INTERVIEWER_VOICE_PAUSE_MS", 70, 0, 300);
  const styleProfile = options?.styleProfile ?? "default";

  const tweak = STYLE_TWEAKS[styleProfile];
  const rate = clamp(baseRate + tweak.rateDelta, 0.75, 1.1);
  const pitch = clamp(basePitch + tweak.pitchDelta, 0.85, 1.2);
  const pauseMs = clamp(basePauseMs + tweak.pauseDeltaMs, 0, 350);

  const beginSpeaking = () => {
    const voice = pickPreferredVoice(synth.getVoices(), preferredVoiceName);
    let chunkIndex = 0;
    let started = false;

    const speakNextChunk = () => {
      if (speechToken !== activeSpeechToken) return;
      if (chunkIndex >= chunks.length) {
        onEnd?.();
        return;
      }

      const utterance = new SpeechSynthesisUtterance(chunks[chunkIndex]);
      utterance.rate = rate;
      utterance.pitch = pitch;
      if (voice) utterance.voice = voice;

      utterance.onstart = () => {
        if (started) return;
        started = true;
        onStart?.();
      };

      utterance.onerror = () => {
        if (speechToken !== activeSpeechToken) return;
        activeSpeechToken += 1;
        onEnd?.();
      };

      utterance.onend = () => {
        if (speechToken !== activeSpeechToken) return;
        chunkIndex += 1;
        if (chunkIndex < chunks.length) {
          window.setTimeout(speakNextChunk, pauseMs);
          return;
        }
        onEnd?.();
      };

      synth.speak(utterance);
    };

    speakNextChunk();
  };

  if (synth.getVoices().length > 0) {
    beginSpeaking();
    return;
  }

  let resolved = false;
  const resolveAndSpeak = () => {
    if (resolved) return;
    resolved = true;
    synth.removeEventListener("voiceschanged", resolveAndSpeak);
    beginSpeaking();
  };

  synth.addEventListener("voiceschanged", resolveAndSpeak);
  window.setTimeout(resolveAndSpeak, 250);
}

export function speak(text: string, onStart?: () => void, onEnd?: () => void, options?: SpeakOptions): void {
  void (async () => {
    if (typeof window === "undefined") {
      onEnd?.();
      return;
    }

    const speechToken = ++activeSpeechToken;
    clearActiveAudio();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();

    const provider = normalizeTtsProvider(process.env.NEXT_PUBLIC_INTERVIEWER_TTS_PROVIDER);
    const shouldTryElevenLabs = provider === "auto" || provider === "elevenlabs";

    if (shouldTryElevenLabs) {
      const played = await speakWithElevenLabs(text, speechToken, onStart, onEnd, options);
      if (played || speechToken !== activeSpeechToken) return;
      console.warn("[TTS] ElevenLabs playback failed; browser fallback is disabled.");
      onEnd?.();
      return;
    }

    if (speechToken !== activeSpeechToken) return;
    if (!shouldFallbackToBrowser(provider)) {
      onEnd?.();
      return;
    }
    speakWithBrowserVoices(text, speechToken, onStart, onEnd, options);
  })();
}
