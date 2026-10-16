# Current work: handoff hub

**Start here.** If you are an agent picking this up after the previous agent ran out of quota,
this file is the single entry point. It holds:

- the workspace details;
- the rules;
- the live status of every task across the three tracks;
- links to the detailed specs.

Update the status tables **as soon as** a task lands: a commit hash plus a one-line result. Do
not batch the updates. The next agent trusts this file over chat history.

Last updated: 2026-10-16 (Codex cloud continuation; historical fixtures restored, T1.4a and T1.3 verified).

## Workspace

| Item | Value |
|---|---|
| Cloud continuation checkout | `/workspace/unfiltered`; fetched requested branch at `45b1cc3`; `npm ci` completed |
| Owner worktree (local work happens here) | `/Volumes/rexy/GitHub/codex-worktrees/unfiltered-foundation/unfiltered` |
| Branch | `codex/unfiltered-foundation` (pushed to `origin`, which is public on GitHub) |
| Open PRs (linked to the t3-code thread) | #7, #8 |
| WIP snapshot | `0fd34e3` holds the **unverified** code from stopped agents (D-b/D-c, D-d, D-f, T1.3, T1.4a, T1.4b). Nothing in it has passed the six-command gate. A task becomes `done` only with a later verifying commit. |
| Cloud agents | A Codex cloud agent works on a fresh clone of this branch. Local-only items do not exist there: the primary checkout, `.env.local`, `docs/implementation/evidence/`, `infra/cloud/.private/`, Medplum/Vercel credentials, t3-code preview tools. Skip anything that needs them and mark it `blocked: needs local/owner`. |
| Primary checkout (do **not** work here) | `/Volumes/rexy/GitHub/unfiltered`, branch `codex/rebuild-discovery`. Its `.env.local` holds credentials. |
| Shell note | The tool shell resets cwd to the primary checkout after every command. Always `cd <worktree> && …`. |
| Hosted clinic demo | `https://corvo-clinic-demo.vercel.app` (stage8, native questionnaire `native-5`). Qualification expires **2026-10-21T01:48:12Z**. |

### Commands (run from the worktree)

Install root dependencies with `npm ci`. Hosting also needs the separately locked dependency:
`npm ci --prefix infra/cloud/vercel/research --ignore-scripts --omit=dev --omit=optional --legacy-peer-deps`.
Before foundation tests, run `npm run foundation:build` for seed-upgrade's local module import.
Neither installation nor the build requires provider credentials.

```bash
npx vitest run -c vitest.foundation.config.mts   # packages/{clinical-core,clinic-content,clinic-api,speech}/test (~1,900 tests)
npx vitest run -c apps/clinic/vitest.config.mts   # apps/clinic/test
npx vitest run -c vitest.hosting.config.mts       # infra/cloud/vercel/test
npx tsc -p tsconfig.foundation.json --noEmit      # CommonJS-style NodeNext build: no import.meta
npx tsc -p tsconfig.clinic.json --noEmit          # browser app; includes only apps/clinic/src and packages/clinic-contract/src
npm run hosting:typecheck                       # clinic NodeNext + research Bundler, including research tests
npx tsx scripts/dev/local-mock-clinic.mts         # local mock API on :8787 (no provider calls by default)
npm run clinic:dev                                # clinic web on 127.0.0.1:5173, proxies to the mock
# Optional real-model mock (spends DO credits, capped): LOCAL_ENV_FILE=/Volumes/rexy/GitHub/unfiltered/.env.local LOCAL_DO_CALL_CAP=20 npx tsx scripts/dev/local-mock-clinic.mts
# Known mock limitation: "Confirm and send" fails on the mock (no Medplum). Not a bug to fix.
```

A task is **done** when all six commands are green. The only exception is a test that the task
spec explicitly allows to be `it.fails` (a recorded bug).

### Hard rules

1. **No new worktree or clone** on the owner's machine (a cloud agent's own clone of this branch is fine). Preserve the existing WIP. No broad `git add`, `reset`, `stash`
   or cleanup.
2. **Commit with explicit pathspecs only** (`git add path/a path/b`). **Never** commit
   `docs/implementation/evidence/**`, `infra/cloud/.private/**` or
   `.stream-chunk-diagnostic-stage/`. Leave `docs/implementation/evidence/S1-BROWSER.md` modified
   and uncommitted.
3. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the
   implementing model's name). PR bodies end with
   `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Link any new PR with the
   t3-code `link_pull_request` tool.
4. **Secrets.** Never print secrets or whole env/config files. Read selected fields only.
5. **Providers.** Application inference uses DigitalOcean only. OpenAI, Anthropic and Arcee
   runtime models are excluded. Spend credits first. A further $25 is a last resort, not a
   testing budget. Use small bounded experiments and never blindly retry an uncertain call.
6. **Do not touch the research demo's untouched allowances.** No admin re-elevation and no
   project wipes on Medplum.
7. **Synthetic demo only.** Never claim HIPAA.
8. **Never lower an acceptance criterion** to relabel a failure as success. A real bug found by
   a new test is recorded as `it.fails(...)` with a `// BUG: <description>` comment and added to
   the bug list below.
9. **Clinical boundaries:**
   - authored questions only;
   - PHQ-4 uses exact wording, is buttons-only and is never answered from free text;
   - incomplete stays incomplete;
   - no diagnosis, dose or eligibility advice;
   - agent-authored content uses `wordingStatus: 'proposed-detail'`.
10. **Standing decisions:**
    - D1: re-qualify once, bundled;
    - D2: no new hosting cost;
    - D3: browser read-aloud by default, ElevenLabs optional;
    - D4: PHQ-4 buttons-only;
    - D5: retrieve-then-interpret;
    - D6: no class-based "did you mean";
    - D7: defer pill-bottle photos.
11. **Questionnaire digest.** Any change that alters the native questionnaire digest (pinned in
    `packages/clinic-content/test/native-questionnaire.test.ts:30`) is a re-qualification event.
    Never make one inside the Oct 21 window. See
    [PLAN-QUESTIONNAIRE-TEMPLATE.md](PLAN-QUESTIONNAIRE-TEMPLATE.md#re-qualification-bundling).

## Tracks and status

Status values:
- `not started`
- `in progress (<who>)`
- `done <commit>`
- `blocked: <reason>`
- `needs owner`

### Track 1: finish the intake demo

Detailed specs: [PLAN-INTAKE-DEMO-FINISH.md](PLAN-INTAKE-DEMO-FINISH.md)

| ID | Task | Status |
|---|---|---|
| D-a | Tier-0 safety false positive on negated statements | done (pre-cb0bfe8); docs still list it as open, which D-i fixes |
| D-b | "Hopeless" free-text turn handling | WIP in `0fd34e3`, unverified (agent stopped at "now the interpreter changes": tests written in `packages/clinic-api/test/intake-interpreter.test.ts`, source edits in `intake-interpreter.ts` / `dialogue.ts` may be partial) |
| D-c | Spoken weight/number confirmation | WIP in `0fd34e3`, unverified (same agent as D-b; check whether any source exists yet) |
| D-d | Turn latency instrumentation + reductions | WIP in `0fd34e3`; independent GPT-6.1 Sol xhigh review found timing/logging gaps; gate blocked (see below). Files: `apps/clinic/src/{api.ts,turn-timing.ts}`, `packages/clinic-api/src/{handler.ts,request-timing.ts}`, `scripts/dev/latency-report.mts`, tests `apps/clinic/test/turn-timing.test.ts`, `packages/clinic-api/test/request-timing{,-handler}.test.ts` |
| D-e | Staff safety screen visual check | not started |
| D-f | Re-qualification without an admin grant (`/auth/me` observer) | WIP in `0fd34e3`, unverified, code believed complete (agent stopped at "now the docs, then full suites"). Files (attributed by timestamp, verify by diff): `packages/clinic-api/src/deployment-qualification.ts` + test, `infra/cloud/{clinic-manifest,medplum-preflight,seed-clinic}.mjs`, `infra/cloud/medplum-preflight.test.mjs`, `infra/cloud/vercel/{hosted-config.ts,test/hosting.test.ts}`, `infra/aws/clinic/config.ts`, `infra/aws/test/{config.test,fixtures}.ts`, `scripts/qualification/*`, `docs/implementation/CLOUD-CLINIC.md` |
| D-g | Mobile layout check | not started |
| D-h | Secret rotation + one-time calibration + re-qualify before 2026-10-21 | blocked: needs local/owner; no live calls authorized for this continuation |
| D-i | Docs: OPUS-HANDOFF, DEMO-TESTING-GUIDE, CLOUD-CLINIC | not started |
| D-j | Free text at a guided choice repeats the choice | not started (start after D-b lands; both may touch conversation flow) |
| D-k | Crisis phrasing coverage **[digest]** | blocked: needs local/owner; hold for bundled re-qualification and owner phrase review |
| D-l | PHQ-4 live/mock coverage | not started |
| D-m | **Pre-/post-visit native guided crash without context** (see bug table) | not started (the fix agent was stopped immediately; no edits attributed to it) |

### Track 2: intake as a questionnaire template

Overview: [PLAN-QUESTIONNAIRE-TEMPLATE.md](PLAN-QUESTIONNAIRE-TEMPLATE.md). Specs:
[T1](PLAN-QT-T1-REGISTRY.md), [T2](PLAN-QT-T2-PACKS.md), [T3](PLAN-QT-T3-REACH.md).

| ID | Task | Depends on | Status |
|---|---|---|---|
| T1.1 | Workflow registry (one `scenarioIds` source) | D-d landed (it touches `handler.ts`) | not started |
| T1.2 | Declarative workflow behaviour fields | T1.1 | not started |
| T1.3 | PHQ-4 coding only for the locked block | — | done `a811bd4`: strict topic/item scope and numeric decoding verified; fractional option sets explicitly use FHIR decimals; all six gates pass, golden/digest/count pins unchanged. |
| T1.4a | Guided walk tests W02–W07 | — | done `7e46cde`: review details, confirmed owners and complete billing/scheduling logistics asserted; all six gates pass on Node 22. Four documented D-m expected failures remain. |
| T1.4b | Voice-mode tests, non-intake workflows | — | WIP in `0fd34e3`, unverified. Files: `packages/clinic-api/test/workflow-voice.test.ts`, `apps/clinic/test/workflow-choice-voice.test.ts` |
| T2.5 | Pack zod schema | T1.2 | not started |
| T2.6 | Pack compiler + exporter + parity test | T2.5 | not started |
| T2.7 | FHIR Questionnaire export for new packs | T2.6 | not started |
| T3.8 | Between-visit check-in pack | T2.6, T1.3 | not started |
| T3.9 | Prior-submission readback | T1.2 | not started |
| T3.10 | Clinic-initiated link (Resend) | T3.9 recommended | not started |

### Track 3: Unfiltered as an async mass-feedback platform

Plan: [PLAN-ASYNC-FEEDBACK-AT-SCALE.md](PLAN-ASYNC-FEEDBACK-AT-SCALE.md) plus
`PLAN-ASYNC-FEEDBACK-PHASE-{1..5}.md`. Phase 5 planning was written in `4b11c24`
(voice, interview-quality controls, optional pack items; T5.8 depends on the pack track).
This is a documentation delivery, **not** a six-command-gate completion. Implementation remains
not started and waits until Tracks 1 and 2 (T1–T2) complete. Its own status table lives in the
overview file.

## Known bugs found by tests (append; never delete without a fix commit)

| Found by | Test | Description | Fixed in |
|---|---|---|---|
| T1.4a | `packages/clinic-api/test/guided-workflows.test.ts` | Pre-visit with no `nativeContext`: the turn after S01a returns 503 `prompt-rule-inactive` at the `changes` slot. `W02.followup.1` is gated on `context.pre-visit` (`native-questionnaire.ts:928`, guard `:1062`). **The hosted demo never supplies nativeContext, so this hits real testers in native guided mode.** Fix: D-m. | — |
| T1.4a | same | Post-visit with no context: `W04.followup.1` fails the same way (`native-questionnaire.ts:930`). Fix: D-m. | — |
| T1.4a | same | Pre-visit with context: the W02 `logistics` slot lists `S01a` first, which throws `context-fallback-inactive` (`scenarios.ts:26`, guard `native-questionnaire.ts:1065`). Fix: D-m. | — |
| T1.4a | same | Pre-visit with context: `W02.followup.1` shows unfilled `[previously reported item]` / `[date]` to the patient (`content.ts:958`). Fix: T3.9 (D-m may hide the prompt in the meantime). | — |

Additional defects found by the bounded D-d static review (regression tests still needed):

| Found by | Location | Description | Fixed in |
|---|---|---|---|
| D-d independent review | `packages/clinic-api/src/request-timing.ts` | Arbitrary non-UUID route segments and caller request-ID text can enter request logs, contrary to the module's no-patient-text metadata contract. | — |
| D-d independent review | `apps/clinic/src/api.ts` | `clientMs` ends before render and separates adaptive accept/interpret, so it is not submit-to-rendered-turn latency. | — |

## Open owner decisions

1. **Research and the clinic engine.** Should research share the clinic engine? Recommendation:
   share the engine and the pack format, but keep storage separate (Track 3 plan §decisions).
2. **D-h.** The owner must rotate the Medplum ClientApplication secret and run the one-time
   calibration before 2026-10-21 01:48 UTC. Steps are in
   [PLAN-INTAKE-DEMO-FINISH.md](PLAN-INTAKE-DEMO-FINISH.md#d-h).

## WIP map (snapshot commit `0fd34e3`, 2026-10-15)

All earlier subagents are **stopped**; their IDs are irrelevant now. Their edits were committed
unverified in `0fd34e3`. Inspect a task's part with `git show 0fd34e3 -- <paths>`:

| Files | Task |
|---|---|
| `apps/clinic/src/{api.ts,turn-timing.ts}`, `packages/clinic-api/src/{handler.ts,request-timing.ts}`, `scripts/dev/latency-report.mts`, `apps/clinic/test/turn-timing.test.ts`, `packages/clinic-api/test/request-timing*.test.ts` | D-d |
| `packages/clinic-api/src/deployment-qualification.ts` + test, `infra/**` (except `.private`), `scripts/qualification/*`, `docs/implementation/CLOUD-CLINIC.md` | D-f |
| `packages/clinic-api/src/{intake-interpreter,dialogue}.ts`, `packages/clinic-api/test/intake-interpreter.test.ts` | D-b/D-c (dialogue.ts may instead be D-j-ish; read the diff) |
| `packages/clinic-api/src/{adaptive-session,adaptive-validation}.ts` | D-c: spoken-number confirmation prompt repetition exemption and confirmation provenance/types, confirmed by independent diff review. |
| `packages/clinic-content/src/{mental-health,register}.ts`, `packages/clinical-core/src/questionnaire-response.ts`, `packages/clinical-core/test/phq4-response-scope.test.ts` | T1.3 |
| `packages/clinic-api/test/guided-workflows.test.ts` | T1.4a |
| `packages/clinic-api/test/workflow-voice.test.ts`, `apps/clinic/test/workflow-choice-voice.test.ts` | T1.4b |
| `docs/implementation/evidence/**`, `.stream-chunk-diagnostic-stage/` | local only, **never commit** |

## Resuming paused subagents

If the orchestrator stopped mid-flight, uncommitted edits from the agents listed above may be in
the tree. Before doing anything:

1. Run `git status --short` and `git diff --stat`.
2. Treat every file in the WIP map (or still uncommitted) as **that task's WIP**. Read the diff,
   then finish or verify the task against its spec rather than discarding it.
3. Run all six commands. Attribute failures to a task by file before fixing.


## Cloud continuation: baseline gate and review findings (2026-10-15)

No runtime task has landed or been marked done. All snapshot source/test files remain unchanged.
The first required landing, T1.4a, is blocked by the full gate; later runtime tasks remain queued
in the requested order. Do not fabricate historical/private fixtures, skip their tests, or weaken
assertions to make the gate green. No live providers, deployment, AccessPolicy edits or digest
changes were performed. Chromium is installed, so D-e/D-g are pending the earlier task sequence,
not proven blocked by browser availability. T3.8's digest/version edit remains blocked by hard
rule 11 during this window, even though the continuation prompt suggests a separate commit.

### Six-command baseline

After root `npm ci`, exact hub commands produced:

| Command | Result |
|---|---|
| `npx vitest run -c vitest.foundation.config.mts` | **FAIL**: 24 files failed / 109 passed; 41 tests failed / 1802 passed; five suites could not load; 214.21 s |
| `npx vitest run -c apps/clinic/vitest.config.mts` | PASS: 15 files, 305 tests |
| `npx vitest run -c vitest.hosting.config.mts` | PASS: 1 file, 29 tests |
| `npx tsc -p tsconfig.foundation.json --noEmit` | PASS |
| `npx tsc -p tsconfig.clinic.json --noEmit` | PASS |
| `npx tsc -p tsconfig.hosting.json --noEmit` | **FAIL**: 659 diagnostics (654 Convex, five research code/tests) |

Full command logs are local to this cloud workspace at `/workspace/scratch/unfiltered-validation/`.
They are not committed. Representative failures and root causes:

- **Missing owner-local fixtures**: `ENOENT ... docs/implementation/evidence/DO-A2.json`,
  `DO-A3.json`, `DO-A4.json`, `DO-A19-PREFLIGHT.json`, retained AF/AS receipts,
  `MEDPLUM-DYNAMIC-QUESTIONNAIRE-INVENTORY.json`, historical safety module, and
  `Cannot find module '../../../.stream-chunk-diagnostic-stage/.../digitalocean-stream.js'`.
  Some tests also need `infra/cloud/.private/DO-AF122-PREFIX.json`, `DO-AF138-REQUEST.json`
  and `DO-AF67-PREFIX.json`. These are explicitly unavailable in the cloud handoff:
  **blocked: needs local/owner**. They must never be committed. The owner can run the gate
  locally with these inputs; this continuation cannot honestly claim it passes.
- **Unbuilt local artifact**: four seed-upgrade tests initially report
  `Cannot find module '../../.qualification-build/packages/clinic-api/src/deployment-qualification.js'`.
  The root install is insufficient for those tests; `npm run foundation:build` is a local,
  credential-free prerequisite and completed successfully during diagnosis.
- **Timing/deadline failures**: six test timeouts (5 s or 15 s) and three grouped-stream assertions
  occurred in the full run. Grouped-stream fixtures use real 200 ms/1000 ms deadlines, so
  pre-dispatch work can consume the deadline. A serialized diagnostic run is recorded below;
  neither timeout increases nor assertion changes are justified by the initial run alone.
- **Hosting compiler graph** (read-only diagnosis): `tsconfig.hosting.json` includes research
  sources and nested research tests via `infra/cloud/vercel/**/*.ts`, while inheriting NodeNext
  and excluding only the immediate clinic `test` folder. Convex generated declarations exist;
  the cascade comes from CJS/ESM Convex type identities (`cjs-types` versus `esm-types`, separate
  private `TableDefinition.indexes`), not missing codegen. No diagnostic points to a source file
  edited in `0fd34e3`; `OPUS-HANDOFF.md` already records research/Convex hosting errors.
  Separate errors include `TS2307: Cannot find module '@vercel/functions'` (dependency belongs
  to the nested research package), `TS1470` for two research tests using `import.meta`, and a
  header fixture type mismatch. Future repair must preserve research coverage with the existing
  ESNext/Bundler research config and appropriate research test checking, rather than silently
  dropping files from the gate. A baseline checkout was not separately executed.

### Serialized diagnosis after local build

`npm run foundation:build` passed. Then the following command passed **6 files / 192 tests**
in 93.46 s, with no source/assertion/timeout edits:

```bash
npx vitest run -c vitest.foundation.config.mts \
  packages/clinic-api/test/adaptive-extraction-grouped-session.test.ts \
  packages/clinic-api/test/adaptive-extraction-grouped-session-v2.test.ts \
  packages/clinic-api/test/adaptive-extraction-sparse-route.test.ts \
  packages/clinic-api/test/adaptive-session.test.ts \
  packages/clinic-api/test/provisional-full-intake.test.ts \
  packages/clinic-api/test/seed-upgrade.test.ts \
  --maxWorkers=1 --no-file-parallelism
```

The seed tests now resolve the emitted local qualification module. The rich-context test took
1856 ms in isolation (initial full run exceeded 5000 ms); the first-intake test took 7923 ms
(initial exceeded 15000 ms). Grouped capture and timeout assertions also passed once serialized.
This narrows the initial timing failures to load-sensitive real-deadline behavior, not a
reproduced deterministic assertion failure. The first full run overlapped typechecks and a
brief targeted guided test; the serialized diagnostic did not. Deadline consumption before
extraction is relevant to D-d and needs deterministic clock/scheduling coverage before anyone
claims the original full gate is robust. This targeted result does **not** replace the failed
full command, nor resolve missing historical evidence.

### Bounded task reviews (not completion claims)

- **T1.4a**: targeted 12 tests pass, including all four `it.fails`. Spec filename corrected to
  `guided-workflows.test.ts`. No test/expectation changes. Audit found missing assertions for
  every workflow review detail and billing/scheduling `administrativeLogistics` fields. The
  current harness also uses a 150-turn guard and October 20 date, differing from spec's 60 turns
  and November 3 date. Context-present pre-visit currently expects administrative ownership;
  preserve that expectation for D-m and investigate, rather than silently rewriting it.
- **T1.3**: independent GPT-6.1 Sol xhigh review; integer choices and PHQ scoping are correct,
  and existing golden/digest/count test files are unchanged. Fractional non-PHQ choices use
  `valueDecimal`, whereas the spec says all numeric choices use `valueInteger`; resolve the
  FHIR integer-versus-fractional contract explicitly before landing. New coverage lives in
  `phq4-response-scope.test.ts`, not the spec's `questionnaire-response.test.ts`. Five scope
  tests pass. No confirmed runtime defect was found within this bounded PHQ review.
- **D-d**: independent GPT-6.1 Sol xhigh review found unresolved correctness/coverage issues:
  (1) `clientMs` ends after JSON parsing, before rendering; adaptive accept/interpret use
  unrelated request IDs, so the report does not measure submit-to-rendered-reply latency;
  (2) `routeName()` retains non-UUID arbitrary path segments, and `requestIdFrom()` accepts
  arbitrary safe-token text, allowing patient-looking text into request logs;
  (3) handler timing tests cover unauthenticated failures, not successful guided/adaptive
  timing or deferred safety completion; (4) report CLI still needs fixture-log execution.
  Fixed Server-Timing phase names contain numeric durations and awaited safety ordering is
  unchanged. These findings require fixes/tests before D-d can land.

### Next resumption

1. Resolve the missing-input gate with the owner/local environment. The hosting compiler
   repair below preserves coverage; use the aggregate command. Keep unavailable evidence/private
   files out of Git.
2. Finish T1.4a's spec coverage, then run all six commands and make a verifying commit before
   marking it done. Continue the original priority order; no snapshot task was discarded.
3. Resolve the bounded T1.3/D-d findings above when those tasks reach the front of the queue.
4. Phase 5 planning is delivered in `4b11c24`; Track 3 implementation remains not started.


## Hosting typecheck repair (2026-10-16)

Committed `84d392f`; independently reviewed by GPT-6.1 Sol at xhigh with no findings.

The owner explicitly authorized repairing the compiler configuration and continuing development
while historical fixtures are obtained. The complete hosting gate is now
`npm run hosting:typecheck`; running the clinic tsconfig alone is insufficient.

- Clinic hosting retains NodeNext. Research hosting uses its existing ESNext/Bundler mode and
  now includes all four research hosting test files. Compiler-API comparison against the old
  configuration found the same union of **13 root files and 194 repository source files**,
  with none removed. No Convex source or generated declarations changed.
- Installed the documented nested research dependency from its existing lock. Its transitive
  Zod 4 shadows root Zod 3 for the research config; explicit `zod/v3` preserves the authored
  default parsing semantics. A regression assertion checks all three default interview bounds.
- The denied-header fixture is explicitly typed as `Record<string, string>[]`; its values and
  assertions are unchanged. Nested installed dependencies are ignored by Git.
- Validation: aggregate hosting typecheck **PASS**, clinic hosting suite **29 PASS**. The focused
  research-package test file reports **7 PASS / 1 FAIL**: the unknown-interview fake-timer case
  times out after 5000 ms. That exact timeout was reproduced with the unchanged HEAD test in
  isolation under the same installed environment (Node 24.19.0; deployment package targets
  Node 22). Its fixture bypasses the changed runtime config parser. Do not label it flaky or
  weaken it; diagnosing that pre-existing async/fake-timer interaction is separate work.
  Full foundation remains blocked by the previously documented historical fixture inputs.
- The environment now reports `MEDPLUM_CLIENT_ID` and `MEDPLUM_CLIENT_SECRET` **ready**. These
  are injected environment variables, not permission to perform live qualification or writes.
  No live provider calls were made. Vercel credentials are unnecessary for these local checks.

The historical baseline failure table above is retained as evidence of the original run, not
as the current hosting compiler result. No intake WIP task is newly marked done by this repair.


## Verified cloud continuation (2026-10-16)

Started from latest remote `e8dc812`, preserving snapshot WIP. Downloaded release
`historical-fixtures-v1`; `sha256sum -c` passed. Inspected every archive member for absolute
paths, traversal, non-file/directory entries and existing-content conflicts, then restored all
109 files unchanged. Restored files and downloaded archive/checksum remain uncommitted.

Use **Node 22.23.3** for these gates (the research hosting package requires Node 22). The first
unchanged Node 24.19.0 baseline passed five gates; foundation reported 6 failed / 1973 passed,
all in `stream-chunk-diagnostics.test.ts` full mock-call equality. Vitest 3.2.4 compares
enumerable AbortSignal symbol keys with undefined values inconsistently; Node 24 cleaned
signals contain such keys. The same archived suite passes 23/23 unchanged on Node 22. No
historical bytes, assertions, adapter code or test inclusion were changed to resolve this.

T1.4a `7e46cde` passed independent GPT-6.1 Sol xhigh review and all six exact hub checks
sequentially on Node 22: foundation **133 files / 1979 tests**, clinic **15 / 305**, hosting
**1 / 29**, all three aggregate/typecheck commands pass. A separate cloud verification
worktree `/workspace/unfiltered-verify` contains only the task candidate, avoiding concurrent
subagent edits; only the parent runs full suites. Logs: `/workspace/scratch/unfiltered-validation/t14a-{0..6}.log`.
The spec explicitly preserves W02.changes as not-asked with no evidence and partial completion
when trusted prior-item context is unavailable; no invented answer or digest change.

The separate research-package test still reports **7 passed / 1 timeout** on Node 22:
`npx vitest run -c vitest.research-hosting.config.mts infra/cloud/vercel/research/test/research-package.test.ts`.
The failing test is “unknown interview response retains native lease until the actual late
provider settles”, timing out after 5000 ms. Log:
`/workspace/scratch/unfiltered-validation/research-node22.log`. It is outside the six gate
commands and remains unresolved, not labelled flaky.

Environment status currently reports configured Medplum/Vercel runtime variables as `unknown`,
not ready. No values were printed. No live provider, deployment, Medplum write, policy/admin or
qualification operation was performed. These remain owner steps.

T1.3 `a811bd4` passed fresh GPT-6.1 Sol xhigh review and all six gates sequentially on
Node 22: foundation **133 files / 1994 tests**, clinic **15 / 305**, hosting **1 / 29**,
three typecheck commands pass. Logs: `/workspace/scratch/unfiltered-validation/t13-{0..6}.log`.
The spec now explicitly uses `valueInteger` for integer-only option sets and `valueDecimal`
for a scale with any fractional option (including an integral selection on that scale). No
rounding, existing-assertion edit, questionnaire/export/digest change or runtime change was
needed. Synthetic slot tests do not claim native export support for a new numeric scale.
