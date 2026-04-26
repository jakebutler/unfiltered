# Unfiltered
## AI UX Researcher with Conversation Cues + Multimodal Analysis

**Working name:** Unfiltered  
**Hackathon goal:** Ship an impressive, live, end-to-end AI UX interview experience + evidence-backed findings report.  
**Primary differentiation:** Real-time *conversation cues* + lightweight multimodal signals drive adaptive interviewing and surface “stumble moments” automatically.

---

## 1) Product Overview

Unfiltered is an AI-powered UX researcher that conducts live user interviews and detects friction using:

- **Conversation cues (real-time):** transcript + timestamps → hesitation/confusion/failure-loop signals.
- **Multimodal signals (real-time):** webcam engagement classification + mouse behavior (heatmap + derived metrics).
- **Cross-reference analysis (post-session, V2):** aligns camera frames + transcript segments + interaction patterns to generate richer, verifiable findings.

Unfiltered adapts its questioning in real time and produces an evidence-backed UX findings report (moment cards + themes + recommended changes).

---

## 2) Problem

1. Founders and teams don’t run enough UX interviews.
2. Participants often filter feedback due to social desirability bias.
3. Micro-friction (hesitation, confusion) is subtle and easy to miss.
4. Reviewing recordings manually is time-consuming and unscalable.

---

## 3) Solution

Unfiltered autonomously runs a moderated session:
- reads tasks
- prompts the participant to think aloud
- detects friction moments
- probes appropriately
- produces a structured UX report with evidence pointers

**Framing:** These are *attention flags*, not diagnoses. Unfiltered augments UX researchers and accelerates review.

---

## 4) Goals (Hackathon Scope)

### Must-Have (V1)
- Live AI interviewer (real-time)
- Streaming transcription (Speechmatics)
- Real-time conversation cue extraction (rule-based signals)
- Webcam-based engagement classification (MiniMax, Option A)
- Mouse tracking + heatmap capture
- Adaptive question logic (Decide engine)
- Findings dashboard with friction “moment cards”

### Nice-to-Have
- Founder-facing “observer view” (live timeline of moments)
- Narrated executive summary (ElevenLabs)

### Stretch
- MiniMax-generated short “TikTok-style” findings video (not required for demo)

---

## 5) Target Users

- **Founder / PM / Designer** who wants quick feedback on a prototype
- **UX researcher** who wants faster review + better signal surfacing
- **Hackathon judges** evaluating novelty, sponsor use, demo clarity, and feasibility

---

## 6) Key Differentiators

1. **Real-time “stumble detection”** from transcript + timestamps (not just summarization).
2. **Multimodal corroboration** (engagement state + interaction patterns) to reduce false positives.
3. **Policy A/B mode:** deterministic vs. bounded LLM decisioning for next-question selection.
4. **Verification loop (V2):** Unfiltered can ask the founder to confirm/reject inferences, improving trust.

---

## 7) User Flows

### 7.1 Founder Flow (Setup)
1. Create Study
   - Title
   - Prototype URL (iframe)
   - Paste/upload PRD/context
   - Define 1–3 tasks
   - Select Decide mode:
     - **Mode A:** Deterministic policy
     - **Mode B:** Bounded LLM policy
     - **Mode C:** A/B run (alternating sessions)
2. Generate Interview Script
3. Create Interview Link

### 7.2 Participant Flow (Interview Room)
1. Consent
   - Mic required
   - Camera optional (recommended)
   - Mouse tracking disclosed
2. Interview Room (Split layout)
   - Left: Prototype iframe
   - Right: Interview panel
     - Status: Listening / Thinking / Speaking
     - Live transcript
     - Task progress
     - “End Turn” fallback button

---

## 8) System Architecture (V1)

### 8.1 Realtime Inputs
- **Speechmatics realtime transcript** with timestamps (word-level where available)
- **Webcam frames** sampled every N seconds (adaptive) → MiniMax (Option A)
- **Mouse events** (mousemove/click/scroll) → heatmap + derived features
- (Optional) explicit “task step markers” (user clicks “Done” or system detects timeouts)

### 8.2 Data Storage (Convex)
- Studies
- Sessions
- Transcript segments
- Signal windows + friction moments
- Engagement events
- Mouse events + heatmap aggregates
- Decide events (what the interviewer chose and why)

### 8.3 Frontend Stack
- **Framework:** Next.js (TypeScript)
- **UI components:** shadcn/ui
- **Backend / DB:** Convex (realtime subscriptions + storage)
- **Streaming transcription:** Speechmatics Realtime API

### 8.4 LLM / Model Assignments

| Component | Model | Rationale |
|---|---|---|
| Camera engagement classifier | MiniMax Vision | Multimodal; low-res frame classification |
| Decide Engine — Policy B (realtime) | `claude-haiku-4-5-20251001` | Fast structured JSON; low latency required |
| Post-session finding labeler | `claude-sonnet-4-6` | Quality over speed; nuanced UX synthesis |
| Findings themes summary | `claude-haiku-4-5-20251001` | Lightweight aggregation task |
| Multimodal cross-reference (Tier 2) | `claude-sonnet-4-6` | Vision-capable; deeper reasoning needed |
| Narrated executive summary | ElevenLabs TTS | Nice-to-Have; audio narration |

> All Claude calls use the Anthropic SDK. MiniMax vision calls routed via OpenRouter or FireworksAI.

---

## 9) Conversation Cues (Real-Time Signal Set)

**Principle:** Keep it rule-based and fast. Use per-window rates and speaker normalization.  
**Windowing (suggested):** 15s windows, stride 5s.

### 9.1 Core Signals (12-signal scaffold)
**A) Hesitation / uncertainty**
1) Filled pauses (“uh/um/er”) rate  
2) Hedging rate (“maybe”, “I think”, “kind of”)  
3) Explicit uncertainty (“I don’t know”, “not sure”, “I’m confused”)  
4) Long silent pauses (gap-based from timestamps)

**B) Cognitive load / confusion**
5) Self-repair markers (“wait—no”, “I mean”, “actually”)  
6) Repetition / false starts (“I I…”, repeated tokens within short gap)  
7) Clarification initiators (“where is…?”, “what do you mean?”, “can you repeat?”)  
8) Response latency after interviewer prompt (requires turn segmentation)

**C) Frustration / negative affect**
9) Negative affect / breakdown lexicon (“frustrating”, “stuck”, “doesn’t work”)

**D) Confidence / clarity**
10) Clarity/commitment index (confirmations/certainty minus hedges)

**E) Task flow breakdowns**
11) Backtracking markers (“go back”, “start over”)  
12) Repeated attempt loops (“again”, “still”, repeated “click/submit” narration + short clustering)

### 9.2 Scoring (V1)

> Full signal definitions, thresholds, and UX-methods evidence base: see [`behavioral-friction-signal-research.md`](./behavioral-friction-signal-research.md)

**Per-window friction score (0–100):**
- Normalize each signal per speaker using robust z-score: `z = (x − median) / (MAD + ε)`
- `friction_raw = Σ(w_i × z_i) + w_clarity × (−z_clarity)`
  - Weights: hesitation/confusion = 1.0 | backtracking/repeat loops = 1.2 | negative affect = 1.3 | clarity (reduces false positives) = 0.7
- `friction_0_100 = 100 × sigmoid(friction_raw)`

**Session-level summary:**
- `avg_friction`, `peak_friction`, `time_in_high_friction_pct` (windows ≥ 75)
- `session_friction = 0.45×avg + 0.35×peak + 0.20×time_in_high_friction_pct`
- Per-task ranking by peak friction

**UI representation:** Numeric score maps to LOW (<40) / MED (40–70) / HIGH (>70) for display.

**Peak-first reporting:** Confusions/frustrations at peak moments shape remembered impressions (peak–end rule). Surface top-N windows with multi-signal corroboration.

---

## 10) Tier 1 Multimodal (Real-Time)

### 10.1 Camera Processing — Option A (Chosen)

> Prompt and full output schema: see [`camera-engagement-classifier.md`](./camera-engagement-classifier.md)

**Flow:**
1. Capture webcam frame in browser
2. Downscale (e.g., width 256–384px) + compress (jpg/webp)
3. Send to backend with recent transcript snippet as context
4. Backend calls MiniMax Vision (via OpenRouter/FireworksAI) to classify engagement state
5. Store full classifier output per `EngagementEvent` (see §14 data model):
   - `state` (classification result)
   - `confidence` (0.0–1.0)
   - `signals` sub-object: `face_present`, `gaze_toward_screen_likely`, `attention_stable_likely`, `visible_frustration_cues_likely`
   - `notes` (≤160 chars, neutral)
   - `timestamp`
   - (optional) frame hash / short-lived blob reference

**Engagement states (V1):**
- `engaged_active` (focused / attentive)
- `engaged_stuck` (focused but struggling)
- `disengaged_away` (looking away / not present)
- `uncertain_low_confidence` (insufficient signal)

**Sampling:**
- Default: 1 frame / 3–5 seconds
- Increase frequency if friction cues spike (adaptive sampling)

> Note: We avoid “emotion diagnosis” claims. This is engagement estimation used as a supporting cue.

### 10.2 Mouse Signals + Heatmap
**Capture:**
- mousemove events (x,y,t)
- clicks (x,y,t,button)
- scroll (delta,t)

**Derived metrics — canonical `mouse_summary` shape (used by both Decide policies):**
```json
{
  “inactive_sec”: 8.5,
  “erraticness”: 0.62,
  “repeat_clicks_same_region”: 2,
  “scroll_bursts”: 1
}
```
- `inactive_sec`: seconds of no mouse movement in window
- `erraticness`: 0–1 score from direction-change frequency / velocity variance
- `repeat_clicks_same_region`: count of clicks clustered in same ~50px area
- `scroll_bursts`: rapid scroll sequences suggesting searching behavior

**Heatmap:**
- Aggregate points into bins to render a heatmap overlay per session.
- Keep complexity low by using an existing lightweight library or simple binning.

---

## 11) Decide Engine (V1) — Dual-Policy + A/B Mode

### 11.1 Goal
Select the next interviewer action based on:
- conversation cues
- engagement state
- mouse behavior
- task context / timer

### 11.2 Allowed Actions (bounded)
- `ask_followup`
- `clarify_task`
- `reflect_back`
- `move_to_next_task`
- `wait`

### 11.3 Policy A — Deterministic (Rules)

> Full rule set (7 priority steps): see [`determinstic-decide-policy.md`](./determinstic-decide-policy.md)

**Purpose:** stability, debuggability, reliability.
- Prioritized rule cascade: hard overrides → disengagement → frustration/breakdown → explicit confusion → “stuck” pattern (multi-signal STUCK_SCORE) → task prompt issues → smooth progress → default
- All threshold values are defined in the policy doc.

### 11.4 Policy B — Bounded LLM Policy

> Full prompt template and output schema: see [`decide-engine-policy-b-prompt.md`](./decide-engine-policy-b-prompt.md)
> Model: `claude-haiku-4-5-20251001` (see §8.4)

**Purpose:** adaptability, smarter probing.
- Input:
  - current task + task list
  - recent transcript excerpt (last ~30–60s)
  - extracted signal summary (not raw tokens)
  - engagement state summary
  - mouse summary (canonical shape — see §10.2)
  - allowed_actions list
  - hard_overrides (precomputed)
- Output (strict JSON, 5 fields):
  - `action`
  - `next_prompt` (≤220 chars)
  - `rationale` (≤220 chars)
  - `probe_type`: `expectation` | `comprehension` | `navigation` | `system_status` | `emotion_checkin` | `move_on` | `none`
  - `confidence` (0.0–1.0)

**Both policies produce the same output schema** — Policy A uses fixed confidence values; Policy B infers them.

### 11.5 Hybrid Guardrails (applies to both)
Hard overrides:
- prolonged disengagement
- timeouts
- explicit user request to move on
- safety/consent events

### 11.6 A/B Demonstration Mode
- Founder chooses:
  - run the same study twice with different policies
  - compare:
    - number of friction moments detected
    - time-to-insight
    - participant completion rate
    - qualitative “interview quality” rating (founder feedback)

---

## 12) Findings Dashboard (V1)

> Post-session finding labeler prompt and output schema: see [`post-session-candidate-finding-labeler.md`](./post-session-candidate-finding-labeler.md)
> Model: `claude-sonnet-4-6` (see §8.4)

**Labeler scope:** Runs on **all** detected `FrictionMoment` records at session end. UI may filter/surface only top peaks, but all moments are processed and stored.

### 12.1 Summary
- Top 3 friction themes (LLM-assisted; `claude-haiku-4-5-20251001`)
- Peak moments list (ranked by `friction_0_100` score)
- Per-task friction ranking (by peak friction)

### 12.2 Timeline (Moment Cards)
Each card surfaces the full `FrictionMoment` output (see §14 data model):
- timestamp range
- transcript quote(s)
- detected signals (e.g., long pause + uncertainty statement)
- `category` (e.g., `discoverability`, `system_status_feedback`)
- `interpretation` (≤260 chars)
- engagement state around moment
- mouse pattern tag (e.g., “inactivity”, “erratic search”, “repeat clicks”)
- `recommendations` (2–4 actionable bullets)
- `verification_question` (stored in V1; founder confirmation UI deferred to V2)

### 12.3 Heatmap View
- Heatmap overlay image per task/session
- Links from moment card → heatmap timestamp region (optional)

### 12.4 Export
- Markdown report export
- JSON export for downstream tooling (e.g., OpenClaw skill)

---

## 13) Tier 2 Cross-Reference (Planned / Next Round)

**Not required for V1 demo.**

> Prompt and output schema: see [`multimodal-cross-reference-explainer.md`](./multimodal-cross-reference-explainer.md)
> Model: `claude-sonnet-4-6` with vision (see §8.4)

After session:
- pick top friction segments
- cross-reference: transcript snippet + engagement events (incl. `signals` sub-object) + mouse summary + webcam frame (low-res)
- generate (strict JSON):
  ```json
  {
    “moment_story”: “string (≤300 chars)”,
    “what_user_was_trying_to_do”: “string (≤160 chars)”,
    “what_likely_went_wrong”: “string (≤200 chars)”,
    “confidence”: 0.0,
    “recommended_fix”: {
      “ui_change”: “string”,
      “copy_change”: “string”
    },
    “verification_question”: “string”
  }
  ```
- verification prompt to founder: “We inferred X. Confirm/Reject?” (UI in V2; field computed here)

---

## 14) Data Model (High-Level)

### Study
- id
- title
- prototype_url
- tasks[] (id, label)
- prd_text / attachments
- decide_mode (A/B/Hybrid)
- created_at

### Session
- id
- study_id
- participant_meta (optional)
- started_at / ended_at
- transcript_segments[]
- signal_windows[]
- friction_moments[]
- engagement_events[]
- mouse_events_agg
- heatmap_bins
- decide_events[]
- outputs (summary, themes)

### SignalWindow
> See [`behavioral-friction-signal-research.md`](./behavioral-friction-signal-research.md) for per-signal computation formulas and thresholds.
- t_start, t_end
- task_id (optional)
- speaker_id (optional)
- prompt_type: `"moderator_question"` | `"user_action"` | `"system_error"` | `"free_explore"`
- context_hint (optional string — e.g., `"signup form"`, `"nav menu"`)
- computed_signals { ... }
- friction_0_100 (numeric score, 0–100)
- severity_hint: `LOW` | `MED` | `HIGH` (derived from friction_0_100)
- flags[] — e.g., `"candidate_moderator_silence"`

### EngagementEvent
> Full classifier output from [`camera-engagement-classifier.md`](./camera-engagement-classifier.md)
- t
- task_id (optional)
- state: `engaged_active` | `engaged_stuck` | `disengaged_away` | `uncertain_low_confidence`
- confidence (0.0–1.0)
- signals: { face_present, gaze_toward_screen_likely, attention_stable_likely, visible_frustration_cues_likely }
- notes (≤160 chars)
- frame_hash (optional)

### FrictionMoment
> Candidate finding fields populated by [`post-session-candidate-finding-labeler.md`](./post-session-candidate-finding-labeler.md) (`claude-sonnet-4-6`) at session end.
- t_start, t_end
- task_id
- friction_peak (0–100, highest window score in range)
- evidence:
  - transcript_snippets[]
  - pause_spans[]
  - matched_phrases[]
- signal_tags[]
- engagement_snapshot (EngagementEvent ref)
- mouse_snapshot (mouse_summary object)
- candidate_finding_label (≤90 chars)
- category: `copy_language` | `discoverability` | `system_status_feedback` | `navigation_ia` | `form_field_friction` | `task_prompt_issue` | `error_recovery` | `other`
- interpretation (≤260 chars)
- recommendations[] (2–4 strings)
- verification_question (string — stored V1; founder confirmation UI deferred to V2)
- confidence (0.0–1.0)

### DecideEvent
> Output schema shared by both policies — see [`determinstic-decide-policy.md`](./determinstic-decide-policy.md) and [`decide-engine-policy-b-prompt.md`](./decide-engine-policy-b-prompt.md).
- t
- policy_used: `deterministic` | `llm`
- input_summary
- output_action
- output_prompt (≤220 chars)
- probe_type: `expectation` | `comprehension` | `navigation` | `system_status` | `emotion_checkin` | `move_on` | `none`
- confidence (0.0–1.0)

---

## 15) Method + Ethics Notes (Hackathon Language)

- These signals are **probabilistic attention flags**, not diagnoses.
- Silence can be intentional in moderated sessions; interpret pauses with context and corroborating cues.
- Think-aloud is useful but imperfect; people may under- or over-verbalize.
- Engagement estimation from camera is approximate and optional.
- The product **augments** UX research by speeding up discovery and review.

---

## 16) Demo Narrative (for Judges)

**Pitch:** “Unfiltered runs user interviews overnight and automatically spots where users stumble.”

**Demo beats:**
1. Create a study with tasks + prototype URL
2. Join as participant, run a 2–3 minute session
3. Show real-time transcript + a couple live “moment” flags
4. End session → instant dashboard:
   - top friction moments
   - heatmap
   - recommendations
5. Flip to A/B mode comparison:
   - deterministic vs bounded-LLM interviewing outcomes

---

## 17) Open Source + Extensibility

- Export JSON allows integrating Unfiltered as:
  - an OpenClaw skill
  - a CI check for onboarding friction (future)
  - a UX “regression” suite for product updates (future)

---
