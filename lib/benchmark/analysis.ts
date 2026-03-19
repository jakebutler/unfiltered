import type { SessionResult } from "@/lib/voice/types";
import { computeLatencyStats, aggregateAcrossSessions } from "@/lib/voice/metrics";
import type { AggregatedMetrics, LatencyStats } from "@/lib/voice/metrics";

export interface ProviderSummary {
  provider: string;
  totalSessions: number;
  successfulSessions: number;
  failedSessions: number;
  latency: {
    ttft: LatencyStats;
    transcription: LatencyStats;
    total: LatencyStats;
  };
  avgWer: number | null;
  avgCostPerSession: number;
  avgCostPerMinute: number;
  manualEvals?: {
    transcriptionAccuracy: number;
    responseRelevance: number;
    voiceNaturalness: number;
    conversationFlow: number;
    professionalism: number;
    overallQuality: number;
  };
}

export interface ScenarioBreakdown {
  scenario: string;
  providerResults: Record<string, {
    avgTtftMs: number | null;
    avgWer: number | null;
    successRate: number;
  }>;
}

export function aggregateByProvider(sessions: SessionResult[]): ProviderSummary[] {
  const byProvider = new Map<string, SessionResult[]>();
  for (const session of sessions) {
    const key = session.provider;
    if (!byProvider.has(key)) byProvider.set(key, []);
    byProvider.get(key)!.push(session);
  }

  const summaries: ProviderSummary[] = [];
  for (const [provider, providerSessions] of byProvider) {
    const successful = providerSessions.filter((s) => s.success);
    const metrics = aggregateAcrossSessions(successful);

    summaries.push({
      provider,
      totalSessions: providerSessions.length,
      successfulSessions: successful.length,
      failedSessions: providerSessions.length - successful.length,
      latency: metrics.latency,
      avgWer: metrics.wer.overallMean,
      avgCostPerSession: metrics.cost.meanPerSession,
      avgCostPerMinute: metrics.cost.meanPerMinute,
    });
  }

  return summaries.sort((a, b) => a.provider.localeCompare(b.provider));
}

export function breakdownByScenario(sessions: SessionResult[]): ScenarioBreakdown[] {
  const byScenario = new Map<string, SessionResult[]>();
  for (const session of sessions) {
    const key = session.config.scenarioName;
    if (!byScenario.has(key)) byScenario.set(key, []);
    byScenario.get(key)!.push(session);
  }

  const breakdowns: ScenarioBreakdown[] = [];
  for (const [scenario, scenarioSessions] of byScenario) {
    const providerResults: Record<string, { avgTtftMs: number | null; avgWer: number | null; successRate: number }> = {};

    const byProvider = new Map<string, SessionResult[]>();
    for (const session of scenarioSessions) {
      if (!byProvider.has(session.provider)) byProvider.set(session.provider, []);
      byProvider.get(session.provider)!.push(session);
    }

    for (const [provider, providerSessions] of byProvider) {
      const successful = providerSessions.filter((s) => s.success);
      const ttfts = successful.map((s) => s.avgTtftMs).filter((v): v is number => v != null);
      const wers = successful.map((s) => s.overallWer).filter((v): v is number => v != null);

      providerResults[provider] = {
        avgTtftMs: ttfts.length > 0 ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : null,
        avgWer: wers.length > 0 ? wers.reduce((a, b) => a + b, 0) / wers.length : null,
        successRate: providerSessions.length > 0 ? successful.length / providerSessions.length : 0,
      };
    }

    breakdowns.push({ scenario, providerResults });
  }

  return breakdowns;
}

export function generateMarkdownReport(
  summaries: ProviderSummary[],
  breakdowns: ScenarioBreakdown[],
): string {
  const lines: string[] = [];

  lines.push("# Voice Provider Benchmark Results\n");
  lines.push("## Summary\n");
  lines.push("| Provider | Sessions | Avg TTFT (ms) | Avg WER | Overall Quality | Cost/min |");
  lines.push("|----------|----------|---------------|---------|-----------------|----------|");

  for (const s of summaries) {
    const quality = s.manualEvals?.overallQuality;
    lines.push(
      `| ${s.provider} | ${s.successfulSessions}/${s.totalSessions} | ` +
      `${s.latency.ttft.mean > 0 ? s.latency.ttft.mean.toFixed(0) : "N/A"} | ` +
      `${s.avgWer != null ? (s.avgWer * 100).toFixed(1) + "%" : "N/A"} | ` +
      `${quality != null ? quality.toFixed(2) + "/3" : "N/A"} | ` +
      `$${s.avgCostPerMinute.toFixed(3)} |`
    );
  }

  lines.push("\n## Scenario Breakdown\n");

  for (const breakdown of breakdowns) {
    lines.push(`### ${breakdown.scenario}\n`);
    lines.push("| Provider | Avg TTFT (ms) | Avg WER | Success Rate |");
    lines.push("|----------|---------------|---------|--------------|");

    for (const [provider, result] of Object.entries(breakdown.providerResults)) {
      lines.push(
        `| ${provider} | ` +
        `${result.avgTtftMs != null ? result.avgTtftMs.toFixed(0) : "N/A"} | ` +
        `${result.avgWer != null ? (result.avgWer * 100).toFixed(1) + "%" : "N/A"} | ` +
        `${(result.successRate * 100).toFixed(0)}% |`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}
