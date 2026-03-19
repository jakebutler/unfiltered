import type { Word } from "./extractor";

export interface WindowBoundsInput {
  sessionElapsedSec: number;
  words: Word[];
  windowSec: number;
}

export interface WindowBounds {
  windowStart: number;
  windowEnd: number;
}

export interface SpeechWindowBoundsInput extends WindowBoundsInput {
  lagToleranceSec?: number;
}

/**
 * Keep window time aligned to whichever clock is farther ahead:
 * - local elapsed session time, or
 * - latest transcript word end-time
 */
export function computeWindowBounds(input: WindowBoundsInput): WindowBounds {
  const latestWordEnd = input.words.reduce((max, word) => {
    const duration = Number.isFinite(word.duration) ? word.duration : 0;
    return Math.max(max, word.startTime + duration);
  }, 0);
  const windowEnd = Math.max(input.sessionElapsedSec, latestWordEnd);
  const windowStart = Math.max(0, windowEnd - input.windowSec);
  return { windowStart, windowEnd };
}

/**
 * Speech providers can emit word timestamps on a clock that lags the local session timer.
 * If lag is large, anchor signal windows to transcript time so we don't miss all words.
 */
export function computeSpeechWindowBounds(input: SpeechWindowBoundsInput): WindowBounds {
  const base = computeWindowBounds(input);
  if (input.words.length === 0) return base;

  const latestWordEnd = input.words.reduce((max, word) => {
    const duration = Number.isFinite(word.duration) ? word.duration : 0;
    return Math.max(max, word.startTime + duration);
  }, 0);
  const lagToleranceSec = input.lagToleranceSec ?? input.windowSec;
  const lagSec = input.sessionElapsedSec - latestWordEnd;
  if (lagSec <= lagToleranceSec) return base;

  return {
    windowStart: Math.max(0, latestWordEnd - input.windowSec),
    windowEnd: latestWordEnd,
  };
}

export function selectWordsInWindow(words: Word[], windowStart: number, windowEnd: number): Word[] {
  return words.filter((word) => word.startTime >= windowStart && word.startTime < windowEnd);
}

export function hasEnoughSpeech(words: Word[], minWords = 3): boolean {
  return words.length >= minWords;
}
