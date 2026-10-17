# Proposed capture-only staging manifest

Preparation only: nothing staged or committed. Relative to the current HEAD on October 10, 2026 UTC. Preserve unrelated dirty clinic/provider/voice/V5 work. Use explicit files; do not add the repository root or any runtime directory.

## New code/configuration files

```text
apps/research-server/.gitignore
apps/research-server/tsconfig.json
apps/research-server/vite.config.mts
apps/research-server/vitest.config.mts
apps/research-server/src/config.ts
apps/research-server/src/index.ts
apps/research-server/src/listener.ts
apps/research-server/src/origin.ts
apps/research-server/src/qualify.ts
apps/research-server/src/server.ts
apps/research-server/src/worker.ts
apps/research-server/test/listener.test.ts
apps/research-server/test/origin.test.ts
apps/research/src/CaptureSources.tsx
apps/research/src/ResearchCapture.tsx
apps/research/src/capture-browser.ts
apps/research/test/capture-browser.test.ts
apps/research/fixtures/capture.html
apps/research/fixtures/capture.tsx
apps/research/fixtures/prototype.html
apps/research/fixtures/prototype.ts
apps/research/fixtures/tsconfig.json
convex/capture.ts
convex/captureGateway.ts
convex/captureLifecycle.ts
convex/captureValidators.ts
infra/research/setup-capture.mjs
packages/research-capture/tsconfig.json
packages/research-capture/vitest.config.mts
packages/research-capture/src/bucket-store.ts
packages/research-capture/src/contracts.ts
packages/research-capture/src/convex-authority.ts
packages/research-capture/src/dom.ts
packages/research-capture/src/gateway.ts
packages/research-capture/src/local-store.ts
packages/research-capture/src/proof.ts
packages/research-capture/test/backend.test.ts
packages/research-capture/test/gateway.test.ts
packages/research-capture/demo/prototype.html
```

## Shared tracked files: current capture hunks only

The current diff in each following file is entirely capture-related; recheck at actual staging because other agents share the worktree.

| File | Necessary capture change |
| --- | --- |
| `apps/research/src/ParticipantApp.tsx` | CaptureControls/ref/component, await recorder stop before conversation transition, optional recording consent/copy. |
| `apps/research/src/ProjectWorkspace.tsx` | CaptureSources/PrototypeAuthorization import and study/session composition. |
| `apps/research/src/styles.css` | Appended capture/player/track styles only. |
| `apps/research/vite.config.ts` | Same-origin `/capture` proxy to loopback8789 only. |
| `convex/_generated/api.d.ts` | Four capture module imports and matching ApiFromModules entries only. |
| `convex/schema.ts` | Capture validator import; invitation by_sessionId index; session withdrawnAt; six capture tables and their bounded-access indexes. |
| `convex/validators.ts` | Backward-compatible optional DOM consent boolean only. |
| `convex/participant.ts` | conversationCaptureTransition import and awaited atomic transition call only. |
| `convex/lifecycle.ts` | Three withdrawal-aware scheduling/purge/recovery conditions; retainUntil remains original. |
| `convex/crons.ts` | One capture/upload recovery cron. |

No `package.json` or `package-lock.json` hunk is required for this capture graph. Their current sole change is the Zod root constraint ^3.24.1→^3.25.76 from the clinical slice; exclude both. Exclude `infra/local/.gitignore`'s clinic-provider-settings entry, all clinic/speech/adaptive files, `tsconfig.hosting.json`, cloud scripts, provider receipts and holdout material. Existing research-core/auth/access/generated/data/compose/setup-local infrastructure is already tracked in HEAD and is a prerequisite, not a new staging addition. New capture graph imports research-core and Convex/Node/browser primitives; no clinical/voice/provider module is imported.

## Capture documentation/evidence candidates

```text
docs/implementation/S5-CAPTURE.md
docs/implementation/S5-CAPTURE-LOCAL.md
docs/implementation/evidence/S5-INDEPENDENT-REVIEW.md
docs/implementation/evidence/S5-REPAIR-HANDOFF.md
docs/implementation/evidence/S5-R4-RESOLUTION.md
docs/implementation/evidence/S5-BROWSER-CAPTURE-HANDOFF.md
docs/implementation/evidence/S5-CAPTURE-INDEPENDENT-REVIEW.md
docs/implementation/evidence/S5-NATIVE-LOCAL-2026-10-09.json
docs/implementation/evidence/S5-BROWSER-SYNTHETIC-2026-10-09.md
docs/implementation/evidence/S5-CAPTURE-STAGING-MANIFEST.md
```

Native JSON is immutable. Historical static-only/pending statements in handoffs require interpretation alongside the newer independent/native/browser evidence; do not silently rewrite historical receipts. Root owns the final documentation selection and any status update before commit.

## Verified frontier and remaining gates

Latest scoped checks: server typecheck/build pass; facade/listener10/10; capture34/34; browser recorder12/12; research typecheck pass; actual native8/8; actual synthetic Chrome audio/camera/screen decoding, simultaneous sources, pause/resume, selective withdrawal, controlled DOM stop/reconnect; production research build pass with fixtures absent. Separate browser report records exact source/build fingerprints and limits. Runtime slot returned to V5 author; owned gateway/Vite stopped, only healthy local Convex retained.

Real microphone/camera permission flows, native screen picker/system audio, mobile/other browsers, browser lost-ack injection, backend VM restart persistence and all hosted/cloud/deployment gates remain unproved. Local synthetic capture acceptance does not qualify those gates. Never stage local operator/config/env/media files, server/research dist output, node_modules or VM data.
