import type { SessionResult, TurnMetrics } from "./types";

/** Compute Word Error Rate using Levenshtein distance on word arrays. */
export function calculateWer(reference: string, hypothesis: string): number {
  const refWords = normalizeForWer(reference).split(/\s+/).filter(Boolean);
  const hypWords = normalizeForWer(hypothesis).split(/\s+/).filter(Boolean);

  if (refWords.length === 0) return 0;
  if (hypWords.length === 0) return 1;

  const n = refWords.length;
  const m = hypWords.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));

  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (refWords[i - 1] === hypWords[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  return dp[n][m] / n;
}

function normalizeForWer(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface LatencyStats {
  mean: number;
  median: number;
  p95: number;
  min: number;
  max: number;
  std: number;
}

export function computeLatencyStats(values: number[]): LatencyStats {
  if (values.length === 0) {
    return { mean: 0, median: 0, p95: 0, min: 0, max: 0, std: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((sum, v) => sum + v, 0) / n;
  const median = n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)];
  const p95Index = Math.min(Math.floor(n * 0.95), n - 1);
  const variance = n > 1
    ? sorted.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1)
    : 0;

  return {
    mean,
    median,
    p95: sorted[p95Index],
    min: sorted[0],
    max: sorted[n - 1],
    std: Math.sqrt(variance),
  };
}

export function computeTurnLatencies(turn: TurnMetrics): void {
  if (turn.transcriptionReceivedAt != null && turn.audioSentAt != null) {
    turn.transcriptionLatencyMs = turn.transcriptionReceivedAt - turn.audioSentAt;
  }
  if (turn.llmResponseAt != null && turn.transcriptionReceivedAt != null) {
    turn.ttftMs = turn.llmResponseAt - turn.transcriptionReceivedAt;
  }
  if (turn.audioReceivedAt != null && turn.audioSentAt != null) {
    turn.totalResponseLatencyMs = turn.audioReceivedAt - turn.audioSentAt;
  }
}

export function aggregateSessionMetrics(result: SessionResult): void {
  const ttfts: number[] = [];
  const transcriptionLatencies: number[] = [];
  const totalLatencies: number[] = [];
  const wers: number[] = [];

  for (const turn of result.turns) {
    if (turn.ttftMs != null) ttfts.push(turn.ttftMs);
    if (turn.transcriptionLatencyMs != null) transcriptionLatencies.push(turn.transcriptionLatencyMs);
    if (turn.totalResponseLatencyMs != null) totalLatencies.push(turn.totalResponseLatencyMs);
    if (turn.wer != null) wers.push(turn.wer);
  }

  result.avgTtftMs = ttfts.length > 0 ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : undefined;
  result.avgTranscriptionLatencyMs = transcriptionLatencies.length > 0
    ? transcriptionLatencies.reduce((a, b) => a + b, 0) / transcriptionLatencies.length
    : undefined;
  result.avgTotalLatencyMs = totalLatencies.length > 0
    ? totalLatencies.reduce((a, b) => a + b, 0) / totalLatencies.length
    : undefined;
  result.overallWer = wers.length > 0 ? wers.reduce((a, b) => a + b, 0) / wers.length : undefined;

  if (result.endedAt && result.startedAt) {
    result.totalDurationMs = result.endedAt - result.startedAt;
  }
}

export interface AggregatedMetrics {
  latency: {
    ttft: LatencyStats;
    transcription: LatencyStats;
    total: LatencyStats;
  };
  wer: {
    cleanMean: number | null;
    noiseMean: number | null;
    overallMean: number | null;
  };
  cost: {
    meanPerSession: number;
    meanPerMinute: number;
    total: number;
  };
  sampleCount: number;
}

export function aggregateAcrossSessions(sessions: SessionResult[]): AggregatedMetrics {
  const allTtft: number[] = [];
  const allTranscription: number[] = [];
  const allTotal: number[] = [];
  const allWer: number[] = [];
  const allWerNoise: number[] = [];
  const allCosts: number[] = [];
  const allDurations: number[] = [];

  for (const session of sessions) {
    for (const turn of session.turns) {
      if (turn.ttftMs != null) allTtft.push(turn.ttftMs);
      if (turn.transcriptionLatencyMs != null) allTranscription.push(turn.transcriptionLatencyMs);
      if (turn.totalResponseLatencyMs != null) allTotal.push(turn.totalResponseLatencyMs);
      if (turn.wer != null) {
        if (session.config.noiseLevel) {
          allWerNoise.push(turn.wer);
        } else {
          allWer.push(turn.wer);
        }
      }
    }
    allCosts.push(session.estimatedCostUsd);
    if (session.totalDurationMs) allDurations.push(session.totalDurationMs);
  }

  const meanOrNull = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const meanCost = allCosts.length > 0 ? allCosts.reduce((a, b) => a + b, 0) / allCosts.length : 0;
  const meanDuration = allDurations.length > 0 ? allDurations.reduce((a, b) => a + b, 0) / allDurations.length : 0;

  return {
    latency: {
      ttft: computeLatencyStats(allTtft),
      transcription: computeLatencyStats(allTranscription),
      total: computeLatencyStats(allTotal),
    },
    wer: {
      cleanMean: meanOrNull(allWer),
      noiseMean: meanOrNull(allWerNoise),
      overallMean: meanOrNull([...allWer, ...allWerNoise]),
    },
    cost: {
      meanPerSession: meanCost,
      meanPerMinute: meanDuration > 0 ? meanCost / (meanDuration / 60000) : 0,
      total: allCosts.reduce((a, b) => a + b, 0),
    },
    sampleCount: sessions.length,
  };
}

export function classifyLatency(latencyMs: number, thresholds: { excellent: number; acceptable: number }): "excellent" | "acceptable" | "poor" {
  if (latencyMs <= thresholds.excellent) return "excellent";
  if (latencyMs <= thresholds.acceptable) return "acceptable";
  return "poor";
}

export function classifyWer(wer: number, withNoise = false): "excellent" | "acceptable" | "poor" {
  const thresholds = withNoise
    ? { excellent: 0.10, acceptable: 0.20 }
    : { excellent: 0.05, acceptable: 0.10 };
  if (wer <= thresholds.excellent) return "excellent";
  if (wer <= thresholds.acceptable) return "acceptable";
  return "poor";
}
