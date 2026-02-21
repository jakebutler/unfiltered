"use client";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useParams } from "next/navigation";
import { Id } from "@/convex/_generated/dataModel";
import { SummarySection } from "@/components/dashboard/SummarySection";
import { MomentCard } from "@/components/dashboard/MomentCard";
import { HeatmapView } from "@/components/dashboard/HeatmapView";
import { ExportButtons } from "@/components/dashboard/ExportButtons";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import Link from "next/link";

export default function DashboardPage() {
  const params = useParams();
  const sessionId = params.sessionId as Id<"sessions">;
  const data = useQuery(api.sessions.getWithStudy, { sessionId });
  const moments = useQuery(api.friction.listBySession, { sessionId });
  const mouseWindows = useQuery(api.mouse.listBySession, { sessionId });

  if (!data?.session || !data.study) return <div className="p-8">Loading results…</div>;

  const { session, study } = data;
  const themes = session.outputs?.themes ?? [];
  const sessionFriction = session.outputs?.sessionFriction ?? 0;
  const sortedMoments = [...(moments ?? [])].sort((a, b) => b.frictionPeak - a.frictionPeak);
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

  return (
    <div className="max-w-4xl mx-auto p-8 space-y-6">
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
          {sortedMoments.map((m) => (
            <MomentCard
              key={m._id}
              moment={m}
              taskLabel={study.tasks.find((t: { id: string; label: string }) => t.id === m.taskId)?.label}
            />
          ))}
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
  );
}
