# Clinic adaptive intake — handoff (updated 2026-10-16)

Current task status and gates live in [HANDOFF-CURRENT-WORK.md](HANDOFF-CURRENT-WORK.md).
The dated deployment notes below are historical receipts. The verified October 16 source
changes have not been deployed or exercised against live providers in this continuation.
Hosted remains stage8/native-5; its existing proof expires **2026-10-21T01:48:12Z**.

## Verified source changes (2026-10-16)

The October 16 commits below passed independent review and all six hub gates on Node 22.23.3.
D-a is the separately recorded historical fix:

- **D-a:** the E-0.2 NegEx scope fix predates `cb0bfe8`; negated/history/family mentions no
  longer trigger the tier-0 floor solely because they contain a crisis keyword. This does
  not promise that the separate model gate will clear every such statement.
- **D-b `f68c94f`:** the single-call interpreter awaits safety before extraction. A hopeless
  disclosure retains its exact source, never supplies a PHQ answer or silently becomes
  current stress, and a different authored probe preserves the original unanswered gap.
  Existing higher-risk safety routing remains; no authored crisis list was widened.
- **D-c `70437f8`:** spoken weight/height and digit transcripts require exact readback and a
  reviewed confirmation before recording. An unreviewed yes cannot confirm; raw speech and
  both sources remain in provenance. Approximation, conflicting units, signs and decimal
  precision are checked; uncertain actual readings require clarification.
- **D-d `b6a1761`:** fixed route templates and opaque request IDs protect timing metadata.
  `Server-Timing` and request records measure request phases; a separate browser buffer
  measures submit to React commit. The report CLI passed on a synthetic fixture. A real local PatientApp
  exercise recorded two submit-to-React-commit timings (102.4 ms and 78.3 ms) containing only
  opaque metadata; these mocked operations do not establish hosted latency or reductions.
- **D-f `07da259`:** new schema-3 qualification observes the demoted runtime's `/auth/me`
  Project projection at seal time and checks drift on refresh, without an admin feature
  file. Schema-2 proofs retain their original contract until expiry. Full sealing-dependency
  pins are verified locally. Frozen private continuation smoke is blocked by a missing q4f
  runtime; owner calibration and live renewal remain outstanding. See
  [CLOUD-CLINIC.md](CLOUD-CLINIC.md#qualification-without-request-time-writes).
- **T1.3 `a811bd4`, T1.4a `7e46cde`, T1.4b `46a1a3b`:** PHQ coding is scoped to the locked
  block and guided/voice regressions are covered. T1.4b originally recorded ten expected
  failures; D-j `6dbc672` now passes all ten with their expectations unchanged.
- **D-m `63a1483`:** active authored prompt selection prevents the pre-/post-visit guided
  crash without trusted context. Unavailable prior-item questions stay unasked and partial;
  questionnaire bytes, digest and count pins are unchanged.

- **D-j `6dbc672`:** non-PHQ typed/spoken choices require explicit confirmation; unmatched
  sources retain their displayed question without repeating the assistant turn. Original
  speech remains immutable and is screened during recovery. PHQ rejects voice/control
  bypasses; direct button scoring remains. A real offline PatientApp walk passed.

- **D-l `8067411`:** the new offline native API and actual PatientApp/StaffApp walkthrough
  verify incomplete three-item screening and four-button scores (GAD-2 3, PHQ-2 3, PHQ-4 6),
  retaining partial overall intake and clinician review. No provider or hosted call is made.

**Still open:** D-e staff safety visual checks and D-g mobile checks remain pending. D-k crisis
phrase additions require owner review and bundled re-qualification. D-h requires owner-only
secret rotation, one-time calibration, demotion verification and renewal before the expiry
above. A real-microphone hosted human-voice test is still outstanding. Local gate success does
not establish these live or visual results.

## Historical deployment receipts

> **2026-10-14 (stage8, P5): hosted runs native-5 with hands-free voice.**
> - Medplum: questionnaire `CC-0.2.phq4.native-5` published (`Questionnaire/9004366b-…`), the three named AccessPolicies updated in place, staff memberships unchanged. One temporary admin elevation (owner-approved, granted three times in the console because of two retries); every seed run ended `demotion-verified`.
> - Qualification: `qualify-clinic-deployment.ts`, 39 checks including the native questionnaire round-trip, expires **2026-10-21 01:48 UTC** (re-qualify before then).
> - Vercel env: policy `clinic-demo-intake-v1-20261013a` (Deepgram 3000 s/session, 36000 s/account, concurrency 4; DigitalOcean 150 requests/session, account cap unchanged), `CLINIC_SPEECH_INPUT=deepgram-direct`, Member-role `DEEPGRAM_API_KEY`, new `CLINIC_CONFIG_JSON`. Browser read-aloud.
> - Verified on hosted: config advertises direct voice; CSP allows only `wss://api.deepgram.com` beyond self; a fake-microphone hands-free run minted 9 tokens, saved 8 answers and advanced 5 questions in 75 s; physician, RD and admin log in and their queues load.
> - Found and fixed on the way: old handoffs (all 18 were native-4) failed the whole staff queue — now counted and noted; the qualifier never passed the questionnaire binding, tripped the login rate limit and hard-coded the mapping check to fail — all fixed (`--rehearsal` added); the seed couldn't upgrade policies in place or find existing staff by email (staff references carried from the previous journal).
> - Rollback: stage7 can't be restored, because its sealed identity no longer matches the updated policies.
> - Still to do: rotate the Medplum client secret (it appeared in a screenshot); a real-microphone, human-voice test.

> **Late on 2026-10-11 (stage7, `dpl_6b2TqHBsfQXC375jGsuxQtgqUkKw`):**
> - **All open issues closed:**
>   - Test suites: foundation 1664, hosting 25 and clinic app 148, all passing (`tsc` clean).
>     - Some fixes are real behaviour fixes: a patient's direct edit inside a provisional list item is no longer dropped, and coordinated unknowns ("I don't remember the oatmeal portion or what was added to the coffee") are admitted.
>     - Two fixes re-pin historical receipts honestly: the AF37 schema no longer matches the current code, and the test now says so.
>   - The guided-choice repeat on free text is fixed: free text answers the question actually shown, and a guided fallback shown twice parks its topic.
>   - Approximate numbers ("around 6") are recorded as uncertain, never exact.
>   - PHQ-4 was exercised live (`infra/cloud/.private/local-cloud-dev/phq-safety-live.cjs`, 3 DigitalOcean calls) against real Medplum: exact wording, button answers, scores gad2=1 / phq2=2 / phq4=3 with clinician review, delivery `received`, and physician and RD staff views show the screening.
> - **Tiered safety** (see `DEMO-TESTING-GUIDE.md`):
>   - Tier 0: E-0.1 rules, unchanged and digest-pinned.
>   - Tier 1: liberal lexical screen `safety-screen.ts` (S1-0.1). It never interrupts.
>   - Tier 2: background DigitalOcean review `safety-review.ts` (safety-review-v1), on its own admission session. Results are stored in a separate `urn:corvo:clinic:safety-review` document so reviews never make the patient's turn stale. Anything not explicitly cleared fails closed to human review. High or imminent risk pauses with the authored copy (`via: 'model-review'`).
>   - Tier 3: a clinician-only staff safety queue, detail and actions. RD and admin get 404.
>   - Live check: "chest pain right now and my left arm feels numb" was missed by tier 0 and escalated to E01 by tier 2. "My father had a stroke" was cleared. "Hopeless most days" was routed to a clinician at moderate.
> - **Voice (hosted push-to-talk):**
>   - The browser records one clip and `POST /api/clinic/speech/transcriptions` calls Deepgram `nova-3-medical` REST once (about 0.8 s on hosted). The words land in the answer box for review.
>   - The browser `speechSynthesis` reads questions aloud.
>   - PHQ and other exact-choice prompts stay button-only.
>   - Push-to-talk is enabled by `CLINIC_SPEECH_INPUT=deepgram-rest` + `DEEPGRAM_API_KEY` (sensitive) + provider policy `clinic-demo-intake-v1-20261011c`. That policy adds a Deepgram budget of 300 requests / 3600 s per account and 80 requests / 1200 s per session.
>   - The UI has been checked on hosted. A real microphone was not exercised in automation.
> - **Voice V2, hands-free (2026-10-13, P4, code complete):**
>   - `CLINIC_SPEECH_INPUT=deepgram-direct` makes the browser stream microphone audio straight to Deepgram live (`nova-3-medical`). Each utterance uses a 30 s token minted at `POST /api/clinic/speech/tokens`. The server never relays audio. Each mint is an admission reservation under the Deepgram ledger, and it charges the 59 s stream bound. Requires the interpreter and provider policy as before.
>   - Push-to-talk upload stays wired as the fallback. `deepgram-rest` remains push-to-talk only.
>   - Optional read-aloud: `CLINIC_SPEECH_OUTPUT=elevenlabs` + `ELEVENLABS_API_KEY`, served by `POST /api/clinic/speech/output`. It only voices authored prompts or the current assistant reply, and it uses the same ledger. The default is browser voice.
>   - **Setup requirement (historical P4 note; hosted key was updated in stage8):** Deepgram's token grant (`/v1/auth/grant`) needs an API key with at least the **Member** role; a lower-role key gets `403 FORBIDDEN` and hands-free falls back to push-to-talk. The local env file has a Member-role key since 2026-10-13; the hosted `DEEPGRAM_API_KEY` was subsequently updated in P5 (stage8).
>   - The page's Content-Security-Policy adds `wss://api.deepgram.com` to connect-src only in direct mode.
>   - Local testing: `LOCAL_SPEECH=direct` on `scripts/dev/local-mock-clinic.mts` runs direct voice and upload against real Deepgram. Calls are capped by `LOCAL_DEEPGRAM_CAP` (default 30). `DEEPGRAM_API_KEY` is read from `LOCAL_ENV_FILE`.
>   - Verified 2026-10-13: suites green (foundation 1849, clinic 230, hosting 28). Live, the exact streaming URL transcribed a self-correction clip as one utterance with a clean close. A live browser token refusal fell back to push-to-talk, and real dictation filled the answer box.
> - **Follow-up status (updated 2026-10-16):**
>   - Tier-0 negation was fixed in E-0.2 before `cb0bfe8`; it is no longer an open task.
>   - The staff safety screen was verified through its API; the visual check is still D-e.
>   - The hopeless-turn defect is fixed in source by D-b `f68c94f`; live retesting remains pending.
>   - Hands-free is hosted in stage8 (`cb0bfe8`), including the fake-microphone receipt above.
>     The earlier local browser receipt covered 14 consecutive turns, barge-in, stop and a
>     self-correction; a real-microphone hosted human-voice test remains outstanding.


> **Later the same day:**
> - All work is committed on `codex/unfiltered-foundation` and open as draft PR #7.
> - Hosted now runs deployment `dpl_HzkFg758m1Kx3Pjx4TBuRMAkLXQb` (stage6).
> - **Topic avoidance is recorded explicitly.** The displayed detail is declined, with the patient's words, and the topic stops as `patient-declines`. Staff see "Patient preferred not to discuss this topic. Consider a gentle follow-up." A plain skip is `patient-moves-on`. Facts in the same message are kept.
> - **Conflict loop fixed.** A compound answer no longer becomes a conflict, and any answer to a conflicting field resolves it.
> - **"Move on or come back" can no longer loop.**
> - **Tests:** 23 of the 35 pre-existing failures were fixed. 12 remain in experimental extraction paths and need product/safety decisions (see commit `b96f401`).
> - Tester instructions are in `DEMO-TESTING-GUIDE.md`.
> - **Full live journey passes** (run 8, 54 interpreter calls, local build = stage6): intake through Q22 and the diabetes branch, then review, then confirm (`received`). Physician and RD see the handoff; admin gets 404. Checks passed:
>   - metformin label vs actual use;
>   - lisinopril correction to 20 mg with no stale 10 mg;
>   - father's diabetes under family history;
>   - estimate labelled;
>   - Q03 and Q17 avoidance as `patient-declines`.
> - **Fixed after run 6:**
>   - Review 503 `questionnaire-inactive-answer-is-active`: the capture projection is now repeated until stable, because an unreviewed routing anchor changed DM sources between passes.
>   - Corrections quoted with a small unmarked word gap are no longer rejected.
>   - A question is never shown a third time for the same topic in a session.
> - **Still open:**
>   - That stage6 script never reached PHQ-4 within its 55-call cap. Stage7 later exercised it live (receipt above); D-l adds a repeatable smoke path.
>   - Typing free text at a guided yes/no choice can repeat that choice. Use the buttons.
>   - Twelve failures were recorded at stage6 (`b96f401`); this is a historical count, superseded by the current hub gates.
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

**Historical cloud-connected local alternative (October 11; owner-only)**

These commands preserve a historical setup, not a currently verified configuration. They
make real DigitalOcean calls and share cloud Medplum state and budgets. Do not use the
old private q4f configuration as current qualification. Any live reuse requires explicit
owner authorization and a current verified runtime/qualification setup. For current offline
PHQ testing, use the new harness in
[the demo guide](DEMO-TESTING-GUIDE.md#offline-phq-browser-smoke-d-l).

- Historical commands, run from the worktree:
  1. `CLINIC_CONFIG_PATH=$PWD/infra/cloud/.private/clinic-q4f-mapping-suffix-20261010-a3/clinic-config.qualified.json CLINIC_PROVIDER_SETTINGS=$PWD/infra/cloud/.private/local-cloud-dev/provider-settings.json npm run clinic:api`
  2. `npx vite --config infra/cloud/.private/local-cloud-dev/vite.cloud-origin.config.mjs`, then open http://127.0.0.1:5173.
- The DO key must be in the environment, or in a 0600 file named by `CLINIC_PROVIDER_ENV_FILE`.
- Local runs share the same Medplum project and budget ledger as hosted.

## October 11 implementation narrative (historical)

The remaining sections preserve the original October 11 notes. Their deployment IDs,
configuration values, test counts, working-tree state, process state and proposed next steps
are historical, not current operator instructions. The verified source section and hub
supersede their status. In particular, the old October 17 seal expiry and stage4 rollback
suggestions below must not be used: hosted stage8 uses the October 21 expiry and changed
sealed policies, and even stage7 cannot be restored with its old sealed identity.
Use the D-h owner checklist in [CLOUD-CLINIC.md](CLOUD-CLINIC.md) for renewal.

### What changed and why

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

### October 11: model and configuration

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
  - Historical stage6: `dpl_HzkFg758m1Kx3Pjx4TBuRMAkLXQb` (stage6), built from the working tree by `infra/cloud/.private/clinic-intake-v1-20261011/build.mjs`, then `vercel build`, then the reused `prepare-api-routing.mjs` (prepared routing hash matches the previous deployment), then `deploy.py deploy`.
  - Obsolete rollback note (do not execute; sealed identity has since changed): promote `dpl_2F9eveSeA6PSk2GDw6ew53DQbCXs` (stage4) or `dpl_CxDXSoWkB7RjtqAgQBuG7bkMba1B` (guided only), or remove the `CLINIC_ADAPTIVE_INTERPRETER` env var and redeploy.
- **Historical expiry:** the stage6 seal expired **2026-10-17T20:25:41Z**; this is superseded by stage8's **2026-10-21T01:48:12Z** expiry. Follow the current D-h checklist, not these stage6 operating notes.

### October 11: checks performed, and their limits

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

### October 11: remaining failures and known weaknesses

**Historical October 11 result: 35 of 1596 foundation tests failed in 16 files**, recorded then as pre-existing. Current six-gate results in the hub supersede this count. An independent triage reran every failing file with the interpreter disabled and the digest change reverted, and got identical failures. None of these paths is used by the live intake. Causes:
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
- The historical full run also showed a timing failure: the granular guided `conversation.test.ts` test exceeds 5 s under parallel load and passes alone in 2.6 s.

**Respecting resistance can over-skip**
- "Rather not get into my childhood" stopped the whole weight-history topic, not just the childhood detail.
- When the patient resists a diet recall, volunteered details in the same message are discarded with the topic (holdout `holdout-diet-resist`).
- This is safe but loses information.

**Dialogue pacing**
- After an off-topic answer, the dialogue returns to the outstanding authored question, sometimes with identical wording several turns in a row.

**Other**
- A medication-change question received the generic "include your question for the care team" reply, not the prescriber-specific copy.
- "No stomach issues" was not recorded as digestive=negative. The GI branch remains ineligible until asked anyway.

### October 11: uncommitted state

At that October 11 snapshot, nothing had been committed or staged and work sat in the large WIP tree. This does not describe the current checkout; the verifying commits and current WIP map are in the hub.

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

### October 11: running processes

The October 11 session reported no dev servers, test runners or browsers left running. This is not a current process inventory.

### October 11: single best next step

The October 11 proposed next step was a complete hosted first-visit intake through PHQ-4 and every topic to find pacing gaps, then fixing the two resistance and over-skip behaviors in `intake-interpreter.ts`:
- keep volunteered facts when moving on;
- scope the move-on to the displayed detail where possible.
