# Feature: Voice Latency Telemetry

## Goal
Measure interviewer response latency as experiments, establish a reproducible baseline, and compare variants with the same script.

## Data Model
### Baseline telemetry tables
- `telemetryExperiments`: experiment metadata (`name`, `scriptId`, `notes`)
- `telemetryRuns`: concrete run metadata (`variant`, `status`, optional config snapshot, optional session)
- `latencyEvents`: append-only timing events per session/turn/stage

### Operator run-orchestration tables
- `experimentRuns`: lifecycle of a structured experiment run (`running|paused|complete|aborted`)
- `experimentVariations`: deterministic matrix rows (`studyId`, `decisionEngineIdTarget`, `decisionEngineIdAssigned`, `repeatIndex`, `status`, optional `sessionId`)
- `experimentGlobalState`: singleton pointer to currently active run
- `sessions` linkage fields:
  - `experimentRunId`
  - `experimentVariationId`

## Captured Latency Stages
- `participant_last_word_end`
- `decide_trigger`
- `policy_start`
- `policy_end`
- `prompt_selected`
- `tts_request_start`
- `tts_first_audio_byte`
- `audio_play_start`
- `timing_config_resolved`

## Derived Metrics
- `response_start_latency_ms = audio_play_start - participant_last_word_end`
- `decision_latency_ms = policy_end - policy_start`
- `tts_startup_ms = audio_play_start - tts_request_start`
- `trigger_delay_ms = decide_trigger - participant_last_word_end`

## Assignment Model (Convex Authoritative)
- Variation assignment is generated deterministically in Convex via `lib/experiments/variationGenerator.ts`.
- `experimentVariations.decisionEngineIdAssigned` is the source of truth for runtime routing.
- Session start applies assigned engine mode once and persists it on `sessions.decideMode`.
- Runtime never asks PostHog which variant to run.

## PostHog Role (Analytics, Not Assignment)
- PostHog receives exposure/lifecycle analytics only.
- Primary events:
  - `decision_engine_exposure`
  - `experiment_run_started|paused|resumed|completed|aborted`
- Suggested event properties:
  - `experiment_id`
  - `run_id`
  - `variation_index`
  - `study_id`
  - `assigned_engine_variant`

## Exposure Delivery and Failure Policy
- Exposure send is idempotent per variation:
  - sent timestamp: `posthogExposureSentAt`
  - failure debug fields: `posthogExposureLastErrorAt`, `posthogExposureLastError`
- If PostHog is unavailable:
  - experiment progression continues
  - assignment and runtime routing remain unaffected
  - failure is recorded for retry/inspection

## Baseline Protocol
1. Create experiment with stable `name` and fixed `scriptId`.
2. Start a run with variant `baseline-current`.
3. Execute the same interviewee script end-to-end.
4. Complete run and export stage deltas.
5. Report p50/p90/p95 and outlier turns.
6. Repeat for at least 5 runs before making tuning decisions.

## Config Safety
Turn-taking timing env values are resolved through `lib/decide/runtimeConfig.ts` with:
- range clamps,
- warning collection for missing/invalid values,
- one-time `timing_config_resolved` telemetry event per session.
