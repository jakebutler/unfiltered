"use client";
import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { useParams } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { EvalCard } from "@/components/benchmark/EvalCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { RatingScore, EvaluationDimensionId } from "@/lib/benchmark/scenarios";

export default function EvalPage() {
  const params = useParams();
  const runId = params.runId as Id<"benchmarkRuns">;

  const run = useQuery(api.benchmarkRuns.get, { runId });
  const sessions = useQuery(api.benchmarkSessions.listByRun, { runId });
  const existingEvals = useQuery(api.benchmarkEvaluations.listByRun, { runId });
  const createEval = useMutation(api.benchmarkEvaluations.create);

  const [blindMode, setBlindMode] = useState(true);
  const [evaluatedIds, setEvaluatedIds] = useState<Set<string>>(new Set());

  const evaluatedSessionIds = new Set([
    ...(existingEvals?.map((e) => e.sessionId) ?? []),
    ...evaluatedIds,
  ]);

  const pendingSessions = sessions?.filter((s) => !evaluatedSessionIds.has(s._id)) ?? [];
  const completedCount = evaluatedSessionIds.size;
  const totalCount = sessions?.length ?? 0;

  const handleSubmit = async (
    sessionId: Id<"benchmarkSessions">,
    ratings: Record<EvaluationDimensionId, RatingScore>,
    notes: string,
  ) => {
    await createEval({
      sessionId,
      evaluatorId: "default",
      transcriptionAccuracy: ratings.transcriptionAccuracy,
      responseRelevance: ratings.responseRelevance,
      voiceNaturalness: ratings.voiceNaturalness,
      conversationFlow: ratings.conversationFlow,
      professionalism: ratings.professionalism,
      overallQuality: ratings.overallQuality,
      notes: notes || undefined,
    });
    setEvaluatedIds((prev) => new Set([...prev, sessionId]));
  };

  if (!run) return <div className="p-8">Loading...</div>;

  return (
    <div className="max-w-3xl mx-auto p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Evaluate: {run.name}</h1>
          <p className="text-sm text-muted-foreground">
            {completedCount}/{totalCount} sessions evaluated
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={blindMode ? "default" : "outline"}
            size="sm"
            onClick={() => setBlindMode(!blindMode)}
          >
            {blindMode ? "Blind Mode On" : "Blind Mode Off"}
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={`/benchmark/results/${runId}`}>View Results</a>
          </Button>
        </div>
      </div>

      {pendingSessions.length === 0 ? (
        <div className="text-center py-12 space-y-4">
          <Badge variant="default" className="text-lg px-4 py-2">All sessions evaluated</Badge>
          <p className="text-muted-foreground">
            <a href={`/benchmark/results/${runId}`} className="underline">View results</a>
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {pendingSessions.slice(0, 3).map((session) => (
            <EvalCard
              key={session._id}
              sessionId={session._id}
              scenario={session.scenario}
              providerHidden={blindMode}
              provider={session.provider}
              onSubmit={(ratings, notes) => handleSubmit(session._id, ratings, notes)}
            />
          ))}
          {pendingSessions.length > 3 && (
            <p className="text-sm text-muted-foreground text-center">
              {pendingSessions.length - 3} more sessions to evaluate
            </p>
          )}
        </div>
      )}
    </div>
  );
}
