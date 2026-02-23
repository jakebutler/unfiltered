"use client";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useParams, useRouter } from "next/navigation";
import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Id } from "@/convex/_generated/dataModel";
import { PrototypeFrame } from "@/components/interview/PrototypeFrame";
import { InterviewPanel } from "@/components/interview/InterviewPanel";
import { useSpeechmatics } from "@/hooks/useSpeechmatics";
import { useMouseTracker } from "@/hooks/useMouseTracker";
import { useCamera } from "@/hooks/useCamera";
import { useSignalProcessor } from "@/hooks/useSignalProcessor";
import { useDecideEngine } from "@/hooks/useDecideEngine";
import { extractSignals } from "@/lib/signals/extractor";
import { speak } from "@/lib/tts";
import type { SignalResult } from "@/lib/signals/extractor";
import type { LatencyStage } from "@/lib/telemetry/latency";
import { isExperimentTelemetryEnabled } from "@/lib/telemetry/runtime";

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
  const telemetryEnabled = isExperimentTelemetryEnabled(process.env);
  const params = useParams();
  const router = useRouter();
  const sessionId = params.sessionId as Id<"sessions">;
  const data = useQuery(api.sessions.getWithStudy, { sessionId });
  const segments = useQuery(api.transcripts.listBySession, { sessionId });
  const latestEngagement = useQuery(api.engagements.getLatest, { sessionId });
  const mouseWindows = useQuery(api.mouse.listBySession, { sessionId });
  const signalWindows = useQuery(api.signals.listBySession, { sessionId });
  const decideEvents = useQuery(api.decide.listBySession, { sessionId });
  const activeExperimentRun = useQuery(
    api.telemetry.getActiveRunBySession,
    telemetryEnabled ? { sessionId } : "skip",
  );
  const endTurn = useMutation(api.sessions.endTurn);
  const addSegment = useMutation(api.transcripts.addSegment);
  const storeDecideEventMutation = useMutation(api.decide.storeEvent);
  const detectFriction = useAction(api.friction.detectAndStore);
  const labelMoments = useAction(api.findings.labelAllMoments);
  const generateThemes = useAction(api.findings.generateThemes);
  const recordLatencyEventMutation = useMutation(api.telemetry.recordLatencyEvent);

  const [interviewerStatus, setInterviewerStatus] = useState<"listening" | "thinking" | "speaking">("listening");
  const [latestSignals, setLatestSignals] = useState<SignalResult | null>(null);
  const [signalProcessorError, setSignalProcessorError] = useState<string | null>(null);

  const sessionStartRef = useRef<number>(Date.now());
  const taskStartRef = useRef<number>(Date.now());
  const latestMouseRef = useRef({ inactiveSec: 0, erraticness: 0, repeatClicksSameRegion: 0, scrollBursts: 0 });
  const introSpokenRef = useRef(false);
  const notifyParticipantUtteranceRef = useRef<(payload: { wordCount: number }) => void>(() => undefined);
  const triggerDecideRef = useRef<(signals: SignalResult, friction0to100: number) => void>(() => undefined);
  const recentSpeechWordsRef = useRef<{ text: string; startTime: number; duration: number }[]>([]);
  const lastLiveDecideAtMsRef = useRef(0);
  const activeTurnIdRef = useRef<string | undefined>(undefined);

  const currentTaskIndex = data?.session?.currentTaskIndex ?? 0;
  const currentTaskId = data?.study?.tasks[currentTaskIndex]?.id;
  const currentTaskLabel = data?.study?.tasks[currentTaskIndex]?.label;

  const handleEndTurn = useCallback(async () => {
    if (!data?.session) return;
    const result = await endTurn({ sessionId });
    if (result.completed) {
      await detectFriction({ sessionId }).catch(() => undefined);
      await labelMoments({ sessionId }).catch(() => undefined);
      await generateThemes({ sessionId }).catch(() => undefined);
      router.push(`/dashboard/${sessionId}`);
    }
  }, [data, sessionId, endTurn, detectFriction, labelMoments, generateThemes, router]);

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
    const turnId = `turn_${Date.now()}_${Math.round(normalizedWords[normalizedWords.length - 1].startTime * 1000)}`;
    activeTurnIdRef.current = turnId;
    notifyParticipantUtteranceRef.current({ wordCount: normalizedWords.length });

    const latestEnd = normalizedWords[normalizedWords.length - 1].startTime + normalizedWords[normalizedWords.length - 1].duration;
    if (telemetryEnabled) {
      void recordLatencyEventMutation({
        sessionId,
        runId: activeExperimentRun?._id,
        turnId,
        stage: "participant_last_word_end",
        t: Date.now(),
        meta: JSON.stringify({ transcriptEndSec: latestEnd, wordCount: normalizedWords.length }),
      }).catch(() => undefined);
    }
    recentSpeechWordsRef.current = [...recentSpeechWordsRef.current, ...normalizedWords]
      .filter((w) => w.startTime >= latestEnd - 20);

    const liveSignals = extractSignals(recentSpeechWordsRef.current, 15);
    const hasImmediateCue = (
      liveSignals.explicitUncertaintyCount >= 1 ||
      liveSignals.clarificationCount >= 1 ||
      liveSignals.negAffectCount >= 1 ||
      liveSignals.repeatAttemptLoopFlag ||
      /\bconfus|not sure|unclear|don'?t know|dont know|stuck\b/i.test(event.text)
    );
    const nowMs = Date.now();
    if (hasImmediateCue && nowMs - lastLiveDecideAtMsRef.current >= 1000) {
      lastLiveDecideAtMsRef.current = nowMs;
      triggerDecideRef.current(liveSignals, 90);
    }

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
  }, [sessionId, activeExperimentRun?._id, addSegment, currentTaskId, recordLatencyEventMutation, telemetryEnabled]);

  const { start: startSpeechmatics, stop: stopSpeechmatics } = useSpeechmatics(handleTranscript);
  const { recordEvent: recordMouseEvent, flushWindow: flushMouseWindow } = useMouseTracker();

  const segmentWords = useMemo(
    () =>
      (segments ?? []).flatMap(
        (segment: { words?: { text: string; startTime: number; duration: number }[] }) => segment.words ?? [],
      ),
    [segments],
  );

  const recentTranscript = (segments ?? []).slice(-3).map((s: { text: string }) => s.text).join(" ");
  const { start: startCamera, stop: stopCamera, cameraActive } = useCamera(sessionId, currentTaskId, currentTaskLabel, recentTranscript);

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

  const recordLatencyEvent = useCallback((event: { stage: LatencyStage; t?: number; turnId?: string; meta?: Record<string, unknown> }) => {
    if (!telemetryEnabled) return;
    void recordLatencyEventMutation({
      sessionId,
      runId: activeExperimentRun?._id,
      turnId: event.turnId ?? activeTurnIdRef.current,
      stage: event.stage,
      t: event.t,
      meta: event.meta ? JSON.stringify(event.meta) : undefined,
    }).catch(() => undefined);
  }, [activeExperimentRun?._id, recordLatencyEventMutation, sessionId, telemetryEnabled]);

  const { triggerDecide, notifyParticipantUtterance } = useDecideEngine({
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
    getActiveTurnId: () => activeTurnIdRef.current,
    onStatusChange: setInterviewerStatus,
    onTaskAdvance: handleEndTurn,
    storeDecideEvent,
    recordLatencyEvent,
  });
  notifyParticipantUtteranceRef.current = notifyParticipantUtterance;
  triggerDecideRef.current = triggerDecide;

  useSignalProcessor({
    sessionId,
    taskId: currentTaskId,
    getWords: () => ({
      words: segmentWords,
      sessionOffsetSec: (Date.now() - sessionStartRef.current) / 1000,
    }),
    getMouseFlush: flushMouseWindow,
    onWindow: (score, signals, mouseSummary) => {
      setLatestSignals(signals);
      latestMouseRef.current = mouseSummary;
      triggerDecide(signals, score);
    },
    onError: setSignalProcessorError,
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
  const latestSignalWindow = (signalWindows ?? []).at(-1) as { tEnd?: number } | undefined;
  const cameraError = typeof latestEngagement?.notes === "string" && /failed|missing|invalid/i.test(latestEngagement.notes);
  const pipelineHealth = {
    camera: !cameraActive ? "off" : cameraError ? "error" : "ok",
    cameraNote: latestEngagement?.notes ?? "",
    mouseWindows: mouseWindows?.length ?? 0,
    signalWindows: signalWindows?.length ?? 0,
    decideEvents: decideEvents?.length ?? 0,
    lastSignalWindowEndSec: latestSignalWindow?.tEnd ?? null,
    signalProcessorError,
  } as const;

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
          pipelineHealth={pipelineHealth}
        />
      </div>
    </div>
  );
}
