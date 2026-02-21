import type { SignalResult } from './extractor';

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function robustZScore(value: number, history: number[]): number {
  if (history.length < 2) return 0;
  const sorted = [...history].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const deviations = history.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const dMid = Math.floor(deviations.length / 2);
  const mad = deviations.length % 2 === 0
    ? (deviations[dMid - 1] + deviations[dMid]) / 2
    : deviations[dMid];
  return (value - median) / (mad + 0.01);
}

const WEIGHTS: Partial<Record<keyof SignalResult, number>> = {
  filledPausePer100w: 1.0,
  hedgesPer100w: 1.0,
  explicitUncertaintyCount: 1.0,
  longPauseCount: 1.0,
  veryLongPauseCount: 1.0,
  repairsPer100w: 1.0,
  repetitionsPer100w: 1.0,
  clarificationCount: 1.0,
  negAffectCount: 1.3,
  backtrackCount: 1.2,
  clarityIndex: 0.7, // inverted
};

export function computeFrictionScore(signals: SignalResult, history: SignalResult[]): number {
  let frictionRaw = 0;

  for (const [key, weight] of Object.entries(WEIGHTS) as [keyof SignalResult, number][]) {
    const currentVal = signals[key] as number;
    const hist = history.map((h) => h[key] as number);

    if (hist.length >= 2) {
      const z = robustZScore(currentVal, hist);
      frictionRaw += key === 'clarityIndex' ? weight * -z : weight * z;
    } else {
      // Early windows: crude normalization
      if (key !== 'clarityIndex') frictionRaw += weight * Math.min(currentVal / 5, 1);
      else frictionRaw += weight * Math.min(-currentVal / 5, 1);
    }
  }

  // Boolean repeat attempt loop adds fixed friction
  if (signals.repeatAttemptLoopFlag) frictionRaw += 1.2;

  return Math.round(100 * sigmoid(frictionRaw));
}

export function severityHint(score: number): 'LOW' | 'MED' | 'HIGH' {
  if (score < 40) return 'LOW';
  if (score <= 70) return 'MED';
  return 'HIGH';
}

export function computeSessionFriction(windowScores: number[]): number {
  if (windowScores.length === 0) return 0;
  const avg = windowScores.reduce((a, b) => a + b, 0) / windowScores.length;
  const peak = Math.max(...windowScores);
  const timeInHigh = (windowScores.filter((s) => s >= 75).length / windowScores.length) * 100;
  return Math.round(0.45 * avg + 0.35 * peak + 0.2 * timeInHigh);
}
