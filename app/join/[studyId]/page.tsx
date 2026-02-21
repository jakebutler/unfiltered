"use client";
import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Id } from "@/convex/_generated/dataModel";
import { Camera, Mic, MousePointer2, ShieldCheck } from "lucide-react";

export default function JoinPage() {
  const params = useParams();
  const router = useRouter();
  const studyId = params.studyId as Id<"studies">;
  const study = useQuery(api.studies.get, { studyId });
  const createSession = useMutation(api.sessions.create);
  const startSession = useMutation(api.sessions.start);

  const [micConsent, setMicConsent] = useState(false);
  const [mouseConsent, setMouseConsent] = useState(false);
  const [cameraConsent, setCameraConsent] = useState(false);
  const [starting, setStarting] = useState(false);

  if (!study) return <div className="p-8">Loading…</div>;

  const canStart = micConsent && mouseConsent;

  const handleStart = async () => {
    setStarting(true);
    sessionStorage.setItem("cameraConsent", String(cameraConsent));
    const sessionId = await createSession({ studyId });
    await startSession({ sessionId });
    router.push(`/interview/${sessionId}`);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(72,187,120,0.16),_transparent_40%),linear-gradient(180deg,_hsl(var(--background))_0%,_hsl(var(--muted))_100%)] p-4 sm:p-8">
      <Card className="w-full max-w-2xl border-foreground/10 shadow-xl">
        <CardHeader>
          <CardTitle className="text-3xl tracking-tight">Welcome to &ldquo;{study.title}&rdquo;</CardTitle>
          <CardDescription className="text-base leading-relaxed">
            You&apos;re about to join a guided UX interview. We ask for a few permissions so the interviewer can understand what felt easy, what felt hard, and where the product caused friction.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="rounded-xl border border-foreground/10 bg-background/80 p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
              Built for trust
            </div>
            <ul className="space-y-1 text-sm text-muted-foreground">
              <li>We only collect signals needed to improve UX and interview quality.</li>
              <li>Raw webcam footage is not stored in this experience.</li>
              <li>If the AI infers confusion or excitement, it will confirm with you before making assumptions.</li>
            </ul>
          </div>

          <p className="text-sm font-medium">Before we start, choose what you&apos;re comfortable sharing:</p>
          <div className="space-y-3">
            <Label
              htmlFor="mic"
              className={cn(
                "cursor-pointer rounded-xl border p-4 transition-colors block space-y-2 text-sm leading-snug",
                micConsent ? "border-emerald-300 bg-emerald-50/70" : "border-border bg-background/90",
              )}
            >
              <span className="flex items-center gap-3">
                <Checkbox id="mic" checked={micConsent} onCheckedChange={(c) => setMicConsent(!!c)} />
                <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                  <span className="flex items-center gap-2 font-semibold text-foreground">
                    <Mic className="h-4 w-4 text-emerald-700" />
                    Microphone
                  </span>
                  <Badge variant="secondary">Required</Badge>
                </span>
              </span>
              <span className="block pl-7 text-foreground">
                So we can hear your think-aloud feedback and understand what made a task easy or difficult.
              </span>
              <span className="block pl-7 text-muted-foreground">
                Your voice is transcribed for this session to support analysis.
              </span>
            </Label>

            <Label
              htmlFor="mouse"
              className={cn(
                "cursor-pointer rounded-xl border p-4 transition-colors block space-y-2 text-sm leading-snug",
                mouseConsent ? "border-emerald-300 bg-emerald-50/70" : "border-border bg-background/90",
              )}
            >
              <span className="flex items-center gap-3">
                <Checkbox id="mouse" checked={mouseConsent} onCheckedChange={(c) => setMouseConsent(!!c)} />
                <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                  <span className="flex items-center gap-2 font-semibold text-foreground">
                    <MousePointer2 className="h-4 w-4 text-emerald-700" />
                    Mouse tracking
                  </span>
                  <Badge variant="secondary">Required</Badge>
                </span>
              </span>
              <span className="block pl-7 text-foreground">
                So we can see what you&apos;re clicking on, and whether things are easy or difficult to find.
              </span>
              <span className="block pl-7 text-muted-foreground">
                We record clicks, movement, and scrolling inside the prototype only.
              </span>
            </Label>

            <Label
              htmlFor="camera"
              className={cn(
                "cursor-pointer rounded-xl border p-4 transition-colors block space-y-2 text-sm leading-snug",
                cameraConsent ? "border-emerald-300 bg-emerald-50/70" : "border-border bg-background/90",
              )}
            >
              <span className="flex items-center gap-3">
                <Checkbox id="camera" checked={cameraConsent} onCheckedChange={(c) => setCameraConsent(!!c)} />
                <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                  <span className="flex items-center gap-2 font-semibold text-foreground">
                    <Camera className="h-4 w-4 text-emerald-700" />
                    Camera
                  </span>
                  <Badge variant="outline">Recommended</Badge>
                </span>
              </span>
              <span className="block pl-7 text-foreground">
                Helpful for tracking if you&apos;re confused, excited, or confident so the interviewer can ask better follow-ups.
              </span>
              <span className="block pl-7 text-muted-foreground">
                Don&apos;t worry, we&apos;ll always confirm with you before relying on emotional interpretation.
              </span>
            </Label>
          </div>

          <Button className="mt-2 h-11 w-full text-base" disabled={!canStart || starting} onClick={handleStart}>
            {starting ? "Starting session…" : "I agree — Start interview"}
          </Button>
          {!cameraConsent && (
            <p className="text-xs text-muted-foreground">
              You can continue without camera access, but enabling it gives richer context so we can improve the product faster.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
