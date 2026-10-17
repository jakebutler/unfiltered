# S5 R1–R5 static repair handoff

October 9, 2026. Author response to `S5-INDEPENDENT-REVIEW.md`. **All five corrections are implemented statically and await coordinator-run checks plus independent re-review.** This document is not a passing test or native qualification receipt. No tests, typechecks, builds, services, VM, Convex push, bucket or provider calls were run during this repair.

**Local verification follow-up, October 9, 2026:** see `S5-R4-RESOLUTION.md` for the reproduced R4 timer-drain failure and repair preserving day-one, 151-source, recovery-only deletion before the original day-thirty deadline. Focused R4 passes; full capture and research-core each pass 31/31. Research UI, capture package and Convex TypeScript checks pass after module-scoped type-only environment declarations in `capture.ts`/`captureGateway.ts`. This updates the static-only status above for local checks; independent disposition and native/browser/hosted qualification remain separate and pending. No services or push ran in this follow-up.

## Repairs and preserved counterexamples

**R1:** selective media cleanup now uses compound indexes for capture/state/modality/consent epoch, and a separate capture/state/expiry index for abandoned attempts. Each bounded query selects eligible rows before taking its batch. Still-consented microphone records cannot pin a camera withdrawal behind them. Full batches schedule continuation; subsequent consent epochs use the current persisted watermark. DOM deletion likewise selects its revoked epochs by index. Tests preserve the 50-microphone-then-camera arrangement for `available`, `reserved` and `uploading` states, immediate camera read denial, and a second consent change while cleanup is underway.

**R2:** each immutable logical segment now has a bounded attempt number and distinct server-chosen object key based on its database ID. A PUT first inspects the reservation and validates content length/body presence without consuming a claim. Claimed attempts remain single-dispatch. POST reconciliation first checks whether the current object exists and, if so, completes its receipt without another upload.

For a proven absent object with an expired writer lease, the gateway requests `beginRetry`, which persists `retry-fencing`. No late finalization can publish a fencing attempt. The gateway retires that exact old key and confirms its tombstone before `activateRetry` changes the current key/attempt. The descriptor, time interval, source ID, row and reserved bytes stay unchanged. Activation acknowledgement replay cannot reset a successor that is already uploading. Every claim/finalization/deletion acknowledgement binds the attempt number, so stale writers and cleanup receipts cannot mutate a successor. The old marker fences a delayed conditional write, including a write that completes after the first absent HEAD. Unknown HEAD/retirement outcomes stay unresolved; they do not authorize a successor.

Default limits are three attempts in ten minutes from the original reservation, with a two-minute claim window for each attempt and a one-minute writer lease capped by the overall deadline. These limits may only be reduced. Retry exhaustion or deadline expiry is an explicit unrecoverable segment, not a fabricated source. Pre-pause reservations may settle/recover within this original bounded window; no new logical segment is admitted while paused or after conversation completion. Cleanup retires the current key, while already-confirmed prior attempt markers remain non-content fences. This is not a provider billing guarantee or a claim about historical object versions.

Tests preserve invalid content length, truncated body, checksum mismatch, pre-write connection loss, successful write/lost receipt, same-segment capacity/source identity, stale writer finalization, lost activation acknowledgement, attempt exhaustion, and a deferred old conditional writer racing retirement and successor upload. Store/gateway tests use the private local adapter; backend tests separately exercise real Convex function logic in convex-test. They are authored, **not executed**.

**R3:** `participant.transition` now invokes capture coordination in the same transaction. Pause/end closes new DOM admission, invalidates the current challenge, releases the active-recording slot and retains explicit per-consented-mode pause/end gaps, including DOM. Gaps remain bounded; if that history reaches capacity, capture stops rather than silently losing continuity or refusing the participant's pause. New DOM connect/append also require an active conversation. Exact previously accepted DOM receipts remain reconcilable by matching the original origin, challenge hash and events, subject to current retained consent and access.

Conversation resume leaves capture paused. An explicit `capture.start` can re-admit the existing capture if capacity and its original deadline permit. A new DOM generation needs a new connected event, carries the next global sequence and preserves the prior gap. The prototype accepts an exact-origin `corvo-dom-stop` message and reconnects after it. There is no flush of newly received DOM events after pause; only old receipt replay is accepted. Tests cover pause, partial completion and full completion, receipt replay, implicit resume denial, explicit re-admission and retained DOM gap. Browser integration must actually send the stop message and remove listeners; this library/backend repair does not claim that an unwired frontend does so.

**R4:** source retention recovery selects bounded `purging` sessions independently of their original `retainUntil`, using the existing compound index prefix. Withdrawal-marked sessions schedule their purge immediately, retaining the original deadline in the callback's scope guard. Retained future sessions are still not selected. The preserved day-one counterexample directly leaves 151 source rows and `withdrawnAt`/`purging` state without its immediate job, then invokes only recovery entrypoints and zero-delay scheduled progress; it requires complete deletion before the original thirty-day deadline. The follow-up test verifies the first bounded batch and persisted zero-delay continuation, then advances the fake timer one millisecond to drain Vitest's nested zero-delay timer behavior, without firing future retention jobs.

**R5:** protected streaming reauthorizes after awaited object I/O and immediately before every enqueue, including splits of an already received chunk. Its wrapper uses no prefetch queue (`highWaterMark: 0`). Denial cancels the source and errors the response. The new test deliberately holds the underlying read open after authorization, revokes access, then releases its bytes; consumption must reject and cancel the source. Already transmitted bytes and the unavoidable network transmission boundary remain outside revocation's reach.

## Exact changes in this repair

- `convex/captureLifecycle.ts`: indexed eligible-row cleanup, retry-fencing lifecycle, paused-state recovery.
- `convex/captureGateway.ts`: attempt-bound claims/receipts, begin/activate retry fencing, bounded reconciliation.
- `convex/capture.ts`: logical segment attempt fields/keys; explicit capture resume; atomic conversation transition helper; DOM generations, active-state gates and exact receipt replay.
- `convex/captureValidators.ts`: retry-fencing state and gateway attempt/deadline fields.
- **Shared `convex/schema.ts`:** capture paused state, generation/interruption fields; media attempt/deadline/retired-key fields and eligibility indexes; DOM challenge hash/epoch index; DOM and conversation-ended gap variants. S5 tables have not been pushed and do not yet contain persisted rows; required fields are confined to those new tables.
- **Shared `convex/participant.ts`:** one import and the same-transaction pause/end helper call.
- **Shared `convex/lifecycle.ts`:** withdrawal-aware scheduling and recovery of all bounded purging sessions independently of the original deadline. No new source-recovery index is necessary; the existing index prefix is used.
- `packages/research-capture/src/{contracts,gateway,convex-authority,dom}.ts` and `demo/prototype.html`: matching retry, stream and DOM contracts.
- `packages/research-capture/test/{backend,gateway}.test.ts`: compatibility updates plus named R1–R5 counterexamples.
- `docs/implementation/S5-CAPTURE.md`: revised retry/reconnect statements; this handoff file is new.

The independent review file itself is preserved. No frontend, clinic, secret or provider settings were changed.

## Sequential coordinator commands

From `/Volumes/rexy/GitHub/codex-worktrees/unfiltered-foundation/unfiltered`, using Node 22, after coordinating host capacity:

```sh
node node_modules/typescript/bin/tsc -p packages/research-capture/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p convex/tsconfig.json --noEmit
node node_modules/vitest/vitest.mjs run --config packages/research-capture/vitest.config.mts --maxWorkers=1 -t 'R[1-5]'
node node_modules/vitest/vitest.mjs run --config packages/research-capture/vitest.config.mts --maxWorkers=1
node node_modules/vitest/vitest.mjs run --config packages/research-core/vitest.config.mts --maxWorkers=1
npm run research:typecheck --silent
```

The focused R1–R5 invocation is optional if running the full capture suite immediately afterward; do not repeat checks absent a new failure/change. After those pass and independent review closes the findings, coordinate the isolated local backend startup and push **only** with `npx convex dev --once --env-file infra/research/.env.local`. No service startup or push is authorized by this handoff itself.

All prior S5 native/browser/hosted gates remain: mounted gateway and persistent cleanup runner, actual local end-to-end and restart receipts, concrete bucket transport and native atomic retirement guarantees, body/stream latency and memory/operation measurements, MediaRecorder/player and permission integration, parent DOM lifecycle, publication/client grants and hosting/account headroom. No findings are marked closed solely on this static edit.
