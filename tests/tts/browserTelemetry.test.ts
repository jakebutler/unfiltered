import { afterEach, describe, expect, it } from "vitest";
import { speak } from "@/lib/tts";

type MockMode = "start_then_end" | "error_only";

class MockUtterance {
  text: string;
  rate = 1;
  pitch = 1;
  voice: SpeechSynthesisVoice | null = null;
  onstart: ((ev: SpeechSynthesisEvent) => void) | null = null;
  onerror: ((ev: SpeechSynthesisErrorEvent) => void) | null = null;
  onend: ((ev: SpeechSynthesisEvent) => void) | null = null;

  constructor(text: string) {
    this.text = text;
  }
}

const originalWindow = globalThis.window;
const OriginalUtterance = globalThis.SpeechSynthesisUtterance;
const originalProvider = process.env.NEXT_PUBLIC_INTERVIEWER_TTS_PROVIDER;

function installSpeechSynthesisMock(mode: MockMode) {
  const mockSpeechSynthesis = {
    cancel: () => undefined,
    getVoices: () => [{ name: "Test Voice", lang: "en-US" }] as SpeechSynthesisVoice[],
    speak: (utterance: MockUtterance) => {
      if (mode === "error_only") {
        utterance.onerror?.({} as SpeechSynthesisErrorEvent);
        return;
      }
      utterance.onstart?.({} as SpeechSynthesisEvent);
      utterance.onend?.({} as SpeechSynthesisEvent);
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };

  Object.defineProperty(globalThis, "window", {
    value: {
      speechSynthesis: mockSpeechSynthesis,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
    value: MockUtterance,
    configurable: true,
  });
}

afterEach(() => {
  if (typeof originalProvider === "string") {
    process.env.NEXT_PUBLIC_INTERVIEWER_TTS_PROVIDER = originalProvider;
  } else {
    delete process.env.NEXT_PUBLIC_INTERVIEWER_TTS_PROVIDER;
  }
  Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true });
  Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
    value: OriginalUtterance,
    configurable: true,
  });
});

describe("browser TTS telemetry", () => {
  it("emits first-audio-byte only when speech playback starts", async () => {
    process.env.NEXT_PUBLIC_INTERVIEWER_TTS_PROVIDER = "browser";
    installSpeechSynthesisMock("start_then_end");

    const stages: string[] = [];
    await new Promise<void>((resolve) => {
      speak(
        "hello world",
        undefined,
        () => resolve(),
        { onTelemetry: (event) => stages.push(event.stage) },
      );
    });

    expect(stages).toContain("tts_request_start");
    expect(stages).toContain("tts_first_audio_byte");
    expect(stages).toContain("audio_play_start");
  });

  it("does not emit first-audio-byte when browser speech errors before start", async () => {
    process.env.NEXT_PUBLIC_INTERVIEWER_TTS_PROVIDER = "browser";
    installSpeechSynthesisMock("error_only");

    const stages: string[] = [];
    await new Promise<void>((resolve) => {
      speak(
        "hello world",
        undefined,
        () => resolve(),
        { onTelemetry: (event) => stages.push(event.stage) },
      );
    });

    expect(stages).toContain("tts_request_start");
    expect(stages).not.toContain("tts_first_audio_byte");
  });
});
