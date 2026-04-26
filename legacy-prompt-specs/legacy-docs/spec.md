# Unfiltered — Product Spec

**Last updated:** 2026-02-21
**Status:** V1 — Hackathon build

---

## 1. What It Is

Unfiltered is an AI UX researcher that runs live moderated user interviews and automatically surfaces friction moments — the micro-moments where users hesitate, get confused, or get stuck.

It conducts the interview, listens in real-time, adapts its questions based on how the participant is responding, and delivers a structured findings report at the end — all without a human researcher in the room.

---

## 2. The Problem

1. Founders and teams don't run enough user research because it's time-consuming to set up and analyze.
2. Participants filter their feedback in live interviews due to social desirability bias.
3. Micro-friction (brief hesitation, confusion, frustration) is easy to miss during observation.
4. Reviewing recordings manually doesn't scale.

---

## 3. The Solution

Unfiltered autonomously runs a moderated UX session:
- reads the task to the participant and prompts think-aloud narration
- listens for friction signals in real-time (hesitation, confusion, frustration, repeat behaviors)
- detects when to probe deeper vs. move on
- produces a structured findings report with evidence-backed moment cards and actionable recommendations

**Framing:** These are *attention flags*, not diagnoses. Unfiltered augments UX researchers and accelerates review.

---

## 4. Users

| Role | Goal |
|---|---|
| **Founder / PM / Designer** | Quick feedback on a prototype without scheduling a researcher |
| **UX researcher** | Faster session review + better signal surfacing |
| **Hackathon judges** | Demo clarity, novelty, sponsor API use, feasibility |

---

## 5. Key Differentiators

1. **Real-time stumble detection** — not just post-session summarization. The system flags friction as it happens.
2. **Multimodal corroboration** — camera engagement state + mouse behavior corroborates or mutes speech signals, reducing false positives.
3. **Dual-policy adaptive questioning** — deterministic rule engine (Policy A) vs. bounded LLM engine (Policy B) for next-question selection. A/B mode lets founders compare outcomes.
4. **Evidence-backed findings** — every moment card includes transcript quotes, detected signals, engagement snapshot, and mouse behavior tag.

---

## 6. V1 Scope

### Must-Have
- Live AI interviewer with voice (Web Speech API TTS)
- Streaming real-time transcription (Speechmatics)
- Conversation cue extraction — 12 behavioral friction signals detected per 15s window
- Webcam engagement classification (MiniMax Vision)
- Mouse tracking and heatmap capture
- Adaptive questioning logic (Decide Engine — Policy A and B)
- Findings dashboard with moment cards, themes, heatmap, and export

### Nice-to-Have
- Founder observer view (live friction timeline during session)
- Narrated executive summary (ElevenLabs)

### Stretch (not required for demo)
- MiniMax-generated short video summary of findings

---

## 7. User Flows

### 7.1 Founder Flow — Study Setup

1. **Create Study**
   - Enter title
   - Paste prototype URL (embedded as iframe)
   - Paste PRD / product context (optional — informs AI interviewer framing)
   - Define 1–3 tasks (each with a label the AI will read to the participant)
   - Select Decide mode:
     - **Mode A:** Deterministic policy only
     - **Mode B:** LLM policy only
     - **Mode C:** A/B run (alternating sessions, enables comparison)

2. **Generate interview script** — AI produces the opening script and task prompts

3. **Create and share interview link** — unique link per session

### 7.2 Participant Flow — Interview Room

1. **Consent screen**
   - Microphone required (for transcription)
   - Camera optional but recommended (engagement classification)
   - Mouse tracking disclosed
   - Confirm before proceeding

2. **Interview Room (split layout)**
   - **Left panel:** Prototype iframe (the product they're testing)
   - **Right panel:**
     - AI interviewer status: Listening / Thinking / Speaking
     - Live transcript (auto-scrolling)
     - Current task description
     - Task progress indicator
     - "End Turn / Skip" fallback button (participant control)

3. **AI interviewer behavior**
   - Opens with warm framing ("I'm going to ask you to try a few tasks…")
   - Reads the first task
   - Listens and detects friction signals continuously
   - Probes when friction spikes or specific patterns detected
   - Moves to next task when task is complete or timeout reached
   - Closes session with a thank-you

4. **Session end** → Participant sees a "Thank you" screen → Post-session processing begins

### 7.3 Founder Flow — Findings Review

1. Open session from dashboard
2. View **summary panel** — top 3 themes, peak friction moments, per-task ranking
3. Browse **moment cards** — scrollable timeline of friction events (highest severity first)
4. View **heatmap** — click/mouse movement overlay per task
5. **Export** — Markdown report or JSON

---

## 8. Findings Dashboard — Moment Card Detail

Each detected friction moment surfaces as a card with:
- **Timestamp range** — when in the session it occurred
- **Task** — which task the participant was on
- **Friction score** — LOW / MED / HIGH (backed by 0–100 numeric score)
- **Transcript quote(s)** — the words spoken around the moment
- **Detected signals** — e.g., "long pause + uncertainty statement + repeat clicks"
- **Category** — one of: `copy_language`, `discoverability`, `system_status_feedback`, `navigation_ia`, `form_field_friction`, `task_prompt_issue`, `error_recovery`, `other`
- **Interpretation** — AI summary of what was happening (≤260 chars)
- **Engagement state** — camera-based snapshot at that moment
- **Mouse pattern** — e.g., "inactivity", "erratic search", "repeat clicks same region"
- **Recommendations** — 2–4 actionable bullets
- **Verification question** — a clarifying question the founder could ask in a follow-up

---

## 9. A/B Mode — Comparing Policies

When Mode C is selected, consecutive sessions alternate between Policy A (deterministic) and Policy B (LLM). The dashboard shows a comparison view:
- Number of friction moments detected per session
- Time-to-insight (how quickly key moments were surfaced)
- Participant completion rate
- Qualitative interviewer quality (founder rating)

---

## 10. Ethics and Framing

- All signals are **probabilistic attention flags**, not emotion diagnoses or psychological assessments.
- Silence is not always friction; pauses are interpreted with context and corroborating signals.
- Camera engagement is an estimate — approximate, optional, and used only as a supporting cue.
- Think-aloud narration is imperfect; people under- or over-verbalize.
- Unfiltered augments human UX researchers; it does not replace judgment.

---

## 11. Demo Narrative (for judges)

**Pitch:** "Unfiltered runs user interviews overnight and automatically spots where users stumble."

**Demo flow:**
1. Create a study with tasks + prototype URL
2. Join as participant, run a 2–3 minute live session
3. Show real-time transcript + friction moment flags appearing live
4. End session → findings dashboard loads instantly
5. Walk through: top themes → moment card with evidence → heatmap
6. Flip to A/B comparison view

---

## 12. Out of Scope (V1)

- Founder confirmation UI for verification questions (stored in V1; UI is V2)
- Multimodal cross-reference deep analysis (Tier 2 — V2)
- Narrated executive summary (nice-to-have)
- Recording storage / video playback
- Multi-participant sessions
- Authentication / team accounts
