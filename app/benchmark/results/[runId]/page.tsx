"use client";
import { useMemo } from "react";
import { useQuery } from "convex/react";
import { useParams } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { ResultsTable } from "@/components/benchmark/ResultsTable";
import { LatencyChart } from "@/components/benchmark/LatencyChart";
import { QualityRadar } from "@/components/benchmark/QualityRadar";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ProviderSummary } from "@/lib/benchmark/analysis";

export default function ResultsPage() {
  const params = useParams();
  const runId = params.runId as Id<"benchmarkRuns">;

  const run = useQuery(api.benchmarkRuns.get, { runId });
  const sessions = useQuery(api.benchmarkSessions.listByRun, { runId });
  const evaluations = useQuery(api.benchmarkEvaluations.listByRun, { runId });

  const summaries = useMemo<ProviderSummary[]>(() => {
    if (!sessions) return [];

    const byProvider = new Map<string, typeof sessions>();
    for (const session of sessions) {
      if (!byProvider.has(session.provider)) byProvider.set(session.provider, []);
      byProvider.get(session.provider)!.push(session);
    }

    const evalsBySession = new Map<string, typeof evaluations>();
    for (const ev of evaluations ?? []) {
      if (!evalsBySession.has(ev.sessionId)) evalsBySession.set(ev.sessionId, []);
      evalsBySession.get(ev.sessionId)!.push(ev);
    }

    const result: ProviderSummary[] = [];
    for (const [provider, providerSessions] of byProvider) {
      const successful = providerSessions.filter((s) => s.success);
      const ttfts = successful.map((s) => s.avgTtftMs).filter((v): v is number => v != null);
      const totalLatencies = successful.map((s) => s.avgTotalLatencyMs).filter((v): v is number => v != null);
      const wers = successful.map((s) => s.overallWer).filter((v): v is number => v != null);
      const costs = successful.map((s) => s.estimatedCostUsd).filter((v): v is number => v != null);

      // Aggregate manual evals
      const sessionEvals = providerSessions.flatMap((s) => evalsBySession.get(s._id) ?? []);
      let manualEvals: ProviderSummary["manualEvals"];
      if (sessionEvals.length > 0) {
        const avg = (key: "transcriptionAccuracy" | "responseRelevance" | "voiceNaturalness" | "conversationFlow" | "professionalism" | "overallQuality") =>
          sessionEvals.reduce((sum, e) => sum + (e[key] ?? 0), 0) / sessionEvals.length;
        manualEvals = {
          transcriptionAccuracy: avg("transcriptionAccuracy"),
          responseRelevance: avg("responseRelevance"),
          voiceNaturalness: avg("voiceNaturalness"),
          conversationFlow: avg("conversationFlow"),
          professionalism: avg("professionalism"),
          overallQuality: avg("overallQuality"),
        };
      }

      const meanOrZero = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
      const sorted = (arr: number[]) => [...arr].sort((a, b) => a - b);
      const p95 = (arr: number[]) => arr.length > 0 ? sorted(arr)[Math.min(Math.floor(arr.length * 0.95), arr.length - 1)] : 0;

      result.push({
        provider,
        totalSessions: providerSessions.length,
        successfulSessions: successful.length,
        failedSessions: providerSessions.length - successful.length,
        latency: {
          ttft: {
            mean: meanOrZero(ttfts),
            median: ttfts.length > 0 ? sorted(ttfts)[Math.floor(ttfts.length / 2)] : 0,
            p95: p95(ttfts),
            min: ttfts.length > 0 ? Math.min(...ttfts) : 0,
            max: ttfts.length > 0 ? Math.max(...ttfts) : 0,
            std: 0,
          },
          transcription: { mean: 0, median: 0, p95: 0, min: 0, max: 0, std: 0 },
          total: {
            mean: meanOrZero(totalLatencies),
            median: totalLatencies.length > 0 ? sorted(totalLatencies)[Math.floor(totalLatencies.length / 2)] : 0,
            p95: p95(totalLatencies),
            min: totalLatencies.length > 0 ? Math.min(...totalLatencies) : 0,
            max: totalLatencies.length > 0 ? Math.max(...totalLatencies) : 0,
            std: 0,
          },
        },
        avgWer: wers.length > 0 ? meanOrZero(wers) : null,
        avgCostPerSession: meanOrZero(costs),
        avgCostPerMinute: 0,
        manualEvals,
      });
    }

    return result;
  }, [sessions, evaluations]);

  if (!run) return <div className="p-8">Loading...</div>;

  return (
    <div className="max-w-5xl mx-auto p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{run.name}</h1>
          <p className="text-sm text-muted-foreground">
            {new Date(run.startedAt).toLocaleString()}
            {run.endedAt && ` — ${((run.endedAt - run.startedAt) / 1000).toFixed(0)}s`}
          </p>
        </div>
        <div className="flex gap-2">
          <Badge variant={run.status === "complete" ? "default" : run.status === "failed" ? "destructive" : "secondary"}>
            {run.status}
          </Badge>
          <a href={`/benchmark/eval/${runId}`} className="text-sm underline text-muted-foreground">
            Evaluate sessions
          </a>
        </div>
      </div>

      <Tabs defaultValue="table">
        <TabsList>
          <TabsTrigger value="table">Summary Table</TabsTrigger>
          <TabsTrigger value="latency">Latency</TabsTrigger>
          <TabsTrigger value="quality">Quality</TabsTrigger>
        </TabsList>

        <TabsContent value="table">
          <ResultsTable summaries={summaries} />
        </TabsContent>

        <TabsContent value="latency">
          <LatencyChart summaries={summaries} />
        </TabsContent>

        <TabsContent value="quality">
          <QualityRadar summaries={summaries} />
        </TabsContent>
      </Tabs>

      {sessions && sessions.length > 0 && (
        <Card className="p-6">
          <h3 className="font-semibold text-sm mb-4">Individual Sessions</h3>
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {sessions.map((s) => (
              <div key={s._id} className="flex items-center justify-between text-sm border-b pb-2 last:border-0">
                <div className="flex items-center gap-2">
                  <Badge variant={s.success ? "default" : "destructive"} className="text-xs">
                    {s.success ? "OK" : "FAIL"}
                  </Badge>
                  <span className="font-medium">{s.provider}</span>
                  <span className="text-muted-foreground">{s.scenario.replace(/_/g, " ")}</span>
                </div>
                <div className="flex gap-4 text-xs text-muted-foreground">
                  {s.avgTtftMs != null && <span>TTFT: {s.avgTtftMs.toFixed(0)}ms</span>}
                  {s.overallWer != null && <span>WER: {(s.overallWer * 100).toFixed(1)}%</span>}
                  {s.estimatedCostUsd != null && <span>${s.estimatedCostUsd.toFixed(4)}</span>}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
