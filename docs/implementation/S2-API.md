# S2 durable adaptive API

This slice integrates the pure proposal/validation/dialogue modules with the existing patient capability, versioned Medplum draft, review and confirmation flow. It is synthetic technical implementation, not live-model qualification, clinical-content approval, clinical clearance or production acceptance. The root coordinator owns provider configuration, bounded live qualification, browser work and speech.

## HTTP contract

All mutations retain strict same-origin JSON validation and a signed HttpOnly patient capability with confirmed persona. Identity, patient, scenario, source IDs, model choice, content and clinical bindings cannot be supplied by the browser.

| Route | Input | Behavior |
| --- | --- | --- |
| `POST /api/clinic/adaptive-turns` | `requestId`, `expectedRevision`, exact `text`, `channel: "text"` | CAS-saves raw wording and a server-issued operation/source before inference; returns HTTP 202 with `{session,operation}`. |
| `POST /api/clinic/adaptive-turns/:id/interpret` | `{}` | Claims an accepted operation once, then calls the injected proposer. Terminal/processing calls return current status without another provider request. |
| `GET /api/clinic/adaptive-turns/:id` | None | Current session and requested operation, without resetting identity confirmation. Expired processing is reconciled to unresolved, never restarted. |
| `POST /api/clinic/adaptive-turns/:id/discard` | `expectedRevision` | Explicitly prevents pending interpretation from applying. Exact wording remains available. |
| `POST /api/clinic/conversation-mode` | `expectedRevision`, `mode` | Selects adaptive or guided questions. Pending interpretation must be discarded first. |

Operation status is `accepted`, `processing`, `applied`, `failed`, `unresolved` or `discarded`. Applied operations can still have `hasUnresolvedInterpretation: true`; this means supported details were added but the statement was not fully understood. Historical uninterpreted sources remain in `session.adaptive.unresolvedSources`, review and the confirmed clinical snapshot. Their presence prevents a claim of complete intake. No provider receipt, trusted binding, credentials or raw model output is returned in public operation DTOs.

A raw-acceptance retry must keep the original request ID and exact original body. It returns that operation's current state alongside the latest session; replay never erases a newer operation or dialogue. If an acceptance response was lost, the client may reconcile the exact same acceptance and show an explicit continue action when its saved status is definitively accepted. It must not automatically submit another interpretation after uncertainty. Existing guided request idempotency remains intact.

## Claim, binding and recovery

1. Save exact text, channel, server capture time and the actual displayed prompt ID, plus the assistant question, under the draft's FHIR `If-Match` version. The source is never replaced by a model summary or normalized field label.
2. Bind the operation to patient/session/scenario, accepted revision, content version and a digest of exact source history, answers, allowed definitions, displayed target coverage, dialogue and prompt register. The client cannot supply this context.
3. Before inference, validate context and size locally, then durably claim `processing` with a fresh attempt ID and expected processing revision. Every successful save acknowledgement must match the exact intended canonical draft, the same FHIR resource ID and a changed FHIR version; scope checks alone are insufficient. A stale/malformed success is reconciled by an exact readback. An unconfirmed claim never dispatches, and the caller independently verifies its processing state/attempt/revision before calling the provider.
4. Invoke the injected proposer once. A bounded 15-second maximum call deadline becomes unresolved uncertainty; it is not evidence that provider work or usage was cancelled. An abandoned processing claim becomes unresolved after its stored deadline, with no restart or replay.
5. Validate and apply in memory using the pure trusted-token API. Re-read the saved operation and verify attempt, revision and context digest before a conditional result save. A discarded, superseded, confirmed or changed context cannot receive late facts/dialogue.
6. Store outcome, spans, transformations, clarification alternatives, omitted-question spans, whole dialogue state, safe receipt and result digest with the applied facts. Lost result acknowledgements use exact store readback. An unsaved result becomes unresolved when reconciliation permits; it never triggers another inference call.

Late safe receipt metadata can be attached to the original attempt without applying its facts, changing the current clinical revision, or reopening a discarded operation. This is bounded best-effort persistence; a second persistence failure remains unresolved and is not converted into a provider retry. Provider-side usage reconciliation remains the root coordinator's responsibility.

Guided answers, topic/detail changes, mode switches, review and confirmation reject an accepted/processing operation. The patient can explicitly discard then continue, review a partial version or leave. Leave/resume does not cancel provider work or invent an outcome. Identity gates return no topics, source history or operation detail before confirmation. Stored adaptive metadata is validated before use: finite operation states, source/request linkage, server identity binding, revision and attempt/deadline consistency, one active pending operation and applied result digest. Malformed claims fail closed. Legacy guided drafts without adaptive metadata remain readable; this is not a full clinical-schema migration.

## Content and evidence

The persisted dialogue uses the pure engine's grouped, directed prompt and target paths. Short workflows include their own topics and explicitly selected reusable topics; they do not become a full intake. Existing DM/SLEEP/GI definitions can be extraction candidates only where Q06 is in scope. Historical branch responses remain visible even after applicability is disputed. Untriggered reproductive context is not universally prompted.

PHQ-4 items use the frozen exact guided stem/item/four choices. The model cannot write score fields. Safety matching executes while accepting raw wording, before inference or structured extraction, and preserves source/help without requiring handoff. Existing safety limitations remain; this bounded matcher does not establish general clinical triage.

Field detail DTOs contain source spans and transform names independently from the patient quote. The full operation retains transformation provenance and clarification alternatives. Review/confirmation retains exact patient sources; the confirmed snapshot retains detail provenance and an explicit uninterpreted-wording section for assigned clinical staff. Existing administrative projection continues to select only the allowlisted structured logistics fields and exposes no raw clinical sources. Native FHIR sources remain exact patient wording; source channel/displayed-question metadata remains in the durable clinic draft.

Normal guided collection `Add`/`Finished listing` turns no longer label previous listing evidence as a correction. Explicit detail changes still preserve correction lineage. Root's actual-confirmation timestamps, immutable receipt time and stable PHQ completion time are unchanged.

## Offline verification and limits

`packages/clinic-api/test/adaptive-session.test.ts` exercises the real Fetch handler and `readDraft`/`saveDraft` against a fault-injecting FHIR boundary. It covers raw-save failure/lost acknowledgement, racing accepts, simultaneous interpretation/restarted handler, ambiguous claim or stale HTTP-200 acknowledgement with zero dispatch, lost/failed result saves, explicit discard and late completion after guided changes or partial confirmation, snapshot/source drift, origin and cross-session isolation, exact sources, safety, PHQ, partial understanding and seven scenario-shaped multifield saves/reviews. These injected proposer tests establish persistence and authority behavior, not live-model semantic quality.

A substantive late-intake regression saves 40 guided turns with longer narrative answers, then switches to adaptive and completes one injected interpretation. It checks preservation of the entire new source and every current top-level fact's value/state/source IDs. The pure author's compact lossless projection now keeps this fixture within 32,000 characters per message and 60,000 aggregate UTF-8 bytes including the system instruction. Inputs beyond the explicit bounds still fail locally before provider dispatch; no source or fact is silently sliced. This is bounded offline context evidence, not proof of live latency or extraction quality throughout arbitrary long intakes.

Draft byte/turn bounds and source limits remain enforced. The API adds no queue, database, background inference worker, retry scheduler or alternative provider. Text operation support is not speech acceptance. No credentials, server restarts, live provider calls or live Medplum writes were used for this integration test slice.

Latest targeted verification: 60 tests passed across adaptive-session (37), conversation (10), queue (7), and independent S2 security reproductions (6); `foundation:typecheck` passed. The pure-module author separately owns semantic/context qualification. No live-provider or rendered acceptance is implied by these offline checks.
