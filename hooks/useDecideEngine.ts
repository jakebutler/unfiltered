"use client";
import { useCallback, useEffect, useRef } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { shouldUseDeterministicFastPath } from "@/lib/decide/fastPath";
import { runPolicyA } from "@/lib/decide/policyA";
import { shouldTriggerDecide } from "@/lib/decide/shouldTrigger";
import { buildConfusionProbe, buildExpectationProbe, buildPositiveProbe, hasConfusionFeedback, hasNoMoreToAdd, hasPositiveFeedback } from "@/lib/decide/transcriptHeuristics";
import {
  DEFAULT_INTERRUPTION_ACK_COOLDOWN_MS,
  DEFAULT_MIN_PARTICIPANT_SILENCE_MS,
  DEFAULT_MIN_PROMPT_GAP_MS,
  computePromptDelayMs,
  shouldAcknowledgeInterruption,
  shouldThrottleInterviewerPrompt,
} from "@/lib/decide/turnTaking";
import { resolveTimingConfig } from "@/lib/decide/runtimeConfig";
import { speak } from "@/lib/tts";
import type { VoiceStyleProfile } from "@/lib/elevenlabs";
import type { SignalResult } from "@/lib/signals/extractor";
import type { Action } from "@/lib/decide/types";
import type { LatencyStage } from "@/lib/telemetry/latency";

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
  getActiveTurnId: () => string | undefined;
  onStatusChange: (status: "listening" | "thinking" | "speaking") => void;
  onTaskAdvance: () => void;
  storeDecideEvent: (event: { policyUsed: "deterministic" | "llm"; inputSummary: string; outputAction: string; outputPrompt: string; probeType: string; confidence: number }) => Promise<void>;
  recordLatencyEvent: (event: { stage: LatencyStage; t?: number; turnId?: string; meta?: Record<string, unknown> }) => void;
}

const ACTION_VOICE_STYLE: Record<string, VoiceStyleProfile> = {
  ask_followup: "followup",
  clarify_task: "instruction",
  reflect_back: "empathy",
  move_to_next_task: "transition",
};
const INTERRUPTION_APOLOGY_PROMPT = "Sorry, I jumped in. Please continue.";

export function useDecideEngine(props: Props) {
  const runPolicyBAction = useAction(api.decide.runPolicyB);
  const isSpeakingRef = useRef(false);
  const isDecidingRef = useRef(false);
  const lastInterviewerPromptRef = useRef("");
  const lastPromptAtMsRef = useRef(0);
  const lastParticipantSpeechAtMsRef = useRef(0);
  const lastInterruptionAckAtMsRef = useRef(0);
  const pendingPromptTimeoutRef = useRef<number | null>(null);
  const didLogTimingConfigRef = useRef(false);
  const timingResolution = useRef(resolveTimingConfig(process.env)).current;
  const minParticipantSilenceMs = timingResolution.values.minParticipantSilenceMs;
  const minPromptGapMs = timingResolution.values.minPromptGapMs;
  const interruptionAckCooldownMs = timingResolution.values.interruptionAckCooldownMs;

  const clearPendingPrompt = useCallback(() => {
    if (pendingPromptTimeoutRef.current !== null) {
      window.clearTimeout(pendingPromptTimeoutRef.current);
      pendingPromptTimeoutRef.current = null;
    }
  }, []);

  const speakPrompt = useCallback((prompt: string, styleProfile: VoiceStyleProfile, turnId?: string) => {
    clearPendingPrompt();
    props.onStatusChange("speaking");
    isSpeakingRef.current = true;
    lastInterviewerPromptRef.current = prompt;
    lastPromptAtMsRef.current = Date.now();
    speak(prompt, undefined, () => {
      isSpeakingRef.current = false;
      props.onStatusChange("listening");
    }, {
      styleProfile,
      onTelemetry: ({ stage, t, meta }) => {
        props.recordLatencyEvent({ stage, t, turnId, meta });
      },
    });
  }, [clearPendingPrompt, props]);

  useEffect(() => () => clearPendingPrompt(), [clearPendingPrompt]);
  useEffect(() => {
    if (didLogTimingConfigRef.current) return;
    didLogTimingConfigRef.current = true;
    props.recordLatencyEvent({
      stage: "timing_config_resolved",
      meta: {
        ...timingResolution.values,
        warnings: timingResolution.warnings,
        defaults: {
          minParticipantSilenceMs: DEFAULT_MIN_PARTICIPANT_SILENCE_MS,
          minPromptGapMs: DEFAULT_MIN_PROMPT_GAP_MS,
          interruptionAckCooldownMs: DEFAULT_INTERRUPTION_ACK_COOLDOWN_MS,
        },
      },
    });
    if (timingResolution.warnings.length > 0) {
      console.warn(`[TimingConfig] ${timingResolution.warnings.join(" | ")}`);
    }
  }, [props, timingResolution]);

  const notifyParticipantUtterance = useCallback((utterance: { wordCount: number }) => {
    const now = Date.now();
    if (utterance.wordCount > 0) {
      lastParticipantSpeechAtMsRef.current = now;
    }

    if (!shouldAcknowledgeInterruption({
      isInterviewerSpeaking: isSpeakingRef.current,
      participantWordCount: utterance.wordCount,
      nowMs: now,
      lastInterruptionAckAtMs: lastInterruptionAckAtMsRef.current,
      cooldownMs: interruptionAckCooldownMs,
    })) {
      return;
    }

    lastInterruptionAckAtMsRef.current = now;
    void props.storeDecideEvent({
      policyUsed: "deterministic",
      inputSummary: JSON.stringify({ fallback: "interruption_acknowledgment" }),
      outputAction: "ask_followup",
      outputPrompt: INTERRUPTION_APOLOGY_PROMPT,
      probeType: "none",
      confidence: 0.9,
    });
    speakPrompt(INTERRUPTION_APOLOGY_PROMPT, "empathy", props.getActiveTurnId());
  }, [interruptionAckCooldownMs, props, speakPrompt]);

  const triggerDecide = useCallback(async (signals: SignalResult, friction0to100: number) => {
    if (isSpeakingRef.current || isDecidingRef.current || !props.currentTask) return;
    const transcriptTail = props.getTranscriptTail();
    const turnId = props.getActiveTurnId();
    const now = Date.now();
    props.recordLatencyEvent({ stage: "decide_trigger", t: now, turnId });
    if (!shouldTriggerDecide(signals, friction0to100, transcriptTail)) return;
    isDecidingRef.current = true;

    try {
      props.onStatusChange("thinking");
      props.recordLatencyEvent({ stage: "policy_start", turnId });
      const engagement = props.getLatestEngagement();
      const mouse = props.getLatestMouseSummary();
      const taskTimeSec = props.getTaskTimeSec();

      const hardOverrides = { mustMoveOn: false, reason: "" };

      let result: { action: string; nextPrompt: string; probeType: string; confidence: number };

      // decideMode should be resolved at session creation; AB should not reach runtime.
      const effectivePolicy = props.decideMode === "AB" ? "B" : props.decideMode;

      if (effectivePolicy === "A" || shouldUseDeterministicFastPath(signals, transcriptTail)) {
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
          inputSummary: JSON.stringify({
            friction0to100,
            fastPath: effectivePolicy === "B",
            signals: {
              explicitUncertaintyCount: signals.explicitUncertaintyCount,
              clarificationCount: signals.clarificationCount,
              negAffectCount: signals.negAffectCount,
              repeatAttemptLoopFlag: signals.repeatAttemptLoopFlag,
            },
          }),
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
            lastInterviewerPrompt: lastInterviewerPromptRef.current,
            lastParticipantUtterance: transcriptTail.slice(-200),
            transcriptTail: transcriptTail.slice(-500),
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

        if (result.action === "wait") {
          const deterministicFallback = runPolicyA({
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

          if (deterministicFallback.action !== "wait") {
            result = {
              action: deterministicFallback.action,
              nextPrompt: deterministicFallback.nextPrompt,
              probeType: deterministicFallback.probeType,
              confidence: deterministicFallback.confidence,
            };
            await props.storeDecideEvent({
              policyUsed: "deterministic",
              inputSummary: JSON.stringify({ fallback: "policyA_after_policyB_wait", friction0to100 }),
              outputAction: result.action,
              outputPrompt: result.nextPrompt,
              probeType: result.probeType,
              confidence: result.confidence,
            });
          }
        }

        if (result.action === "wait") {
          const askedForMoreDetail = /(specifically worked well|anything else|tell me more)/i.test(lastInterviewerPromptRef.current);
          const recentlyPrompted = now - lastPromptAtMsRef.current < minPromptGapMs;

          if (hasNoMoreToAdd(transcriptTail) && askedForMoreDetail) {
            result = {
              action: "move_to_next_task",
              nextPrompt: "Thanks, that helps. Let's move to the next task.",
              probeType: "move_on",
              confidence: 0.78,
            };
            await props.storeDecideEvent({
              policyUsed: "deterministic",
              inputSummary: JSON.stringify({ fallback: "move_on_after_no_more_to_add", friction0to100 }),
              outputAction: result.action,
              outputPrompt: result.nextPrompt,
              probeType: result.probeType,
              confidence: result.confidence,
            });
          } else if (
            !recentlyPrompted &&
            hasPositiveFeedback(transcriptTail) &&
            signals.longPauseCount >= 2
          ) {
            result = {
              action: "ask_followup",
              nextPrompt: buildPositiveProbe(lastInterviewerPromptRef.current),
              probeType: "expectation",
              confidence: 0.74,
            };
            await props.storeDecideEvent({
              policyUsed: "deterministic",
              inputSummary: JSON.stringify({ fallback: "positive_probe_after_wait", friction0to100 }),
              outputAction: result.action,
              outputPrompt: result.nextPrompt,
              probeType: result.probeType,
              confidence: result.confidence,
            });
          } else if (!recentlyPrompted && hasConfusionFeedback(transcriptTail)) {
            result = {
              action: "ask_followup",
              nextPrompt: buildConfusionProbe(transcriptTail, lastInterviewerPromptRef.current),
              probeType: "comprehension",
              confidence: 0.76,
            };
            await props.storeDecideEvent({
              policyUsed: "deterministic",
              inputSummary: JSON.stringify({ fallback: "confusion_probe_after_wait", friction0to100 }),
              outputAction: result.action,
              outputPrompt: result.nextPrompt,
              probeType: result.probeType,
              confidence: result.confidence,
            });
          }
        }
      }

      if (
        result.probeType === "expectation" &&
        /what did you expect would happen/i.test(result.nextPrompt)
      ) {
        result = {
          ...result,
          nextPrompt: buildExpectationProbe(lastInterviewerPromptRef.current),
        };
      }

      if (result.action === "move_to_next_task") {
        props.onTaskAdvance();
      }
      props.recordLatencyEvent({ stage: "policy_end", turnId });

      if (result.action !== "wait") {
        props.recordLatencyEvent({
          stage: "prompt_selected",
          turnId,
          meta: { action: result.action, probeType: result.probeType, confidence: result.confidence },
        });
        const action = result.action as Action;
        const shouldRespectCadence = !hasNoMoreToAdd(transcriptTail);
        const promptDelayMs = shouldRespectCadence
          ? computePromptDelayMs({
              nowMs: now,
              lastPromptAtMs: lastPromptAtMsRef.current,
              lastParticipantSpeechAtMs: lastParticipantSpeechAtMsRef.current,
              action,
              minParticipantSilenceMs,
              minPromptGapMs,
            })
          : 0;

        const styleProfile = ACTION_VOICE_STYLE[result.action] ?? "followup";
        if (promptDelayMs > 0) {
          clearPendingPrompt();
          pendingPromptTimeoutRef.current = window.setTimeout(() => {
            pendingPromptTimeoutRef.current = null;
            const delayedNow = Date.now();
            const refreshedTail = props.getTranscriptTail();
            if (
              isSpeakingRef.current ||
              !props.currentTask ||
              (
                !hasNoMoreToAdd(refreshedTail) &&
                shouldThrottleInterviewerPrompt({
                  nowMs: delayedNow,
                  lastPromptAtMs: lastPromptAtMsRef.current,
                  lastParticipantSpeechAtMs: lastParticipantSpeechAtMsRef.current,
                  action,
                  minParticipantSilenceMs,
                  minPromptGapMs,
                })
              )
            ) {
              return;
            }
            speakPrompt(result.nextPrompt, styleProfile, turnId);
          }, promptDelayMs);
          props.onStatusChange("listening");
          return;
        }

        speakPrompt(result.nextPrompt, styleProfile, turnId);
      } else {
        props.onStatusChange("listening");
      }
    } finally {
      isDecidingRef.current = false;
    }
  }, [clearPendingPrompt, minParticipantSilenceMs, minPromptGapMs, props, runPolicyBAction, speakPrompt]);

  return { triggerDecide, notifyParticipantUtterance };
}
