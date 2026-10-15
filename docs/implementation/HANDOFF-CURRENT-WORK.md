# Current work: handoff hub

**Start here.** If you are an agent picking this up after the previous agent ran out of quota,
this file is the single entry point. It holds:

- the workspace details;
- the rules;
- the live status of every task across the three tracks;
- links to the detailed specs.

Update the status tables **as soon as** a task lands: a commit hash plus a one-line result. Do
not batch the updates. The next agent trusts this file over chat history.

Last updated: 2026-10-15 (Opus 5.5 orchestrator, final handoff to a GPT-6.1 Sol implementer; Opus 5.5 now does reviews only).

## Workspace

| Item | Value |
|---|---|
| Worktree (all work happens here) | `/Volumes/rexy/GitHub/codex-worktrees/unfiltered-foundation/unfiltered` |
| Branch | `codex/unfiltered-foundation` (pushed to `origin`, which is public on GitHub) |
| Open PRs (linked to the t3-code thread) | #7, #8 |
| Last commit by the orchestrator | see `git log -1`; everything after `f906198` that is not listed in a status row as `done` is uncommitted WIP |
| Primary checkout (do **not** work here) | `/Volumes/rexy/GitHub/unfiltered`, branch `codex/rebuild-discovery`. Its `.env.local` holds credentials. |
| Shell note | The tool shell resets cwd to the primary checkout after every command. Always `cd <worktree> && …`. |
| Hosted clinic demo | `https://corvo-clinic-demo.vercel.app` (stage8, native questionnaire `native-5`). Qualification expires **2026-10-21T01:48:12Z**. |

### Commands (run from the worktree)

```bash
npx vitest run -c vitest.foundation.config.mts   # packages/{clinical-core,clinic-content,clinic-api,speech}/test (~1,900 tests)
npx vitest run -c apps/clinic/vitest.config.mts   # apps/clinic/test
npx vitest run -c vitest.hosting.config.mts       # infra/cloud/vercel/test
npx tsc -p tsconfig.foundation.json --noEmit      # CommonJS-style NodeNext build: no import.meta
npx tsc -p tsconfig.clinic.json --noEmit          # browser app; includes only apps/clinic/src and packages/clinic-contract/src
npx tsc -p tsconfig.hosting.json --noEmit         # infra/cloud/vercel
npx tsx scripts/dev/local-mock-clinic.mts         # local mock API on :8787 (no provider calls by default)
npm run clinic:dev                                # clinic web on 127.0.0.1:5173, proxies to the mock
# Optional real-model mock (spends DO credits, capped): LOCAL_ENV_FILE=/Volumes/rexy/GitHub/unfiltered/.env.local LOCAL_DO_CALL_CAP=20 npx tsx scripts/dev/local-mock-clinic.mts
# Known mock limitation: "Confirm and send" fails on the mock (no Medplum). Not a bug to fix.
```

A task is **done** when all six commands are green. The only exception is a test that the task
spec explicitly allows to be `it.fails` (a recorded bug).

### Hard rules

1. **No new worktree or clone.** Preserve the existing WIP. No broad `git add`, `reset`, `stash`
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
| D-b | "Hopeless" free-text turn handling | WIP uncommitted (agent stopped at "now the interpreter changes": tests written in `packages/clinic-api/test/intake-interpreter.test.ts`, source edits in `intake-interpreter.ts` / `dialogue.ts` may be partial) |
| D-c | Spoken weight/number confirmation | WIP uncommitted (same agent as D-b; check whether any source exists yet) |
| D-d | Turn latency instrumentation + reductions | WIP uncommitted, believed code-complete (agent was about to run the full foundation suite; earlier failures were from other agents' concurrent edits). Files: `apps/clinic/src/{api.ts,turn-timing.ts}`, `packages/clinic-api/src/{handler.ts,request-timing.ts}`, `scripts/dev/latency-report.mts`, tests `apps/clinic/test/turn-timing.test.ts`, `packages/clinic-api/test/request-timing{,-handler}.test.ts` |
| D-e | Staff safety screen visual check | not started |
| D-f | Re-qualification without an admin grant (`/auth/me` observer) | WIP uncommitted, code believed complete (agent stopped at "now the docs, then full suites"). Files (attributed by timestamp, verify by diff): `packages/clinic-api/src/deployment-qualification.ts` + test, `infra/cloud/{clinic-manifest,medplum-preflight,seed-clinic}.mjs`, `infra/cloud/medplum-preflight.test.mjs`, `infra/cloud/vercel/{hosted-config.ts,test/hosting.test.ts}`, `infra/aws/clinic/config.ts`, `infra/aws/test/{config.test,fixtures}.ts`, `scripts/qualification/*`, `docs/implementation/CLOUD-CLINIC.md` |
| D-g | Mobile layout check | not started |
| D-h | Secret rotation + one-time calibration + re-qualify before 2026-10-21 | needs owner |
| D-i | Docs: OPUS-HANDOFF, DEMO-TESTING-GUIDE, CLOUD-CLINIC | not started |
| D-j | Free text at a guided choice repeats the choice | not started (start after D-b lands; both may touch conversation flow) |
| D-k | Crisis phrasing coverage **[digest]** | not started; hold for the bundled re-qualification and owner phrase review |
| D-l | PHQ-4 live/mock coverage | not started |
| D-m | **Pre-/post-visit native guided crash without context** (see bug table) | not started (the fix agent was stopped immediately; no edits attributed to it) |

### Track 2: intake as a questionnaire template

Overview: [PLAN-QUESTIONNAIRE-TEMPLATE.md](PLAN-QUESTIONNAIRE-TEMPLATE.md). Specs:
[T1](PLAN-QT-T1-REGISTRY.md), [T2](PLAN-QT-T2-PACKS.md), [T3](PLAN-QT-T3-REACH.md).

| ID | Task | Depends on | Status |
|---|---|---|---|
| T1.1 | Workflow registry (one `scenarioIds` source) | D-d landed (it touches `handler.ts`) | not started |
| T1.2 | Declarative workflow behaviour fields | T1.1 | not started |
| T1.3 | PHQ-4 coding only for the locked block | — | WIP uncommitted, believed complete (agent was re-running suites). Files: `packages/clinic-content/src/{mental-health,register}.ts`, `packages/clinical-core/src/questionnaire-response.ts`, `packages/clinical-core/test/phq4-response-scope.test.ts` |
| T1.4a | Guided walk tests W02–W07 | — | WIP uncommitted, complete (12 tests pass incl. 4 `it.fails` = bugs below). File: `packages/clinic-api/test/guided-workflows.test.ts`. Commit as-is. |
| T1.4b | Voice-mode tests, non-intake workflows | — | WIP uncommitted, unverified. Files: `packages/clinic-api/test/workflow-voice.test.ts`, `apps/clinic/test/workflow-choice-voice.test.ts` |
| T2.5 | Pack zod schema | T1.2 | not started |
| T2.6 | Pack compiler + exporter + parity test | T2.5 | not started |
| T2.7 | FHIR Questionnaire export for new packs | T2.6 | not started |
| T3.8 | Between-visit check-in pack | T2.6, T1.3 | not started |
| T3.9 | Prior-submission readback | T1.2 | not started |
| T3.10 | Clinic-initiated link (Resend) | T3.9 recommended | not started |

### Track 3: Unfiltered as an async mass-feedback platform

Plan: [PLAN-ASYNC-FEEDBACK-AT-SCALE.md](PLAN-ASYNC-FEEDBACK-AT-SCALE.md) plus
`PLAN-ASYNC-FEEDBACK-PHASE-{1..4}.md` (written, uncommitted until the handoff commit).
**`PLAN-ASYNC-FEEDBACK-PHASE-5.md` is referenced but was never written** (the planner hit quota):
write it from §10 of the overview (voice, interview-quality controls, optional pack items, task
T5.8 depends on the pack track), in the same task format as Phases 1–4. Implementation starts
only after Tracks 1 and 2 (T1–T2) complete. Its own status table lives in the overview file.

## Known bugs found by tests (append; never delete without a fix commit)

| Found by | Test | Description | Fixed in |
|---|---|---|---|
| T1.4a | `packages/clinic-api/test/guided-workflows.test.ts` | Pre-visit with no `nativeContext`: the turn after S01a returns 503 `prompt-rule-inactive` at the `changes` slot. `W02.followup.1` is gated on `context.pre-visit` (`native-questionnaire.ts:928`, guard `:1062`). **The hosted demo never supplies nativeContext, so this hits real testers in native guided mode.** Fix: D-m. | — |
| T1.4a | same | Post-visit with no context: `W04.followup.1` fails the same way (`native-questionnaire.ts:930`). Fix: D-m. | — |
| T1.4a | same | Pre-visit with context: the W02 `logistics` slot lists `S01a` first, which throws `context-fallback-inactive` (`scenarios.ts:26`, guard `native-questionnaire.ts:1065`). Fix: D-m. | — |
| T1.4a | same | Pre-visit with context: `W02.followup.1` shows unfilled `[previously reported item]` / `[date]` to the patient (`content.ts:958`). Fix: T3.9 (D-m may hide the prompt in the meantime). | — |

## Open owner decisions

1. **Research and the clinic engine.** Should research share the clinic engine? Recommendation:
   share the engine and the pack format, but keep storage separate (Track 3 plan §decisions).
2. **D-h.** The owner must rotate the Medplum ClientApplication secret and run the one-time
   calibration before 2026-10-21 01:48 UTC. Steps are in
   [PLAN-INTAKE-DEMO-FINISH.md](PLAN-INTAKE-DEMO-FINISH.md#d-h).

## Uncommitted WIP map (as of 2026-10-15 handoff)

All earlier subagents are **stopped**; their IDs are irrelevant now. Their edits are in the tree:

| Files | Task |
|---|---|
| `apps/clinic/src/{api.ts,turn-timing.ts}`, `packages/clinic-api/src/{handler.ts,request-timing.ts}`, `scripts/dev/latency-report.mts`, `apps/clinic/test/turn-timing.test.ts`, `packages/clinic-api/test/request-timing*.test.ts` | D-d |
| `packages/clinic-api/src/deployment-qualification.ts` + test, `infra/**` (except `.private`), `scripts/qualification/*`, `docs/implementation/CLOUD-CLINIC.md` | D-f |
| `packages/clinic-api/src/{intake-interpreter,dialogue}.ts`, `packages/clinic-api/test/intake-interpreter.test.ts` | D-b/D-c (dialogue.ts may instead be D-j-ish; read the diff) |
| `packages/clinic-api/src/{adaptive-session,adaptive-validation}.ts` | unattributed: D-b or T1.3. Read the diff before committing either task. |
| `packages/clinic-content/src/{mental-health,register}.ts`, `packages/clinical-core/src/questionnaire-response.ts`, `packages/clinical-core/test/phq4-response-scope.test.ts` | T1.3 |
| `packages/clinic-api/test/guided-workflows.test.ts` | T1.4a |
| `packages/clinic-api/test/workflow-voice.test.ts`, `apps/clinic/test/workflow-choice-voice.test.ts` | T1.4b |
| `docs/implementation/evidence/**`, `.stream-chunk-diagnostic-stage/` | **never commit** |

## Resuming paused subagents

If the orchestrator stopped mid-flight, uncommitted edits from the agents listed above may be in
the tree. Before doing anything:

1. Run `git status --short` and `git diff --stat`.
2. Treat every uncommitted file listed in a status row as **that task's WIP**. Read the diff,
   then finish or verify the task against its spec rather than discarding it.
3. Run all six commands. Attribute failures to a task by file before fixing.
