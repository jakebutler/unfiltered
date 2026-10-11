# Clinic adaptive intake — handoff (2026-10-11)

> **Later the same day:**
> - All work is committed on `codex/unfiltered-foundation` and open as draft PR #7.
> - Hosted now runs deployment `dpl_JnT84ru5vqugxD9YCiueBr96SfEY`.
> - **Topic avoidance is recorded explicitly.** The displayed detail is declined, with the patient's words, and the topic stops as `patient-declines`. Staff see "Patient preferred not to discuss this topic. Consider a gentle follow-up." A plain skip is `patient-moves-on`. Facts in the same message are kept.
> - **Conflict loop fixed.** A compound answer no longer becomes a conflict, and any answer to a conflicting field resolves it.
> - **"Move on or come back" can no longer loop.**
> - **Tests:** 23 of the 35 pre-existing failures were fixed. 12 remain in experimental extraction paths and need product/safety decisions (see commit `b96f401`).
> - Tester instructions are in `DEMO-TESTING-GUIDE.md`.
> - **Known safety gap:** the authored crisis keyword list misses phrasings such as "don't want to be here anymore". Widening it changes the qualified definition digest.

## What you can test now (hosted)

https://corvo-clinic-demo.vercel.app is a synthetic demo, not for real PHI, and not HIPAA-certified.

**Patient journey**
1. Tick the synthetic-details box, choose **First visit intake**, then **Continue as Alex**.
2. Chat in your own words. Several facts, a question, or a correction in one message are all fine.
3. Click **Review my answers**, then **Confirm and send**.

**Staff journey**
1. Go to `/staff` and sign in with the named accounts in the private users file `infra/cloud/.private/clinic-cloud-q4f-20261010/clinic-users.json`. Never commit or paste these credentials.
2. Physician (Dr. Morgan Lee) and RD (Sam Patel) see the full source-linked handoff.
3. Admin (Taylor Brooks) does not: the queue is empty and the handoff detail returns 404.

A good script, exercised on hosted on 2026-10-11:
1. "I want more energy and to stop snacking at night. I'm 5 foot 7, the scale at my doctor's office said 214 pounds in July, probably closer to 220 now."
   - Result: 11 facts applied. The 214 lb reading is kept separate from the "about 220" estimate, and the estimate is labeled as such.
2. "Mostly being able to hike with my kids again. I take metformin 500 mg, the label says twice a day with meals but I usually only take it at dinner, and lisinopril 10 mg every morning. Can I just stop the metformin once I start the weight program?"
   - Result: label directions and actual use are stored separately.
   - The question is routed to the care team, with no advice given.
3. "No new symptoms really. My dad had type 2 diabetes and my mom has high blood pressure. I was told my sugar was borderline last year but nobody said diabetes. I don't have sleep apnea or any stomach issues."
   - Result: dad and mom are recorded as **family** history.
   - The patient's own diabetes is **uncertain** ("You weren't sure"), not negative.
   - Sleep apnea is negative, so the SLEEP branch is skipped.
4. "I'd rather not get into my childhood. Oh, and a correction: the lisinopril is actually 20 mg, not 10."
   - Result: the correction is applied with a cue, and the earlier source is retained.
   - The weight-history topic stops and the next authored topic follows.
5. Reload the page, then **Continue as Alex**. The conversation and answers resume intact.
6. Review. Answers show "Your words" source links and visible gaps ("Some details missing · you can still send").
7. Confirm. The page shows "Received by Corvo Clinic", and staff see it via the queue.

**Local alternative**
- Commands, run from the worktree:
  1. `CLINIC_CONFIG_PATH=$PWD/infra/cloud/.private/clinic-q4f-mapping-suffix-20261010-a3/clinic-config.qualified.json CLINIC_PROVIDER_SETTINGS=$PWD/infra/cloud/.private/local-cloud-dev/provider-settings.json npm run clinic:api`
  2. `npx vite --config infra/cloud/.private/local-cloud-dev/vite.cloud-origin.config.mjs`, then open http://127.0.0.1:5173.
- The DO key must be in the environment, or in a 0600 file named by `CLINIC_PROVIDER_ENV_FILE`.
- Local runs share the same Medplum project and budget ledger as hosted.

## What changed and why

**Root cause.** The earlier adaptive extractors asked mid-size models to fill about 150 typed addresses with mandatory metadata. The validator then rejected whole turns, which made the experience unusable. They were replaced (opt-in) with a simple single-call interpreter, `packages/clinic-api/src/intake-interpreter.ts` (`intake-interpreter-v1`).

**How the interpreter works**
- **Input:** one DO call per patient turn (`json_object`), consisting of:
  - rules and examples;
  - a compact field catalog;
  - the numbered known answers;
  - the displayed question;
  - the patient text only.
- **Output:** `facts`, `items`, `listsDone`, `questions`, `moveOn` and an optional `ack`.
- **Server-side validation, per fact:**
  - The quote must be an exact substring of the patient text.
  - Lexical guards apply for unknown, declined and negative answers, and for family subjects.
  - Values are checked against the slot kind, and branch applicability is checked.
  - Conflict and correction are decided by an explicit cue.
  - List completion requires a completion phrase.
- **On rejection:** a rejected fact becomes a clarification. The turn is never failed as a whole.
- **What stays authored:** the next question always comes from the authored prompts (`selectAdaptiveDialogue`). PHQ-4 items (MH01–MH04) are excluded from the interpreter.
- **The `ack`:** filtered (at most 160 characters, no advice words, no questions). It is shown only before an authored question.

**Fixes found by live runs this session**
- **Item ids exceeded the capture schema limit.** Generated item ids hex-encoded the UUID source id, which exceeded the 64-character limit. Any medicine or family item then made `/interpret` return 503 (`invalid-questionnaire-capture`). Ids now use the alphanumeric source id, capped at 40 characters.
  - The same latent bug remains in the legacy validator (`adaptive-validation.ts:758`, `dialogue.ts:182`), which is unused here.
- **A stated current-weight estimate was silently dropped.** `lastMeasuredWeight.representsCurrent` was unset, so synchronize removed the estimate. When the patient gives a different "now" weight, the interpreter now records `representsCurrent=false`, using the same quote as evidence (transform `estimate-implies-not-current`, labeled in the UI).
- **Prompt rule 15:** capture volunteered facts beyond the displayed question.
- **Prompt rule 9:** separates Q01 `reason` from `priority`. This avoids re-asking the identical Q01 question.
- **Staff queue returned 409 locally.** The working-tree `extractionNegativeScope` hint changed the native Questionnaire digest. `native-questionnaire.ts` now strips extraction-only hints from the digest, which is pinned to the deployed `d787950f…7c5b` by a test.
- **Operator logging.** `handler.ts` logs the class and message of unclassified 503s (`clinic-api-unexpected`). The client still gets the generic error.

**Patient UI copy** (`apps/clinic/src/*`)
- Chat transcript with a typing indicator.
- Contextual "Stop and keep my message as written" and "Check status" controls.
- One honesty line, plain-language review labels, and a muted "I don't know · I'd rather not say · Skip for now" row.
- Staff wording, PHQ-4 and safety copy are unchanged.

**Wiring**
- `adaptiveInterpreter` option in `adaptive-session.ts` and `handler.ts`.
- `apps/clinic-server/src/providers.ts`:
  - private settings (`adaptiveInterpreter: "intake-v1"`) behind the Medplum budget ledger (`createProviderAdmission`);
  - env opt-in `CLINIC_ADAPTIVE_INTERPRETER=intake-v1`;
  - `hostedInterpreterProviders` for Vercel.
- `infra/cloud/vercel/server.ts` now matches the deployed shape (`createClinicApplication`, `site-assets`) and injects the capped interpreter.
- `hosted-config.ts` was ported from the deployed staged copy, adding the `nativeQuestionnaire` binding.

## Model and configuration

- DigitalOcean `qwen3.8-max` (`https://inference.do-ai.run/v1/chat/completions`): `max_tokens` 1500, timeout 14 s, `response_format` `json_object`, no retries.
  - `CLINIC_ADAPTIVE_MODEL` can override this with any allowed DO model.
- Observed latency is about 2.5–6 s per turn.
- **Hosted Vercel production env:** `CLINIC_CONFIG_JSON` (unchanged), `CLINIC_ADAPTIVE_INTERPRETER=intake-v1`, `CLINIC_PROVIDER_POLICY_JSON`, `DIGITALOCEAN_MODEL_ACCESS_KEY` (sensitive).
- **Budget policy** `clinic-demo-intake-v1-20261011b`, a shared Medplum ledger for local and hosted:
  - at most 1000 DO requests per account, 25 MB input and 1.5M output tokens;
  - at most 60 requests per session;
  - concurrency 3.
  - When it is exhausted, turns fail visibly; there is no silent fallback.
- **Deployments:**
  - Current: `dpl_fsBYWiKqd6ctyDF8SHzDewYBtZ3w`, built from the working tree by `infra/cloud/.private/clinic-intake-v1-20261011/build.mjs`, then `vercel build`, then the reused `prepare-api-routing.mjs` (prepared routing hash matches the previous deployment), then `deploy.py deploy`.
  - Rollback: promote the previous deployment `dpl_CxDXSoWkB7RjtqAgQBuG7bkMba1B` (guided only), or remove the `CLINIC_ADAPTIVE_INTERPRETER` env var and redeploy.
- **Expiry:** the storage qualification seal expires **2026-10-17T20:25:41Z**. After that the runtime refuses to start, locally too. Renew with `scripts/qualification/qualify-clinic-deployment.ts`.

## Checks performed, and their limits

**Static and offline checks**
- `foundation:typecheck`, `clinic:typecheck` and `tsc -p tsconfig.hosting.json` are clean for clinic and hosting files. The hosting config's existing research/convex errors are unrelated.
- Clinic UI tests: 130/130.
- Hosting tests: 22/22.
- `intake-interpreter.test.ts`: 12/12, covering:
  - a multi-topic answer;
  - padding rejection;
  - mother/prediabetes/question;
  - two medicines with a correction, with and without a cue;
  - an invented quote;
  - move-on;
  - DM branch not applicable;
  - a handler round trip;
  - a new multi-turn handler journey with UUID sources (this reproduced the 503);
  - estimate applicability, which a mutation check confirmed fails without the fix.
- Native questionnaire tests: 12/12, including the pinned digest.

**Live dev eval** (`scripts/dev/intake-interpreter-eval.mts`, 8 cases)
- qwen3.8-max: 8/8 after rule 15.
- glm-5.3: 7/8. It misses the volunteered "help with meals" and is slower.
- Rule 15 was tuned on the `dm-type` case, so the 8 cases are a dev set.

**Holdout** (3 cases written after tuning, never used to change the prompt; excluded from default runs)
- qwen3.8-max: 3/3.
- The pre-existing `ADAPTIVE-HOLDOUT-20.json` was **not** read or used.

**Live end-to-end runs**
- Local in-process run against cloud Medplum (`infra/cloud/.private/local-cloud-dev/journey-live.cjs`):
  - 7 turns, resume, partial review, confirm `delivery=received`;
  - physician and RD see the full handoff, admin gets 404;
  - all 7 clinical flags pass.
- Hosted browser run (above) plus a hosted per-role API check (`clinic-intake-v1-20261011/hosted-staff-check.cjs`): both pass.

**Limits**
- The staff handoff **view** was checked through the API, not rendered in a signed-in browser session.
- Browser screenshots were unavailable in this harness.
- Only one full hosted patient journey was run.
- The full intake covers 22 topics plus PHQ-4. Nobody has completed it in adaptive mode; runs submitted partial handoffs.
- The eval checks pre-synchronize outcomes. That is why it missed the estimate drop; the handler tests now cover that case.

## Remaining failures and known weaknesses

**Full foundation suite: 35 of 1596 tests fail in 16 files**, all pre-existing. An independent triage reran every failing file with the interpreter disabled and the digest change reverted, and got identical failures. None of these paths is used by the live intake. Causes:
- **Fixtures missing `patients`:** `config.patients[scenario]` reads fail (adaptive-audit and three others).
- **Outdated fake receipt shape:** the fake `check()` returns `{state:'unknown'}` without `resources`, so `handoffs.ts:87` throws (3 tests in adaptive-session).
  - Real `MedplumClient` receipts always include `resources`.
  - A `state === 'received'` guard would hide partially delivered work, so the code was left unchanged; update the fakes instead.
- **Legacy long item ids** (`adaptive-validation.ts:758`, `dialogue.ts:182`), the same bug fixed in the interpreter (2 tests).
- **Grouped, v7, reply-domain and provisional experimental extractors:**
  - gating and invariant mismatches;
  - a stale pinned catalog count (131 vs 115).
- **Speech:**
  - provenance and correction scope;
  - an ingress busy-retry test that expects a single reserve call.
- The full run also showed a timing flake: the granular guided `conversation.test.ts` test exceeds 5 s under parallel load and passes alone in 2.6 s.

**Respecting resistance can over-skip**
- "Rather not get into my childhood" stopped the whole weight-history topic, not just the childhood detail.
- When the patient resists a diet recall, volunteered details in the same message are discarded with the topic (holdout `holdout-diet-resist`).
- This is safe but loses information.

**Dialogue pacing**
- After an off-topic answer, the dialogue returns to the outstanding authored question, sometimes with identical wording several turns in a row.

**Other**
- A medication-change question received the generic "include your question for the care team" reply, not the prescriber-specific copy.
- "No stomach issues" was not recorded as digestive=negative. The GI branch remains ineligible until asked anyway.

## Uncommitted state

Nothing was committed or staged. All work sits in the existing large WIP tree.

Session-touched tracked or untracked files:
- `packages/clinic-api/src/{intake-interpreter.ts (new),adaptive-session.ts,handler.ts,bounded-providers.ts}`
- `packages/clinic-api/test/intake-interpreter.test.ts (new)`
- `packages/clinic-content/src/native-questionnaire.ts`, `packages/clinic-content/test/native-questionnaire.test.ts`
- `apps/clinic-server/src/{providers.ts,index.ts}`
- `apps/clinic/src/{AdaptiveViews.tsx,PatientApp.tsx,components.tsx,adaptive-state.ts,useAdaptiveConversation.ts,styles.css}`, `apps/clinic/test/adaptive-state.test.ts`
- `infra/cloud/vercel/{server.ts,application.ts,hosted-config.ts}`
- `scripts/dev/intake-interpreter-eval.mts (new)`
- `docs/implementation/{OPUS-HANDOFF.md,PAUSE-AND-STRATEGY-RESET.md,ORCHESTRATION.md}`

Private, gitignored files:
- `infra/cloud/.private/local-cloud-dev/{provider-settings.json (0600),journey-live.cjs}`
- `infra/cloud/.private/clinic-intake-v1-20261011/{build.mjs,smoke.cjs,deploy.py,hosted-staff-check.cjs,stage/,stage2/}`

Model spend this session: about 50 DO calls, plus an unknown number of errored calls from the interrupted earlier agent. All were within existing credits; none of the $25 extra was used. Research demo allowances were not touched.

## Running processes

None. No dev servers, test runners or browsers were left running by this session.

## Single best next step

Run one complete hosted first-visit intake end to end, through PHQ-4 and every topic, to find the remaining pacing gaps. Then fix the two resistance and over-skip behaviors in `intake-interpreter.ts`:
- keep volunteered facts when moving on;
- scope the move-on to the displayed detail where possible.
