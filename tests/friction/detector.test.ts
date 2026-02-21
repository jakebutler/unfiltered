import { describe, it, expect } from 'vitest';
import { clusterFrictionWindows } from '@/lib/friction/detector';

describe('clusterFrictionWindows', () => {
  const mkWindow = (tStart: number, tEnd: number, score: number, taskId = "t1") => ({
    tStart, tEnd, friction0to100: score, taskId,
    severityHint: score >= 70 ? "HIGH" : score >= 40 ? "MED" : "LOW",
    computedSignals: {
      negAffectCount: 0, explicitUncertaintyCount: 0, clarificationCount: 0,
      veryLongPauseCount: 0, longPauseCount: 0, repairsPer100w: 0,
      repetitionsPer100w: 0, hedgesPer100w: 0, filledPausePer100w: 0,
      backtrackCount: 0, pauseTimeRatio: 0, clarityIndex: 0, repeatAttemptLoopFlag: false,
    },
    flags: [],
  });

  it('clusters adjacent high-friction windows into a single moment', () => {
    const windows = [
      mkWindow(0, 15, 75),
      mkWindow(5, 20, 80),
      mkWindow(10, 25, 72),
    ];
    const moments = clusterFrictionWindows(windows, 40);
    expect(moments).toHaveLength(1);
    expect(moments[0].frictionPeak).toBe(80);
  });

  it('produces separate moments for non-adjacent high-friction windows', () => {
    const windows = [
      mkWindow(0, 15, 80),
      mkWindow(60, 75, 78), // gap > 30s
    ];
    const moments = clusterFrictionWindows(windows, 40);
    expect(moments).toHaveLength(2);
  });

  it('ignores low-friction windows', () => {
    const windows = [mkWindow(0, 15, 25), mkWindow(5, 20, 30)];
    const moments = clusterFrictionWindows(windows, 40);
    expect(moments).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(clusterFrictionWindows([], 40)).toHaveLength(0);
  });
});
