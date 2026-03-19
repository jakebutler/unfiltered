import { describe, it, expect } from "vitest";
import {
  calculateWer,
  computeLatencyStats,
  computeTurnLatencies,
  aggregateSessionMetrics,
  classifyLatency,
  classifyWer,
} from "@/lib/voice/metrics";
import type { TurnMetrics, SessionResult } from "@/lib/voice/types";

describe("calculateWer", () => {
  it("returns 0 for identical strings", () => {
    expect(calculateWer("hello world", "hello world")).toBe(0);
  });

  it("returns 1 for completely different strings", () => {
    expect(calculateWer("hello world", "foo bar")).toBe(1);
  });

  it("returns 0 for empty reference", () => {
    expect(calculateWer("", "hello")).toBe(0);
  });

  it("returns 1 for empty hypothesis with non-empty reference", () => {
    expect(calculateWer("hello world", "")).toBe(1);
  });

  it("handles single word substitution", () => {
    // "the cat sat" vs "the dog sat" = 1 substitution / 3 words
    expect(calculateWer("the cat sat", "the dog sat")).toBeCloseTo(1 / 3, 2);
  });

  it("is case-insensitive", () => {
    expect(calculateWer("Hello World", "hello world")).toBe(0);
  });

  it("ignores punctuation", () => {
    expect(calculateWer("Hello, world!", "hello world")).toBe(0);
  });

  it("handles insertions", () => {
    // "the cat" vs "the big cat" = 1 insertion / 2 ref words
    expect(calculateWer("the cat", "the big cat")).toBeCloseTo(0.5, 2);
  });

  it("handles deletions", () => {
    // "the big cat" vs "the cat" = 1 deletion / 3 ref words
    expect(calculateWer("the big cat", "the cat")).toBeCloseTo(1 / 3, 2);
  });
});

describe("computeLatencyStats", () => {
  it("returns zeros for empty array", () => {
    const stats = computeLatencyStats([]);
    expect(stats.mean).toBe(0);
    expect(stats.median).toBe(0);
    expect(stats.p95).toBe(0);
  });

  it("computes correct stats for a single value", () => {
    const stats = computeLatencyStats([100]);
    expect(stats.mean).toBe(100);
    expect(stats.median).toBe(100);
    expect(stats.min).toBe(100);
    expect(stats.max).toBe(100);
    expect(stats.std).toBe(0);
  });

  it("computes correct mean and median for multiple values", () => {
    const stats = computeLatencyStats([100, 200, 300, 400, 500]);
    expect(stats.mean).toBe(300);
    expect(stats.median).toBe(300);
    expect(stats.min).toBe(100);
    expect(stats.max).toBe(500);
  });

  it("computes correct median for even count", () => {
    const stats = computeLatencyStats([100, 200, 300, 400]);
    expect(stats.median).toBe(250);
  });
});

describe("computeTurnLatencies", () => {
  it("calculates transcription latency", () => {
    const turn: TurnMetrics = {
      turnIndex: 0,
      role: "user",
      transcriptionText: "",
      responseText: "",
      referenceText: "",
      audioSentAt: 1000,
      transcriptionReceivedAt: 1300,
    };
    computeTurnLatencies(turn);
    expect(turn.transcriptionLatencyMs).toBe(300);
  });

  it("calculates TTFT", () => {
    const turn: TurnMetrics = {
      turnIndex: 0,
      role: "user",
      transcriptionText: "",
      responseText: "",
      referenceText: "",
      transcriptionReceivedAt: 1300,
      llmResponseAt: 1500,
    };
    computeTurnLatencies(turn);
    expect(turn.ttftMs).toBe(200);
  });

  it("calculates total response latency", () => {
    const turn: TurnMetrics = {
      turnIndex: 0,
      role: "user",
      transcriptionText: "",
      responseText: "",
      referenceText: "",
      audioSentAt: 1000,
      audioReceivedAt: 2000,
    };
    computeTurnLatencies(turn);
    expect(turn.totalResponseLatencyMs).toBe(1000);
  });

  it("handles missing timestamps gracefully", () => {
    const turn: TurnMetrics = {
      turnIndex: 0,
      role: "user",
      transcriptionText: "",
      responseText: "",
      referenceText: "",
    };
    computeTurnLatencies(turn);
    expect(turn.transcriptionLatencyMs).toBeUndefined();
    expect(turn.ttftMs).toBeUndefined();
    expect(turn.totalResponseLatencyMs).toBeUndefined();
  });
});

describe("aggregateSessionMetrics", () => {
  it("computes averages from turn metrics", () => {
    const result: SessionResult = {
      sessionId: "test",
      config: { scenarioName: "test", provider: "speechmatics", systemPrompt: "" },
      provider: "speechmatics",
      startedAt: 1000,
      endedAt: 5000,
      turns: [
        { turnIndex: 0, role: "user", transcriptionText: "", responseText: "", referenceText: "", ttftMs: 200, transcriptionLatencyMs: 100, totalResponseLatencyMs: 500, wer: 0.05 },
        { turnIndex: 1, role: "user", transcriptionText: "", responseText: "", referenceText: "", ttftMs: 300, transcriptionLatencyMs: 150, totalResponseLatencyMs: 600, wer: 0.10 },
      ],
      inputTokens: 0,
      outputTokens: 0,
      audioDurationSeconds: 0,
      estimatedCostUsd: 0,
      errors: [],
      success: true,
    };

    aggregateSessionMetrics(result);

    expect(result.avgTtftMs).toBe(250);
    expect(result.avgTranscriptionLatencyMs).toBe(125);
    expect(result.avgTotalLatencyMs).toBe(550);
    expect(result.overallWer).toBeCloseTo(0.075, 3);
    expect(result.totalDurationMs).toBe(4000);
  });
});

describe("classifyLatency", () => {
  it("classifies as excellent below threshold", () => {
    expect(classifyLatency(200, { excellent: 300, acceptable: 500 })).toBe("excellent");
  });

  it("classifies as acceptable in range", () => {
    expect(classifyLatency(400, { excellent: 300, acceptable: 500 })).toBe("acceptable");
  });

  it("classifies as poor above threshold", () => {
    expect(classifyLatency(600, { excellent: 300, acceptable: 500 })).toBe("poor");
  });
});

describe("classifyWer", () => {
  it("classifies clean audio WER", () => {
    expect(classifyWer(0.03)).toBe("excellent");
    expect(classifyWer(0.08)).toBe("acceptable");
    expect(classifyWer(0.15)).toBe("poor");
  });

  it("uses lenient thresholds for noisy audio", () => {
    expect(classifyWer(0.08, true)).toBe("excellent");
    expect(classifyWer(0.15, true)).toBe("acceptable");
    expect(classifyWer(0.25, true)).toBe("poor");
  });
});
