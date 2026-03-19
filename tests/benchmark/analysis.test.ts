import { describe, it, expect } from "vitest";
import { aggregateByProvider, breakdownByScenario, generateMarkdownReport } from "@/lib/benchmark/analysis";
import type { SessionResult } from "@/lib/voice/types";

function makeSession(
  provider: string,
  scenario: string,
  overrides: Partial<SessionResult> = {},
): SessionResult {
  return {
    sessionId: `${provider}_${scenario}_${Date.now()}`,
    config: { scenarioName: scenario, provider: provider as never, systemPrompt: "" },
    provider: provider as never,
    startedAt: 1000,
    endedAt: 5000,
    totalDurationMs: 4000,
    turns: [
      {
        turnIndex: 0,
        role: "user",
        transcriptionText: "hello",
        responseText: "hi",
        referenceText: "hello",
        ttftMs: 250,
        transcriptionLatencyMs: 100,
        totalResponseLatencyMs: 500,
        wer: 0.0,
      },
    ],
    avgTtftMs: 250,
    avgTranscriptionLatencyMs: 100,
    avgTotalLatencyMs: 500,
    overallWer: 0.0,
    inputTokens: 50,
    outputTokens: 20,
    audioDurationSeconds: 4,
    estimatedCostUsd: 0.01,
    errors: [],
    success: true,
    ...overrides,
  };
}

describe("aggregateByProvider", () => {
  it("groups sessions by provider", () => {
    const sessions = [
      makeSession("speechmatics", "session_intro"),
      makeSession("speechmatics", "clarifying_questions"),
      makeSession("vapi", "session_intro"),
    ];

    const summaries = aggregateByProvider(sessions);
    expect(summaries.length).toBe(2);

    const speechmatics = summaries.find((s) => s.provider === "speechmatics");
    expect(speechmatics?.totalSessions).toBe(2);
    expect(speechmatics?.successfulSessions).toBe(2);

    const vapi = summaries.find((s) => s.provider === "vapi");
    expect(vapi?.totalSessions).toBe(1);
  });

  it("counts failed sessions separately", () => {
    const sessions = [
      makeSession("speechmatics", "session_intro"),
      makeSession("speechmatics", "session_intro", { success: false }),
    ];

    const summaries = aggregateByProvider(sessions);
    const sm = summaries[0];
    expect(sm.totalSessions).toBe(2);
    expect(sm.successfulSessions).toBe(1);
    expect(sm.failedSessions).toBe(1);
  });

  it("returns empty for no sessions", () => {
    expect(aggregateByProvider([])).toEqual([]);
  });
});

describe("breakdownByScenario", () => {
  it("groups by scenario with per-provider results", () => {
    const sessions = [
      makeSession("speechmatics", "session_intro", { avgTtftMs: 200, overallWer: 0.05 }),
      makeSession("vapi", "session_intro", { avgTtftMs: 300, overallWer: 0.08 }),
      makeSession("speechmatics", "silence_handling", { avgTtftMs: 250 }),
    ];

    const breakdowns = breakdownByScenario(sessions);
    expect(breakdowns.length).toBe(2);

    const intro = breakdowns.find((b) => b.scenario === "session_intro");
    expect(intro?.providerResults["speechmatics"]?.avgTtftMs).toBe(200);
    expect(intro?.providerResults["vapi"]?.avgTtftMs).toBe(300);
  });
});

describe("generateMarkdownReport", () => {
  it("generates valid markdown with tables", () => {
    const sessions = [
      makeSession("speechmatics", "session_intro"),
      makeSession("vapi", "session_intro"),
    ];

    const summaries = aggregateByProvider(sessions);
    const breakdowns = breakdownByScenario(sessions);
    const report = generateMarkdownReport(summaries, breakdowns);

    expect(report).toContain("# Voice Provider Benchmark Results");
    expect(report).toContain("speechmatics");
    expect(report).toContain("vapi");
    expect(report).toContain("|");
  });
});
