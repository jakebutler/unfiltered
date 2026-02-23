# Experiments Operator + Telemetry Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a production-usable `/experiments` console to create experiments, start/stop runs, and tie interview latency traces to run metadata for comparable benchmarking.

**Architecture:** Extend existing Convex telemetry tables/functions with richer run metadata and computed run analytics, then build a top-level Next.js operator page backed by those queries. Interview runtime will auto-attach latency events to any active session run so trace tagging is automatic and reliable.

**Tech Stack:** Next.js App Router, React client components, Convex queries/mutations/actions, existing shadcn UI primitives.

---

### Task 1: Expand telemetry schema and API surface

**Files:**
- Modify: `convex/schema.ts`
- Modify: `convex/telemetry.ts`

Steps:
1. Add optional metadata fields on `telemetryExperiments` and `telemetryRuns` needed for experiment operations (`hypothesis`, `methodology`, `prototypeId`, `studyId`, `operator`, `environment`, `tags`).
2. Add list/get queries for experiments and active runs.
3. Add query to resolve active run by session for auto-tagging from interview runtime.
4. Add run analytics query that computes stage deltas and percentile summaries per run.
5. Keep all new fields optional to avoid migration breakage.

### Task 2: Auto-associate interview telemetry with active run

**Files:**
- Modify: `app/interview/[sessionId]/page.tsx`

Steps:
1. Query active run by session.
2. Include `runId` on every `recordLatencyEvent` mutation call.
3. Preserve existing behavior when no run exists.

### Task 3: Build `/experiments` operator console

**Files:**
- Create: `app/experiments/page.tsx`

Steps:
1. Build page sections:
- experiment creation form
- experiments list
- run start form (experiment, variant, prototype, study/session linkage)
- active runs panel with stop controls
- recent runs analytics cards
2. Include clear run status and timing metadata in UI.
3. Keep UX mobile-safe and operator-focused.

### Task 4: Document operator checklist and protocol

**Files:**
- Modify: `docs/experiment-writeups.md`

Steps:
1. Add a strict baseline run checklist section.
2. Add IA/screen outline for `/experiments` route.
3. Add run hygiene rules (before/during/after run).

### Task 5: Verify

**Files:**
- No new files

Steps:
1. Run `npx convex codegen`.
2. Run `npx tsc --noEmit`.
3. Run targeted tests where touched logic has tests.
4. Report any pre-existing failures separately.

---

## Plan Delta (2026-02-23): PostHog Assignment Model

### Assignment Source of Truth
- Convex is authoritative for assignment.
- `experimentVariations.decisionEngineIdAssigned` is set deterministically from matrix generation/start.
- Session runtime uses persisted assignment only.
- No mismatch-resolution branch for assignment.

### PostHog Role
- PostHog is analytics-only for operator experiments:
  - exposure tracking
  - lifecycle event tracking
  - downstream visualization/analysis
- Assignment is never chosen by PostHog in this mode.

### Backend Flow Delta
- `experimentRuns.startNextSession`:
  - reads next pending variation from Convex
  - creates session with assigned decide mode
  - schedules exposure emit best-effort
- `sessions.createForExperimentVariation`/session creation path remains responsible for applying assigned mode.

### Runtime Routing Delta
- Interview runtime routes by `session.decideMode` only.
- No runtime PostHog flag lookup for engine selection.

### Failure Policy
- PostHog unavailability must not block experiments.
- Exposure failures are recorded and can be retried out-of-band.
