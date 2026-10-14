# Plan: the intake as a questionnaire template

Status: active, 2026-10-14. Owner: Opus (orchestration/review), Haiku 5.5 (bounded implementation units).
Entry point and live status: [HANDOFF-CURRENT-WORK.md](HANDOFF-CURRENT-WORK.md).

## Goal

Adding a pre-visit check-in, between-visit check-in, after-visit follow-up or any new clinic
questionnaire should be a *content* change: author topics, slots, prompts and a workflow entry,
run the compiler and parity tests, publish, re-qualify. Today it is a code change across ~13
independent enumerations plus scenario-specific branches in `conversation.ts`, `dialogue.ts`,
`handoffs.ts`, `adaptive-*` and `clinical-core`.

## Standards we follow (not invented here)

- **HL7 FHIR R4 Questionnaire + SDC** for authored structure and its terms: `item.linkId` (slot id),
  `item.type` (string/decimal/choice/boolean/group), `required`, `repeats`, `enableWhen` (our
  `when`), `answerOption`, `item.code`, `Questionnaire.version`/`url`, and
  `QuestionnaireResponse` for captured answers. Medplum is FHIR-native; the native questionnaire
  is already a published `Questionnaire` resource with a pinned digest.
- **Validated instruments are locked blocks**: PHQ-4 uses exact stem/items/choices, is buttons
  only, is never answered from free text, and carries its attribution. A pack can *include* a
  locked instrument; it can never re-word it.
- **Wording governance**: every authored or agent-proposed string carries `wordingStatus`
  (`proposed-detail` until a human approves). No pack can label itself approved.
- **Content-as-data with a compiler and golden tests**: the established pattern for form engines
  (SDC `$assemble`, LHC-Forms, SurveyJS JSON). The source of truth is declarative; the runtime
  consumes the compiled, validated output; a golden/digest test catches drift.

## What the code map found (2026-10-14)

- Scenario IDs are enumerated independently in `clinic-content/types.ts:5`, `scenarios.ts`,
  `clinic-contract/src/index.ts:2`, `clinical-core/src/domain.ts:8`,
  `clinical-core/src/questionnaire-response.ts:223`, `clinic-api/src/handler.ts:23`,
  `conversation.ts:22-23`, `StaffApp.tsx:289` (duplicate choice labels), both hosted configs,
  both seed scripts, `local-mock-clinic.mts:52`, and `qualify-clinic-package.mjs:17`.
- Scenario behaviour is hard-coded:
  - W02/W04 context prompt swaps (`conversation.ts:152`, `dialogue.ts:149`, `native-questionnaire.ts:904-1078`)
  - W05/W06 date fields (`conversation.ts:343`, `provisional-draft.ts:145`)
  - billing/scheduling forcing a `medical` owner (`conversation.ts:380`)
  - admin logistics allow-lists (`domain.ts:28-39`, `handoffs.ts:23`)
  - W07 projections (`adaptive-validation.ts:478, 829`)
  - extraction blocks (`adaptive-group-manifest.ts:26-29`)
- `ScenarioTemplate.completion` and `contextRequirement` are never read.
- **Latent coupling:** `questionnaire-response.ts:955` serialises *any* numeric `choice` slot as
  `urn:corvo:phq4-response` with PHQ labels. The first non-PHQ numeric choice item would be mislabeled.
- **Latent bug (unverified):** `W02.followup.1` ("What has changed about [previously reported item]
  since [date]?") has unfilled placeholders and is gated on `context.pre-visit`. Deployed
  configs never supply `nativeContext`, so guided pre-visit/post-visit may hit `prompt-rule-inactive`.
  No guided test walks W02/W04 past the opening prompt.
- Voice is exercised only with first-intake. No prior-submission readback, no clinic-initiated trigger.
- The native digest (`native-questionnaire.ts:1480-1567`, pinned at
  `clinic-content/test/native-questionnaire.test.ts:30`) covers every topic, slot, prompt, rule
  and their order. It does **not** cover:
  - `patientSummary`, `owners`, `completion` or `contextRequirement`
  - `workflowId`, `reusableTopicIds` or `missingContextPromptId`
  - titles, dialogue copy or choice labels

## Phases

Each task is specified for standalone implementation in its phase document. Live status is
tracked only in [HANDOFF-CURRENT-WORK.md](HANDOFF-CURRENT-WORK.md); that file also has the
workspace, commands and rules.

| Phase | Document | Tasks | Digest impact |
|---|---|---|---|
| T1: one registry | [PLAN-QT-T1-REGISTRY.md](PLAN-QT-T1-REGISTRY.md) | T1.1 workflow registry, T1.2 declarative behaviour, T1.3 PHQ-4 coding decoupling, T1.4 guided and voice coverage | none |
| T2: pack format | [PLAN-QT-T2-PACKS.md](PLAN-QT-T2-PACKS.md) | T2.5 pack schema, T2.6 compiler + exporter + parity, T2.7 FHIR export | none (parity-enforced) |
| T3: product reach | [PLAN-QT-T3-REACH.md](PLAN-QT-T3-REACH.md) | T3.8 between-visit pack, T3.9 prior-submission readback, T3.10 clinic-initiated link | T3.8 changes the digest; T3.9/T3.10 need AccessPolicy changes |

Order: T1.3 and T1.4 can run any time. T1.1 waits for D-d, then T1.1 → T1.2 → T2.5 → T2.6 →
T2.7. T3.9 can start after T1.2. T3.8 waits for T2.6. Haiku 5.5 implements each task, and the
Opus orchestrator reviews and commits.

## Re-qualification bundling

- T1 changes no digest.
- T2 (5–7) is digest-neutral by construction for adult-intake. Unit 8 and anything touching
  `native-questionnaire.ts` publish a new Questionnaire version: bump
  `NATIVE_QUESTIONNAIRE_VERSION`, `clinic-manifest.mjs:68` and `questionnaire-response.test.ts:84`.
- Those changes ride on the next re-qualification. The current one expires
  2026-10-21T01:48:12Z, and with the `/auth/me` observer change it no longer needs an admin grant.
- Do not hurry a digest change into the Oct 21 window.

## Boundaries

All existing clinical boundaries apply unchanged:
- authored questions only;
- PHQ-4 exact and buttons-only;
- incomplete stays incomplete;
- no diagnosis, dose or eligibility advice;
- agent-authored wording stays `proposed-detail`;
- the safety floor and model gate are workflow-independent and cannot be configured per pack.
