import { describe, expect, it } from "vitest";
import { computeSpeechWindowBounds, computeWindowBounds, hasEnoughSpeech, selectWordsInWindow } from "@/lib/signals/windowing";

type Word = { text: string; startTime: number; duration: number };

describe("signal windowing", () => {
  it("uses latest word end when transcript time is ahead of local session clock", () => {
    const words: Word[] = [
      { text: "hello", startTime: 18, duration: 0.3 },
      { text: "world", startTime: 20.5, duration: 0.4 },
    ];

    const bounds = computeWindowBounds({
      sessionElapsedSec: 12,
      words,
      windowSec: 15,
    });

    expect(bounds.windowEnd).toBeCloseTo(20.9, 3);
    expect(bounds.windowStart).toBeCloseTo(5.9, 3);
  });

  it("selects only words that fall inside the active window", () => {
    const words: Word[] = [
      { text: "a", startTime: 2, duration: 0.2 },
      { text: "b", startTime: 8, duration: 0.2 },
      { text: "c", startTime: 16, duration: 0.2 },
      { text: "d", startTime: 23, duration: 0.2 },
    ];

    const inWindow = selectWordsInWindow(words, 8, 20);
    expect(inWindow.map((w) => w.text)).toEqual(["b", "c"]);
  });

  it("anchors speech window to transcript clock when session clock drifts too far ahead", () => {
    const words: Word[] = [
      { text: "a", startTime: 8, duration: 0.2 },
      { text: "b", startTime: 11, duration: 0.2 },
      { text: "c", startTime: 14.5, duration: 0.2 },
    ];

    const bounds = computeSpeechWindowBounds({
      sessionElapsedSec: 32,
      words,
      windowSec: 15,
    });

    expect(bounds.windowEnd).toBeCloseTo(14.7, 3);
    expect(bounds.windowStart).toBeCloseTo(0, 3);
  });

  it("requires at least 3 words before signal extraction", () => {
    expect(hasEnoughSpeech([])).toBe(false);
    expect(hasEnoughSpeech([{ text: "a", startTime: 1, duration: 0.2 }])).toBe(false);
    expect(
      hasEnoughSpeech([
        { text: "a", startTime: 1, duration: 0.2 },
        { text: "b", startTime: 2, duration: 0.2 },
        { text: "c", startTime: 3, duration: 0.2 },
      ]),
    ).toBe(true);
  });
});
