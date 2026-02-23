# Experiment Writeups (Living, Append-Only)

This document is the canonical experiment log for interviewer latency and turn-taking.

Rules for this document:
- Append-only: do not rewrite prior timeline entries.
- Corrections must be added as dated addenda.
- Separate facts from hypotheses.
- Every major claim should include evidence source(s).

---

## Experiment Series: Interviewer Latency + Turn-Taking (Series 001)

### Metadata
- Series ID: `series-001-latency-turn-taking`
- Status: `active`
- Started: `2026-02-22`
- Owner: `jacobbutler + codex`
- Primary goal: reduce interviewer response-start latency while preserving thoughtful, context-aware follow-ups.
- Decision: use top-level route `/experiments` for experiment operations and review.

### Scope
- Experiment object: one experiment contains multiple studies/prototypes.
- Current run plan (approved):
  - `3 runs` per prototype
  - `2 prototypes` per implementation batch
  - sample size `n=6` per implementation
- Planned implementation variants:
  - `baseline-current`
  - `internal-decision-engine`
  - `internal-decision-engine-plus-vapi` (if pursued in later phase)

### Baseline Reconstruction (What Happened Before Series 001)

#### A. Repo and commit anchors
- `2026-02-21 10:49 -0800` commit `69a6850`: initial Next.js scaffold.
- `2026-02-21 13:56 -0800` commit `55a0c3f`: first full implementation (interview runtime, decide engine, TTS/STT, dashboard, Convex schema/functions, tests).
- `2026-02-21 14:03 -0800` commit `e283a0c`: restricted browser TTS fallback behavior.
- `2026-02-21 14:07 -0800` commit `0835978`: sequential TTS helper test coverage.

Evidence:
- `git log --reverse` in `/Users/jacobbutler/Documents/GitHub/return-of-the-agents/unfiltered`

#### B. Decision/behavior timeline from Codex threads

1. `2026-02-21T21:44Z` follow-up failure reported:
- Symptom: interviewer not asking follow-ups after confusion statements.
- Investigation found choke points:
  - narrow confusion phrase matching
  - policy path falling back to `wait`
- Action: broaden uncertainty detection and centralize trigger gating.

Evidence:
- Session: `/Users/jacobbutler/.codex/sessions/2026/02/21/rollout-2026-02-21T13-44-10-019c8228-feac-74d0-a68c-c60eb4548dcb.jsonl`

2. `2026-02-21T22:15Z` second failure report:
- Symptom: still no follow-ups in live retest.
- Root cause identified in orchestration timing path (decision loop effectively not firing after intro for some flows).
- Action: patch timer/decision pipeline and add deterministic transcript heuristics for positive affinity probing and confusion follow-ups.

Evidence:
- Session: `/Users/jacobbutler/.codex/sessions/2026/02/21/rollout-2026-02-21T13-44-10-019c8228-feac-74d0-a68c-c60eb4548dcb.jsonl`

3. `2026-02-21T23:00Z` turn-taking + repetition feedback:
- User requested:
  - slower jump-in to reduce interruptions
  - short apology when interviewer interrupts
  - more variation for repetitive prompts
  - explicit confusion/“not sure what to do next” probes
- Action implemented (from thread report):
  - phrase variation utilities (expectation/confusion/affinity)
  - turn-taking rules with cooldowns
  - interruption acknowledgement path
  - policy prompt updates to reduce repetitive phrasing

Evidence:
- Session: `/Users/jacobbutler/.codex/sessions/2026/02/21/rollout-2026-02-21T14-55-08-019c8269-f56a-7a60-bbb1-7a49a00270af.jsonl`

4. `2026-02-22T20:34Z` latency bottleneck decomposition:
- Measured/identified bottlenecks:
  - turn-taking silence floor (`4s`)
  - signal loop stride (`5s`)
  - STT configured without partials (`enable_partials: false`)
  - TTS startup path includes sequential stages before playback
- Conclusion: current baseline cannot reliably hit `<=2s` response start target.

Evidence:
- Session: `/Users/jacobbutler/.codex/sessions/2026/02/22/rollout-2026-02-22T12-15-39-019c86fe-51cf-7f60-84ad-fdc4245c1e36.jsonl`
- Code references:
  - `/Users/jacobbutler/Documents/GitHub/return-of-the-agents/unfiltered/lib/decide/turnTaking.ts`
  - `/Users/jacobbutler/Documents/GitHub/return-of-the-agents/unfiltered/hooks/useSignalProcessor.ts`
  - `/Users/jacobbutler/Documents/GitHub/return-of-the-agents/unfiltered/hooks/useSpeechmatics.ts`
  - `/Users/jacobbutler/Documents/GitHub/return-of-the-agents/unfiltered/lib/tts.ts`

### Baseline Definition (Series 001)
- Baseline implementation: current internal interviewer loop before Phase 1 telemetry analysis.
- Known behavioral properties:
  - deterministic + bounded-LLM orchestration
  - turn-taking guardrails present, but conservative thresholds increase delay risk
  - some historical fixes already landed for interruptions and phrasing variation
- Baseline performance expectation:
  - frequent misses against `<=2.0s` target for response start in natural pauses
  - occasional under-triggering/over-waiting due gating and cadence interactions

### Phase 0 (Completed): Voice Agent Development Skill
- Skill path:
  - `/Users/jacobbutler/.codex/skills/voice-agent-development/SKILL.md`
- Purpose:
  - standardize low-latency voice-agent engineering workflow
  - remain domain-agnostic (not overfit to interview UX only)
  - include TypeScript/Next.js references aligned with this stack
- Key design of the skill:
  - latency-budget-first architecture
  - deterministic turn-taking + interruption patterns
  - repetition control patterns
  - telemetry-first experimentation workflow
  - guidance for when Python/Rust are warranted without forcing migration

### Phase 1 (In Progress): Telemetry Foundation

#### Implemented data model
- `telemetryExperiments`
- `telemetryRuns`
- `latencyEvents`

Code:
- `/Users/jacobbutler/Documents/GitHub/return-of-the-agents/unfiltered/convex/schema.ts`
- `/Users/jacobbutler/Documents/GitHub/return-of-the-agents/unfiltered/convex/telemetry.ts`

#### Captured stages
- `participant_last_word_end`
- `decide_trigger`
- `policy_start`
- `policy_end`
- `prompt_selected`
- `tts_request_start`
- `tts_first_audio_byte`
- `audio_play_start`
- `timing_config_resolved`

Code/docs:
- `/Users/jacobbutler/Documents/GitHub/return-of-the-agents/unfiltered/lib/telemetry/latency.ts`
- `/Users/jacobbutler/Documents/GitHub/return-of-the-agents/unfiltered/docs/feature-voice-latency-telemetry.md`

#### Runtime instrumentation points
- interview runtime emits participant and decide/policy stage markers
- TTS pipeline emits request/first-byte/play-start markers
- runtime timing config emits one-time resolved/clamped config event

Code:
- `/Users/jacobbutler/Documents/GitHub/return-of-the-agents/unfiltered/app/interview/[sessionId]/page.tsx`
- `/Users/jacobbutler/Documents/GitHub/return-of-the-agents/unfiltered/hooks/useDecideEngine.ts`
- `/Users/jacobbutler/Documents/GitHub/return-of-the-agents/unfiltered/lib/tts.ts`
- `/Users/jacobbutler/Documents/GitHub/return-of-the-agents/unfiltered/lib/decide/runtimeConfig.ts`

#### Derived metrics for analysis
- `response_start_latency_ms = audio_play_start - participant_last_word_end`
- `decision_latency_ms = policy_end - policy_start`
- `tts_startup_ms = audio_play_start - tts_request_start`
- `trigger_delay_ms = decide_trigger - participant_last_word_end`

### Hypotheses (Series 001)
1. Reducing turn-end detection + trigger cadence delay will produce the largest latency gain (>35%) before any model/provider change.
2. Background pre-ranking of “next best question/statement” candidates will reduce decision latency variance while preserving response quality.
3. Repetition penalties + variant pools will reduce perceived fatigue without increasing response-start latency.
4. “Thinking hold” exception logic will reduce interruption rate, but can regress latency if signal confidence is too permissive.
5. Guarding timing env resolution (with clamps + telemetry) will reduce config-drift regressions across environments.

### Methodology (Series 001)
- Fixed interviewee script across all runs for comparability.
- Same operator, same environment where possible.
- For each implementation variant:
  - run 3 sessions on prototype A
  - run 3 sessions on prototype B
  - total 6 sessions
- Per run:
  - start run record with variant and config snapshot
  - execute script end-to-end
  - stop run record, capture notes on anomalies
- Evaluation dimensions:
  - latency: p50/p90/p95 + outlier turns
  - turn-taking quality: interruption rate, false “thinking hold” rate
  - conversational quality: relevance, repetition fatigue, progression quality

### Baseline Run Checklist (Operator SOP)
- Before run:
  - confirm correct experiment (`series-001-latency-turn-taking`) and implementation variant.
  - confirm prototype ID (`prototype-a` or `prototype-b`) and target session link.
  - start run in `/experiments` before participant speaks.
  - verify timing config snapshot recorded (or attach manually in run notes).
- During run:
  - execute fixed interviewee script in defined order.
  - avoid improvisation outside script except when script explicitly calls for it.
  - annotate anomalies immediately (audio device, network, browser lag, retries).
- After run:
  - stop run as `complete` or `aborted` immediately.
  - verify run has latency events and turn count > 0.
  - record qualitative notes (interruptions, repetition fatigue, confusion handling quality).

### Interviewee Test Script Template (v0)
- Use-case 1: normal completion of a thought, then silence (expect <=2s response).
- Use-case 2: asks interviewer a direct question, then 1s pause (expect fast response).
- Use-case 3: says “I’m confused / not sure what to do next” (expect clarification probe).
- Use-case 4: expresses strong interest/affinity (“I like this”) (expect detail probe).
- Use-case 5: silent working period (~5s) while actively thinking (expect nudge, not immediate interruption).
- Use-case 6: explicitly says “nothing else to add” (expect progression to next prompt/task).
- Use-case 7: interviewer starts speaking while user restarts speaking (expect interruption handling path).

### Metadata + Trace Tagging Plan (for `/experiments` route)
- Every latency event should include:
  - `experimentId`
  - `runId`
  - `variant`
  - `prototypeId`
  - `sessionId`
  - `turnId`
  - `stage`
  - `ts`
- This maps cleanly to OTel span/event attributes and provider tags (PostHog/Arize) if we dual-write later.
- Recommendation: keep Convex as source-of-truth event log first; add export/forwarding adapter after baseline collection.

### `/experiments` IA + UI Scope (v1)
- Screen: `Experiments Console` (`/experiments`)
- Section 1: `Create Experiment`
  - fields: name, script ID, hypothesis, methodology, notes.
- Section 2: `Start Run`
  - fields: experiment, variant, prototype ID, study/session, operator, environment, tags, config snapshot, notes.
  - action: start run (status = running).
- Section 3: `Run Protocol Checklist`
  - fixed SOP shown inline to reduce operator drift.
- Section 4: `Active Runs`
  - list currently running runs with runtime + session linkage.
  - actions: mark `complete` or `aborted`.
- Section 5: `Recent Run Summaries`
  - show p50/p90/p95 for:
    - response start latency
    - decision latency
    - tts startup
    - trigger delay
  - show turns observed and total event count.

### Risks and Blind Spots (Current)
- Timing defaults can mask env misconfiguration if not surfaced to operator UI.
- False “thinking hold” detection can either increase interruptions or increase dead air depending on threshold tuning.
- Repetition control can conflict with short candidate lists unless variant pools are sufficiently broad.
- Small sample size (`n=6` per variant) is enough for directional comparison, not definitive statistical claims.

### Open Questions
- Should Phase 1 remain Convex-only telemetry, or immediately dual-write to PostHog or Arize?
- What is the minimum operator UI needed in `/experiments` for start/stop discipline and metadata quality?
- Should we record audio-side diagnostics (device/network) per run to control for non-engine variance?

---

## Addendum Log

### 2026-02-22 (initial entry creation)
- Created this document.
- Reconstructed baseline from:
  - git commits in `/Users/jacobbutler/Documents/GitHub/return-of-the-agents/unfiltered`
  - Codex session logs under `/Users/jacobbutler/.codex/sessions/2026/02/21` and `/Users/jacobbutler/.codex/sessions/2026/02/22`
  - project docs, especially `/Users/jacobbutler/Documents/GitHub/return-of-the-agents/unfiltered/docs/feature-voice-latency-telemetry.md`

### 2026-02-23 (implementation delta: deterministic assignment + PostHog analytics)
Facts:
- Implemented Convex-authoritative assignment for structured runs:
  - variation matrix generated in `/Users/jacobbutler/Documents/GitHub/return-of-the-agents/unfiltered/lib/experiments/variationGenerator.ts`
  - run/session orchestration in `/Users/jacobbutler/Documents/GitHub/return-of-the-agents/unfiltered/convex/experimentRuns.ts`
  - runtime routing resolved from persisted session decide mode, not PostHog flags.
- Added run/variation state to schema:
  - `/Users/jacobbutler/Documents/GitHub/return-of-the-agents/unfiltered/convex/schema.ts`
  - new tables: `experimentRuns`, `experimentVariations`, `experimentGlobalState`
  - sessions now carry `experimentRunId` + `experimentVariationId`.
- Added PostHog analytics action layer:
  - `/Users/jacobbutler/Documents/GitHub/return-of-the-agents/unfiltered/convex/posthog.ts`
  - `/Users/jacobbutler/Documents/GitHub/return-of-the-agents/unfiltered/lib/posthog/flags.ts`
  - PostHog used for exposure/lifecycle event capture only.
- Implemented exposure idempotency + failure recording:
  - `posthogExposureSentAt`, `posthogExposureLastErrorAt`, `posthogExposureLastError`.
- Added experiment-focused tests:
  - `/Users/jacobbutler/Documents/GitHub/return-of-the-agents/unfiltered/tests/experiments/variationGenerator.test.ts`
  - `/Users/jacobbutler/Documents/GitHub/return-of-the-agents/unfiltered/tests/experiments/exposure.test.ts`
  - `/Users/jacobbutler/Documents/GitHub/return-of-the-agents/unfiltered/tests/experiments/runtimeRouting.test.ts`

Interpretation:
- This locks assignment deterministically to Convex matrix generation and removes hybrid assignment ambiguity.
- PostHog outages now degrade analytics quality only, not experiment progression.

Open follow-up:
- Wire robust operator UX (`/experiments`) to `experimentRuns` + `experimentVariations` APIs, including the persistent active-run header and in-session use-case checklist.
