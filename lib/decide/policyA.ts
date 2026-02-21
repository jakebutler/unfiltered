import type { DecideInput, DecideOutput } from './types';

export function runPolicyA(input: DecideInput): DecideOutput {
  const { taskTimeSec, taskLabel, engagementState, mouseSummary, conversationCues, hardOverrides } = input;

  // STEP 0 — Hard overrides
  if (hardOverrides.mustMoveOn) {
    return { action: "move_to_next_task", probeType: "move_on", nextPrompt: "Let's move on to the next task. No worries—what would you do next?", rationale: `Hard override: ${hardOverrides.reason}`, confidence: 0.95 };
  }

  // STEP 1 — Disengagement
  if (engagementState.state === "disengaged_away" && engagementState.confidence >= 0.65) {
    if (mouseSummary.inactiveSec >= 8) {
      return { action: "move_to_next_task", probeType: "move_on", nextPrompt: "Want to keep going, or should we move to the next task?", rationale: "disengaged_away + high mouse inactivity", confidence: 0.85 };
    }
    return { action: "reflect_back", probeType: "emotion_checkin", nextPrompt: "No rush—are you still with me? What are you looking for right now?", rationale: "disengaged_away, moderate confidence", confidence: 0.75 };
  }

  // STEP 2 — High-signal frustration / breakdown
  if (conversationCues.negAffectCount >= 1) {
    return { action: "ask_followup", probeType: "system_status", nextPrompt: "It sounds like something isn't working as expected—what did you expect to happen?", rationale: "Negative affect detected", confidence: 0.90 };
  }
  if (conversationCues.repeatAttemptLoopFlag || mouseSummary.repeatClicksSameRegion >= 2) {
    return { action: "ask_followup", probeType: "system_status", nextPrompt: "I noticed repeated attempts there—what feedback did you expect after that action?", rationale: "Repeat attempt loop or repeated clicks", confidence: 0.85 };
  }

  // STEP 3 — Explicit confusion / uncertainty
  if (conversationCues.explicitUncertaintyCount >= 1 || conversationCues.clarificationCount >= 1) {
    return { action: "ask_followup", probeType: "comprehension", nextPrompt: "What's confusing or unclear right now? What were you expecting to find?", rationale: "Explicit uncertainty or clarification request", confidence: 0.85 };
  }

  // STEP 4 — Stuck pattern (multi-signal corroboration)
  const stuckScore = [
    conversationCues.veryLongPauseCount >= 1,
    conversationCues.longPauseCount >= 2,
    conversationCues.repairsPer100w >= 3,
    conversationCues.repetitionsPer100w >= 3,
    mouseSummary.inactiveSec >= 6,
    mouseSummary.erraticness >= 0.65,
    engagementState.state === "engaged_stuck" && engagementState.confidence >= 0.60,
  ].filter(Boolean).length;

  if (stuckScore >= 2) {
    return { action: "ask_followup", probeType: "expectation", nextPrompt: "What are you trying to do right now, and what did you expect would happen?", rationale: `STUCK_SCORE=${stuckScore}`, confidence: 0.80 };
  }

  // STEP 5 — Task prompt / instruction issues (early in task)
  if (conversationCues.clarificationCount >= 1 && taskTimeSec <= 20) {
    return { action: "clarify_task", probeType: "navigation", nextPrompt: `Just to restate the task: please try to ${taskLabel}. Tell me what you're thinking as you do it.`, rationale: "Clarification requested early in task", confidence: 0.75 };
  }

  // STEP 6 — Low friction / smooth progress
  if (
    engagementState.state === "engaged_active" && engagementState.confidence >= 0.60 &&
    mouseSummary.inactiveSec < 6 &&
    conversationCues.explicitUncertaintyCount === 0 &&
    conversationCues.clarificationCount === 0 &&
    conversationCues.negAffectCount === 0 &&
    conversationCues.veryLongPauseCount === 0
  ) {
    return { action: "wait", probeType: "none", nextPrompt: "Take your time—tell me what you're thinking as you go.", rationale: "Engaged_active, low friction", confidence: 0.70 };
  }

  // STEP 7 — Default catch-all
  return { action: "ask_followup", probeType: "navigation", nextPrompt: "What would you do next, and why?", rationale: "Default fallback", confidence: 0.60 };
}
