# S1 — clinic conversation, confirmation and staff work

Local synthetic S1 checkpoint after the qualified S0 foundation. Native workflow, fault, and role evidence exists below; independent staff rendering remains incomplete. This is not the completed adaptive/voice product or a production clinical release.

## Required vertical path

1. Enter the fictional clinic, choose a scenario, acknowledge synthetic-only data, and confirm the displayed persona before prior answers appear. Rejecting identity clears access without deleting the saved draft.
2. Answer a specific current prompt. One accepted patient turn has a stable identifier and source. Granular unknown/declined states and missing detail remain explicit. A retry cannot duplicate a turn; a stale browser version cannot silently overwrite a newer answer.
3. Review the saved answers, open their original sources, and correct an answer. The confirmation preview changes with the corrected payload. Missing required measurements prevent complete-intake status but allow an explicit partial handoff.
4. Deliberately confirm and send. The UI distinguishes saving, confirmed content, unknown receipt, and verified delivery. Checking uncertain delivery reconciles the same version without inventing a new submission.
5. Authenticate as a named staff member. Only assigned received work appears. An RD can inspect the complete intake and sources. Administrative staff sees only necessary logistics. Selecting a record does not mark it reviewed.
6. Perform an allowed role-specific action with a concrete outcome or request for information. The action retains verified identity, role, time and reviewed revision. RD visibility does not confer medical disposition authority. Administrative closure leaves medical work open.
7. Return to the patient status view and see the actual persisted staff outcome, with no claim that a booking, payment, prescription or treatment decision occurred without its separate evidence.

## Scope matrix

| Scenario | Distinct acceptance detail | Result |
| --- | --- | --- |
| First intake | CC-0.2 detail targets, five weight-history periods, dated actual/estimated measurements, condition branches and PHQ-4 | Guided full intake and partial handoff received; actual staff outcome read by patient |
| Pre-visit | Explicit known appointment context or missing context, changes distinguished from unasked items | Native receipt and attributed staff request for clarification read by patient |
| Non-visit | Updates and patient questions routed to appropriate work | Native receipt and staff outcome; admin closure leaves medical work open |
| Post-visit | Existing authored plan sourced or explicitly missing; no invented care instructions | Native receipt and request for authored plan read by patient |
| Billing | Logistics-only administrative view and concrete recorded disposition | Native receipt, bounded logistics projection independently checked, staff clarification read by patient |
| Scheduling | Requested preferences remain requests until actual staff evidence | Native receipt, bounded logistics projection independently checked, staff clarification read by patient |
| Refill | Medical work owns renewal and symptoms; no assistant prescribing | Native receipt and clinician request for label details read by patient; no renewal claim |

## Evidence and unresolved limits

- `apps/clinic-server/test/local-attempt-2026-10-10T01-47-08-832Z.json`: 11/13 checks passed, including all seven attributed staff outcomes. The late amendment save was uncertain and the unassigned queue failed. The failed attempt is retained; it is not a green full-run receipt.
- `recovery-2026-10-10T01-51-58-249Z.json`: actual named physician pages contained five items each, took 780/601 ms, and rejected a forged cursor; unassigned named queue returned empty in 7 ms and denied the handoff. Its amendment assertion failed before mutation because the test omitted the existing guided source label.
- `recovery-2026-10-10T01-52-58-669Z.json`: corrected assertion read the exact saved amendment before any retry, then completed that same version and retained its previous receipt. The two native HTTP 412 entries in these diagnostic files are intentional stale-write probes from runtime storage qualification.
- `complete-results.json`, `fault-results.json`, and `amendment-results.json` retain separate actual Medplum full-intake, lost-response/stale-write/privacy and prior-receipt reconciliation evidence. `local-results.json` is an older failed record retained for provenance; it must not be presented as current acceptance.
- `evidence/S1-SECURITY-REVIEW.md`: independent bounded review closed administrative projection, prior receipt, queue pagination, confirmation timestamp, and completed-PHQ timestamp findings. PHQ completion now follows its cited answer sources; unrelated saves cannot move it. Patient and staff received time comes from the same verified immutable QuestionnaireResponse metadata.
- `evidence/S1-BROWSER.md` and `evidence/S1-DESIGN-REVIEW.md`: root inspected patient-to-RD outcome and amendment flow; independent patient review closed narrow-screen overflow. Independent staff rendering stopped at the original timeout, then browser access was blocked during the paging follow-up. The revised staff flow still needs independent rendered review.
- Latest offline foundation suite: 188/188 checks, including pure S2 and speech foundations; foundation build and clinic build/typecheck pass. Pure-module tests do not establish live adaptive behavior or browser voice quality.

## Fault and access cases

- Lost save response; reload/resume; duplicate request identifier; stale revision.
- Missing/declined height or weight; estimated value cannot overwrite measured value; sparse willingness is not resistance.
- Correction invalidates earlier preview; wrong digest cannot confirm.
- Delivery accepted but response lost; incomplete/unknown/conflicting receipt stays out of normal staff-ready work.
- Cookie tampering/expiry, another session identifier, missing/foreign Origin, oversized input and unauthorized source/work references fail closed.
- Named-role direct FHIR and application denials both matter. Source reads must not expose reusable native signed storage URLs.
- Staff request identity comes from the authenticated session, never submitted role labels. Clinical information cannot leak in admin queue text or error messages.
- Read-only staff tokens remain read-only; any server-mediated action carries explicit verified-user provenance and narrow authority checks.

## Rendered review

Exercise actual served desktop and mobile layouts together, keyboard focus, readable errors, source inspection, review return position, narrow-screen composer and long clinical text. Capture one initial batched inspection; correct material findings; confirm once. A separate reviewer checks the resulting evidence. Do not describe a typecheck or HTTP 200 as rendered acceptance.

## Current limits

The current served conversation is explicitly guided. DigitalOcean credit coverage and bounded model connectivity/format tests are recorded, but adaptive clinical extraction remains unqualified. Deepgram credit coverage and a synthetic ElevenLabs-to-Deepgram round trip are recorded; browser voice is not active. Jake explicitly selected PHQ-4 with clinician review on October 9. Full delivery still includes live adaptive conversation, browser voice, research, free hosted qualification, independent client instances and the AWS package.
