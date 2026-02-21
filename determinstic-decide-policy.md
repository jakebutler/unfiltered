Deterministic Decide Policy (Policy A) — “Guardrails + Simple Rules”
Purpose: Choose next interviewer action using only deterministic rules from realtime signals.
Allowed actions: ask_followup | clarify_task | reflect_back | move_to_next_task | wait

Inputs (latest window + lightweight context):
- task_time_sec
- engagement_state.state + engagement_state.confidence
- mouse_summary: inactive_sec, repeat_clicks_same_region, erraticness (0..1), scroll_bursts
- conversation_cues:
  - explicit_uncertainty_count
  - clarification_count
  - neg_affect_count
  - very_long_pause_count (>=3.0s)
  - long_pause_count (>=1.5s)
  - repairs_per_100w
  - repetitions_per_100w
  - hedges_per_100w
  - repeat_attempt_loop_flag
  - clarity_index
- hard_overrides (precomputed): must_move_on bool, reason

Output:
- action
- probe_type (expectation | comprehension | navigation | system_status | emotion_checkin | move_on | none)
- next_prompt (short, <=220 chars)
- rationale (short)
- confidence (0..1)  // deterministic fixed values are ok

------------------------------------------------------------
STEP 0 — Hard Overrides (highest priority)
If hard_overrides.must_move_on == true:
  action = move_to_next_task
  probe_type = move_on
  next_prompt = "Let’s move on to the next task. No worries—what would you do next?"
  confidence = 0.95
  STOP.

------------------------------------------------------------
STEP 1 — Disengagement / Away
If engagement_state.state == "disengaged_away" AND engagement_state.confidence >= 0.65:
  If mouse_summary.inactive_sec >= 8:
    action = move_to_next_task
    probe_type = move_on
    next_prompt = "Want to keep going, or should we move to the next task?"
    confidence = 0.85
  Else:
    action = reflect_back
    probe_type = emotion_checkin
    next_prompt = "No rush—are you still with me? What are you looking for right now?"
    confidence = 0.75
  STOP.

------------------------------------------------------------
STEP 2 — High-Signal Frustration / Breakdown
If conversation_cues.neg_affect_count >= 1:
  action = ask_followup
  probe_type = system_status
  next_prompt = "It sounds like something isn’t working as expected—what did you expect to happen?"
  confidence = 0.90
  STOP.

If conversation_cues.repeat_attempt_loop_flag == true OR mouse_summary.repeat_clicks_same_region >= 2:
  action = ask_followup
  probe_type = system_status
  next_prompt = "I noticed repeated attempts there—what feedback did you expect after that action?"
  confidence = 0.85
  STOP.

------------------------------------------------------------
STEP 3 — Explicit Confusion / Uncertainty
If conversation_cues.explicit_uncertainty_count >= 1 OR conversation_cues.clarification_count >= 1:
  action = ask_followup
  probe_type = comprehension
  next_prompt = "What’s confusing or unclear right now? What were you expecting to find?"
  confidence = 0.85
  STOP.

------------------------------------------------------------
STEP 4 — “Stuck” Pattern (multi-signal corroboration)
Define STUCK_SCORE as count of:
- (conversation_cues.very_long_pause_count >= 1)
- (conversation_cues.long_pause_count >= 2)
- (conversation_cues.repairs_per_100w >= 3)
- (conversation_cues.repetitions_per_100w >= 3)
- (mouse_summary.inactive_sec >= 6)
- (mouse_summary.erraticness >= 0.65)
- (engagement_state.state == "engaged_stuck" AND engagement_state.confidence >= 0.60)

If STUCK_SCORE >= 2:
  action = ask_followup
  probe_type = expectation
  next_prompt = "What are you trying to do right now, and what did you expect would happen?"
  confidence = 0.80
  STOP.

------------------------------------------------------------
STEP 5 — Task Prompt / Instruction Issues
If (conversation_cues.clarification_count >= 1) AND (task_time_sec <= 20):
  action = clarify_task
  probe_type = navigation
  next_prompt = "Just to restate the task: please try to [TASK_LABEL]. Tell me what you’re thinking as you do it."
  confidence = 0.75
  STOP.

------------------------------------------------------------
STEP 6 — Low Friction / Smooth Progress
If engagement_state.state == "engaged_active" AND engagement_state.confidence >= 0.60 AND
   mouse_summary.inactive_sec < 6 AND
   conversation_cues.explicit_uncertainty_count == 0 AND
   conversation_cues.clarification_count == 0 AND
   conversation_cues.neg_affect_count == 0 AND
   conversation_cues.very_long_pause_count == 0:
  action = wait
  probe_type = none
  next_prompt = "Take your time—tell me what you’re thinking as you go."
  confidence = 0.70
  STOP.

------------------------------------------------------------
STEP 7 — Default (catch-all)
action = ask_followup
probe_type = navigation
next_prompt = "What would you do next, and why?"
confidence = 0.60
STOP.
