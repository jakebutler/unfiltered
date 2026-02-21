"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { Id } from "@/convex/_generated/dataModel";

export default function StudyDetailPage() {
  const params = useParams();
  const studyId = params.studyId as Id<"studies">;
  const study = useQuery(api.studies.get, { studyId });
  const sessions = useQuery(api.sessions.listByStudy, { studyId });
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (!resetTimerRef.current) return;
      window.clearTimeout(resetTimerRef.current);
    };
  }, []);

  if (!study) return <div className="p-8">Loading…</div>;

  const participantLink = typeof window !== "undefined"
    ? `${window.location.origin}/join/${study._id}`
    : `/join/${study._id}`;

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(participantLink);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }

    if (resetTimerRef.current) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => setCopyState("idle"), 2200);
  };

  return (
    <div className="max-w-2xl mx-auto p-8 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/studies" className="text-muted-foreground text-sm">← Studies</Link>
        <h1 className="text-2xl font-bold">{study.title}</h1>
        <Badge>Mode {study.decideMode}</Badge>
      </div>
      <Card>
        <CardHeader><CardTitle>Participant Link</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm font-mono bg-muted p-2 rounded break-all">{participantLink}</p>
          <Button
            variant={copyState === "copied" ? "default" : "outline"}
            size="sm"
            onClick={handleCopyLink}
          >
            {copyState === "copied" ? "Copied!" : copyState === "error" ? "Copy failed — retry" : "Copy Link"}
          </Button>
          <p
            role="status"
            aria-live="polite"
            className={`text-xs ${copyState === "error" ? "text-destructive" : "text-muted-foreground"}`}
          >
            {copyState === "copied"
              ? "Copied to clipboard. Share it with your participant."
              : copyState === "error"
                ? "Clipboard access was blocked. You can copy manually from the link above."
                : "Share this link with your participant to start the study."}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Tasks</CardTitle></CardHeader>
        <CardContent>
          <ol className="list-decimal list-inside space-y-1">
            {study.tasks.map((t: { id: string; label: string }) => <li key={t.id}>{t.label}</li>)}
          </ol>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Sessions ({sessions?.length ?? 0})</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-2">
            {sessions?.map((s: { _id: string; status: "pending" | "active" | "complete" }) => (
              <div key={s._id} className="flex items-center justify-between">
                <span className="text-sm font-mono">{s._id.slice(-8)}</span>
                <Badge variant={s.status === "complete" ? "default" : "secondary"}>{s.status}</Badge>
                {s.status === "complete" && (
                  <Button size="sm" asChild><Link href={`/dashboard/${s._id}`}>View Results</Link></Button>
                )}
              </div>
            ))}
            {sessions?.length === 0 && <p className="text-sm text-muted-foreground">No sessions yet. Share the participant link.</p>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
