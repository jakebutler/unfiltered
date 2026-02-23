# Changelog

## 2026-02-23 — Experiment assignment model + PostHog analytics integration
**Commit:** uncommitted
- Added deterministic experiment matrix generation with Convex-authoritative assignment (`decisionEngineIdAssigned`)
- Added structured run orchestration tables/functions (`experimentRuns`, `experimentVariations`, `experimentGlobalState`)
- Added session linkage to experiment run/variation IDs for stable runtime routing
- Added PostHog analytics action layer for exposure and run lifecycle events (non-authoritative for assignment)
- Added idempotent exposure markers and failure diagnostics fields on experiment variations
- Added experiment tests for matrix generation, exposure idempotency, and runtime routing stability
- Updated voice latency telemetry and experiment writeup docs with the assignment-model delta and failure policy
- Updated README quickstart to include `npx convex dev` requirement and PostHog env keys

## 2026-02-21 11:50 — Repo consolidation + doc alignment
**Commit:** uncommitted
- Moved project documentation, prompt reference docs, stop-hook config, and scripts into the `unfiltered/` git repo root
- Updated `.claude/settings.json` stop-hook command path to the new root
- Canonicalized AI model docs to GLM-5 via FireworksAI for Policy B, moment labeler, and themes
- Canonicalized findings route references to `/dashboard/[sessionId]`
- Rewrote `CLAUDE.md` and `docs/techspec.md` to reflect current implemented structure and schema
- Updated feature docs from planning stubs to implementation-state references

## 2026-02-21 18:00 — Documentation foundation + implementation plan
**Commit:** uncommitted
- Created full implementation plan at `docs/plans/2026-02-21-unfiltered-v1.md` (23 tasks, TDD, complete code)
- Updated and aligned `spec.md` with all 5 detailed reference docs (cross-references, data model corrections)
- Added §8.3 (frontend stack) and §8.4 (LLM model assignments) to spec
- Renamed original `spec.md` → `DEPRECATED-spec.md`; new product-focused `docs/spec.md` created
- Created `docs/techspec.md` with full technical architecture, data model, signal pipeline
- Created 5 feature stub docs: signal-detection, decide-engine, camera-classifier, findings-dashboard, speechmatics
- Created `CLAUDE.md` with project-level context for Claude Code
- Configured stop hook in `.claude/settings.json` → `scripts/update-docs.py`
- Resolved open decisions: numeric scoring (0–100), store full camera signals sub-object, verification_question in V1 storage, GLM-5 via FireworksAI for Policy B and labeler
