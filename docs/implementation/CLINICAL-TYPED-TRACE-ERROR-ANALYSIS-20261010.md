# Typed clinical trace findings — paused

2026-10-10. Bounded read-only error analysis of the existing **16 actual typed traces**. No source change, provider call, replay, holdout read, cloud/browser action, or qualification. Work stopped at the user's clean-pause request. Only this note was added.

Both retained batches remain **3/8 whole-case provisional successes**, all repetitions of the same goals statement across text/confirmed/unreviewed transcript channels. Both are **5/8 raw-schema-valid** despite every request carrying strict JSON schema. These are tiny development-set descriptions, not population rates or model incapability evidence. AF170/AF179 correction calls were unissued because actual setup rejected; neither gets correction/history credit.

Evidence: [GLM independent actual review](evidence/S3-CANONICAL-TYPED-AF162-AF170-INDEPENDENT-REVIEW.md), [Qwen independent actual review](evidence/S3-CANONICAL-TYPED-QWEN-AF171-AF179-INDEPENDENT-REVIEW.md). For each AF below, its exact raw text is `infra/cloud/.private/DO-AF<ID>-PREFIX.json` (`partial`), and exact request context, saved first admission, raw audit and resume are `infra/cloud/.private/DO-AF<ID>-CANONICAL.json`. Frozen requests are `infra/cloud/.private/canonical-typed[-qwen]-development-<case>-request-20261010.json`. No private JSON dump is reproduced here.

## Trace catalog: first observed failure and downstream effect

| Trace / case | Result | Earliest observed defect; downstream saved outcome |
| --- | --- | --- |
| AF162 / D1 | Pass | Both supplied goals admitted; Q02 saved/resumed. Empty optional highlights omitted diagnostically. |
| AF163 / D2 | Fail | Occasion entities are invented address strings, not source-described identities; child fields use `name/value` instead of issued field structure. Three faithful scalars survive, but both occasions, explicit child unknowns/quantities and list closure are lost; Q11 repeats. |
| AF164 / D3 setup | Fail | Correct medicine names/strengths appear inside topic-prefixed child addresses and nested state/value wrappers. Missing catalog fields also become unresolved entries. Zero claims/items; Q08 repeats. |
| AF165 / D4A | Fail | “No diagnosis yet” becomes unsupported patient-diabetes **negative**. Mother's diabetes and explicit diagnostic question are omitted. Negative survives admission; prediabetes uncertainty survives; Q06b advances. |
| AF166 / D4B | Fail | Unsaid diagnosis type/timing/care becomes unknown/missingness; generic item identity `new` is unsupplied. Two faithful reports survive, fabricated unknowns are held. DM01 is correct from the existing guided anchor. |
| AF167 / D5 | Fail | Patient appointment value gains unsupported referral/staff/system context; narrow transport absence becomes broad known logistics. Four useful supplied meanings survive; appropriate missing verified-context hold remains. |
| AF168 / D6A | Pass | Both goals and Q02 retained; confirmed transcript channel preserved. |
| AF169 / D6B | Provisional pass | Both goals and Q02 retained; unreviewed recognition gap preserved; no final fact credit. |
| AF171 / D1 | Pass | Both goals and Q02 retained; fabricated optional ellipsis highlight rejected. |
| AF172 / D2 | Fail | Occasion meanings repeatedly appear as limited collection-root scalars instead of native items/closure. Raw is schema-valid. Three faithful scalars survive; eight gaps and repeated Q11. |
| AF173 / D3 setup | Fail | Four faithful medicine name/strength fields omit mandatory `period` and `correctsSourceIds`. Additional unresolved silence entries use nonissued aggregate child addresses. Zero claims/items, ten gaps; Q08 repeats. |
| AF174 / D4A | Fail | Mother/diabetes is withheld with the false statement that relationship is not supplied; patient-diabetes gets imprecise unknown/ever scope. Explicit question has invalid topic and nutrition owner. Raw is schema-valid; family item/question act absent after admission. |
| AF175 / D4B | Fail | The 70-character source becomes 51 raw scalar unknowns about unsupplied catalog fields. **41 unsupported unknowns** plus two faithful reports are admitted; 26 gaps. Invalid positive child states/missing period also reject items. |
| AF176 / D5 | Fail | Correct dated nausea/appointment/meal/transport source is replaced in raw by unrelated palpitations, medication, allergies, glucose/A1c and sleep narrative. Four unsupported unknowns and 19 gaps survive; all actual supplied meanings are omitted. |
| AF177 / D6A | Pass | Both goals and Q02 retained; confirmed channel; fabricated optional ellipsis highlight rejected. |
| AF178 / D6B | Provisional pass | Both goals and Q02 retained; unreviewed recognition gap preserved; no final fact credit. |

The primary observation categories emerging from these traces are collection mapping/shape loss (AF163/164/172), omitted required metadata (AF173), expressed-state/ownership distortion with lost question (AF165/174), silence promoted to answers or missingness (AF166/175), authority/narrow-scope contamination (AF167), and unrelated narrative substitution (AF176). These are observations rather than proved root causes. Ten of sixteen fail whole-case acceptance; the six successes repeat one simple input.

## What static evidence establishes

- All 16 retained raw outputs equal their saved raw audits after JSON parsing; current source text equals saved source text. The source files inspected match frozen candidate hashes. Correct source binding and an `applied` save do not establish meaningful truth.
- AF165 demonstrates the difference between literal quotation and interpretation: the exact phrase “no diagnosis yet” does not justify a negative diabetes answer. AF176 demonstrates that full-turn provenance cannot validate an invented narrative. Requiring more quotes alone would not resolve either class.
- Current [typed prompt/catalog/schema/decoder](../../packages/clinic-api/src/adaptive-extraction-typed.ts) mixes manifest, displayed question, catalog, prior metadata and patient prose inside one user JSON message (lines 406–420). D3/D4B carry 25 topics, 110 scalar/root addresses and 41 child addresses across 11 collections, against 55/70 characters of actual patient prose. D5 has only 8 topics and a 6,829-byte user message, yet AF176 still goes off source. Size alone is not an established explanation.
- AF167's appointment report appends staff verification wording resembling the actual displayed question. This supports investigating context/patient-data separation; it does not prove that mixed roles caused the output.
- The prompt says both “across all offered topics” and “Missing fields stay absent.” Missingness-only unresolved entries occur in AF164/166/173/175. The task framing may encourage catalog completion, but that mechanism has not been isolated.
- The issued wire requires an outer state and native value; AF164's nested state/value wrapper and AF175's `positive` states are not requested output forms. Collection roots appearing in scalar and item catalogs support distinct whole-list states versus item facts. Eliminating those clinical distinctions is not justified by these traces.
- Strict schema was **requested**; enforcement/support is not established by completed receipts. Existing independent validation found six noncompliant outputs. Four schema-valid rich outputs still fail meaning (AF165/167/172/174). No single provider/schema/model cause is proved. The GLM/Qwen bodies differ in model and reasoning configuration (GLM `low`, Qwen omitted), while messages/schema/context are unchanged.

## Neutral metadata is conditional, not a cure

AF173 has faithful new medicine identities and name/strength values with no prior items. For that limited situation, an absent correction list interpreted as `[]` adds no supersession authority; an unspecified period interpreted as null can avoid a mechanical rejection when no meaningful period is being discarded. This was **not implemented or credited**.

It is not a universally semantics-neutral relaxation: [projection](../../packages/clinic-api/src/provisional-projection.ts:26) includes period in meaning equality, and typed correction guards require same subject/item/attribute/period. Supplied temporal scope must be preserved. An omitted correction link cannot authorize replacement; differing unlinked reports must remain conflicts. Malformed supplied metadata cannot be silently repaired.

Defaults alone would not rescue AF173. The decoder first converts nonissued aggregate unresolved addresses into Q08-wide ambiguous holds (typed source lines 834–851); those holds block native child claims during admission (894–986) and leave no admitted item (1002–1008). Missing label/use/reason/concern catalog fields are not patient uncertainty. Accepting unknown from silence is not an alternative.

## Paused strategy hypothesis

The smallest coherent hypothesis worth considering is **message-role separation within the current typed representation**: trusted authored catalog/contract/context, the actual displayed assistant question, and a user message containing only the immutable patient text. Keep the schema, decoder, correction/conflict guards and source binding fixed so that any future result can be attributed to this narrow change. This is an untested prompt-packaging hypothesis, not an implementation plan or a claim that it will cure collection errors or unrelated output.

Auth/assignment/source isolation, native branch authority, atomic persistence/CAS, explicit PHQ choices/scoring, partial-intake semantics, final patient confirmation and clinician review remain requirements. None is removed to obtain an easier pass. No framework, broad representation rewrite, model sweep or new allocation is proposed here.

**Exact pending state:** no intervention implemented; no new candidate, new call authority, correction derivation, holdout inspection, semantic/latency qualification, activation or hosted acceptance. Both original batches and all failed outputs remain unchanged and unqualified. Resume only after the user's strategy reset.
