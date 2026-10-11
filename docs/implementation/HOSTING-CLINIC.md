# Clinic hosting package

Status: packaging implementation has subsequent local verification recorded in `evidence/hosting-package-bb27592a-c9e2-4962-93e1-97b7880c08eb.json`. The later shared-ingress patch described in [INGRESS-CLINIC.md](INGRESS-CLINIC.md) is **static only, untested and not hosted-qualified**. This package has not been deployed. Current account/project setup is tracked by root separately; it does not establish runtime behavior or remaining hosting headroom.

## Packaging choice

The clinic is a separate generated deployment directory. It does not deploy the repository's older Next.js application or research app. The existing Vite client is built into `public/`; a bundled Node 22 `server.cjs` composes the existing clinic handler, portable Medplum runtime, and Node speech adapter. One origin serves the app, `/api/*`, and `/api/clinic/speech/input`. The first entry injects **no provider adapters**, so guided text is available and adaptive/voice activation remains off.

Vercel's current Node documentation supports root `server.{js,cjs,mjs,ts,cts,mts}` detection through `server.listen()`. This package uses that path instead of adding a framework or rewriting API paths. [Node runtime](https://vercel.com/docs/functions/runtimes/node-js).

Current WebSockets documentation confirms native Node HTTP servers with `ws`, **beta on all plans**, requiring Fluid compute. Connections remain on one instance until closed; reconnects may reach another. Maximum function duration ends a socket. The generated configuration enables Fluid compute and request cancellation, sets a 300-second maximum, and includes only the public assets/manifest in the server bundle. Platform capture, routing and cancellation behavior still need actual hosted verification. [WebSockets](https://vercel.com/docs/functions/websockets), [function configuration](https://vercel.com/docs/project-configuration/vercel-json).

Hobby currently allows 300 seconds, 2 GB memory, 4 CPU-hours, 360 GB-hours and one million function invocations. Its personal/noncommercial terms may suit Jake's synthetic hiring demonstration; paid Corvo client work requires a suitable later plan. Account eligibility and remaining capacity are unknown. Vercel's listed function autoscaling ceiling is **not** an application spending or socket-concurrency cap. [Hobby](https://vercel.com/docs/plans/hobby), [function limits](https://vercel.com/docs/functions/limitations).

## Files and boundaries

| File | Purpose |
| --- | --- |
| `infra/cloud/vercel/package-clinic.mjs` | Local-only Vite client/server packaging into a new ignored directory; rejects existing outputs and retains a failure receipt |
| `infra/cloud/vercel/server.ts` | Captured Node entry, server-only configuration, explicit provider-off composition, shutdown hook |
| `infra/cloud/vercel/application.ts` | Reusable HTTP/API/WS factory; accepts existing adaptive/speech adapters after qualification |
| `infra/cloud/vercel/hosted-config.ts` | Bounded server environment parser; pins Corvo project/client/member, HTTPS origin, seven scenarios, PHQ-4, and live attestation envelope |
| `infra/cloud/vercel/static-assets.ts` | Enumerated asset serving, hash/read-path validation, SPA routes, CSP, ETag and cache behavior |
| `infra/cloud/vercel/test/hosting.test.ts` | Pending focused configuration, traversal/tamper, HTTP routing and denied-upgrade tests |

The generated deployment contains application code, public assets/fonts/licenses, asset hashes and packaging metadata. Packaging does not read `.env` files or clinic/provider configurations; Vite environment-file discovery is disabled. No secret is written into generated files. Output lives below ignored `infra/cloud/.private/` to avoid committing build artifacts, but the package itself is designed to contain no secrets.

At runtime, the only required private value is `CLINIC_CONFIG_JSON`: the exact qualified cloud configuration for the chosen canonical HTTPS origin. Do not prefix it with `VITE_`, put it in `public/`, include it in a build artifact, or replace it with the local fixture config. The parser's structural check is not native storage qualification: `runtimeProvider` still verifies the signed proof and current least-privileged Medplum identity/policy/version before storage operations. Attestation expiry, changed origin, changed policy and server upgrades require the renewal described in [CLOUD-CLINIC.md](CLOUD-CLINIC.md).

The server reads only packaged public assets from disk. Patient state, receipts, provider leases and native membership authority remain in Medplum. Staff cookies are encrypted and portable. There is no runtime configuration file creation, `/tmp` secret materialization, browser provider key, or process-local staff session store.

## Shared admission and remaining public-release controls

The existing `createProviderAdmission` ledger uses conditional creation and versioned CAS in Medplum. It accounts for requests, tokens, input bytes, characters and audio seconds before dispatch, permits bounded provider/session concurrency, and retains the full reservation after an unknown outcome, interruption or timeout. Every instance/deployment must use the **same project and policy ID** for the same budget. A new policy ID is a new allocated budget, not an automatic reset. Separate clinic projects do not magically share this ledger even when they use the same provider account; account-wide allocation across those projects needs explicit coordination.

The hosted factory now injects a shared Medplum ingress ledger for new sessions, staff-login attempts and authenticated speech upgrades. Conditional creation and versioned CAS protect one fixed project-scoped ledger across instances, redeploys and origin changes. The ledger preserves lifetime attempt counts and limits pending/active speech capacity; changed policy names or limits fail against the existing ledger instead of silently allocating a new budget. Existing process counters remain cheap local guards. This new code still needs its focused tests and native/hosted qualification before public use; see [INGRESS-CLINIC.md](INGRESS-CLINIC.md) for the exact bounds, lifecycle and remaining checks. It does not replace platform DDoS controls. Verify actual firewall entitlement and account headroom.

The current speech transport caps capture at 60 seconds with bounded setup/lifetime and frames. This fits the configured function duration on paper. Hosted validation must prove upgrade rejection, cookie/origin scope, disconnect/abort propagation, cancellation before upstream dispatch, provider cleanup, concurrent-instance admission, expiration after a killed instance, and behavior across a deployment. A dropped connection must leave an uncertain attempt charged and explicitly unresolved; automatic paid replay is inappropriate. Native WebSocket beta support alone is not that evidence.

## Pending sequential checks after local resource recovery

Run these individually, inspecting each result before continuing; no parallel worker pool or service startup is needed for the first two commands. The focused test command temporarily creates only loopback fake servers and does not use Medplum or external providers. Coordinate any later service startup with root.

```bash
PATH=/Users/jacobbutler/.nvm/versions/node/v22.22.3/bin:$PATH node_modules/.bin/tsc -p tsconfig.hosting.json
PATH=/Users/jacobbutler/.nvm/versions/node/v22.22.3/bin:$PATH node_modules/.bin/vitest run --config vitest.hosting.config.mts
PATH=/Users/jacobbutler/.nvm/versions/node/v22.22.3/bin:$PATH node infra/cloud/vercel/package-clinic.mjs --output infra/cloud/.private/vercel-clinic-review-1
```

Then inspect the generated receipt/file list, run `node --check` on its `server.cjs`, and inspect remaining `require()` calls/dependencies to establish that bundling is self-contained. Verify the asset manifest and absence of env/config/user files. An isolated loopback smoke of the generated artifact should use synthetic in-memory environment input and request `/`, `/staff`, `/api/clinic/config`, unknown API paths, source/manifest/env paths and a denied upgrade. Confirm guided mode, voice unavailable, no external requests, correct local fonts/CSP, and no source-map or server-file exposure. No current claim is made that these pending steps pass.

## Hosted qualification and later provider wiring

After choosing the actual account/project/plan and stable HTTPS origin, complete the existing scoped Medplum bootstrap and qualification, deliver its server-only config through supported secret handling, and stage this reviewed package. Keep the staging endpoint protected until ingress controls pass. Inspect Vercel's detected server function, Node version, Fluid setting, duration, included files, routing and cancellation support. Validate the seven guided patient-to-staff workflows and native role restrictions on the hosted origin.

Provider activation is already within the approved rebuild scope. It needs completed evidence and an allocated credit budget, not a new invented user approval step. Implement a server-only loader for the existing `boundedAdaptiveProposer` and `speechAdmission` adapters, using the selected DigitalOcean model and the existing Deepgram/ElevenLabs accounts. Inject those adapters at `createHostedClinicServer`'s `providers` extension point. Retain `createProviderAdmission` as the shared spend authority. Do not reinterpret old local qualification markers as proof of hosted behavior or enable providers merely because keys exist.

Run the allocated live qualification against that hosted configuration, with stored attempt/receipt evidence and explicit holds on unknown responses. Only then enable adaptive text/voice in the deployed entry and validate the actual mobile/desktop browser journey. The present entry's provider-off state is temporary packaging scope, not a permanent product limitation. No Vercel deployment, billing upgrade or provider activation has occurred here.
