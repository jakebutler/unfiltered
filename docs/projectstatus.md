# Project Status
**Last updated:** 2026-02-21

## What Happened This Session
- Consolidated the repo so `unfiltered/` is now the effective repo root containing code, docs, scripts, `.claude/`, and reference prompt docs
- Updated stop-hook config to point to `scripts/update-docs.py` in the new root
- Canonicalized model assignments in docs to GLM-5 via FireworksAI for Policy B + labeler + themes
- Canonicalized findings route to `/dashboard/[sessionId]` across active docs
- Rewrote technical and feature docs to reflect implemented code paths, schema tables, and runtime pipelines

## Issues / Watch Out For
- `scripts/update-docs.py` uses Anthropic API and will no-op when `ANTHROPIC_API_KEY` is missing
- MiniMax and Fireworks model names should still be re-verified against provider docs before production deploy
- A/B mode policy assignment currently uses local runtime alternation in `hooks/useDecideEngine.ts`; move to server-resolved assignment for deterministic behavior
- End-to-end behavior has unit coverage, but full browser-level integration still needs repeated manual validation

## Where We Left Off
- Core V1 implementation exists in code (study setup, interview runtime, signal processing, decide engine, post-session labeling/themes, dashboard, export)
- Unit test suite is passing (`7` files, `38` tests)
- Documentation now reflects current implementation structure and canonical model/route decisions

## How to Continue
Start with integration hardening: run a full session in the browser, verify Speechmatics/camera/Fireworks pipelines end-to-end, and then close the remaining runtime gaps (A/B assignment determinism, retry/error paths, production polish).
