# Track 1: finish the intake demo

Status lives in [HANDOFF-CURRENT-WORK.md](HANDOFF-CURRENT-WORK.md), which also has the workspace,
commands and rules. Background: `OPUS-HANDOFF.md` (history), `DEMO-TESTING-GUIDE.md` (the tester
script) and `CLOUD-CLINIC.md` (hosting and qualification).

All D-tasks are code changes that ship **without** a digest change unless they are marked
**[digest]**. Digest-changing items are bundled into the next owner re-qualification (D-h /
hub rule 11).

---

## D-a Tier-0 false positive on negated statements

**Done** before cb0bfe8: E-0.2 NegEx scope in `packages/clinic-content/src/safety.ts`. The only
remaining work is D-i: remove it from OPUS-HANDOFF "Still open" (line 41).

## D-b "Hopeless" adaptive turn

**Symptom (live run).** "feeling hopeless…" repeated the previous question and was filed under
Q16 "current stress".

**Spec**
- A free-text statement of hopelessness must:
  1. go through the safety screen (`packages/clinic-api/src/safety-screen.ts` / `safety.ts`)
     **before** extraction. If a tier fires, the existing safety interruption flow runs;
  2. never be recorded as a PHQ-4 item answer (MH01–04 are buttons-only, D4);
  3. never be silently filed as Q16 "current stress". If it is captured, it is captured as the
     patient's own words in a Q16 free-text slot that accepts it, with provenance;
  4. not cause the same question to be re-asked verbatim. The reply acknowledges and moves on,
     or asks the next authored prompt.
- Tests: `packages/clinic-api/test/intake-interpreter.test.ts`. The agent has uncommitted cases
  there. Cases:
  - "I've been feeling hopeless lately";
  - "honestly kind of hopeless about the weight thing" (non-crisis, domain-specific);
  - "I feel hopeless and don't want to be here anymore", which must trigger the safety path.
- **Do not** widen the authored crisis keyword list here **[digest]**. That is D-k.

**Continuation correction to snapshot WIP assertions.** The WIP hosted test previously required
the next prompt text to equal the previous prompt. That contradicts item 4 above. Require a
different authored prompt while the original slot stays unanswered; retain the disclosure's
exact source and neutral proposed acknowledgement. The acknowledgement now says "We can
continue" instead of "Coming back to the question". Await the single-call interpreter's safety
gate before extraction; leave the separately qualified legacy/grouped streaming ordering intact.
The earlier `safety-handler.test.ts` imminent-risk case expected one interpreter dispatch;
require zero dispatches instead, preserving every patient-visible safety assertion.
The specified crisis phrase uses the existing tier-1/tier-2 safety path; this task adds no crisis
keywords or deterministic hard-stop guarantee for that phrase.

## D-c Spoken weight/number confirmation

**Spec.** A spoken number for a numeric slot ("two hundred and five pounds", "five foot ten") is
normalised and confirmed with an exact read-back before recording, as choice-by-voice does
(`clinic-contract/src/choice-voice.ts`). An unconfirmed `unreviewed-transcript` value never
satisfies the slot.
- Tests:
  - spoken forms such as "two oh five", "205", "two hundred five" and "two-hundred and five"
    give 205;
  - "five ten" in a height context gives 5 ft 10 in;
  - ambiguous forms ("one fifty or so") are recorded as an estimate only when the slot accepts
    an estimate, and otherwise trigger clarification.

**Continuation correction to snapshot WIP assertions.** The WIP expected "five foot ten" to
record directly; require the exact 5 ft 10 in readback and no recorded height until explicit
confirmation. Typed numeric text remains direct. The WIP's "About two oh five pounds" example
previously asked for an exact actual reading; cover the exact spoken form separately, and
require clarification for an approximate actual reading. An estimate is permitted only in the
estimate slot and still requires confirmation when spoken or unreviewed. Digits such as "205"
from `unreviewed-transcript` follow the same readback rule. An unreviewed "yes" cannot confirm
them. Revalidate the proposed number and unit against retained evidence; keep original speech
immutable and both sources in provenance, while unreviewed sources earn no slot readiness.
Timing quantities ("205 pounds one week ago") must not become competing measurement values.
Competing reading alternatives still require clarification. "Maybe", "I think", "probably"
and "I guess" about an actual reading or height require clarification even if the proposed
quote omits the hedge; confirming a number does not establish an actual measurement.
Direct typed values must also match the cited number without dropping a sign or decimal
precision; a positive-number slot must not turn `-205` or `205.5` into `205`.

## D-d Turn latency

**Goal.** Measure, then reduce, the time from patient submit to rendered reply.

**WIP (uncommitted):**
- `packages/clinic-api/src/request-timing.ts`: per-request phase timings, e.g. `safety`,
  `interpret`, `persist`, `render`, emitted as a `Server-Timing` header (no PHI in names or
  values);
- `apps/clinic/src/turn-timing.ts`: client-side marks;
- `apps/clinic/src/api.ts`: reads `Server-Timing`;
- `packages/clinic-api/src/handler.ts`: wiring;
- `scripts/dev/latency-report.mts`: summarises a timing log into p50/p95 per phase;
- tests: `packages/clinic-api/test/request-timing{,-handler}.test.ts` and
  `apps/clinic/test/turn-timing.test.ts`.

**Acceptance**
- the header is present on turn responses and never contains text, ids or values from the
  patient;
- the report script runs on a fixture log;
- all six commands are green.

Reductions, such as parallelising safety and interpretation where the safety result does not
gate the call, or trimming manifest size, are separate follow-ups. Each must show before/after
numbers from the report and must keep the "safety before any patient-visible reply" ordering.

**Note:** the agent saw 11 new foundation failures mid-work. They must be root-caused, not
assumed flaky.

## D-e Staff safety screen: visual check

1. `npx tsx scripts/dev/local-mock-clinic.mts` (it prints its URL).
2. Open it with the t3-code preview tools (`preview_open`, `preview_navigate`,
   `preview_snapshot`).
3. As a patient, trigger a tier-1 safety statement, then sign in as the physician fixture and
   open the safety queue.

Check:
- the item appears at the top with the level label;
- the patient's exact words are shown;
- the available actions match `StaffSafetyAction`;
- after an action, the item leaves the queue and history shows it.

Record screenshots in `docs/implementation/evidence/` (never committed) and a one-line result in
the hub. File any defects as new D-tasks.

## D-g Mobile layout check

Use the same mock with `preview_resize` to 390×844 and 360×740.

Check:
- the patient chat composer stays visible above the keyboard area;
- choice buttons wrap without horizontal scroll;
- the review page tables don't overflow;
- the voice button is reachable;
- staff queue rows are readable.

Fix with CSS only in `apps/clinic/src/*.css`, using the existing tokens. Add no new design
system.

## D-f Re-qualification without an admin grant

**Research result.**
- Only `infra/cloud/seed-clinic.mjs:102-110` needs admin. It does `GET Project/{id}` to save
  `{ projectVersion, features, observedAt }`.
- The qualifier (`packages/clinic-api/src/deployment-qualification.ts:61,74,92`) rejects admin
  and checks only:
  - freshness (15 min);
  - that `features` is an array;
  - that `projectVersion` is non-empty.
- Medplum `/auth/me` returns `project.features` to any member (since v5.1.4, PR #8713).

**Spec**
- Build the observation from `GET auth/me` with the runtime credentials:
  - `features = me.project.features ?? []`;
  - `projectVersion` = SHA-256 of the canonical JSON projection
    `{ id, name, features, strictMode?, checkReferencesOnWrite? }` of `me.project` (only fields
    present), recorded as `projection-sha256:<hex>`;
  - `observedAt = now`.
- Drift is re-checked on every refresh by `observeRuntimeIdentity`. If the projection digest
  changes from the qualified one, qualification fails closed, with the error
  `project-projection-drift`.
- The loss of `Project.meta.versionId` is accepted and documented in `CLOUD-CLINIC.md`.

**Tests**
- `/auth/me` without `project.features` gives `features: []`;
- a changed feature list gives a drift failure;
- an admin membership is still rejected;
- a stale observation (more than 15 min) is rejected.

**Implementation awaiting verification:** schema 3 observes the runtime `/auth/me` inline at seal time and compares it again on each cold start/token refresh through `observeRuntimeProjection`; schema 2 retains `observeRuntimeIdentity` and its historical contract until expiry. The canonical projection sorts the feature list, preserves absent optional fields, and records `projectVersion: projection-sha256:<hex>`. Projection changes fail with `project-projection-drift`; `checkReferencesOnWrite` is included when returned. No admin feature file is required. The observation must be within 15 minutes of the original proof, without shortening the signed proof's validity. Tests are in `packages/clinic-api/test/deployment-qualification.test.ts`, `infra/cloud/medplum-preflight.test.mjs`, and `infra/aws/test/config.test.ts`. Owner calibration and live re-qualification remain D-h; no live execution is implied by this implementation.

## D-h Owner steps before 2026-10-21T01:48:12Z (needs owner)

1. Rotate the Medplum ClientApplication secret, then update the Vercel env and
   `infra/cloud/.private/` config. The agent cannot do this.
2. One calibration run with a **temporary** admin grant: compare the admin `GET Project/{id}`
   features with `/auth/me` `project.features`, and record equality.
3. Remove admin. Verify the demotion with `/auth/me`, where membership must not be admin.
4. Confirm the runtime AccessPolicy has no `*` resourceType rule (Medplum PR #10826 behaviour).
5. Run the qualifier (`CLOUD-CLINIC.md` steps). Deploy bundled changes, i.e. any **[digest]**
   items that are ready.
6. Update `CLOUD-CLINIC.md:57-59` with the new expiry.

After D-f lands, future re-qualifications skip steps 2–3.

## D-i Docs

- `OPUS-HANDOFF.md`:
  - remove the tier-0 item from "Still open" (line 41) and note the fix;
  - update the hands-free line (44) to the current hosted status (stage8 has hosted hands-free
    per cb0bfe8);
  - add D-b/D-c/D-d/D-f results as they land.
- `DEMO-TESTING-GUIDE.md`: add steps to test:
  - a hopeless statement (expected: safety path or acknowledged, not re-asked);
  - a spoken weight (expected: read-back confirmation);
  - where to see timings (`Server-Timing` in devtools).
- `CLOUD-CLINIC.md`: describe the D-f observer and the D-h owner checklist.

## D-j Free text at a guided yes/no choice repeats the choice

**Open** (OPUS-HANDOFF line 67).

- When the patient types at a choice prompt, run the exact-choice matcher (same as voice,
  `exactSpokenChoice`):
  - on an exact match, use the confirmation flow;
  - otherwise, show "Please choose one of the options" once, with the buttons, and do not
    re-render the identical prompt as a new assistant turn.
- PHQ-4 items always just re-show the buttons (D4).
- Tests: in the T1.4b voice test file, or the existing guided tests.

## D-k Crisis phrasing coverage [digest]

"don't want to be here anymore" and similar phrasings are missed by the authored list. Draft the
additions with `wordingStatus: 'proposed-detail'` and the NegEx scope tests, but **hold** them
for the bundled re-qualification and an owner review of the phrase list. Do not ship them
silently.

## D-l PHQ-4 live coverage

The live script never reached PHQ-4. Add a hosted-safe smoke step, used only during the owner
re-qualification, that drives straight to Q16 with the buttons. Alternatively, extend the local
mock walk-through (D-e) to complete PHQ-4 and check scoring in the staff view.

Offline API smoke: `npx tsx scripts/dev/phq4-local-smoke.mts --local` (Node 22).
The runner uses the native handler, text-channel values corresponding to the displayed PHQ
choices, disposable in-memory FHIR delivery, and the assigned physician's production staff
projection. It checks three-item incompleteness/null scores, four-item scores (GAD-2 3,
PHQ-2 3, PHQ-4 6), source channels, verified anchors, and partial overall intake. It reads no
credentials, makes no external requests, and rejects hosted targets/live switches.
Regression coverage: `packages/clinic-api/test/phq4-local-smoke.test.ts`.

The API mode verifies submissions and staff data, not browser clicks or rendering. For the
actual local UI walk-through, start the **new offline PHQ harness** in a separate terminal:
`npx tsx scripts/dev/phq4-local-smoke.mts --serve-local`, then `npm run clinic:dev`.
Open `http://127.0.0.1:5173`, start First intake, confirm the fictional identity, and choose
“Mood, anxiety and support” (Q16) in the topic outline. For this synthetic walk, choose
“I don’t know” for depression history, anxiety history, and current care; those details remain
unknown. Then click and send each of the four PHQ choices (Several days, More than half the days,
Nearly every day, Not at all), review, and Confirm and send. Open `/staff`, sign in using the
harness-only synthetic account `synthetic-md@example.invalid` / `local-smoke-only`, and inspect
the handoff's PHQ-4 scores (GAD-2 3, PHQ-2 3, PHQ-4 6). Other intake topics remain incomplete.
The backend listens only on 127.0.0.1:8787 and uses a synthetic auth adapter and in-memory FHIR;
it never validates real credentials or calls providers. This is distinct from
`scripts/dev/local-mock-clinic.mts`, which requires DigitalOcean credentials and makes real
provider calls. Do not run that older mock for this offline smoke.

Local browser execution on 2026-10-16 passed against the new harness: real PatientApp
PHQ buttons, partial review/confirmation, synthetic staff login, and real StaffApp scores
3/3/6 with clinician-review-required text. Three preceding history/care responses remained
unknown. Parent screenshots/logs are under `/workspace/scratch/unfiltered-validation/`
(`phq-browser-{review,staff}.png`, `phq-browser.log`). This is candidate verification;
completion still requires the task's full gate and verifying commit. Hosted verification
remains an owner re-qualification step; neither local result is live verification.

## D-m Pre-/post-visit native guided crash without trusted context (HIGH)

T1.4a found this (`packages/clinic-api/test/guided-workflows.test.ts`, four `it.fails` cases; see
the hub bug table).

**Symptom.** In native guided mode with no `nativeContext`, which is always the case on hosted,
the second turn of pre-visit (after S01a) and post-visit (after S03a) returns 503
`prompt-rule-inactive`. The runtime asks a slot whose only prompt (`W02.followup.1` /
`W04.followup.1`) is gated on verified context.

**Fix constraints**
- Prefer a **runtime-only** fix that leaves the native digest unchanged:
  - `nextNativeGuidedField` and the conversation `prompt()` selection must skip, or route
    around, a slot whose prompt rule is inactive in the current context;
  - for pre-visit, the `changes` slot without context is asked with an active authored prompt if
    one exists. Otherwise it is left `not-asked`, so incomplete stays incomplete and staff see the
    gap.
- With context, the `logistics` slot must not select `S01a`. Pick the first *active* prompt id
  (`Q20`).
- Unfilled placeholders: a prompt that still contains `[` after filling must never be shown.
  Fall back as above.
- If a correct fix is impossible without changing the digest, stop and document the minimal
  digest change for the bundled re-qualification. Do not ship it.

**Acceptance**
- the four `it.fails` in `guided-workflows.test.ts` flip to `it` with the expectations
  unchanged;
- the digest test and per-scenario counts are unedited;
- all six commands are green;
- check adaptive mode for the same failure, using existing adaptive scenario tests, and record
  the result.
