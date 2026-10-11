# Paused — reset the delivery strategy before resuming

> **Update 2026-10-11:** the pause was lifted for one focused clinic session. The clinic bullet below is out of date: https://corvo-clinic-demo.vercel.app now runs the adaptive text intake (`intake-interpreter-v1`, DigitalOcean `qwen3.8-max`, budget-capped). Read [OPUS-HANDOFF.md](OPUS-HANDOFF.md) first. The research notes below are unchanged.

Jake explicitly requested this pause on October 10, 2026 (local time). He is concerned about quota consumption and insufficient progress toward a demo. All implementation, experiments and deployments are stopped. Do not automatically resume the previous queue.

## What is actually usable

- Research: hosted text interview → follow-up → reviewed analysis → published password-protected report/source access/logout passed. https://corvo-research-demo.vercel.app is on AC, deployment `dpl_5E4wY5F7pBJ34Z6U5DgbFyJMD8zp`, with matching native code. All study opt-ins are OFF; no active work. Both current reports remain intact. The final text allowance has four interview calls and one analysis untouched; reader allowance has 465/500 requests remaining. Private instructions are `infra/cloud/.private/research-playback-diagnostic-20261010/a2/final-demo-run-instructions.private.md`. Do not expose its credentials. These allowances expire October18.
- Clinic: https://corvo-clinic-demo.vercel.app remains Q4f guided mode, providers OFF. Seven guided workflows and a partial hosted patient→medical/RD review→patient outcome were demonstrated. Native qualification expires October17 at20:25:41UTC. Adaptive intake is NOT dependable or activated.
- The new typed clinical implementation passes controlled offline handler tests, but both GLM and Qwen live development batches passed only3/8 whole cases. Unsupported clinical interpretations remain. Both batches are closed; dependent medication corrections were not issued. No active inference/allocation execution remains.
- Research voice/media mechanics have twelve local mounted checks; physical audio and broader hosted media remain incomplete. AWS research source/bundled Node checks exist, but the successor container image and normal AWS startup are not qualified.

## Preserve and stop

Implementation worktree: `/Volumes/rexy/GitHub/codex-worktrees/unfiltered-foundation/unfiltered`, branch `codex/unfiltered-foundation`. There is substantial uncommitted/untracked work. Preserve it; no broad add, reset, cleanup or commit. Preserve unrelated primary-checkout clinical-intelligence work and private env files. No VM or broad dev servers should be restarted merely to inspect this state.

Research combined capture budgets/configuration were only being considered. None was authorized or provisioned. Do not replace the untouched final text allowance. No browser/server remains from the research work. Closed inference outputs/accounting remain historical; do not retry old calls.

Detailed current state is in `ORCHESTRATION.md`. Clinical actual results: `evidence/S3-CANONICAL-TYPED-AF162-AF170-INDEPENDENT-REVIEW.md` and `evidence/S3-CANONICAL-TYPED-QWEN-AF171-AF179-INDEPENDENT-REVIEW.md`. A final read-only trace analysis may accompany this pause; it authorizes no implementation or new call.

## Strategy reset required

The process overinvested in manifests, finite micro-windows, repeated reviews and architecture/model iterations. Better guardrails did not deliver reliable clinical conversation. Do not equate test counts, receipts, or source correctness with a usable product.

On resume, first choose the smallest concrete demo journey with Jake and time-box delivery around it. Reuse what already works. Proposed priority: one Corvo Clinic patient completing a useful text intake, reviewing their answers, and reaching a staff handoff; keep the working research text demo accessible. Defer additional multimodal and AWS expansion until that first journey is convincing, without silently deleting the broader agreed scope.

Use one implementation owner and one review at a meaningful milestone. Run targeted tests for actual risks; use existing outputs for debugging. No new model sweep, extraction rewrite, elaborate qualification machinery, or provider batch without a concise explanation of the observed problem and how the next action gets the demo closer. Present unresolved product choices plainly rather than creating more internal gates.
