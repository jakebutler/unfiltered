# S5 local capture gateway and native qualification

October 9, 2026. The local mount and qualification runner are implemented and have passed the static checks listed below. **The runner has not been executed; no native capture acceptance is claimed.** No service, VM, provider, bucket, credential provisioning or Convex push was run for this slice. Coordinate the host and exclusive execution slot before following the runtime steps.

## Local architecture and facade

`apps/research-server/src/index.ts` starts one Node 22 listener at `http://127.0.0.1:8789`. It loads an explicitly supplied mode-0600 JSON config from a mode-0700 runtime directory. Deployment is fixed to isolated Convex `http://127.0.0.1:3210`, and the public research origin is fixed to `http://127.0.0.1:5174`. Hosted targets and unknown config fields are rejected. The private object directory is fixed beside that config as `media-private`, must be mode 0700 and is never served. Config and bytes under `apps/research-server/runtime/` are ignored by Git. Existing retired markers must be retained.

The service mounts the existing `mediaGateway`, `convexCaptureAuthority` and `LocalPrivateObjectStore`; it does not create a second metadata authority or store participant/operator credentials. Vite's research dev proxy forwards `/capture` to port 8789 with the correct listener host. The Node adapter translates the fixed public facade path to the portable gateway's `/api/research-media` path. It never trusts a forwarded host, arbitrary URL origin or public object key.

| Facade request | Required authority and result |
| --- | --- |
| `PUT /capture/media/:id` | `X-Research-Participant: <capability>`, fixed-origin request and raw body with exact `Content-Length` matching the server reservation. The browser should use a bounded `Blob`/byte array so its HTTP implementation supplies length; JavaScript cannot manually set this forbidden header. Success is `{state:"available"}`. Invalid/ambiguous outcomes require reconciliation. |
| `POST /capture/media/:id` | Same participant header, fixed origin, no body. A successful existing object reconciles as `{state:"available"}`; safely fenced retry readiness returns `{state:"reserved",attempt:n}`; unresolved/denied state is 409. Never dispatch a new PUT merely because an earlier acknowledgement was lost. |
| `GET /capture/media/:id?clientId=…&projectId=…&sessionId=…` | `Authorization: Bearer <current Convex Auth token>` and fixed origin; optional single `Range`. When browser GET omits Origin, the Node facade requires the explicit bearer, `Sec-Fetch-Site: same-origin` and Referer whose parsed origin exactly matches port 5174, then normalizes the portable request Origin. Present wrong Origin always rejects; PUT/POST have no fallback. Scope, login, retention, consent epoch and availability remain checked through Convex before the response and between bounded chunks. There is no cookie or public URL grant. |
| `GET /capture/health` | Loopback-only operational state and aggregate worker counters; no keys, tokens, subjects or private config. |

HTML media elements do not supply that bearer header. The research UI must deliberately fetch a bounded authenticated blob or provide a separately authorized player contract. Do not use `referrerPolicy: "no-referrer"` for protected GET: the browser's default policy preserves same-origin Referer, which is required if Origin is absent. Preview origin 4174 and hosted origins are not admitted by this local config. Browser-reported Origin/Referer semantics still need actual browser qualification; the native runner supplies the exact Origin explicitly.

The Node listener caps headers at 16 KiB, permits four concurrent media operations and one upload, rejects chunked/missing/oversized upload lengths before authority claims, rejects bodies on GET/POST, propagates disconnects through the streaming adapter and caps request duration. Error responses and worker logs omit upstream error text and credentials. Authority calls use the installed SDK's supported custom fetch option, no console logger, redirect denial and a fresh timeout of at most 10 seconds, composed with the server/runner abort signal. Unknown mutations are not automatically redispatched.

The serial worker polls Convex's persisted `delete-pending` rows at startup and then every two seconds by default. Each cycle admits at most ten object receipts through the existing cleanup query. Retirement is checked before an attempt-bound acknowledgement; failures preserve intent and back off up to 30 seconds. Graceful shutdown closes new admission, waits up to five seconds for active HTTP requests, aborts authority I/O and waits for its worker. A process crash loses no local queue because Convex owns the queue. Capture purge/source schedules and minute recovery remain the Convex backend's responsibility.

## Narrow browser metadata APIs

`capture.status({token})` now additionally returns `startedAt`, per-modality `nextSequence` and `nextStartMs`, and `domPolicy:{origin,componentIds}|null`. The counters are derived by three indexed latest-row reads, including reserved attempts, so a reload cannot duplicate a sequence or overlap an earlier interval. DOM policy requires current DOM/storage/analysis consent and reveals only the operator-approved origin and opaque component IDs. It does not expose goals, internal script context, challenges, object keys or capabilities.

`capture.domBatches` and `capture.gaps` take `{clientId,projectId,sessionId,paginationOpts}` and return `{page,isDone,continueCursor}` with a 1–25 page bound. Both require live operator login, matching active client/project, retained session, storage/analysis consent and an unpurged capture. DOM inspection also requires current DOM consent and uses the indexed epoch watermark, so regrant never restores withdrawn observations. DOM pages contain only `{sourceId,generation,origin,events,recordedAt}` with the established masked event schema; gap pages contain `{modality,atMs,reason,recordedAt}`. Return mapping uses the project's existing `pageResult` to exclude extra SDK pagination fields, including in `capture.media`.

`capture.disconnectDom({token,challenge})` is an idempotent close for the matching current challenge. It records one `track-ended` DOM gap and clears that challenge; an old popup cannot clear its successor or append a replay gap. Current access and DOM/storage/analysis consent remain required. At the 100-gap bound it closes capture and releases the active slot instead of erasing continuity. Reconnect uses a fresh challenge and generation, continuing the global DOM sequence. The frontend must send the exact-origin stop message and remove its listener before reopening instrumentation. Existing generated API typing already imports `typeof capture`; the eventual local CLI push must perform normal generation.

## Coordinated commands

From `/Volumes/rexy/GitHub/codex-worktrees/unfiltered-foundation/unfiltered`, run each command sequentially, using the Node 22 executable below. These commands are instructions for the coordinator, not evidence of native execution.

```sh
NODE_OPTIONS=--max-old-space-size=1024 /Users/jacobbutler/.nvm/versions/node/v22.22.3/bin/node node_modules/typescript/bin/tsc -p apps/research-server/tsconfig.json
NODE_OPTIONS=--max-old-space-size=1024 /Users/jacobbutler/.nvm/versions/node/v22.22.3/bin/node node_modules/vite/bin/vite.js build --config apps/research-server/vite.config.mts
```

The isolated research backend must already be running and contain the reviewed capture functions/schema. Starting its VM/compose stack and pushing requires separate coordinator authorization. The exact local push command remains `npx convex dev --once --env-file infra/research/.env.local`. Never substitute a hosted deployment. Do not start a second research gateway during the owned-process proof.

Align the gateway secret with that existing local backend only after runtime coordination:

```sh
NODE_OPTIONS=--max-old-space-size=1024 /Users/jacobbutler/.nvm/versions/node/v22.22.3/bin/node infra/research/setup-capture.mjs --allow-local-config-write
```

The helper checks the existing private local admin config, reuses an already configured gateway secret, persists a new secret privately before its single environment write, and verifies that exact variable via the installed CLI's bounded system-query contract. A different existing private-file secret fails closed; no automatic rotation or blind retry occurs. Admin key, HMAC secret, operator password and login tokens are never printed or placed in an evidence receipt.

For the native proof, select a new unused output filename; an existing receipt is never replaced at initial admission:

```sh
NODE_OPTIONS=--max-old-space-size=1024 /Users/jacobbutler/.nvm/versions/node/v22.22.3/bin/node apps/research-server/dist/qualify.cjs --allow-local-synthetic-capture --config apps/research-server/runtime/capture.private.json --operator infra/research/operator.private.json --server apps/research-server/dist/server.cjs --output docs/implementation/evidence/S5-NATIVE-LOCAL-2026-10-09.json
```

The runner owns only the child gateways it spawns. It refuses an occupied listener, writes an intent receipt before synthetic domain mutations, has a five-minute overall bound, uses bounded queries/readback and stops its child in `finally` or after cancellation. It makes no provider/cloud call and does not restart a VM or Convex container. With the default writer lease, the deliberate failed-attempt recovery waits about one minute before retrying safely; this is lease observation, not deadline shortening.

Its actual-boundary checks cover real operator password login and participant consent; native checksum failure and persisted single-source reservation; SIGKILL/restart of the gateway; expired-lease, old-key retirement and safe successor upload; stale attempt finalization denial and unchanged source identity/capacity; authenticated digest/range reads and wrong-origin/anonymous/client isolation denial; readable bytes after another gateway restart; revocation after the first consumed HTTP chunk with partial termination and fresh-read denial; still-consented camera access; full withdrawal with gateway offline and confirmed persisted cleanup intent; startup worker retirement; permanent current/prior attempt marker readback and rejection of actual late conditional filesystem writes; and permanent denial after a final gateway restart. Receipt fields retain phase, fixture IDs and passed checks but no raw credentials/media. A failed or ambiguous step is preserved as failure; it does not authorize a resubmission.

For ordinary local UI use after a successful proof, start the standalone gateway with the same private config, then the research Vite dev server separately. Ctrl-C stops owned HTTP/worker activity; it does not delete markers or erase retained Convex intent.

```sh
NODE_OPTIONS=--max-old-space-size=1024 /Users/jacobbutler/.nvm/versions/node/v22.22.3/bin/node apps/research-server/dist/server.cjs --config apps/research-server/runtime/capture.private.json
```

## Checks performed and remaining gates

This slice ran Node 22 / 1 GiB checks serially under the coordinator-granted slot: clinic foundation emit passed after moving the new qualifier out of its broad scripts glob; research-server TypeScript and Vite library build passed; three new capture browser-contract backend tests passed; Convex and capture-package TypeScript passed. The focused tests initially found unexpected `pageStatus` return fields; the explicit page mapping correction passed on rerun. The authenticated GET metadata fallback and its three focused facade tests were added afterward; **they have not been run or rebuilt yet** because another reviewer owns the execution slot. No clinic TypeScript boundary was widened. The earlier full capture/core passes are recorded separately in `evidence/S5-R4-RESOLUTION.md`; the newest full suite has not been rerun here. The execution slot was returned to the adaptive agent/root.

Pending: native execution and receipt; actual Convex/backend restart persistence; browser Origin/Referer and proxy verification; real MediaRecorder/device permissions, valid playable container segments, screen reshare/gaps and parent DOM stop/reconnect; combined player/source inspection; latency/memory/operation measurements; hosted operation accounting/headroom; concrete R2/S3 adapter/native atomic-retirement proof; publication and client raw grants. The synthetic runner intentionally does not claim real device capture, browser playability, backend restart or cloud storage guarantees.
