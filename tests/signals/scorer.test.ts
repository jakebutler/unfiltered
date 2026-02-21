import { describe, it, expect } from 'vitest';
import { computeFrictionScore, severityHint, computeSessionFriction } from '@/lib/signals/scorer';
import type { SignalResult } from '@/lib/signals/extractor';

const zeroSignals: SignalResult = {
  filledPausePer100w: 0, hedgesPer100w: 0, explicitUncertaintyCount: 0,
  longPauseCount: 0, veryLongPauseCount: 0, pauseTimeRatio: 0,
  repairsPer100w: 0, repetitionsPer100w: 0, clarificationCount: 0,
  negAffectCount: 0, clarityIndex: 3, backtrackCount: 0, repeatAttemptLoopFlag: false,
};

const highFrictionSignals: SignalResult = {
  filledPausePer100w: 8, hedgesPer100w: 10, explicitUncertaintyCount: 3,
  longPauseCount: 4, veryLongPauseCount: 2, pauseTimeRatio: 0.4,
  repairsPer100w: 5, repetitionsPer100w: 4, clarificationCount: 2,
  negAffectCount: 2, clarityIndex: -3, backtrackCount: 3, repeatAttemptLoopFlag: true,
};

describe('computeFrictionScore', () => {
  it('returns a number between 0 and 100', () => {
    const score = computeFrictionScore(zeroSignals, []);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('returns higher score for high-friction signals than zero signals', () => {
    const history = Array(5).fill(zeroSignals);
    const high = computeFrictionScore(highFrictionSignals, history);
    const low = computeFrictionScore(zeroSignals, history);
    expect(high).toBeGreaterThan(low);
  });
});

describe('severityHint', () => {
  it('returns LOW for score < 40', () => expect(severityHint(30)).toBe('LOW'));
  it('returns MED for score 40–70', () => expect(severityHint(55)).toBe('MED'));
  it('returns HIGH for score > 70', () => expect(severityHint(85)).toBe('HIGH'));
});

describe('computeSessionFriction', () => {
  it('computes weighted composite', () => {
    const scores = [60, 80, 40, 75];
    const result = computeSessionFriction(scores);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(100);
  });
});
