# S5 independent static security and architecture review

October 9, 2026. Reviewer: architecture/security subagent, separate from the implementation author. Reviewed the working-tree files enumerated in `docs/implementation/S5-CAPTURE.md`, their authorization/lifecycle dependencies, and the approved research capture/consent contract. Base checkout HEAD: `849a79b1779bfcb1080bf4bd64033ebcb20dcd27`; S5 files are uncommitted working-tree additions.

**Current disposition after repair re-review: R1, R2, R3 and R5 are closed at the static code-review level; R4 remains conditional/open after the coordinator's failing runtime counterexample. Native qualification remains pending.** Original counterexamples are preserved below. This is static reasoning, not independently reproduced runtime evidence. No tests, typechecks, builds, services, Convex pushes, provider calls, secret reads, account operations or implementation edits were performed by this reviewer. Existing authored tests were read, not run. The coordinator owns serial validation while the host recovers.

## Repair re-review — October 10, 2026 UTC

Read `S5-REPAIR-HANDOFF.md`, the current repaired functions/store contracts/schema, and the authored backend and transport counterexample tests. No additional actionable defect was identified in this bounded re-review.

| Finding | Static disposition and evidence |
| --- | --- |
| R1 | Closed. `captureLifecycle.ts:30-49` selects eligibility by capture/state/expiry or modality/consent epoch before taking a batch. Unchanged microphone rows cannot starve camera rows. Full eligible batches schedule continuation and each new invocation uses the current persisted revocation watermark. The 50+1 mixed-modality and second-withdrawal cases remain in the tests. |
| R2 | Closed. `captureGateway.ts:11-68` and `gateway.ts:24-66` implement bounded attempts for one immutable logical source. Headers are checked before claim. Existing objects reconcile before retry; active writer leases prevent retry; persisted `retry-fencing` denies old finalization before object retirement. A confirmed old-key fence precedes activation of a different server-selected key. Late finalize/deletion acknowledgements carry attempt identity, and replaying an activation acknowledgement cannot reset an uploading successor. Neither descriptor/source ID nor reserved bytes are recreated during rotation. |
| R3 | Closed. `participant.ts:69-74` coordinates capture in the same mutation; `capture.ts:64-75,136-165` invalidates the DOM challenge and rejects new collection when conversation/capture is paused or ended. Exact historical receipt replay still checks its original content, origin, challenge and current consent epoch. Conversation resume alone does not restart capture; explicit capture start and a new connection establish the next generation. |
| R4 | **Conditional/open.** The source correction at `lifecycle.ts:19-20,91-98` selects purging sessions independently of their old deadline and schedules withdrawn sessions immediately. However, root's full capture run reports the preserved day-one recovery-only test failing at `backend.test.ts:222`: the session remains `purging` after four zero-time cycles. Do not close R4 until the scheduling/test behavior is understood and the original multi-batch counterexample passes without weakening its contract. |
| R5 | Closed. `gateway.ts:80-91` reauthorizes after awaited object reads and immediately before each enqueue, including split chunks, with zero wrapper prefetch. The deferred-read test revokes while I/O is pending and requires rejection/cancellation when those bytes arrive. |

The R2 review specifically traced both orderings of a late conditional writer versus retirement: if the write wins first, retirement overwrites its bytes; if the marker wins first, conditional create cannot replace it. Once `retry-fencing` commits, neither result can make the old attempt available, and a stale receipt cannot mutate the successor. A lost retirement/activation response leaves the old attempt fenced or allows idempotent activation reconciliation. These conclusions depend on the private store's stated atomic contracts; static inspection of the local link/rename implementation and unwired bucket port is not evidence of actual R2/S3 guarantees or power-loss durability.

Root's latest serial validation report: capture package and Convex TypeScript checks passed; the full capture run passed 30 of 31 tests, with the R4 failure described above. These results were reported by root, not rerun by this reviewer. The new authored tests use separate fake-authority/local-store and convex-test layers; they do not replace the still-required combined mounted gateway→Convex→private-store, restart/recovery and real browser receipts. In particular, include stale cleanup acknowledgement rejection, lost activation response and consent withdrawal during retirement in native lifecycle qualification. The original browser/capture/player/publication/hosted gates at the end of this document remain open.

## Original findings and retained counterexamples

### R1 — P1: selective consent cleanup can permanently skip withdrawn media

**Paths:** `convex/captureLifecycle.ts:30-33` and `:49`; consent epoch changes at `convex/capture.ts:93-96`.

Each purge reads the first 50 records for a capture/state, then decides in memory whether each is withdrawn. Unaffected records remain at the front of the same index. Re-running the minute sweep does not advance past them.

**Counterexample:** make 50 available microphone segments, then one available camera segment. Withdraw camera while retaining microphone/storage/analysis. The camera epoch becomes inaccessible immediately, but every purge fetches the same 50 microphone records, changes zero records, and never marks the camera object `delete-pending`. The physical camera bytes survive until full retention purge, contrary to the selective withdrawal cleanup contract. The same issue can affect mixed reserved/uploading batches.

**Required correction:** make bounded cleanup advance through all relevant rows, or query by the fields that identify withdrawn media. Persist a cursor/generation if necessary; do not solve this by unbounded collection. Unchanged rows must not starve later rows. Preserve idempotency if consent changes during the traversal.

**Independent acceptance case:** the mixed-modality 51-record sequence above, plus a second consent change during cleanup. Assert both immediate read denial and eventual object-retirement intent for every withdrawn segment while still-consented objects remain available.

### R2 — P1: an upload failure before object creation has no recoverable retry path

**Paths:** `packages/research-capture/src/gateway.ts:30-51`, `:25-28`; `convex/captureGateway.ts:16-19`; `convex/capture.ts:59-74`.

The gateway claims a reservation before validating headers or reading/hashing the body. Claim durably changes `reserved` to `uploading`. If the body is truncated, the checksum fails, or the connection disappears before object creation, reconciliation reports `object: absent`, but no endpoint can return the logical segment to a dispatchable state. Repeating PUT fails because claim only permits `reserved`. Repeating reserve with the same request ID returns the stuck row. A new request ID cannot replace that interval because the previous reserved sequence/end time already advances the modality's ordering. Expiry eventually retires the key rather than recovering its source bytes.

**Counterexample:** reserve segment 0 for interval 0–1,000 ms, begin PUT, then lose the connection before the object write. The browser still has the correct bytes. POST reconciliation finds no object; retry PUT is rejected; a replacement segment covering 0–1,000 ms is rejected by ordering. A routine upload interruption therefore forces a permanent evidence gap even though the captured data remains recoverable locally. The approved product contract requires partial/failed upload with retry.

**Required correction:** distinguish unknown write outcome from proven pre-write failure. After the prior writer lease is safely resolved/fenced, permit a bounded new upload attempt for the same logical segment without changing its evidence interval or double-counting capacity. A fresh attempt key with retirement of the old key is one option; do not simply reset `uploading` while an older writer might still complete. Validate readily checked headers before consuming a claim as an additional improvement, not the complete fix.

**Independent acceptance cases:** invalid content length, truncated body, checksum mismatch, pre-write network loss, and write-succeeded/receipt-lost. Correct local bytes must recover the first four safely; the fifth must reconcile without duplicating object writes or source records. Add a late old-writer completion race against the retry.

### R3 — P2: new DOM collection remains accepted after pause or conversation completion

**Paths:** `convex/capture.ts:112-126`, `:133-136`; `convex/participant.ts:68-72`.

`connectDom` and `appendDom` check capture state/deadline but not the conversation state. `participant.transition` changes only the session. Media reservation does check `session.state === 'active'`, so the modalities have inconsistent pause behavior.

**Counterexample:** start capture and connect DOM; transition the participant session to `paused`; submit a new correctly sequenced click with the valid challenge. `appendDom` stores it. It also accepts new events after the session becomes `partial` or `completed`, while the capture deadline is still in the future. This violates the approved “Pause session stops conversational capture and active recording together” boundary and can create evidence after the participant believes collection ended.

**Required correction:** explicitly coordinate conversation/capture pause and end transitions. New DOM collection must require an active permitted recording session; any permitted flush of already captured pre-pause events needs a bounded, explicit contract. Exact replay of an existing receipt can remain idempotent. The eventual browser integration must stop instrumentation/listeners as well as update a badge.

**Independent acceptance cases:** pause, partial completion and full completion each reject new DOM events; permitted old receipt reconciliation remains safe; resuming the same session restores only explicitly enabled capture without erasing the gap.

### R4 — P2: early withdrawal of transcript sources is omitted from recovery scanning

**Paths:** `convex/capture.ts:98-99`; `convex/lifecycle.ts:37-52`, `:91-98`; `convex/captureLifecycle.ts:19-23`.

S5 correctly allows `purgeSources` to run before `retainUntil` when `withdrawnAt` is present. But the recovery query for `retentionState === 'purging'` still requires `retainUntil <= now`. The capture sweep retires media and DOM; it does not restart transcript-source deletion.

**Counterexample:** withdraw storage on day 1 of a 30-day session, leaving `withdrawnAt` and `retentionState: purging`, then lose/fail the scheduled early `purgeSources` invocation before completion. Run the recovery sweeps. Source access stays denied, but transcript records are not selected for deletion until day 30. The new immediate withdrawal path lacks the stated recovery behavior.

**Required correction:** include early-withdrawal `purging` sessions in the bounded indexed recovery path independently of their original retention deadline. Ensure multi-batch interruption is recoverable. Do not weaken immediate read denial or reschedule every future retained session.

**Independent acceptance case:** persist the day-1 withdrawal state with remaining sources and no pending deletion job, run only recovery entrypoints, and verify sources are purged before the original deadline.

### R5 — P2: stream reauthorization occurs before a potentially stalled read

**Path:** `packages/research-capture/src/gateway.ts:68-73`.

The comment promises authorization before each emitted chunk, but a pull authorizes first, then may await the underlying object stream, and enqueues without checking again.

**Counterexample:** allow `authority.read`, keep the next `reader.read()` pending, revoke consent/operator access, then release the source chunk. Up to 256 KB is emitted after revocation despite a fresh check at that point being able to deny it. The existing test revokes before a pull; it does not cover revocation while object I/O is pending.

**Required correction:** check current authorization after awaited underlying reads and immediately before enqueue, including splitting a previously received chunk. Cancel the source when denied. This cannot recall bytes already sent or make network transmission atomic with revocation, but it closes the avoidable arbitrarily long authorization-to-send window.

**Independent acceptance case:** a deferred source stream and controllable authority, with revocation between successful authorization and resolution of the underlying read. Assert no subsequent chunk is enqueued.

## Boundaries that look sound in this static pass

- Participant capability resolution rechecks invitation, retained session and client/project state. Media read additionally requires the live named operator session and exact client/project/session scope. The server chooses object keys; public participants cannot attest object existence or finalize media without the gateway proof.
- Consent epochs prevent withdrawn historical media becoming visible merely because the participant later re-enables a modality. Full storage/analysis withdrawal denies access immediately; findings above concern subsequent physical recovery, not a demonstrated bypass of that immediate denial.
- Operation-bound HMAC proofs, conditional object creation and persistent retirement markers form a useful fence against delayed writes. Local atomic link/rename operations and the bucket port's stated conditional-create/overwrite contract address the intended resurrection race. Actual R2/S3 guarantees and crash durability are not established by this static review.
- DOM bridge checks the actual window identity, origin and challenge, and rejects unexpected envelope/event fields. Instrumentation serializes opaque approved IDs and typed events rather than text, values or selectors. Backend provenance correctly stops short of treating a participant-supplied event as independent attestation.
- Admission uses a global transactional capacity row, so the six-session/one-active envelope is shared across clients rather than multiplied per client. Reduced configuration values cannot raise the documented envelope. This is not per-client fairness or billing enforcement.

## Unvalidated or intentionally unfinished gates

The S5 checkpoint candidly identifies these; they are not findings of implemented behavior passing acceptance:

- No mounted gateway, persistent cleanup runner, native gateway→Convex→private-store receipt, local restart/restore proof, concrete R2/S3 port, hosted headroom check, or provider operation accounting. Do not expose hosted admission until they are qualified. Storage/retirement tombstones, unfinished writes, generated frames and historical bucket versions must be included in the storage/deletion story.
- No browser MediaRecorder integration, actual microphone/camera/screen permission handling, local buffer bounds, playable container/segment strategy, source player or parent DOM connection. The demo origin is hardcoded for local use. DOM reload/reconnection after recorded events is explicitly unfinished; the approved resumability path still needs it.
- Raw publication/client-password grants are not implemented by these operator-only read APIs. Source grant/download controls must be enforced when that path is added, not inferred from current private reads.
- Per-chunk Convex authorization and whole-segment buffering/hashing need measurement against the chosen runtime and included usage. Same-origin browser Origin/header behavior and the authenticated player/facade need a real browser test; synthetic `Request` tests do not qualify browser transport.
- The local store does not establish fsync-based power-loss durability, backup erasure or production filesystem permissions. The bucket adapter trusts its private port for object metadata and atomic writes; native conditional-write, retirement, versioning and lifecycle behavior needs separate qualification.

Preserve the five counterexamples above as independent acceptance tests when the coordinator authorizes execution. Report test results and native integration evidence separately from this static review.
