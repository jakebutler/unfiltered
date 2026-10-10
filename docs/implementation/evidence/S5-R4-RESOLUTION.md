# S5 R4 runtime resolution

October 9, 2026. Bounded follow-up to `S5-REPAIR-HANDOFF.md` and `S5-INDEPENDENT-REVIEW.md`, on `codex/unfiltered-foundation`. This records local automated verification, not native qualification or deployment.

## Cause and correction

The original focused R4 counterexample was reproduced: four `advanceTimersByTimeAsync(0)` / `finishInProgressScheduledFunctions()` cycles left the session `purging` (assertion at the former `backend.test.ts:222`). This was a fake-timer drain defect, not another production retention defect. Installed `convex-test` implements scheduled callbacks through `setTimeout`; the installed Vitest timer implementation assigns a zero-delay timer created during a tick to `clock.now + 1` (`node_modules/vitest/dist/chunks/vi.bdSIJ99Y.js:2051`). Waiting for in-progress functions does not fire that pending timer.

The R4 repair changes only its test in `packages/research-capture/test/backend.test.ts`. It now explicitly places withdrawal/recovery on day one, still persists 151 sources and an interrupted `purging` withdrawal without its immediate job, and invokes only `sweepRetention` plus scheduled progress. After the first zero-time turn it requires `purging`, exactly 51 remaining sources, the original retention deadline, and exactly one pending `lifecycle:purgeSources` continuation whose persisted scheduled time equals the recovery clock. It advances only one millisecond to drain Vitest's next turn, then requires the original unchanged deadline, `purged`, zero source count, no source rows, and `purgedAt === recoveryAt + 1`, strictly before day thirty. No direct purge mutation, deadline substitution, broad timer drain, or weakened completion assertion was introduced. `convex/lifecycle.ts` needed no further edit.

The coordinator then extended this follow-up to fix the research TypeScript errors. Generated `convex/_generated/api.d.ts` imports backend module types, so the frontend's `types: ["vite/client"]` checks the capture backend modules without Node ambient declarations. Following the existing `convex/lifecycleQualification.ts` pattern, `convex/capture.ts` and `convex/captureGateway.ts` now each declare a module-scoped, type-only `process.env` shape. These declarations are erased; no browser runtime code, Node import, global browser declaration or TypeScript configuration change was added. The Convex expert skill and current schema were read before these edits. The user/coordinator's explicit no-services/no-push boundary supersedes the skill's normal push verification workflow.

## Commands and results

All commands ran sequentially from `/Volumes/rexy/GitHub/codex-worktrees/unfiltered-foundation/unfiltered`, with Node `/Users/jacobbutler/.nvm/versions/node/v22.22.3/bin/node`. Repair verification explicitly used `NODE_OPTIONS=--max-old-space-size=1024`; Vitest used `--maxWorkers=1 --no-file-parallelism`.

| Command after the Node executable | Result |
| --- | --- |
| `node_modules/vitest/vitest.mjs run --config packages/research-capture/vitest.config.mts --maxWorkers=1 --no-file-parallelism -t 'R4:'` before repair | Reproduced failure, 1 failed / 30 skipped. |
| Same focused command after repair | 1 passed / 30 skipped. |
| `node_modules/vitest/vitest.mjs run --config packages/research-capture/vitest.config.mts --maxWorkers=1 --no-file-parallelism` | 31 passed, 2 files. |
| `node_modules/vitest/vitest.mjs run --config packages/research-core/vitest.config.mts --maxWorkers=1 --no-file-parallelism` | 31 passed, 3 files, including all 11 lifecycle cases. |
| `node_modules/typescript/bin/tsc -p tsconfig.research.json` (exact `research:typecheck` script body), before type correction | Failed, exit 2: ten TS2591 missing `process` declaration errors in `convex/capture.ts:44,53,78,157,177` and `convex/captureGateway.ts:9,18,32,45,47`. |
| Same research TypeScript command after module-scoped declarations | Passed, exit 0. |
| `node_modules/typescript/bin/tsc -p convex/tsconfig.json --noEmit` after declarations | Passed, exit 0. |
| `node_modules/typescript/bin/tsc -p packages/research-capture/tsconfig.json --noEmit` after declarations | Passed, exit 0. |

The initial reproducer did not explicitly set `NODE_OPTIONS`; subsequent verification did. The full runtime suites ran after the R4 repair. They were not repeated for the later erased type declarations; all three relevant TypeScript checks passed after those declarations. The exclusive execution slot was released after the last package typecheck.

## Remaining gates

The R4 runtime counterexample and research UI typecheck now pass; independent reviewer disposition remains separate. All prior S5 native/browser/hosted gates remain: mounted gateway and persistent cleanup runner; combined local gateway→Convex→private-store flow and restart/recovery receipts; concrete bucket transport and atomic retirement guarantees; stale cleanup acknowledgement, lost activation response and consent withdrawal during retirement; body/stream latency, memory and operation measurements; actual MediaRecorder/player and permission integration; parent DOM listener lifecycle; publication/client grants; hosting/account headroom.

No services, VM, cloud/provider calls, secrets, installations, commits, or deployment mutations were used. Other agents' working files were preserved; the adaptive holdout file was not read.
