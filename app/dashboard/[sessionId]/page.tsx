"use client";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Id } from "@/convex/_generated/dataModel";
import { SummarySection } from "@/components/dashboard/SummarySection";
import { MomentCard } from "@/components/dashboard/MomentCard";
import { TranscriptReviewSidebar } from "@/components/dashboard/TranscriptReviewSidebar";
import { HeatmapView } from "@/components/dashboard/HeatmapView";
import { ExportButtons } from "@/components/dashboard/ExportButtons";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { pickTranscriptSnippetsForMoment } from "@/lib/friction/snippets";
import Link from "next/link";

export default function DashboardPage() {
  const params = useParams();
  const sessionId = params.sessionId as Id<"sessions">;
  const [selectedMomentId, setSelectedMomentId] = useState<string | null>(null);
  const [savingMomentId, setSavingMomentId] = useState<string | null>(null);
  const data = useQuery(api.sessions.getWithStudy, { sessionId });
  const moments = useQuery(api.friction.listBySession, { sessionId });
  const mouseWindows = useQuery(api.mouse.listBySession, { sessionId });
  const transcripts = useQuery(api.transcripts.listBySession, { sessionId });
  const setVerification = useMutation(api.friction.setVerification);
  const relabelMoments = useAction(api.findings.labelAllMoments);

  if (!data?.session || !data.study) return <div className="p-8">Loading results…</div>;

  const { session, study } = data;
  const themes = session.outputs?.themes ?? [];
  const sessionFriction = session.outputs?.sessionFriction ?? 0;
  const typedMoments = (moments ?? []) as Array<{
    _id: string;
    tStart: number;
    tEnd: number;
    taskId: string;
    frictionPeak: number;
    evidence: { transcriptSnippets: string[] };
    signalTags: string[];
    candidateFindingLabel?: string;
    category?: string;
    interpretation?: string;
    recommendations?: string[];
    verificationStatus?: "confirmed" | "incorrect";
  }>;
  const momentsWithFreshSnippets = typedMoments.map((moment) => {
    const transcriptSnippets = pickTranscriptSnippetsForMoment(
      { tStart: moment.tStart, tEnd: moment.tEnd, taskId: moment.taskId },
      transcripts ?? [],
    );
    if (transcriptSnippets.length === 0) return moment;
    return {
      ...moment,
      evidence: {
        ...moment.evidence,
        transcriptSnippets,
      },
    };
  });
  const sortedMoments = [...momentsWithFreshSnippets].sort((a, b) => b.frictionPeak - a.frictionPeak);
  const selectedMoment = sortedMoments.find((moment) => String(moment._id) === selectedMomentId) ?? null;
  const selectedTaskLabel = selectedMoment
    ? study.tasks.find((task: { id: string; label: string }) => task.id === selectedMoment.taskId)?.label
    : undefined;
  const allBins = (mouseWindows ?? []).flatMap((w: { heatmapBins?: { x: number; y: number; count: number }[] }) => w.heatmapBins ?? []);

  const reportData = {
    studyTitle: study.title,
    sessionId: String(sessionId),
    endedAt: session.endedAt ?? Date.now(),
    themes,
    sessionFriction,
    moments: sortedMoments.map(m => ({
      tStart: m.tStart,
      tEnd: m.tEnd,
      taskId: m.taskId,
      taskLabel: study.tasks.find((t: { id: string; label: string }) => t.id === m.taskId)?.label,
      frictionPeak: m.frictionPeak,
      candidateFindingLabel: m.candidateFindingLabel,
      category: m.category,
      interpretation: m.interpretation,
      recommendations: m.recommendations,
      signalTags: m.signalTags,
      evidence: m.evidence,
    })),
  };

  const submitVerification = async (
    momentId: string,
    status: "confirmed" | "incorrect",
    feedback?: string,
  ) => {
    setSavingMomentId(momentId);
    try {
      await setVerification({
        momentId: momentId as Id<"frictionMoments">,
        status,
        feedback,
      });
      if (status === "incorrect") {
        void relabelMoments({ sessionId }).catch(() => undefined);
      }
    } finally {
      setSavingMomentId(null);
    }
  };

  return (
    <div className="max-w-7xl mx-auto p-8">
      <div className={`gap-6 ${selectedMoment ? "grid lg:grid-cols-[minmax(0,1fr)_360px]" : ""}`}>
        <div className="space-y-6 min-w-0">
          <div className="flex items-center justify-between">
            <div>
              <Link href={`/studies/${study._id}`} className="text-sm text-muted-foreground">← {study.title}</Link>
              <h1 className="text-2xl font-bold mt-1">Session Results</h1>
            </div>
            <ExportButtons reportData={reportData} />
          </div>

          <SummarySection
            themes={themes}
            sessionFriction={sessionFriction}
            momentCount={sortedMoments.length}
            taskCount={study.tasks.length}
          />

          <Tabs defaultValue="moments">
            <TabsList>
              <TabsTrigger value="moments">Friction Moments ({sortedMoments.length})</TabsTrigger>
              <TabsTrigger value="heatmap">Heatmap</TabsTrigger>
            </TabsList>
            <TabsContent value="moments" className="space-y-4 mt-4">
              {sortedMoments.length === 0 && (
                <p className="text-muted-foreground text-sm">No friction moments detected — great session!</p>
              )}
              {sortedMoments.map((m) => {
                const momentId = String(m._id);
                return (
                  <MomentCard
                    key={m._id}
                    moment={m}
                    taskLabel={study.tasks.find((t: { id: string; label: string }) => t.id === m.taskId)?.label}
                    onViewTranscript={() => setSelectedMomentId(momentId)}
                    onConfirmAnalysis={() => submitVerification(momentId, "confirmed")}
                    onSubmitIncorrectAnalysis={async (feedback) => {
                      setSelectedMomentId(momentId);
                      await submitVerification(momentId, "incorrect", feedback);
                    }}
                    isSavingVerification={savingMomentId === momentId}
                  />
                );
              })}
            </TabsContent>
            <TabsContent value="heatmap">
              {allBins.length > 0 ? (
                <div className="mt-4">
                  <HeatmapView bins={allBins} prototypeUrl={study.prototypeUrl} />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground mt-4">No mouse data captured.</p>
              )}
            </TabsContent>
          </Tabs>
        </div>
        {selectedMoment && (
          <TranscriptReviewSidebar
            moment={selectedMoment}
            taskLabel={selectedTaskLabel}
            transcripts={transcripts ?? []}
            onClose={() => setSelectedMomentId(null)}
          />
        )}
      </div>
    </div>
  );
}
