import { describe, it, expect } from 'vitest';
import { extractSignals } from '@/lib/signals/extractor';

const w = (text: string, startTime: number, duration = 0.3) => ({ text, startTime, duration });

describe('extractSignals', () => {
  it('counts filled pauses', () => {
    const words = [w('I', 0), w('uh', 0.5), w('um', 1.0), w('think', 1.5)];
    const result = extractSignals(words, 15);
    expect(result.filledPausePer100w).toBeGreaterThan(0);
  });

  it('counts explicit uncertainty phrases', () => {
    const words = "i don't know what to do".split(' ').map((t, i) => w(t, i * 0.5));
    const result = extractSignals(words, 15);
    expect(result.explicitUncertaintyCount).toBe(1);
  });

  it('counts adjective forms like confusing/unclear as explicit uncertainty', () => {
    const words = 'this is confusing and unclear'.split(' ').map((t, i) => w(t, i * 0.5));
    const result = extractSignals(words, 15);
    expect(result.explicitUncertaintyCount).toBeGreaterThanOrEqual(1);
  });

  it('detects long pauses from timestamp gaps', () => {
    const words = [w('okay', 0), w('so', 3.0), w('then', 3.5)]; // 2.7s gap between 'okay' and 'so'
    const result = extractSignals(words, 15);
    expect(result.longPauseCount).toBeGreaterThanOrEqual(1);
  });

  it('detects very long pauses (>=3.0s)', () => {
    const words = [w('hello', 0), w('world', 4.0)]; // 3.7s gap
    const result = extractSignals(words, 15);
    expect(result.veryLongPauseCount).toBe(1);
  });

  it('counts self-repair markers', () => {
    const words = "wait actually i mean the button".split(' ').map((t, i) => w(t, i * 0.4));
    const result = extractSignals(words, 15);
    expect(result.repairsPer100w).toBeGreaterThan(0);
  });

  it('detects repetitions within 0.3s gap', () => {
    const words = [w('click', 0, 0.2), w('click', 0.25, 0.2), w('the', 0.5, 0.2)];
    const result = extractSignals(words, 15);
    expect(result.repetitionsPer100w).toBeGreaterThan(0);
  });

  it('counts negative affect phrases', () => {
    const words = "this is so frustrating it doesn't work".split(' ').map((t, i) => w(t, i * 0.4));
    const result = extractSignals(words, 15);
    expect(result.negAffectCount).toBeGreaterThan(0);
  });

  it('flags repeat attempt loops', () => {
    const words = [w('click', 0, 0.2), w('click', 5.0, 0.2), w('click', 8.0, 0.2)];
    const result = extractSignals(words, 15);
    expect(result.repeatAttemptLoopFlag).toBe(true);
  });

  it('counts backtracking markers', () => {
    const words = "let me go back and start over".split(' ').map((t, i) => w(t, i * 0.4));
    const result = extractSignals(words, 15);
    expect(result.backtrackCount).toBeGreaterThan(0);
  });

  it('returns zero signals for empty input', () => {
    const result = extractSignals([], 15);
    expect(result.filledPausePer100w).toBe(0);
    expect(result.negAffectCount).toBe(0);
    expect(result.repeatAttemptLoopFlag).toBe(false);
  });
});
