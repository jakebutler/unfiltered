# Phase 5: Voice, interview quality and optional structured items

Read [PLAN-ASYNC-FEEDBACK-AT-SCALE.md](PLAN-ASYNC-FEEDBACK-AT-SCALE.md) §0 first for workspace, isolation, provider, cost and commit rules. The design rationale is in §§3, 4, 8 and 9. Paths are relative to the worktree root.

**Phase goal.** Add campaign-only push-to-dictate with participant-reviewed transcripts, browser-first read-aloud with optional budgeted ElevenLabs, stronger follow-up quality controls, per-question saturation and response-quality flags. Add structured questionnaire-pack items only if the separate pack track supplies a compatible storage-neutral compiler output. Campaign behaviour remains additive; demo sessions without `campaignId` retain their existing path.

**Phase acceptance**
- All task tests pass and typechecks are clean against baseline.
- Campaign speech is independently budgeted; token grants are scoped to the campaign session, and no raw audio is retained.
- Interview guard and saturation behaviours are covered by deterministic tests; operator health and quality views expose the specified metrics and flags.
- T5.9's owner-authorized real-microphone run is recorded. It is a manual qualification step, not permission for an implementer to make unapproved provider calls.
- Independent review covers the whole Phase 5 slice.

**Phase out of scope**
- Any clinic turn engine, clinic package, or clinic deployment changes.
- Raw audio storage, audio upload through Vercel, camera/screen/DOM capture, or non-English interviews.
- Feeding codebook themes back into live interviews, automatic campaign closure, or removing operator override of saturation.
- Structured pack items before the pack track has completed and provided its storage-neutral compiled contract.

**Gate.** Phase 5 is downstream of the campaign foundation and analysis pipeline: Phase 1 must be complete before campaign voice or interview-quality work begins, and Phase 3 must be complete before saturation work (T5.5). The program-level Track 3 implementation remains gated until Tracks 1 and 2 are complete. T5.8 is separately conditional on the pack track. Do not begin gated implementation early; independent planning or review does not waive these dependencies.

## T5.1 Campaign speech budget and Deepgram token mint action (M)

**Files:** `convex/schema.ts`, `convex/researchSpeech.ts` (new or campaign additions to the existing research speech boundary), and campaign budget helpers in `packages/research-core/src/campaign.ts`.

Add atomic per-campaign speech-second reservation and settlement using campaign shard rows. The action verifies the participant capability and campaign state, checks `voice === 'dictation'`, reserves the requested bounded grant, and mints the existing short-lived Deepgram direct-stream token. It must not return the provider key or accept a participant-supplied session/campaign association. Deny closed/exhausted campaigns and campaigns without voice enabled. Reconcile consumed seconds from the existing speech receipt; unknown outcomes remain charged at the reservation bound. Speech exhaustion disables dictation while text answering continues. Do not persist audio.

Keep the token URL/host fixed to Deepgram using the existing `packages/speech` contract. The action is keyed to `campaignId` sessions and must not touch demo capacity or provider-ledger rows. Pin and validate grant bounds server-side; callers cannot choose a larger duration.

**Tests:** `packages/research-core/test/campaign-speech.test.ts` and `packages/research-core/test/campaign-speech-native.test.ts`
- `grant requires a campaign participant capability and enabled dictation`
- `campaign speech seconds reserve atomically and settle within allocation`
- `unknown speech outcome retains bounded charge; no blind grant retry`
- `exhausted speech budget denies another grant while text session remains usable`
- `grant never returns credentials or accepts another campaign's session`
- `demo speech admission path and fixtures remain unchanged`

**Commands:** codegen after schema changes (§0); `npx tsc -p convex/tsconfig.json`; `npx vitest run --config packages/research-core/vitest.config.mts packages/research-core/test/campaign-speech.test.ts packages/research-core/test/campaign-speech-native.test.ts`.
**Depends on:** T1.6. **Out of scope:** UI, audio persistence, changing shared speech or clinic code.

## T5.2 Dictation UI: push-to-dictate (M)

**Files:** campaign participant UI in `apps/research/src/ParticipantApp.tsx` (or its campaign participant component) and focused tests under `apps/research/test/`.

When a campaign enables dictation and speech budget remains, expose an explicit push-to-dictate control. Obtain the scoped token through T5.1, stream directly to Deepgram using the existing research speech client, and show a clear recording/stopped/error state. The participant must review and may edit the transcript before submitting it as `confirmed-transcript`. Never auto-submit a transcript, retain audio, or send audio through the research server. Stop recording on explicit stop, route/session change, tab loss, grant expiry, or budget denial. A dictation failure leaves the text box available and does not block the scripted interview.

**Tests:** campaign UI tests
- `campaign voice off hides dictation control`
- `push starts only after consent and a scoped grant`
- `transcript is editable and is not submitted before participant confirmation`
- `stop, route change and tab loss stop capture`
- `grant or provider failure preserves text entry and scripted progress`
- `demo participant UI remains unchanged`

**Command:** `npm run research:test -- apps/research/test/campaign-dictation.test.tsx`.
**Depends on:** T5.1. **Out of scope:** hands-free conversation, raw audio retention, shared clinic UI.

## T5.3 Read-aloud: browser default, ElevenLabs optional (M)

**Files:** campaign participant UI and campaign speech boundary; reuse `packages/speech` contracts where applicable.

Browser `speechSynthesis` is the default and requires no provider budget. Add optional ElevenLabs read-aloud only when the campaign explicitly selects it and has TTS characters remaining. Enforce character reservation/settlement per campaign before requesting synthesis; charge unknown results at the reserved bound and do not retry. On provider failure or exhaustion, fall back to browser speech. Bound input text and output duration, cancel prior playback on question change or explicit stop, and never expose ElevenLabs credentials. No audio is stored.

**Tests:** campaign read-aloud tests
- `browser speech is the default and works with ElevenLabs disabled`
- `ElevenLabs requires campaign opt-in and a positive character budget`
- `reservation and settlement enforce campaign character cap`
- `provider failure and exhausted budget fall back to browser speech`
- `new prompt and explicit stop cancel current playback`
- `demo read-aloud path remains unchanged`

**Command:** `npm run research:test -- apps/research/test/campaign-read-aloud.test.tsx` plus the focused server test named by the implementation.
**Depends on:** T1.6. **Out of scope:** server-side audio retention, autoplay bypass, changing default browser speech.

## T5.4 Interview guards and `probeIntent` (S)

**Files:** `packages/research-core/src/interview.ts`, campaign study validation/schema/UI as required, and their focused tests. Keep campaign-specific prompt changes behind the campaign path.

Add an optional authored `probeIntent` (maximum 280 characters) to a question's interview packet. Apply two guards to model-proposed follow-ups: reject leading language matching the examples in overview §8 (including “don't you think”, “wouldn't you agree”, “isn't it”, “how much did you love”), and reject a follow-up whose normalized token overlap with any script question is at least 0.8. Preserve existing exact quote/source binding, repeated-question checks, skip/resistance advancement and two-follow-up cap. A rejected follow-up advances to the next scripted question; it must not expose model text. Campaign revision/config digest pins the resulting prompt configuration. Do not feed codebook content into interview prompts.

**Tests:** `packages/research-core/test/interview-quality.test.ts`
- `probeIntent is included when present and omitted when absent`
- `probeIntent over 280 characters is rejected at authoring validation`
- `leading and agreement-seeking follow-ups are rejected`
- `normalized token overlap at 0.8 is rejected against any script question`
- `overlap below threshold can pass other existing guards`
- `rejection advances scripted interview and preserves exact quote validation`
- `demo interview fixtures and path remain unchanged`

**Command:** `npx vitest run --config packages/research-core/vitest.config.mts packages/research-core/test/interview-quality.test.ts packages/research-core/test/interview.test.ts packages/research-core/test/interview-native.test.ts`.
**Depends on:** T1.6. **Out of scope:** clinic lexical guards, adaptive codebook input, more than two follow-ups per question.

## T5.5 Per-question saturation detection (S)

**Files:** `packages/research-core/src/saturation.ts` (new), `convex/researchSessionMap.ts` or the map completion mutation, campaign question-stat schema, and operator themes UI.

After each successful map, compute for each question the distinct codes first introduced in its latest 20 mapped sessions. Once at least 30 sessions for that question are mapped, mark it saturated when zero new codes appeared in that window. Store the state in the existing question stats/campaign structures and update it atomically with map completion. Saturation disables follow-ups for that question in subsequent turns; an operator can override per question. When every open question is saturated, show “consider closing”; never auto-close. Preserve revision pinning and do not retroactively alter completed sessions.

**Tests:** `packages/research-core/test/saturation.test.ts` and `packages/research-core/test/saturation-native.test.ts`
- `under 30 mapped sessions cannot saturate`
- `zero new codes in the last 20 mapped sessions saturates`
- `a new code in the window prevents saturation`
- `saturated question suppresses future follow-ups unless operator override is set`
- `all open questions show consider-closing state without closing campaign`
- `withdrawn/excluded map data does not create a new-code event`

**Command:** `npx vitest run --config packages/research-core/vitest.config.mts packages/research-core/test/saturation.test.ts packages/research-core/test/saturation-native.test.ts`.
**Depends on:** T3.5. **Out of scope:** automatic campaign closure, changing already-issued interview decisions, codebook in prompt.

## T5.6 Response quality flags (S)

**Files:** `packages/research-core/src/quality.ts` (new), campaign session settlement/map path, and quality flags UI/query.

Implement the overview §5 quality signals using campaign sessions only: identical normalized answer content across at least three sessions (store a hash, not a second copy of answer text); completion time below 20% of the campaign median duration; at least 50% of answers shorter than three words; and non-language text. Flags are explainable, recomputable, and do not delete or rewrite participant sources. Flagged sessions are excluded from synthesis by default until an operator explicitly includes them. The operator can see the reason and inclusion state. Define deterministic normalization and minimum data requirements so sparse campaigns do not generate misleading duration/language flags. Never infer identity, honesty, emotion or diagnosis.

**Tests:** `packages/research-core/test/quality.test.ts` and `packages/research-core/test/quality-native.test.ts`
- `duplicate answer hashes flag only after three distinct sessions`
- `duration below 20% of median is flagged once sufficient durations exist`
- `short-answer flag uses answer count denominator and 50% threshold`
- `non-language flag is deterministic and stores no copied answer`
- `operator inclusion removes quality exclusion from synthesis eligibility`
- `demo sessions are not scanned or flagged`

**Command:** `npx vitest run --config packages/research-core/vitest.config.mts packages/research-core/test/quality.test.ts packages/research-core/test/quality-native.test.ts`.
**Depends on:** T1.7, T3.4. **Out of scope:** automatic deletion, identity or intent inference, changing manual demo analysis.

## T5.7 Interviewer health panel (M)

**Files:** campaign aggregate query (new campaign health query or an addition to the campaign operator API), `apps/research/src/FindingsWorkspace.tsx` (campaign branch) or a focused campaign panel, and UI tests.

Show metrics per question and campaign revision: follow-up rate; validator rejection rate by reason; median answer length after a follow-up versus after a script question; and skip/resistance rate. For questions with at least 50 mapped/eligible sessions, compare follow-up rate with the first-50-session baseline and flag deviation greater than two standard deviations. Specify the denominator for every displayed rate, handle zero denominators, and compute from bounded counters/aggregates rather than scanning full transcript tables. The panel provides an operator review aid; it does not change campaign settings or auto-disable questions. Keep data scoped through the existing operator/project authorization checks.

**Tests:** `apps/research/test/interviewer-health.test.tsx` and focused query tests
- `metrics are separated by question and campaign revision`
- `each rate uses the documented denominator and zero denominators render safely`
- `first-50 baseline is not flagged before sufficient later observations`
- `more than 2σ deviation is flagged`
- `health query is project-authorized and does not return participant text`
- `demo findings panel remains unchanged`

**Command:** `npm run research:test -- apps/research/test/interviewer-health.test.tsx` plus the focused Convex native test.
**Depends on:** T1.6. **Out of scope:** automatic quality interventions, transcript export, project-wide unbounded scans.

## T5.8 Questionnaire-pack structured items (conditional, M)

**Gate:** do this only after the questionnaire-pack track has delivered its authoring and compiler contract. If that track is incomplete or its output depends on `clinical-core`/Medplum, leave T5.8 blocked and do not invent a parallel pack schema.

**Files:** campaign study definition/schema and authoring UI, participant rendering/answer validation, response persistence, and pack compatibility tests. Exact module names follow the delivered pack contract.

Embed storage-neutral compiled structured items for supported choice, integer/rating and NPS-style questions in the campaign study definition. Open-text pack items may carry the pack's probe extension (`goals`, `maxFollowUps ≤2`) and must map to the campaign interview contract. Persist validated structured answers as participant sources with stable question/item identifiers and typed values; never coerce them into free-text model evidence. The compiler output used here must not import `clinical-core` or Medplum. Preserve existing authored `study.definition.script` behavior for campaigns without pack items and all demo sessions.

**Tests:** add focused compatibility tests against the pack track's actual compiler fixtures:
- `storage-neutral pack output round-trips into campaign study definition`
- `choice, integer/rating and NPS answers enforce pack constraints`
- `open-text probe extension is bounded to two follow-ups`
- `structured values persist with stable item identity and are not treated as quote evidence`
- `campaign without pack items and demo study fixtures are unchanged`

**Command:** the focused pack compatibility and campaign UI suites, plus the standard typechecks. Record exact commands after the pack contract exists.
**Depends on:** pack track. **Out of scope:** editing the pack implementation, Medplum/FHIR persistence, migrating existing studies.

## T5.9 Owner-authorized real-microphone run (S)

This is an owner-run qualification on the feedback deployment after the provider and speech configuration has been explicitly approved. Do not perform live provider calls as part of ordinary implementation or tests. Record the approved cap in the status notes and usage ledger before the run, as required by §0. Use a campaign with dictation enabled and a bounded speech allocation.

Run one real microphone response through grant → direct Deepgram capture → visible transcript review/edit → participant confirmation → saved answer. Confirm stop behavior and browser fallback. Verify the campaign speech ledger settles and no audio object/row was retained. Preserve the normal text path and ensure no demo project, allowance, or provider row was used. Record timestamp, deployment/campaign identifiers (no secrets or transcript PII), bounded usage, observed result and limitations in the implementation status/evidence location authorized by §0.

**Acceptance:** owner approves the recorded run and the evidence proves a confirmed-transcript source, correct campaign-only speech accounting, and no retained audio. A failed or ambiguous provider outcome is recorded and charged according to T5.1; do not retry without a new owner-approved cap.
**Depends on:** T5.1–T5.3. **Out of scope:** a general voice reliability claim, physical-device matrix, provider retry, or any clinic qualification.
