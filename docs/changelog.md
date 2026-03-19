# Changelog

## 2026-02-23 — Decide-engine turn-taking + dashboard transcript verification UX
**Commit:** uncommitted
- Added deterministic fast-path routing and richer transcript heuristics for confusion, positive feedback, and "no more to add" cues
- Added turn-taking cadence controls, interruption acknowledgements, and runtime timing-config resolution
- Added latency stage instrumentation hooks from decision path through TTS playback
- Updated interview runtime with live cue triggering, pipeline health diagnostics, and `endTurn` flow
- Added dashboard transcript verification sidebar plus confirm/incorrect analyst feedback loop
- Improved friction snippet extraction and review utilities for fragmented transcripts
- Hardened engagement classifier output parsing and error-note handling with vision-capable default model
- Added focused tests for decide runtime config/fast-path/turn-taking, snippet selection, dashboard review helpers, and classifier output parsing

## 2026-02-23 — Experiments console + telemetry/assignment plumbing
**Commit:** uncommitted
- Added deterministic experiment matrix generation and Convex-authoritative assignment tracking
- Added structured run orchestration via `experimentRuns`, `experimentVariations`, and `experimentGlobalState`
- Added telemetry run metadata and latency event storage/query surfaces
- Added PostHog analytics actions for exposure and run lifecycle events (non-authoritative for assignment)
- Added top-level `/experiments` operator console and studies navigation entry points
- Added experiment matrix/exposure/runtime routing tests
- Updated dev/lint config for `.next-dev` and generated Convex artifacts

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
