"use client";
import { useCallback, useRef } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { runPolicyA } from "@/lib/decide/policyA";
import { shouldTriggerDecide } from "@/lib/decide/shouldTrigger";
import { speak } from "@/lib/tts";
import type { VoiceStyleProfile } from "@/lib/elevenlabs";
import type { SignalResult } from "@/lib/signals/extractor";

interface Props {
  sessionId: Id<"sessions">;
  decideMode: "A" | "B" | "AB";
  prototypeUrl: string;
  taskList: { id: string; label: string }[];
  currentTask: { id: string; label: string } | null;
  getTaskTimeSec: () => number;
  getLatestEngagement: () => { state: string; confidence: number } | null;
  getLatestMouseSummary: () => { inactiveSec: number; erraticness: number; repeatClicksSameRegion: number; scrollBursts: number };
  getTranscriptTail: () => string;
  onStatusChange: (status: "listening" | "thinking" | "speaking") => void;
  onTaskAdvance: () => void;
  storeDecideEvent: (event: { policyUsed: "deterministic" | "llm"; inputSummary: string; outputAction: string; outputPrompt: string; probeType: string; confidence: number }) => Promise<void>;
}

const ACTION_VOICE_STYLE: Record<string, VoiceStyleProfile> = {
  ask_followup: "followup",
  clarify_task: "instruction",
  reflect_back: "empathy",
  move_to_next_task: "transition",
};

export function useDecideEngine(props: Props) {
  const runPolicyBAction = useAction(api.decide.runPolicyB);
  const isSpeakingRef = useRef(false);

  const triggerDecide = useCallback(async (signals: SignalResult, friction0to100: number) => {
    if (isSpeakingRef.current || !props.currentTask) return;
    if (!shouldTriggerDecide(signals, friction0to100)) return;

    props.onStatusChange("thinking");
    const engagement = props.getLatestEngagement();
    const mouse = props.getLatestMouseSummary();
    const taskTimeSec = props.getTaskTimeSec();

    const hardOverrides = { mustMoveOn: false, reason: "" };

    let result: { action: string; nextPrompt: string; probeType: string; confidence: number };

    // decideMode should be resolved at session creation; AB should not reach runtime.
    const effectivePolicy = props.decideMode === "AB" ? "B" : props.decideMode;

    if (effectivePolicy === "A") {
      const output = runPolicyA({
        taskTimeSec,
        taskLabel: props.currentTask.label,
        engagementState: {
          state: (engagement?.state ?? "uncertain_low_confidence") as "engaged_active" | "engaged_stuck" | "disengaged_away" | "uncertain_low_confidence",
          confidence: engagement?.confidence ?? 0,
        },
        mouseSummary: mouse,
        conversationCues: {
          explicitUncertaintyCount: signals.explicitUncertaintyCount,
          clarificationCount: signals.clarificationCount,
          negAffectCount: signals.negAffectCount,
          veryLongPauseCount: signals.veryLongPauseCount,
          longPauseCount: signals.longPauseCount,
          repairsPer100w: signals.repairsPer100w,
          repetitionsPer100w: signals.repetitionsPer100w,
          hedgesPer100w: signals.hedgesPer100w,
          repeatAttemptLoopFlag: signals.repeatAttemptLoopFlag,
          clarityIndex: signals.clarityIndex,
        },
        hardOverrides,
      });
      result = { action: output.action, nextPrompt: output.nextPrompt, probeType: output.probeType, confidence: output.confidence };

      await props.storeDecideEvent({
        policyUsed: "deterministic",
        inputSummary: JSON.stringify({ friction0to100, signals: { negAffectCount: signals.negAffectCount } }),
        outputAction: output.action,
        outputPrompt: output.nextPrompt,
        probeType: output.probeType,
        confidence: output.confidence,
      });
    } else {
      // Policy B — Convex action
      try {
        const raw = await runPolicyBAction({
          sessionId: props.sessionId,
          prototypeUrl: props.prototypeUrl,
          taskList: props.taskList,
          currentTask: props.currentTask,
          taskTimeSec,
          conversationCues: signals,
          engagementState: engagement ?? { state: "uncertain_low_confidence", confidence: 0 },
          mouseSummary: mouse,
          lastInterviewerPrompt: "",
          lastParticipantUtterance: props.getTranscriptTail().slice(-200),
          transcriptTail: props.getTranscriptTail().slice(-500),
          hardOverrides,
        });
        result = raw as { action: string; nextPrompt: string; probeType: string; confidence: number };
      } catch {
        result = {
          action: "wait",
          nextPrompt: "Take your time—tell me what you're thinking.",
          probeType: "none",
          confidence: 0.5,
        };
      }
    }

    if (result.action === "move_to_next_task") {
      props.onTaskAdvance();
    }

    if (result.action !== "wait") {
      props.onStatusChange("speaking");
      isSpeakingRef.current = true;
      const styleProfile = ACTION_VOICE_STYLE[result.action] ?? "followup";
      speak(result.nextPrompt, undefined, () => {
        isSpeakingRef.current = false;
        props.onStatusChange("listening");
      }, { styleProfile });
    } else {
      props.onStatusChange("listening");
    }
  }, [props, runPolicyBAction]);

  return { triggerDecide };
}
