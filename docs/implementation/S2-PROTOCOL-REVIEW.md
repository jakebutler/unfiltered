# Adaptive interpretation boundary: independent review

2026-10-09 · prospective recommendation after DO-A6 · no activation approval

**Make one bounded protocol revision before spending another model call: let the model identify patient meanings and evidence; let the server own addresses, normalization, correction lineage, and the next question.** Freeze that revision, independently review it, then compare the two already allowed DigitalOcean candidates on the same development inputs. Do not add another gold-specific prompt paragraph, relax clinical validation, or replace the existing content/persistence architecture.

The desired product is still a natural adaptive interviewer across all seven scenarios. Server-owned questions do not imply a fixed questionnaire: the server can follow an explicitly requested topic, interrupt for a patient question, resume an unfinished topic, fill several fields from one answer, and skip already supplied or explicitly unavailable details. The existing `selectAdaptiveDialogue` already provides most of this behavior.

This review inspected `S2-ADAPTIVE.md`, the independent review history and DO-A1–A6 receipts, with complete raw-output inspection of the recent failures; `adaptive.ts`, `adaptive-source.ts`, `adaptive-wire.ts`, `adaptive-validation.ts`, `dialogue.ts`, and relevant existing tests/session status code. Product constraints were checked against the primary checkout's approved product, experience, and clinical registers. The frozen holdout was not opened. No provider calls, implementation changes, runtime changes, cloud writes, or new tests were performed.

## What the observed failures establish

| Evidence | Implication |
| --- | --- |
| A5 passes G1/G2/G4/G6/G7/G8 in independent review. G3/G5 fail address/schema validation; G3 additionally omits explicit unknown details. | The underlying extraction task is feasible. Exact addressing and an executable wire contract matter, but successful parsing cannot establish semantic completeness. |
| A6 G1 invents `next.promptId=":end"`; canonical validation rejects the whole proposal. | The model has authority over an unnecessary output. The next question depends on the **post-application** state, which the model cannot reliably precompute. Remove this output prospectively. |
| A6 G1 also cites both a number and a unit as two evidence entries for each numeric weight value. `deriveAnswer` requires one numeric entry. | Removing `next` alone would not make G1 pass. The model is choosing a transform while also reverse-engineering its input grammar. Make the field's extraction contract explicit and server-owned. |
| A6 G2 outputs `topicId="Q03", path="Q03.childhood"` and similar fabricated paths. The strict JSON schema permits arbitrary strings there. | Closed objects are insufficient. Valid current addresses must be native schema enums, resolved through one server-created manifest. |
| A6 G2 marks “I don't remember what happened over the past 18 months.” as `known` narrative. | This is a semantic defect independent of the malformed address. The current verbatim guard rejects a short list of entire phrases, so this longer sentence can satisfy a text target if its address is repaired. Do not fix only the path and then claim clinical success. |
| A6 G1/G2 emit redundant `answer` acts repeating their facts. G1 uses 1,082 output tokens versus A5's 369; G2 uses 569 versus 222. | Remove repetition before changing timeouts. `answer` and generic `correction` acts add no dialogue behavior beyond facts and correction metadata. Long repeated source identifiers also cost output. |
| A6 G1 takes 11,565 ms; G2 takes 6,024 ms; G3 reaches the 15-second timeout with no settled provider outcome. | The candidate fails the current experience. Three calls do not identify whether decoding, service variance, or request differences caused the regression. Preserve G3 as unresolved usage; do not retry it or quietly increase the deadline. |

The A6 responses are compatible with the requested static schema: invented paths and prompts were legal strings in that schema. These failures do **not** prove that DigitalOcean ignored strict structured output. Conversely, two compatible outputs do not prove every schema feature is enforced. Local validation remains necessary.

## Recommended v4 boundary

Keep one inference call, the existing saved-source operation, canonical spans, content-native answers, validation/apply machinery, and durable Medplum path. Add an opt-in prospective wire version and a small trusted request manifest. Preserve v1/v2/v3 and historical receipts unchanged.

### 1. Compile current context into a trusted manifest

The server creates and retains, for this immutable operation:

- Writable target references mapping to exactly one topic and scalar or existing-item path, its content definition, existing answer, allowed states, and deterministic extraction kind.
- Collection references and their valid new-item child references. New-item fields are scoped to their collection; an existing medicine reference cannot accidentally identify a newly created medicine.
- Evidence references mapping to exact segments of the current immutable source. Keep v3's exact quote resolution, repeated-literal addresses, complete original source, and whole-source subject/negation/entity checks.
- Eligible agenda topic references and approved reply references. Exclude PHQ scores, configuration fields, timestamps, patient/session IDs, clinical ownership, delivery/completeness fields, and other server-owned data.

Generate the native schema and local parser from this same manifest. A target is a single enum reference, rather than two strings whose relationship is described in prose. Collection and child compatibility must be enforced locally and, where practical, by a small per-collection schema alternative. Source, agenda, and reply references are also enums. Do not build a giant alternative for every combination of target, state, quote, and operation; the schema enforces structural eligibility, while the local validator enforces evidence and semantics.

Short request-local references such as `f12`, `c2`, and `s3` can replace long repeated paths and hashes in model output. Their scope comes from the trusted manifest bound to the persisted operation, not from their appearance. Never rebuild a manifest from provider output or resolve a result against a newer session snapshot. If the existing long source IDs are retained initially, that is an acceptable implementation simplification; eliminating redundant output has higher priority than changing a working source resolver.

Keep every scenario-allowed topic available for volunteered information, including allowed conditional candidates. Do not limit extraction to the currently displayed field or silently truncate a later-session chart to meet the byte budget. A bounded whole-context failure remains explicit. Include the displayed question and current relevant answers, but remove the eligible probe text bank from inference input once `next` is removed.

### 2. Remove outputs the server can determine

A compact illustrative shape is:

```ts
{
  schema: 4,
  facts: [{ target: "f12", state: "known", evidence: [...], operation: "assert" }],
  newItems: [{ collection: "c2", fields: [{ field: "cf4", state: "unknown", evidence: [...] }] }],
  completedLists: [{ collection: "c2", evidence: [...] }],
  interruptions: [{ kind: "question", evidence: [...], topic: null, reply: "r2" }],
  unmapped: [{ evidence: [...], reason: "ambiguous" }]
}
```

This is a design sketch, not an approved parser. All references and applicable states must be generated enums, objects closed, arrays bounded, and neutral representations explicit if required by the provider dialect.

Remove `next` entirely. Remove repeated `topicId`/`path`, model-generated new-item `key` (the server already creates identity from source and array position), generic `answer`/`correction` acts, and model-copied prior source IDs. Keep only meaningful interruptions: questions, explicit move-on, explicit topic change, and unresolved interpretation. Facts already establish that an answer was supplied; a field operation already establishes a proposed correction.

The server derives canonical `transform` from the target definition and the declared patient answer state. A text target uses exact narrative; numeric targets use the explicitly identified numeric literal; composite height uses the existing bounded parser; unit/choice/presence targets use the existing finite parsers. A non-known answer preserves its evidence and state. Do not try several interpretations until one happens to pass. The manifest must expose a concise extraction kind so the model knows whether to return one numeric literal, a complete composite height, or a full narrative. For a known numeric candidate, require one value-bearing quote; its unit has its own existing target and source. Broader context is already available from the full source. This prevents A6 G1's two-entry numeric mistake without accepting arbitrary number-containing prose.

For an existing target, `operation: correct` identifies intent. The server resolves the exact prior source lineage from that target in the bound snapshot and still requires an explicit, locally scoped correction cue. New items cannot carry corrections. A contradictory assertion without a valid explicit correction remains a conflict; missing or ambiguous entity identity never becomes permission to overwrite. This changes wire mechanics, not correction authority.

Keep explicit list completion separate. Creating an item or answering one field cannot close a list. Keep a meaningful question's exact evidence and its approved reply choice; the server remains responsible for reply priority and safe fallback. `unmapped` is a bounded abstention record for meaningful source text the model could not place, not an excuse to discard it or a patient answer state.

### 3. Fix the uncertainty boundary before qualification

Distinguish three independent properties:

1. What the patient says: a known report, explicit negative, uncertainty, unavailable detail, or refusal.
2. What the machine can interpret: mapped, conflicting, or unresolved.
3. Whether the topic's clinical minimum is satisfied.

“The patient supplied this sentence” does not mean the requested clinical detail is known. A known narrative about inability to recall the requested weight history must not make that history sufficient. Conversely, `uncertainDiagnosis` intentionally records a **known report of uncertainty**; globally converting every sentence containing “unsure” into an uncertain answer would corrupt that field and unrelated known information.

Give the manifest enough target meaning to distinguish a requested fact from a narrative explicitly intended to preserve uncertainty. Keep the model's state proposal, then reject known-state claims where the cited clause explicitly says the requested detail is unavailable. Use the full sentence and target scope, not a global keyword scan. Do not automatically relabel a known output as unknown simply to make it pass. If a safe scope cannot be established, retain the source as unresolved and clarify or allow partial handoff. This is a bounded contradiction guard, not a new general English entailment engine.

Required controls include an extended unavailable-history sentence, an unavailable portion with a known food, uncertainty about treatment logistics beside an established condition report, a known value with an unknown date, mixed known/unknown details in one clause, and a narrative whose purpose is to record diagnostic uncertainty. These must test actual readiness and next dialogue, not just the presence of quoted words. Existing finite coverage projections remain useful only with their provenance and safeguards; do not expand them into a second clinical extractor.

Source retention alone is not semantic capture. A5 G3 retained the whole patient turn but still failed because unknown portion/additions were not represented and could be asked again. `unmapped` and source-level omission guards can expose some gaps; neither a model declaration nor character-span coverage proves that every meaning was captured. Independent semantic evaluation remains the gate.

### 4. Keep partial application narrow and truthful

Do **not** add permissive malformed-JSON recovery or a catch-and-drop candidate loop in this revision. Wrong envelope, invalid/foreign references, invalid evidence addresses, stale bindings, forbidden fields, and unknown schema versions still reject the proposal as a whole. Save the original patient message and raw result independently; show interpretation failure and recovery without asking the patient to retype their source. The contextual schema should remove the observed mechanical failures before making recovery more complicated.

Within a structurally valid, bound proposal, preserve the current distinction between accepted supported facts and semantic deferrals. Independent supported information can be retained while a disputed detail remains unresolved. Dependent changes must be consistent: do not change a medicine child under unresolved identity, apply half of an incompatible composite-height correction, or suppress a multi-entity statement because one child matched. This does not require rejecting legitimate partial measurements; a supported value with unknown units/date remains recorded and incomplete.

Every deferred candidate and model-reported unmapped span needs a durable reason and evidence, included in the result digest and staff review path. Never mark the turn fully interpreted merely because one fact was accepted. Avoid asking the patient to repair irrelevant model artifacts: rejected redundant data can leave the clarification queue only when its meaning is demonstrably covered, using the existing narrow coverage rules and retained audit record. Actual consequential omissions and conflicts remain visible.

This retains a clear distinction between “your words were saved,” “supported details were added,” and “this topic has enough detail.” A partial handoff stays available; a clinician receives the raw source plus clearly labeled unresolved interpretation. Neither an unresolved detail nor a failed model call becomes a negative clinical answer.

## Natural interviewing with a server-owned next question

After applying the accepted outcome, recompute readiness and choose from actual remaining probes:

1. Existing safety and frozen PHQ handling keep precedence and run outside inference.
2. Honor an explicit stop immediately. Answer a supported interruption from approved content; retain all concurrent supported facts.
3. Follow an explicit patient topic preference when eligible. Otherwise resume the suspended or current topic, scoped to its real remaining detail and named item.
4. Clarify a consequential interpretation conflict without repeating an explicitly unavailable or refused detail. Respect the existing engagement/move-on path.
5. Once the topic is accounted for, choose the next required unresolved topic, then optional topics, or offer review.

This is already close to `selectAdaptiveDialogue` without its nomination branch. Preserve item-specific and life-stage questions, reported anchors, ordinary connective copy, and the separate wording provenance. Do not replace them with internal field labels. A patient can volunteer several future answers in one turn, which changes the next question; a fixed ordering of topics does not undo that adaptivity, provided explicit agenda changes and relevant missing-detail follow-ups work. If rendered review finds the result mechanical, change the finite dialogue policy/copy using approved content rather than granting the extractor unrestricted clinical prose or another inference call.

## Bounded implementation and acceptance gates

**Implementation scope:** one v4 manifest/compiler, a compact wire resolver into the existing canonical proposal, removal of prospective model nomination, deterministic transform/correction-lineage selection, and the specific uncertainty/readiness guard above. Integrate durable unresolved-span metadata if added. Do not rewrite the clinical content schema, agent runtime, Medplum store, or interview engine. No second model call, automatic retry, JSON repair, runtime model fallback, or free-form care advice.

Before any live run:

- Independent tests prove contextual reference rejection, collection/child compatibility, exact source spans and ambiguous repeated literals, stale-manifest rejection, forbidden PHQ/config writes, correction lineage, branch preservation, and the uncertainty controls above. Real safety/PHQ boundaries make zero provider calls.
- Test the **generated** schema for a small and a full later-session context. Check local/parser equivalence, request byte budget including dynamic schema, and deterministic schema/manifest receipt digests. Keep whole source and complete admitted context. Do not use the frozen holdout to implement this.
- Demonstrate existing gold-source semantics with supplied valid v4 proposals and verify resulting readiness/dialogue. These are protocol tests, not reclassification of A1–A6 or model quality evidence.
- Confirm saved source, partial interpretation, raw receipt, canonical provenance, and unresolved details survive the existing durable operation path. Rejecting a result must not resend it or spend again.

Then freeze the protocol and evaluation input. Root can reserve **one unchanged eight-case development run for Qwen and one for the already allowed GLM candidate**, each single-attempt and separately receipted, if credit headroom permits. This is now justified: six iterations have mixed protocol defects with model behavior, and A6 introduced a material latency regression. A paired comparison on a sound frozen boundary is more informative than another sequence of prompt patches on Qwen. Do not compare on the currently broken v3 boundary, change prompts between candidates, choose a best-of-many result per turn, or activate a runtime fallback. If one candidate fails a mandatory safety/semantic gate, its average score does not compensate.

Qualification must independently inspect every supplied meaning and next exchange: zero unsupported consequential facts, correct person/entity/time association, no collapse of unknown/declined/negative states, exact source/correction lineage, no questions for detail already supplied or explicitly unavailable, and no false completeness or external action. The eight development cases have been repeatedly observed; passing them is necessary regression evidence, not generalization evidence.

Only a viable frozen candidate proceeds to the unopened broader holdout, full-context budgets, native patient-to-staff Medplum readback, and rendered text/voice journeys across the seven scenarios. A live protocol or schema change after seeing holdout failures requires a new independently prepared holdout; do not tune on and rerun the same set as if it remained unseen. Report latency by successful semantic turns and preserve failures/timeouts separately. Text inference timing alone cannot establish the voice end-of-utterance-to-audible-response requirement.

**Decision:** bounded schema/boundary revision first; frozen two-model comparison next; adaptive activation remains off until broader semantic, persistence, and rendered experience gates pass. This proposal changes neither the approved clinical minimums nor clinician authority and does not require reopening the user's product approval.
