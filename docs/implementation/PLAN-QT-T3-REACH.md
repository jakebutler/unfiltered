# T3: product reach (new pack, readback, clinic-initiated links)

Parent: [PLAN-QUESTIONNAIRE-TEMPLATE.md](PLAN-QUESTIONNAIRE-TEMPLATE.md). Status lives in
[HANDOFF-CURRENT-WORK.md](HANDOFF-CURRENT-WORK.md).

T3 tasks change the published questionnaire and/or the hosted surface, so each one is a
**re-qualification event** (hub rule 11). Build and test them locally against
`scripts/dev/local-mock-clinic.mts`. Deploy only in the next bundled re-qualification, which needs
the owner.

---

## T3.8 Between-visit symptom check-in pack

**Depends on** T2.6 (compiler) and T1.3 (PHQ coding decoupling).

**What.** A new workflow, `between-visit`, authored as **pack data**, not code. A patient sends a
short structured update between visits.

### Content

Add the workflow to `adult-intake.pack.json` as a new `workflows[]` entry. Per T2.6 it is
generated from the TS sources until the JSON is canonical, so add it in `scenarios.ts` and
re-export.

```ts
'between-visit': {
  id: 'between-visit', workflowId: 'W08',
  patientSummary: 'Send a short update on how things are going between visits.',
  openingPromptId: 'S08',                     // new supplemental prompt, wordingStatus 'proposed-detail'
  contextRequirement: 'Most recent confirmed submission if available (T3.9); otherwise none required.',
  reusableTopicIds: ['Q08', 'Q11', 'Q15', 'Q16'], // medicines, a day of food, sleep, mood incl. PHQ-4 locked block
  additionalTopics: [topic('W08', 'S08', [
    f('overall', 'How things have been overall since the last visit', ['S08']),
    f('changes', 'Changes since the last visit, or none', ['W08.followup.1'], true),
    f('help', 'Anything the care team should help with before the next visit', ['W08.followup.2'], true),
  ])],
  owners: ['medical', 'nutrition'],
  completion: 'Each relevant owner reviews the update and records a next step. PHQ-4 is scored only when all four items are answered by buttons.',
  detailStatus: 'proposed-detail',
}
```

New prompts go in `supplementalPromptText` (`content.ts:949`), all with
`wordingStatus: 'proposed-detail'` and `origin: 'between-visit'`:

| id | text |
|---|---|
| `S08` | "How have things been going since your last visit?" |
| `W08.followup.1` | "Has anything changed since your last visit, such as medicines, eating, sleep or how you feel? If nothing has changed, you can say so." |
| `W08.followup.2` | "Is there anything you'd like your care team to help with before your next visit?" |

### Code touch points

T1.1 and T1.2 should leave only these:
- `scenarioIds` gains `'between-visit'`, appended last. Order matters for seeds.
- `scenarioTitles['between-visit'] = 'Between-visit check-in'`.
- The clinic-contract `ScenarioId` union gains it, and the T1.1 equality test enforces that.
- `infra/cloud/clinic-manifest.mjs` `SCENARIOS` and `infra/local/seed-clinic.mjs` gain it. The
  seed creates one more synthetic patient mapping. **This is a Medplum write, so do it only
  during the owner's re-qualification.**
- `native-questionnaire.ts` gains the W08 group. This **changes the digest**: bump
  `NATIVE_QUESTIONNAIRE_VERSION` (`native-5` → `native-6`), `clinic-manifest.mjs:68` and
  `questionnaire-response.test.ts:84`, and update the pinned digest in
  `native-questionnaire.test.ts:30` with a commit message stating the reason.
- Add `between-visit` to the per-scenario counts in `provisional-full-intake.test.ts:325`. The
  existing seven values must stay unchanged.

### Tests

- The guided walk from T1.4a is extended to `between-visit`.
- Adaptive: one free-text turn ("Sleep's been worse and I stopped the metformin") routes to Q15
  and Q08 and never answers MH01–04.
- Voice: spoken PHQ answers are not recorded (buttons-only).
- Staff queue shows the title, and the staff view shows the T1.2 workflow metadata.

**Acceptance:** all six commands are green, and a local mock browser walk-through is recorded in
the hub. Deploying is a separate owner step.

---

## T3.9 Prior-submission readback

**Depends on** T1.2. **Fixes** the `W02.followup.1` placeholder bug if T1.4a confirms it.

**Today**
- `config.patients[scenario].nativeContext` (`NativeRoutingContext`, `native-questionnaire.ts:63`)
  is static deployment config. The hosted config never sets it, so pre-visit always opens with
  `S01a` and post-visit with `S03a`.
- The prompt placeholders (`[verified date/time/timezone]`, `[dated prior update]`,
  `[demo author/role]`, `[date]`, `[previously reported item]`) are filled ad hoc in
  `conversation.ts:155-156`.

### Design (retrieve-then-interpret, D5)

1. New `packages/clinic-api/src/prior-context.ts`:

   ```ts
   export interface PriorContextSource { reference: string; version: string; recordedAt: string; kind: 'appointment' | 'plan' | 'prior-submission' }
   export async function loadPriorContext(client: MedplumClient, patient: string, scenario: ScenarioId): Promise<{ context: NativeRoutingContext; sources: PriorContextSource[] }>
   ```

   - **Appointment** (pre-visit): `GET Appointment?patient=<ref>&status=booked&date=ge<now>&_sort=date&_count=1`
     maps to `context.appointment = { reference, version: meta.versionId, startsAt: start, timezone: <from Appointment extension or 'Not recorded'>, priorUpdateAt: <recordedAt of latest prior submission or omit> }`.
   - **Plan** (post-visit): `GET DocumentReference?patient=<ref>&category=<plan category>&_sort=-date&_count=1`
     maps to `context.plan = { reference, version, author: author[0].display, recordedAt: date, text: <attachment text, ≤8000 chars> }`.
     If the attachment is not inline text, leave `plan` absent. Never summarise or invent.
   - **Prior submission**: `GET QuestionnaireResponse?subject=<ref>&questionnaire=<NATIVE canonical>&_sort=-authored&_count=1`
     gives the date and, for `W02.followup.1`, the **first patient-stated item** of the most
     recent Q02 / Q08 answer: an exact string, already patient-confirmed.
   - Each request is bounded: 5 s timeout and 1 attempt. On any failure, return
     `{ context: {}, sources: [] }`, so the workflow falls back to the missing-context prompt.
     Never throw into the turn.
2. Session creation in `handler.ts` (`POST /api/clinic/sessions`): call `loadPriorContext` once,
   then store it on the draft as `d.priorContext = { context, sources, loadedAt }`. This is frozen
   for the session, which is a deterministic replay.
3. `nativeContext(d)` (`conversation.ts:37`) merges `config.patients[...].nativeContext`, which
   still wins and is used by tests and fixtures, over `d.priorContext.context`.
4. **Placeholder filling** moves to a pure function in `packages/clinic-content/src/prompt-fill.ts`:

   ```ts
   export function fillPrompt(text: string, context: NativeRoutingContext, prior?: { item?: string; date?: string }): { text: string; complete: boolean }
   ```

   - If any `[…]` placeholder remains, `complete: false`. The caller then uses the workflow's
     `contextPrompts.missingPromptId`.
   - `W02.followup.1` has no missing variant, and the existing W02 scoped-question catalog has
     no `changes` question. Without a verified prior item/date and the existing appointment
     gate, preserve D-m: leave `changes` not asked with empty evidence and a partial handoff.
     Do not invent fallback wording or reuse the appointment opening to credit this detail.
   - **A bracket never reaches the patient.** Add the invariant test "no patient-visible prompt
     contains `[`" to the T1.4a walk.
5. Staff visibility: `StaffHandoffView` gains
   `contextSources?: { kind; reference; recordedAt }[]`, rendered in the T1.2 "About this
   workflow" block as "Context used: Appointment/123 (recorded 2026-10-01)".

### Tests

- `prior-context.test.ts`, using a fake `MedplumClient` (follow the existing medplum fakes; grep
  `class Fake` or `fetch:` in `packages/clinic-api/test`):
  - each resource present or absent;
  - a timeout returns empty;
  - a malformed resource returns empty;
  - plan text over 8000 characters is truncated with an explicit "(truncated)" marker in staff
    view only.
- `prompt-fill.test.ts`: every prompt containing `[` in `promptText` and `supplementalPromptText`
  is either fully filled given a full context, or reports `complete: false`.
- The T1.4a walk passes with and without context, and the `it.fails` from T1.4a flips to `it`.

### Medplum permissions

The runtime AccessPolicy must allow reading `Appointment`, `DocumentReference` and
`QuestionnaireResponse` for the patient compartment. Check the current policy in
`infra/cloud/clinic-manifest.mjs` (`clinicalRules`). If a new read is needed, it is a policy
change, applied during the owner's re-qualification. **Do not apply it with admin yourself.**

### Local implementation boundaries and owner proposal

The runtime readback is limited to native pre-visit and post-visit sessions. The first new
session loads it once; save, resume, handler restart and patient turns use the frozen result,
including an empty result after a failure. Static deployment `nativeContext` still wins for
each explicitly supplied field. Historical patient values never become current answers or
new-session source turns. This runtime/schema extension leaves the authored native definition,
version, digest and counts unchanged. Deployment and any permission changes still await the
owner's bundled re-qualification.

The QuestionnaireResponse search adds `status=completed,stopped` to select confirmed captures.
Readback accepts the current native canonical/version/digest and app-generated source binding
only. It performs one additional, bounded read of the response's immutable source
DocumentReference to verify patient, resource identity/version/date, matching handoff component
and confirmation digest, and exact patient-source text. Only a known Q02 concern or known Q08
medicine name with confirmed patient provenance is a prior item. Assistant text, model
summaries, unreviewed speech, unreviewed collection ancestry and PHQ items cannot supply it.
The first eligible Q02 concern precedes medicine names in authored order. Unsupported or
malformed resources, transport errors and authorization failures discard the entire lookup;
absent resources stay absent. Each GET uses the real transport abort timeout of at most five
seconds with no retry. It does not leave an uncancelled background request after a timeout.

The existing native response decoder re-evaluates source scope, routing, active values,
completeness and the canonical response tree before any quote is selected. Source-channel and
timestamp checks also reject raw known ancestors or mismatched source-time values. Captures
with `reviewBinding` are conservatively unavailable: their prior qualification authority is
not reconstructed from stored audit text. Ordinary guided/text-confirmed captures have no
such binding and are covered through the real answer/review/confirmation/FHIR compiler flow.
Support for prior qualified provisional representations needs a separate authority-bearing
design before enabling that readback.

An appointment is a booked future appointment with exactly the requested patient participant.
Its timezone comes from `http://hl7.org/fhir/StructureDefinition/timezone` (`valueCode`); an
absent extension is explicitly `Not recorded`. Its audit date is `meta.lastUpdated`. Without
a dated confirmed prior submission, `priorUpdateAt` is absent and the existing S01 gate stays
inactive. The appointment itself remains available as consulted context.

Plan lookup uses the deliberately narrow synthetic category
`urn:corvo:clinical:document-kind|follow-up-plan`. A plan must be current/final, have the requested
patient, a valid resource version/date and a displayed author, and contain a single inline
`text/plain` UTF-8 attachment. No external attachment URL, Binary fetch or content summary is
used. Text is capped at 8000 UTF-16 code units without splitting a surrogate pair. The
`(truncated)` marker appears only in the staff audit, never inside plan text or patient prompts.
Missing inline text leaves plan context absent. This category and timezone convention must
be confirmed against owner-authored synthetic fixtures before deployment.

Staff context sources are derived from the context bound into the confirmed capture. They are
shown only on an authorized clinical handoff with verified source/response anchors, after the
named staff client reads each immutable context version in the same patient compartment.
Inaccessible sources are omitted; administrative and unrelated staff receive no context audit.
Prior-submission audit additionally requires named access to its immutable source document.

**Owner proposal, not an active policy edit:** `clinic-manifest.mjs` currently omits Appointment
from both runtime resources and named clinical read rules. Add only patient-scoped
`Appointment` read/search/vread/history permission for the configured synthetic patients,
without create/update/delete or administrative access, during re-qualification. Existing
DocumentReference/QuestionnaireResponse compartment reads and immutable source-document reads
must be verified, including cross-patient denials. Do not append Appointment to `RUNTIME_TYPES`
as-is, because that helper would also grant writes. No AccessPolicy, seed, membership, admin
grant, qualification or hosted deployment is changed by the local implementation.

---

## T3.10 Clinic-initiated link

**Depends on** nothing hard; T3.9 is recommended so the patient sees context.

**What.** A staff member chooses a patient and workflow and clicks "Send check-in link". The
patient receives an email with a signed, expiring link that opens the clinic directly into that
workflow.

### Pattern to reuse

The research invitation capability token, `convex/invitations.ts:12-35`:
- 32 random bytes in hex;
- only the SHA-256 hash is stored;
- the plaintext is returned once;
- an idempotent `requestId` replay returns the receipt without the token.

### Design

- Store invitations as a Medplum `Task`, so there is no new storage and no new cost (D2):
  - `code = urn:corvo:clinical:work-kind|invitation`, `for = Patient`, `owner = CareTeam`;
  - `input` = `{ scenario, tokenHash, expiresAt }`;
  - `identifier = requestId`, with a conditional create on identifier for idempotency.
  - If the AccessPolicy forbids staff Task creation with this code, that is a policy change at
    re-qualification time.
- `POST /api/clinic/staff/invitations` with body `{ patient, scenario, requestId }`:
  - staff session plus Origin check, as for existing staff mutations;
  - role check: administrative or clinical, for an assigned patient only;
  - returns `{ invitationId, expiresAt, link }`, where `link` is present only on first insert;
  - expiry is 72 h.
- `GET /join#token=…` (the token is in the fragment, as in research, so it never reaches server
  logs):
  - the browser POSTs the token to `/api/clinic/invitations/redeem`;
  - the server hashes it, finds the Task, checks expiry and unused state, marks it used, and sets
    the patient session cookie bound to `{patient, scenario}`;
  - it then redirects into the workflow with `syntheticAcknowledged` still required on screen.
- Email via **Resend** (free tier, 3,000/month):
  - `packages/clinic-api/src/email.ts` with
    `sendInvitationEmail({ to, link, workflowTitle }): Promise<'sent' | 'failed'>`;
  - `fetch('https://api.resend.com/emails')`, 5 s timeout, **no retry**, because the outcome is
    uncertain (hub rule 5);
  - the API key comes from config (`RESEND_API_KEY`, server-only, never logged).
  - In the synthetic demo, `to` must match an allow-list in config. Default: empty, so the link
    is shown to staff only for copying.
  - The email body is plain, carries no clinical content and states that the demo is synthetic.
- StaffApp: on the patient row, a "Send check-in link" button opens a select of workflows, then
  shows the copyable link and the email status.

### Tests

- `invitations.test.ts`:
  - issue, redeem, then a second redeem is rejected;
  - an expired token is rejected;
  - a wrong patient's staff gets 403;
  - a `requestId` replay returns no token;
  - the token never appears in any logged object (spy on the logger).
- `email.test.ts`, with fetch mocked:
  - an allow-list miss means no fetch;
  - a timeout returns `'failed'` and makes no second call.
- `apps/clinic/test`: the join page reads the fragment and clears it from history
  (`history.replaceState`).

### Owner steps (record in the hub when reached)

- Create a Resend account/API key, or decide to ship copy-link only.
- Approve the AccessPolicy change for invitation Tasks at re-qualification.
