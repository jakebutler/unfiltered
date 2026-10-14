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

**WIP:** uncommitted edits in `deployment-qualification.ts` (agent a42f748).

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
