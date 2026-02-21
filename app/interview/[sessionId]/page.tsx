"use client";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useParams, useRouter } from "next/navigation";
import { useState, useCallback, useEffect, useRef } from "react";
import { Id } from "@/convex/_generated/dataModel";
import { PrototypeFrame } from "@/components/interview/PrototypeFrame";
import { InterviewPanel } from "@/components/interview/InterviewPanel";
import { useSpeechmatics } from "@/hooks/useSpeechmatics";
import { useMouseTracker } from "@/hooks/useMouseTracker";
import { useCamera } from "@/hooks/useCamera";
import { useSignalProcessor } from "@/hooks/useSignalProcessor";
import { useDecideEngine } from "@/hooks/useDecideEngine";
import { speak } from "@/lib/tts";
import type { SignalResult } from "@/lib/signals/extractor";

async function requestMediaPermission(constraints: MediaStreamConstraints): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    stream.getTracks().forEach((track) => track.stop());
    return true;
  } catch {
    return false;
  }
}

export default function InterviewPage() {
  const params = useParams();
  const router = useRouter();
  const sessionId = params.sessionId as Id<"sessions">;
  const data = useQuery(api.sessions.getWithStudy, { sessionId });
  const segments = useQuery(api.transcripts.listBySession, { sessionId });
  const latestEngagement = useQuery(api.engagements.getLatest, { sessionId });
  const advanceTask = useMutation(api.sessions.advanceTask);
  const endSession = useMutation(api.sessions.end);
  const addSegment = useMutation(api.transcripts.addSegment);
  const storeDecideEventMutation = useMutation(api.decide.storeEvent);
  const detectFriction = useAction(api.friction.detectAndStore);
  const labelMoments = useAction(api.findings.labelAllMoments);
  const generateThemes = useAction(api.findings.generateThemes);

  const [interviewerStatus, setInterviewerStatus] = useState<"listening" | "thinking" | "speaking">("listening");
  const [latestSignals, setLatestSignals] = useState<SignalResult | null>(null);

  const wordBufferRef = useRef<{ text: string; startTime: number; duration: number }[]>([]);
  const sessionStartRef = useRef<number>(Date.now());
  const taskStartRef = useRef<number>(Date.now());
  const latestMouseRef = useRef({ inactiveSec: 0, erraticness: 0, repeatClicksSameRegion: 0, scrollBursts: 0 });
  const introSpokenRef = useRef(false);

  const currentTaskIndex = data?.session?.currentTaskIndex ?? 0;
  const currentTaskId = data?.study?.tasks[currentTaskIndex]?.id;
  const currentTaskLabel = data?.study?.tasks[currentTaskIndex]?.label;

  const handleEndTurn = useCallback(async () => {
    if (!data?.session) return;
    const { session, study } = data;
    if (!study) return;
    const nextIndex = session.currentTaskIndex + 1;
    if (nextIndex >= study.tasks.length) {
      await endSession({ sessionId });
      await detectFriction({ sessionId });
      await labelMoments({ sessionId });
      await generateThemes({ sessionId });
      router.push(`/dashboard/${sessionId}`);
    } else {
      await advanceTask({ sessionId });
    }
  }, [data, sessionId, advanceTask, endSession, detectFriction, labelMoments, generateThemes, router]);

  const handleTranscript = useCallback(async (event: { text: string; words: { text: string; startTime: number; duration: number }[]; startTime: number; endTime: number }) => {
    const normalizedWords = event.words
      .filter((w) => w.text.trim() && Number.isFinite(w.startTime))
      .map((w, i, arr) => {
        if (Number.isFinite(w.duration) && w.duration > 0) return w;
        const next = arr[i + 1];
        const inferred = next && next.startTime > w.startTime ? next.startTime - w.startTime : 0.25;
        return { ...w, duration: inferred };
      });
    if (normalizedWords.length === 0) return;

    wordBufferRef.current.push(...normalizedWords);
    await addSegment({
      sessionId,
      speakerId: "participant",
      text: event.text,
      words: normalizedWords,
      startTime: normalizedWords[0].startTime,
      endTime:
        normalizedWords[normalizedWords.length - 1].startTime +
        normalizedWords[normalizedWords.length - 1].duration,
      taskId: currentTaskId,
    });
  }, [sessionId, addSegment, currentTaskId]);

  const { start: startSpeechmatics, stop: stopSpeechmatics } = useSpeechmatics(handleTranscript);
  const { recordEvent: recordMouseEvent, flushWindow: flushMouseWindow } = useMouseTracker();

  const recentTranscript = (segments ?? []).slice(-3).map((s: { text: string }) => s.text).join(" ");
  const { start: startCamera, stop: stopCamera } = useCamera(sessionId, currentTaskId, currentTaskLabel, recentTranscript);

  const storeDecideEvent = useCallback(async (event: { policyUsed: "deterministic" | "llm"; inputSummary: string; outputAction: string; outputPrompt: string; probeType: string; confidence: number }) => {
    await storeDecideEventMutation({
      sessionId,
      policyUsed: event.policyUsed,
      inputSummary: event.inputSummary,
      outputAction: event.outputAction as "ask_followup" | "clarify_task" | "reflect_back" | "move_to_next_task" | "wait",
      outputPrompt: event.outputPrompt,
      probeType: event.probeType as "expectation" | "comprehension" | "navigation" | "system_status" | "emotion_checkin" | "move_on" | "none",
      confidence: event.confidence,
    });
  }, [sessionId, storeDecideEventMutation]);

  const { triggerDecide } = useDecideEngine({
    sessionId,
    decideMode: (data?.session as { decideMode?: "A" | "B" } | null)?.decideMode ?? "B",
    prototypeUrl: data?.study?.prototypeUrl ?? "",
    taskList: data?.study?.tasks ?? [],
    currentTask: data?.study?.tasks[currentTaskIndex] ?? null,
    getTaskTimeSec: () => Math.round((Date.now() - taskStartRef.current) / 1000),
    getLatestEngagement: () =>
      latestEngagement
        ? { state: latestEngagement.state, confidence: latestEngagement.confidence }
        : null,
    getLatestMouseSummary: () => latestMouseRef.current,
    getTranscriptTail: () => (segments ?? []).slice(-5).map((s: { text: string }) => s.text).join(" "),
    onStatusChange: setInterviewerStatus,
    onTaskAdvance: handleEndTurn,
    storeDecideEvent,
  });

  useSignalProcessor({
    sessionId,
    taskId: currentTaskId,
    getWords: () => ({
      words: wordBufferRef.current,
      sessionOffsetSec: (Date.now() - sessionStartRef.current) / 1000,
    }),
    getMouseFlush: flushMouseWindow,
    onWindow: (score, signals, mouseSummary) => {
      setLatestSignals(signals);
      latestMouseRef.current = mouseSummary;
      triggerDecide(signals, score);
    },
  });

  const handleMouseEvent = useCallback((event: { type: "move" | "click" | "scroll"; x?: number; y?: number; button?: string; delta?: number; t: number }) => {
    recordMouseEvent(event);
  }, [recordMouseEvent]);

  // Request browser permissions and start capture.
  useEffect(() => {
    let isMounted = true;
    const cameraConsented = typeof sessionStorage !== "undefined" && sessionStorage.getItem("cameraConsent") === "true";

    sessionStartRef.current = Date.now();
    taskStartRef.current = Date.now();

    const bootstrapMedia = async () => {
      const micGranted = await requestMediaPermission({ audio: true });
      const cameraGranted = cameraConsented
        ? await requestMediaPermission({ video: { width: 640 } })
        : true;

      if (!isMounted) return;

      if (micGranted) startSpeechmatics();
      if (cameraConsented && cameraGranted) startCamera();
    };

    void bootstrapMedia();

    return () => {
      isMounted = false;
      stopSpeechmatics();
      stopCamera();
    };
  }, [startSpeechmatics, stopSpeechmatics, startCamera, stopCamera]);

  useEffect(() => {
    taskStartRef.current = Date.now();
  }, [currentTaskId]);

  // Speak opening prompt only after reminder has played and required permissions are granted.
  useEffect(() => {
    if (!data?.study) return;
    if (introSpokenRef.current) return;
    const task = data.study.tasks[0];
    if (!task) return;

    introSpokenRef.current = true;
    const intro = `If you haven't yet, allow your browser access to your camera and microphone for this session. Hi! I'm your AI interviewer. Let's get started. Your first task is: ${task.label}. Please think out loud as you work through it. Take your time.`;
    setInterviewerStatus("speaking");
    speak(intro, undefined, () => setInterviewerStatus("listening"), { styleProfile: "intro" });
  }, [data?.study]);

  if (!data?.session || !data.study) return <div className="p-8">Loading session…</div>;

  const { session, study } = data;
  const currentTask = study.tasks[session.currentTaskIndex] ?? null;

  void latestSignals; // used via triggerDecide

  return (
    <div className="flex h-screen">
      <div className="flex-1 bg-muted">
        <PrototypeFrame url={study.prototypeUrl} onMouseEvent={handleMouseEvent} />
      </div>
      <div className="w-80 border-l bg-background flex flex-col">
        <InterviewPanel
          status={interviewerStatus}
          segments={segments ?? []}
          currentTask={currentTask}
          taskIndex={session.currentTaskIndex}
          totalTasks={study.tasks.length}
          onEndTurn={handleEndTurn}
        />
      </div>
    </div>
  );
}
