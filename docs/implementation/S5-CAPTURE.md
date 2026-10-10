# S5 capture foundation — static implementation checkpoint

October 9, 2026. **Unvalidated work in progress.** The coordinator paused checks, services and pushes because the host became overloaded. This slice has not been pushed to any Convex instance, started a media gateway, contacted a provider or object bucket, or exercised a real device. No paid resource or hosted resource was created. Do not expose these APIs or treat the tests below as passing until the sequential validation and independent review are complete.

**Follow-up status:** local automated repair checks are recorded in `evidence/S5-R4-RESOLUTION.md`. The Node gateway mount, persistent cleanup poller, narrow browser metadata APIs and executable native proof are now implemented in `S5-CAPTURE-LOCAL.md`. Their research-server build/typecheck and three new backend contract tests pass. Native execution, browser qualification, local push and hosted gates remain pending; the original paragraphs below describe the earlier checkpoint and do not constitute current native evidence.

## Scope implemented

Research media metadata remains in Convex and bytes use a separate private object-store contract, following the approved architecture. Nothing touches clinic data or clinical staff authority. Existing source text/corrections remain in `researchSources`; media and DOM have distinct source identifiers and provenance. Conversation completion, byte availability and capture continuity are separate states.

The backend adds capture admission, immutable segment reservations, a gateway-only upload claim/receipt protocol, explicit gaps, per-track consent withdrawal, controlled-prototype authorization/handshake/events, and cleanup intent. The approved defaults bound one active recording, six retained captures, 750,000,000 bytes/session, 8,000,000 bytes/segment, 45 minutes, 2,000 segments and 1,800 DOM events. Individual segments are at most 90 seconds. `RESEARCH_CAPTURE_LIMITS_JSON` accepts positive integer reductions of these defaults; unknown keys, invalid values and increases fail closed. These limits are application admission controls, **not provider billing caps or verification of account headroom**. Monthly object-operation and Worker-request accounting remains unimplemented and is required before hosted admission.

Recording requires explicit consent for at least one mode before capacity allocation; each reservation requires matching track consent. The public participant cannot choose an object key, prove a stored object, or finalize an upload. Reusing an operation ID with identical descriptor returns the same reservation; changing its content fails. Sequences and time intervals must move forward per modality. References to conversational sources must resolve within the same session and question.

`captureGateway` calls require a server-only HMAC secret of at least 32 characters, a proof no older than 30 seconds, and a signature over the operation and exact canonical arguments. Operator byte reads additionally require a live Convex Auth identity/session and the correct client/project/session. Upload claims require the participant capability and consent. An attempt cannot be dispatched again through the claim endpoint. A lost result first uses inspect/head/finalize reconciliation; after an expired writer lease and confirmed old-key retirement, an absent attempt may rotate to a fresh key for the same logical segment. Three attempts and a ten-minute total recovery window are the maximum defaults. See the static repair addendum below. Invalid checksums, bytes, MIME, consent, retention or scope do not become available media. No public object URLs or upload presigned URLs exist in this implementation.

The portable HTTP handler checks the exact configured origin, buffers only one capped segment for hashing, uses immutable object writes, returns private/no-store responses, implements a single HTTP byte range, and rechecks operator authorization before each emitted chunk (maximum 256 KB). Already transmitted bytes cannot be recalled. This strict per-chunk check has not been measured for latency or included operation budgets. The handler is a library: it has **not** been mounted in a Worker/Node service or integrated with the research app. HTML media elements cannot directly supply its Authorization header; the future same-origin authenticated facade/player must deliberately satisfy that contract.

## Cleanup and consent

Changing consent increments a capture consent epoch. Withdrawing a modality permanently invalidates media from earlier consent epochs, including if the participant later grants that modality again. Sharing flags remain separate from capture flags; publication/raw grants are still future work. Full storage or analysis withdrawal marks the session inaccessible immediately and schedules early physical source deletion. This is the only source-lifecycle change: `purgeSources` may run before its original deadline when a persisted `withdrawnAt` exists.

Revocation or client/project archival stops future participant uploads and queues incomplete reservations for cleanup. Existing available evidence stays private for the operator (and is inaccessible while its client/project is archived). Revoking an invitation is not a deletion request. Retention/full withdrawal queues all recordings and deletes DOM batches/gap data. Missing scheduled work recovers through an indexed minute sweep, bounded by the six admitted non-purged captures. Cleanup persists `delete-pending` first, waits for the admitted writer lease, then requires the gateway's confirmed object retirement before releasing reserved bytes. The retained session slot is released only after all object receipts are retired and raw metadata has been purged.

Object retirement atomically replaces payload bytes with a zero-byte private marker. This fences delayed conditional uploads: an earlier in-flight write either precedes the retirement overwrite or fails its condition after the marker exists. The marker is deliberately retained; deleting it would permit a late conditional write to resurrect bytes. The local implementation uses atomic filesystem link/rename, private files and a directory that must not be statically served. Process-crashed pending local files are tied to the object key and removed during retirement. There is no claim of erasing backups, already downloaded bytes or provider historical versions. Bucket versioning/lifecycle/backups need explicit deployment qualification.

`BucketPrivateObjectStore` accepts a narrow R2/S3-compatible port requiring atomic conditional create and atomic overwrite for retirement. **There is no concrete R2 binding or AWS SDK port wired yet, nor a native cloud qualification.** `LocalPrivateObjectStore` is the intended first qualification store. Credential provisioning, a local service launcher, persistent cleanup-worker scheduling and a native end-to-end receipt are still needed. Merely importing `cleanupObjects()` does not run recovery.

## Controlled DOM

The operator explicitly authorizes the pinned study's exact prototype origin and up to 64 opaque component IDs. A participant's separate DOM consent defaults false on preexisting consent rows. The parent interview generates a random challenge, calls `connectDom`, then sends that challenge only to the authorized prototype window with an exact target origin. The prototype never receives the research invitation capability. The parent uses `acceptPrototypeMessage` to check the actual `MessageEvent.source`, `MessageEvent.origin`, challenge and exact schema before forwarding masked events through the participant API.

Only typed `connected`, `click`, `focus`, `change` and `scroll` data, sequence/timing, approved component IDs, limited tag types and optional quantized coordinates are admitted. No text, labels, selectors, element attributes, URLs, form values, passwords, keystrokes or content-editable activity are serialized. The current instrumentation emits connected/click/focus/change; scroll is admitted for future instrumentation but is not fabricated. Events are **browser-reported observations**, not independent attestation that a trustworthy participant performed an action. A malicious authorized participant can falsify their own event payload; neither this nor pixels authorize instructions or cross-scope access.

`demo/prototype.html` is a fictional checkout. `c1` denotes the delivery option control and `c2` the review-order button; those stable application-owned meanings are inspectable in source. It performs no purchase. It currently accepts the exact local research opener origin `http://127.0.0.1:5174`; a deployment must explicitly replace it. Serve the package through Vite to resolve its TypeScript module, after coordinator permission to restart services. The parent sends `{ type: 'corvo-dom-connect', challenge, offsetMs, startSequence }`, where offset is elapsed time since capture start and startSequence is returned by connectDom. A accepted `connected` event must be stored before the API reports DOM connected. No parent app integration has been added. A conversation pause invalidates the current DOM challenge and records a gap. Conversation resume leaves capture paused; an explicit capture start can re-admit it without extending its deadline, followed by a new challenge/connected event continuing the global sequence. The prototype supports explicit stop/connect messages. The parent browser integration and listener stop/reconnect behavior remain unqualified.

## Exact touched files

New package files:

- `packages/research-capture/src/contracts.ts`: descriptor, range, limit and object-store contracts.
- `packages/research-capture/src/proof.ts`: canonical operation-bound HMAC proof.
- `packages/research-capture/src/gateway.ts`: private HTTP upload/reconcile/range handler and bounded cleanup helper.
- `packages/research-capture/src/local-store.ts`: private local store and retirement fence.
- `packages/research-capture/src/bucket-store.ts`: narrow R2/S3-compatible bucket-port adapter (unwired).
- `packages/research-capture/src/convex-authority.ts`: server-only gateway-to-Convex bridge.
- `packages/research-capture/src/dom.ts`: masked opt-in instrumentation and parent-message validation.
- `packages/research-capture/demo/prototype.html`: controlled checkout prototype.
- `packages/research-capture/test/backend.test.ts`, `test/gateway.test.ts`: authored, **not run**.
- `packages/research-capture/tsconfig.json`, `vitest.config.mts`.

New backend files: `convex/capture.ts`, `captureGateway.ts`, `captureLifecycle.ts`, `captureValidators.ts`.

Narrow changes: `convex/schema.ts` adds capture tables, invitation session index, optional session withdrawal timestamp; `convex/validators.ts` adds optional DOM consent; `convex/lifecycle.ts` permits withdrawal-driven early purge; `convex/crons.ts` registers bounded capture recovery. `convex/_generated/api.d.ts` was temporarily updated for static module typing and must be regenerated by the local Convex CLI after checks. No research frontend files, clinic files, secret files or provider settings were edited.

## Deferred validation commands

Run sequentially only after the coordinator confirms the host is responsive. Use Node 22. Do not start the isolated VM or push until coordinated. Current schema changes have never reached the local persisted database.

```sh
node node_modules/typescript/bin/tsc -p packages/research-capture/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p convex/tsconfig.json --noEmit
node node_modules/vitest/vitest.mjs run --config packages/research-capture/vitest.config.mts --maxWorkers=1
node node_modules/vitest/vitest.mjs run --config packages/research-core/vitest.config.mts --maxWorkers=1
npm run research:typecheck --silent
# Only after root coordinates restarting the isolated research stack:
npx convex dev --once --env-file infra/research/.env.local
```

One early backend TypeScript check ran before the slowdown instruction. It returned a single literal-union inference error in `capture.status`; that annotation was fixed statically. It is **not** evidence that the final files typecheck. No tests, native checks or local pushes ran after that instruction.

Before acceptance, independently review authorization, callback bounds, consent changes, conditional-write/retirement races, upload aborts and malformed bodies. Then run a native local gateway→Convex→private filesystem session, restart/recovery, byte-range/revocation and deletion readback. Add the concrete bucket port with documented provider guarantees and qualify its behavior. Browser MediaRecorder permissions, actual microphone/camera/screen segments, bounded buffering, playable segment/container strategy, reshare/gaps, DOM parent handshake, operator DOM/gap inspection, natural research voice and raw-source player all remain required work. Analysis, publication and client-password raw grants remain separate subsequent slices. This checkpoint does not claim capture or the overall research experience is test-ready.
