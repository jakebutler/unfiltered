# Bounded independent capture backend/server review

October 10, 2026 UTC. Reviewer: GPT-6.1-sol, High. Applied the Convex reviewer skill. Scope: `S5-CAPTURE-LOCAL.md`, research-server facade/config/worker/runner, capture authority SDK fetch integration, new status/DOM/gap/disconnect APIs and Vite proxy. Frontend was excluded from this initial execution/review because another author was editing it. Existing retirement/gateway code was read only as needed for deletion-race and wrapper compatibility checks. No services, VM, native runner, cloud, provider, credential provisioning or Convex push was executed.

## Actionable finding and authorized repair

**P2 — occupied listener was discovered after synthetic mutations.** The native runner first called its listener probe inside `start()` after operator login, client/project/study/invitation creation, participant consent/capture start and media reservation. Therefore a reachable unrelated process at port 8789 could leave synthetic writes before the runner refused admission, contrary to its documented precondition. Its generic `TypeError` exception also treated connection reset and other unknown fetch failures as evidence of an absent listener.

Root authorized a narrow correction. New `src/listener.ts` accepts only a native TypeError with `cause.code === ECONNREFUSED` as absence. Every reachable HTTP status and unknown/reset/timeout/malformed outcome fails closed. `qualify.ts` invokes this gate before the first authentication/domain mutation and again before spawning its child. A reachable response body is canceled without awaiting arbitrary cancellation; no unrelated process is terminated and no unrelated synthetic state is deleted. The reviewer authored this correction; root subsequently inspected the guard and ordering and accepted the narrow fix.

Seven synthetic helper tests cover explicit refusal, reset/timeout/unknown errors and reachable 200/403/500 responses whose cancellation promises never resolve. They pass without network, child processes or private config.

## Boundaries reviewed

- Facade Origin takes precedence. Missing Origin is accepted only for GET with an explicit bearer, exact same-origin fetch metadata and parsed Referer origin; it still calls live Convex operator authority before bytes. PUT/POST never use the fallback. Proxy `changeOrigin:true` supplies the fixed listener Host; portable request origin is normalized only after this facade admission.
- Server operation/upload counters increment synchronously before asynchronous work, preserving four concurrent operations and one PUT. Upload shape/size rejects before authority claims. GET/POST bodies and wrong methods/hosts reject. Health returns aggregate operational counters, not credentials or subjects.
- Installed Convex SDK explicitly supports `{logger:false, fetch:transport}`. Queries/mutations dispatch through that fetch once; redirect denial, configured-origin pinning and fresh ≤10-second timeout compose with server lifetime or runner abort. The server propagates individual disconnect through its streaming request; metadata claims already in flight may retain an unknown attempt and require reconciliation.
- Cleanup uses persisted Convex intent, bounded receipt batches, permanent retirement before acknowledgement and attempt-bound acknowledgement. Shutdown closes new admission, aborts lingering authority work and waits for the serial worker. Existing gateway tests exercise upload/revocation and retirement interleavings rather than assuming deletion from UI state.
- Status uses three indexed latest sequence reads, including reservations, and returns only bounded counters/start time/approved DOM policy. DOM/gap inspection uses live operator ownership, active scope, retention/consent and explicit pagination shape; revoked DOM epochs are excluded through the index. Current challenge is required to disconnect, replay is idempotent, stale generation cannot clear its successor, and gap exhaustion stops capture/releases capacity.
- Runner claims remain synthetic local gateway/filesystem proof only. It records intent before domain writes, owns only spawned children, stops unknown mutations instead of replaying them, and preserves its failed receipt. Backend/device/browser/cloud acceptance is not inferred from static checks.

## Serial local verification

Node 22.22.3 and `NODE_OPTIONS=--max-old-space-size=1024`; Vitest one worker with file parallelism disabled. All final checks after the listener correction pass:

```sh
node_modules/.bin/tsc -p apps/research-server/tsconfig.json
node_modules/.bin/vite build --config apps/research-server/vite.config.mts
node_modules/.bin/vitest run --config apps/research-server/vitest.config.mts --maxWorkers=1 --no-file-parallelism
node_modules/.bin/vitest run --config packages/research-capture/vitest.config.mts --maxWorkers=1 --no-file-parallelism
```

Server typecheck/build exit **0**. Facade/listener tests **10/10 pass** (3 existing origin checks, 7 new listener counterexamples). Full capture suite **34/34 pass** (20 backend, 14 gateway). No frontend tests or native qualifier execution are part of this initial result. The slot was explicitly released to root for its separate DO-A10 batch with no active processes remaining.

Pending: actual local native runner acceptance, browser GET/proxy semantics, device/media playability, backend restart persistence and all hosted/cloud/accounting gates in `S5-CAPTURE-LOCAL.md`. No additional backend/server blocker was found within this bounded scope.

## Frontend follow-up

Reviewed `capture-browser.ts`, `ResearchCapture.tsx`, `CaptureSources.tsx` and their participant integration after author handoff. The independently identified one-PUT server versus three independent frontend upload chains was repaired by the frontend author with one shared FIFO queue. Queued sources retain their six-slot allocation; per-mode cancellation and permission/generation checks run before dispatch. The timeout and dispatched/unknown marker begin only when the network job starts. A dispatched failure retains the original source for explicit POST reconciliation rather than automatic PUT replay. Selective withdrawal stops its own tracks and waiting source while other modalities continue. Recorders share the persisted session clock and combine each stopped run into a complete container.

The six slots cap retained/live container bytes at 48 MB, with the already-disclosed transient digest copies and browser encoder/network memory outside that accounting. Protected playback authenticates same-origin fetch, bounds bytes against the receipt, and releases object URLs on close, token/scope change and unmount. DOM messages validate the exact window/origin/challenge; only authorized opaque events are appended, and uncertain original connection/batch identities are retained for explicit checking. These static checks do not establish real browser container playability, fetch metadata/proxy behavior or native acceptance.

Focused `capture-browser.test.ts` **12/12 pass** under the same Node/heap/worker bounds, including simultaneous capture, common offsets, six-slot backpressure, selective withdrawal, unknown reconciliation, queued cancellation and stale admission. Research typecheck initially exposed the adapter returning Convex's `Promise<null>` where `CapturePort.gap` requires `Promise<void>`; root authorized the one-line async-await adapter normalization, after which `npm run research:typecheck --silent` exits **0**. No extra test rerun was needed for that return-type-only change. The execution slot was released to root with no processes remaining. No additional material frontend blocker was found in this bounded review; services/native/browser proof remain separate gates.

## Authorized first native execution

Root separately authorized local runtime execution. After checking free ports and acceptable host pressure, started only the existing Colima `unfiltered-s0` profile at 2 CPUs/4 GiB/20 GiB with no host mounts, automatic context activation or SSH-config modification. All clinic containers remained exited with restart policy `no`; started only the pinned `infra/research/compose.yml` backend on loopback 3210/3211. Verified the private configuration's local target without printing credentials. A single Node 22/1 GiB `convex dev --once --env-file infra/research/.env.local` push and a single `setup-capture.mjs --allow-local-config-write` both succeeded.

Ran the documented native qualifier once with the unused `S5-NATIVE-LOCAL-2026-10-09.json` filename. **Passed 8/8, exit 0**, from `2026-10-10T04:45:55.817Z` to `04:47:06.600Z` (70.8 seconds). This exercised actual operator/participant authority, checksum rejection, owned SIGKILL/restart, the unshortened writer lease and old-key retirement, safe attempt rotation preserving source/capacity, stale finalization denial, authenticated digest/range and isolation, restart reads, streaming withdrawal, persisted offline withdrawal, startup cleanup, and permanent retirement/late-write denial. Withdrawal terminated the 4,000,000-byte HTTP body after 256,000 bytes; camera remained readable until full withdrawal. No automatic retry or second run occurred.

The receipt confirms owned gateway stopped and operator signed out. Final port/container checks confirmed only responsive research Convex 3210/3211 remains running; 8789 and 5174 are free and clinic containers remain stopped. Host free-memory indicator ended at 42%, without severe pressure. Execution slot released to root. No frontend was launched, and the synthetic receipt explicitly has `realBrowserMedia:false`, zero cloud/provider calls and zero cash. Backend restart persistence, actual browser/proxy/device/container playability and hosted gates remain unproved by this run.
