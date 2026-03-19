"use client";
import { useState, useCallback } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { RunConfigForm } from "@/components/benchmark/RunConfigForm";
import { RunProgress } from "@/components/benchmark/RunProgress";
import { ResultsTable } from "@/components/benchmark/ResultsTable";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ProviderType } from "@/lib/voice/types";
import type { RunProgress as RunProgressData } from "@/lib/benchmark/runner";
import { runBenchmark } from "@/lib/benchmark/runner";
import { aggregateByProvider } from "@/lib/benchmark/analysis";
import { registerProvider } from "@/lib/voice/provider-registry";
import { SpeechmaticsProvider } from "@/lib/voice/speechmatics";
import { OpenAIWhisperTTSProvider } from "@/lib/voice/openai-whisper";
import { OpenAIRealtimeProvider } from "@/lib/voice/openai-realtime";
import { AssemblyAIProvider } from "@/lib/voice/assemblyai";
import { VapiProvider } from "@/lib/voice/vapi";

// Register providers on page load
registerProvider("speechmatics", (c) => new SpeechmaticsProvider(c));
registerProvider("openai_whisper_tts", (c) => new OpenAIWhisperTTSProvider(c));
registerProvider("openai_realtime", (c) => new OpenAIRealtimeProvider(c));
registerProvider("assemblyai", (c) => new AssemblyAIProvider(c));
registerProvider("vapi", (c) => new VapiProvider(c));

export default function BenchmarkPage() {
  const runs = useQuery(api.benchmarkRuns.list);
  const createRun = useMutation(api.benchmarkRuns.create);
  const completeRun = useMutation(api.benchmarkRuns.complete);
  const createSession = useMutation(api.benchmarkSessions.create);

  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<RunProgressData | null>(null);
  const [lastSummaries, setLastSummaries] = useState<ReturnType<typeof aggregateByProvider>>([]);

  const handleStart = useCallback(async (config: {
    name: string;
    providers: ProviderType[];
    scenarios: string[];
    repetitions: number;
  }) => {
    setIsRunning(true);
    setProgress(null);

    const runId = await createRun({
      name: config.name,
      providers: config.providers,
      scenarios: config.scenarios,
      repetitions: config.repetitions,
      config: JSON.stringify(config),
    });

    try {
      const results = await runBenchmark(
        {
          providers: config.providers,
          scenarios: config.scenarios,
          repetitions: config.repetitions,
        },
        (p) => setProgress(p),
      );

      // Store results in Convex
      for (const result of results) {
        await createSession({
          runId,
          provider: result.provider,
          scenario: result.config.scenarioName,
          repetition: 0,
          success: result.success,
          avgTtftMs: result.avgTtftMs,
          avgTranscriptionLatencyMs: result.avgTranscriptionLatencyMs,
          avgTotalLatencyMs: result.avgTotalLatencyMs,
          overallWer: result.overallWer,
          estimatedCostUsd: result.estimatedCostUsd,
          turns: JSON.stringify(result.turns),
          errors: result.errors.length > 0 ? JSON.stringify(result.errors) : undefined,
        });
      }

      await completeRun({ runId, status: "complete" });
      setLastSummaries(aggregateByProvider(results));
    } catch {
      await completeRun({ runId, status: "failed" });
    } finally {
      setIsRunning(false);
    }
  }, [createRun, completeRun, createSession]);

  return (
    <div className="max-w-5xl mx-auto p-8 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Voice Benchmark</h1>
        <Badge variant="outline">UX Research Session Testing</Badge>
      </div>

      <Tabs defaultValue="run">
        <TabsList>
          <TabsTrigger value="run">Run Benchmark</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="run" className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <RunConfigForm onSubmit={handleStart} isRunning={isRunning} />
            <div className="space-y-4">
              <RunProgress progress={progress} />
              {lastSummaries.length > 0 && <ResultsTable summaries={lastSummaries} />}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="history" className="space-y-4">
          {runs?.map((run) => (
            <Card key={run._id} className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-sm">{run.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(run.startedAt).toLocaleString()} | {run.providers.length} providers | {run.scenarios.length} scenarios
                  </p>
                </div>
                <div className="flex gap-2">
                  <Badge variant={run.status === "complete" ? "default" : run.status === "failed" ? "destructive" : "secondary"}>
                    {run.status}
                  </Badge>
                  <Button variant="outline" size="sm" asChild>
                    <a href={`/benchmark/results/${run._id}`}>View Results</a>
                  </Button>
                  <Button variant="outline" size="sm" asChild>
                    <a href={`/benchmark/eval/${run._id}`}>Evaluate</a>
                  </Button>
                </div>
              </div>
            </Card>
          ))}
          {(!runs || runs.length === 0) && (
            <Card className="p-6 text-center text-muted-foreground text-sm">
              No benchmark runs yet. Start one from the Run tab.
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
