# Research package (local artifact; hosted acceptance pending)

This package serves Corvo Labs research only. It preserves the separate clinic project and Medplum boundary. The frontend connects exclusively to the existing Free Convex target `elegant-crane-662`; HTTP capture, reports, password/grant reads, DO analysis, goal-aware interview and speech share the explicit Node server. Browser input upgrades enter the existing research speech transport. No local storage, cleanup interval, credential-file loader or platform provisioning command is used by the entrypoint.

The root supplies a public JSON manifest with **an actual assigned canonical HTTPS origin**, exact Convex targets, private R2 account/bucket/namespace, <=4,000,000 byte segment/response limits and a pinned Linux x64 FFmpeg version/source/license/digests/size. `config.ts` defines the strict manifest shape. Extra fields, credentials, ambiguous origins and other deployments/buckets fail closed. An `offline-fixture` manifest must use `.invalid`/`.test`; its artifact is explicitly nondeployable and the runtime refuses activation. This avoids inventing an origin before root has provisioned it.

Install the separately pinned hosted lifecycle dependency with scripts disabled. This deploy-specific lock leaves root/frontend dependencies unchanged; the official `@vercel/functions` API is bundled into the backend rather than installed at invocation time:

```bash
npm ci --prefix infra/cloud/vercel/research --ignore-scripts --omit=dev --omit=optional --legacy-peer-deps
```

After the root and nested installs, run `npm run hosting:typecheck` from the repository root.
This is the complete hosting typecheck gate: clinic modules use NodeNext, while research modules
and all research hosting tests use ESNext/Bundler for the Convex ESM dependencies and `import.meta`.
Running only `tsc -p tsconfig.hosting.json` checks the clinic portion, not the complete gate.

The hosted composition injects supported `waitUntil` at peer attachment, while the upgrade request's async context is available. It retains the actual later terminal work through settlement and release acknowledgements. The promise is bounded by the native ingress lifetime plus the existing 5-second save and 10-second terminal ACK waits. Retention ending or timing out never establishes native drainage, releases an unknown hold, or changes provider charges. Local transport callers may omit the hook; the official API itself is a no-op outside the hosted request context.

Build from this checkout with Node22 and the coordinator's execution window:

```bash
NODE_OPTIONS=--max-old-space-size=1024 node infra/cloud/vercel/research/package-research.mjs \
  --manifest /absolute/path/root-public-research-manifest.json \
  --ffmpeg /absolute/path/pinned-linux-x64-ffmpeg \
  --ffmpeg-license /absolute/path/complete-redistribution-notices.txt \
  --output /absolute/path/checkout/infra/cloud/.private/new-research-package
```

Output must be new and under ignored `infra/cloud/.private/`. Builds disable env-file loading and automatic public environment injection. Only the exact public Convex URL and prototype origin are defined at build time. Source maps are off. Only enumerated Vite assets, bundled server, public manifest, FFmpeg and notices are copied. No `.env.local`, private settings, source snapshot, `node_modules`, account state or qualification snapshots are copied. Receipt records file hashes, installed lock digest and actual module inventories; a forbidden legacy/build-only runtime dependency or unbundled non-Node import rejects packaging.

At deployment root, the generated `package.json` starts `server.cjs` with Node22; generated `vercel.json` explicitly selects `framework: "node"`, `buildCommand: null`, a300-second function ceiling, cancellation and build-only function architecture`x86_64`, with exact runtime includes. An empty-string build command forces static mode in Vercel CLI63.1.2 and is incompatible with this Node entrypoint. The explicit architecture matches the pinned Linux binary even when building on an ARM Mac. The entrypoint calls `server.listen()` at module startup as required by the [Node runtime](https://vercel.com/docs/functions/runtimes/node-js). Assets live inside `site-assets/`, served exclusively by the application; there is no platform-autoserved `public/` directory to bypass its canonical Host checks or headers. Root must verify the exact account/project/origin/commit/environment before a separately authorized deployment. The existing empty clinic project is not a research deployment target.

CLI63.1.2 accepts that architecture for local building, but the remote project-config validator rejects it in `vercel.json`. For the accepted candidate C prebuilt output, run the offline helper with a fresh ignored output directory:

```bash
node infra/cloud/vercel/research/prepare-prebuilt-deploy.mjs \
  --stage /absolute/path/checkout/infra/cloud/.private/research-stage-20261010-c \
  --output /absolute/path/checkout/infra/cloud/.private/new-deploy-config
```

The helper removes only `functions.server.cjs.architecture` from a separate `vercel.deploy.json`. It asserts the accepted C build config, function runtime/architecture/cancellation and exact routes; hashes all physical platform output before/after; and writes a receipt. The17 function files remain144,871,288bytes. Builder metadata and routing are also hashed. Original build config, candidates and platform output remain intact. Root's separately authorized `deploy --prebuilt` must run from the original stage with `--local-config /absolute/path/new-deploy-config/vercel.deploy.json`. The prebuilt `.vc-config.json` still supplies `architecture:"x86_64"`; the override only selects deployment project configuration. This helper performs no rebuild, deployment, secrets read or network call and does not establish hosted acceptance.

## Private runtime settings

Configure `RESEARCH_RUNTIME_JSON` in the host's secret environment. Required fields are `gatewaySecret` (64–128 lowercase hex) and `allocationId` (existing prospectively approved native gateway allocation). Optional `speechEnabled`, `analysis`, `interview` default disabled. `analysis` uses the strict existing `parseAnalysisConfig` contract with the package's pinned executable substituted internally; DO-V1 qualification/model and exact unexpired reservations are required for enabling. `interview` requires enabled/model and bounded timeout/input/output limits; its native authority admits each finite model call. Keys alone enable none of these paths.

Required R2 secrets: `RESEARCH_R2_ACCESS_KEY_ID`, `RESEARCH_R2_SECRET_ACCESS_KEY`, bucket scoped to the existing private `unfiltered-recordings`. Optional features require `DIGITALOCEAN_MODEL_ACCESS_KEY`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY` only when explicitly enabled. No OpenAI, Anthropic, Arcee or Fal path is composed. Keys remain runtime only; never put them in the public manifest. Native speech policy/grants, goal-aware policy and analysis reservations need separate prospective activation; packaging does not create/reset them.

Native hosted quotas guard media/report/interview requests under their existing lifetime through response settlement. Interview uses kind`analysis` and wraps each authority operation and underlying provider promise in that lifetime. An unknown interview response does not release the native lease while an uncancellable provider remains unresolved. Speech uses its own existing allocated ingress, provider reservation and cross-instance settlement; it is not double-admitted. Unknown provider/body/storage work keeps existing holds. DO analysis reuses the accepted native extractor and report provenance path. Durable Convex scheduled cleanup calls `/api/research/internal/cleanup` with its pre-acquired signed lease. No server process timer replaces that scheduler. Root must install exact hosted Convex auth/schema/functions/config/allocation and scheduled cleanup URL before admission can succeed.

Static HTML and API responses apply private no-store, capture permissions, CSP for self plus exact Convex endpoints and same-origin WS, nosniff and no-referrer. Hashed static assets may cache immutably. Report capability URLs retain existing Secure/HttpOnly cookie checks. `/prototype/index.html` is the controlled synthetic DOM prototype (`c1`); native immutable study authorization and participant consent are still required. Instrumentation accepts only its same-origin opener/challenge. It does not instrument arbitrary webpages.

## Acceptance frontier

Local composition/dependency tests and reproducible builds do not establish hosting. Required actual-hosted proof includes deployed URL/DOM/security headers, native HTTP and WS upgrade/cancellation, Linux FFmpeg retained-frame parity, simultaneous synthetic devices + controlled DOM, retained playback, password/report/download grants, revoke/withdraw and bounded durable R2 content retirement. Preserve all S7 quotas/charges and S6 grants/evidence. No live provider call, policy activation, cloud mutation or cash use occurs in this package step.
The diagnostic successor adds a dependency-free `server.cjs` entry and bundles the unchanged assembly into `research-bootstrap.cjs`. Its fixed `research-startup` JSON records show `entry`, `import`, `manifest`, `config`, `binary`, `adapters`, `assets`, `application`, `listen` and `listening`. `success` means the synchronous `listen()` call returned; the separate `listening` phase indicates its readiness event. A synchronous failure records only an allowlisted phase/category and throws a generic stackless error. No exception fields, runtime configuration, paths, secrets or stacks are logged. An absent `entry` marker does not prove a platform fault: log delivery itself may also fail. An `import` marker followed by dependency-load failure isolates loading from subsequent application assembly.

Candidate C and its output remain immutable. The prebuilt-config helper retains its original exact C guards with its original four arguments. A diagnostic successor requires **both** explicit root-reviewed `--reviewed-inventory-sha256` and `--reviewed-function-config-sha256` pins, in addition to exact expected diagnostic build configuration, function settings, routing, file envelope and before/after identity. It removes only the project-level architecture field in a new destination; the function architecture stays pinned. Review the complete inventory before supplying its SHA, rather than treating a locally computed hash as approval.

