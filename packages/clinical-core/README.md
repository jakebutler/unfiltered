# Clinical boundary foundation (S0)

This is a small TypeScript library and qualification CLI. It is not a patient-facing app, an authenticated API, an EHR authorization qualification, or an approved clinical content register. It does not change the existing UI, D1 schema, deployments, or provider accounts.

One native `fetch` transport is used by the Medplum and DigitalOcean adapters. The core imports no Node or Cloudflare runtime modules; Node-specific environment access is confined to the CLI. The same library can be bundled into Worker and Node entrypoints. Actual Worker runtime/CPU qualification remains pending.

## Run

Use Node 22.22.3 or newer and the repository's locked dependencies:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run foundation:typecheck
npm run foundation:test
npm run qualify -- status
npm run qualify -- mock
npm run qualify -- mock --non-atomic
```

`status` makes no network calls. Missing or partial configuration is explicit. `mock` is an in-memory test double with a `mock` mode, `mock-pass`/`mock-received` outcomes, and no live qualification capability. `--non-atomic` demonstrates why a transaction-shaped request is not proof of rollback. No command in this CLI calls inference.

For a disposable, synthetic local Medplum project, inject these variables through the shell or an ignored environment loader. Never put a token into committed files, shell command arguments, transcripts, or logs:

| Variable | Value |
| --- | --- |
| `QUALIFICATION_MEDPLUM_URL` | Complete FHIR base, such as `http://127.0.0.1:8103/fhir/R4/` |
| `QUALIFICATION_MEDPLUM_MODE` | `local` for a loopback server; `live` for a remote HTTPS server |
| `QUALIFICATION_MEDPLUM_TOKEN` | Runtime access token for the selected synthetic project |

```sh
npm run qualify -- medplum --allow-synthetic-writes
```

This command writes fictional Patient/CareTeam fixtures, technical source/response/task/manifest resources, and control Patients. It retains them for inspection and reports stable identifiers. It performs no cleanup, account creation, permission changes, transaction feature activation, or provider operation. A remote run additionally requires `--allow-live`; it is outside automatic local verification. Run only with authorization for the selected synthetic project. A local result is not a hosted-plan result.

The actual report distinguishes:

1. A batch control persists a valid resource while a sibling stale If-Match update fails with 412.
2. The equivalent transaction rejects the stale update and the valid sibling is absent on readback. Both observations plus a successful valid transaction are required for rollback evidence. An execution-level version conflict is deliberate: a local Medplum project accepted an invalid Task status/missing intent, so schema rejection is not assumed.
3. Repeating a conditional create returns one identity without overwriting the first payload.
4. A current `If-Match` update succeeds, a stale update receives 412, and readback preserves the winning update.
5. The handoff transaction succeeds but the harness deliberately discards its response. Identifier/content reconciliation must find every expected resource without another write.
6. Reusing the stable version identity with changed confirmed content is detected as a conflict.

The qualification is bound to the exact base URL, local/live mode, and a SHA-256 fingerprint of the tested credential. Rotation or changing credentials requires requalification; configuration or permission changes also require a rerun. This is trusted server configuration, not a capability accepted from an untrusted browser. The raw token is never reported. A bootstrap/admin credential can qualify write semantics but cannot qualify named-role authorization. `authorization: not-qualified` remains explicit in every report.

## Submitted data and receipt

`confirmSubmission` validates caller-supplied reviewed content and scope, then binds the exact preview digest. All applicable required questions must have the allowed answered/negative state plus trusted, source-linked sufficiency evidence for every configured detail target before a complete questionnaire can be confirmed. Actual values can be required for measurement questions such as height/weight; a negative does not satisfy a required value. The evaluator assessment is separate from patient input, bound to the exact submitted digest and content version, attributed, and retained in the manifest. It must come from the trusted content evaluator, never a browser assertion; unknown, declined, uncertain, conflicting, omitted and unasked are preserved. Partial submission is explicit. The content contract carries detail targets and explicit stop conditions for a future conversation consumer; no arbitrary numeric clinical clarification cap is used; this library does not run adaptive questioning or embed CC-0.1/CC-0.2 wording. The technical height/weight fixture is not clinical approval.

Patient statements, corrections, assistant statements, structured answers and explicit review actions are distinct. Answers must reference retained patient source turns for the same patient. Corrections retain originals and point backward. This validates association and structure, not the clinical truth of generated prose. Content support/clinical safety evaluation remains a later acceptance gate.

The proposed minimal FHIR profile uses:

- One bounded `DocumentReference` with inline JSON containing exact source turns, authorship, times and corrections.
- One patient-confirmed `QuestionnaireResponse`, preserving source-turn IDs and answer states in namespaced extensions.
- Separate clinical/administrative `Task` resources with fixed patient, owner and response associations.
- A `DocumentReference` manifest listing expected component identifiers and the confirmation digest.

Every component has a stable conditional identifier (`submissionId.vN.component`) and the confirmed digest. Transaction URNs are deterministic; receipt readback verifies the resolved references, full expected content, same-patient relationships and digest. Server-added root metadata is allowed, and Task workflow status can change without invalidating historic receipt. A Task becoming completed never proves a named review or external booking/payment/prescription. Callers must persist the returned transaction result/delivery attempt through the eventual narrow API; this library owns no secondary database.

A source's optional recording time-range structure can be validated in the domain, but recording-backed handoff persistence currently fails with `recording-evidence-not-qualified`. This S0 profile qualifies inline transcript evidence only; it cannot claim an unread/externally stored recording is available. FHIR Provenance resource mapping, external attachment resolution, source retention, and raw audio policy remain to qualify. These are deliberately not fabricated by the fixture.

`deliver` is available only after observed native atomicity, conditional identity, and version conflict checks. It always reconciles before a write, then verifies readable persisted components afterward. `received` requires all expected resources; missing/unknown/conflicting state blocks blind replay and staff-ready claims. No staged fallback is implemented. If native atomicity is unavailable, qualification stops with evidence so a bounded fallback can be selected and reviewed.

The library supports stable version/amendment identity and requires a prior same-submission version/digest for versions after 1. A future authenticated amendment handler must verify the actual prior receipt and expose reconfirmation before delivering that version. This foundation does not expose an amendment endpoint or claim an amendment workflow is qualified.

## Staff boundaries

The caller must resolve `StaffContext` from authenticated identity and server-maintained assignment, never client role labels. Each assigned clinical role (RD, NP, PA, physician) receives full intake and source context. Administrative projection contains only submission/version/patient and its assigned administrative work. It does not contain answers, transcripts, source URLs or clinical tasks. Work responsibility is separate from visibility: nutrition work can be dispositioned by the assigned RD, medical work by the assigned NP/PA/physician, and administrative work by assigned administrative staff. RD access to the full intake cannot resolve a medication/refill task. Administrative review cannot close clinical work. Review construction rechecks the exact confirmation digest and requires the matching received receipt; opening a view does not create review.

These are pure domain projections. Named Medplum staff OAuth, AccessPolicy enforcement, direct FHIR denials, invitation/cookie authorization, API routes, durable attributed review and a normal staff queue remain unqualified. A Task reference does not grant the recipient access to its target. Never expose the backend token or use these projection helpers as a substitute for server/FHIR authorization.

## DigitalOcean boundary

`digitalOcean` requires explicit endpoint, token, model, timeout and output bound. The only endpoint is `https://inference.do-ai.run`; the only allowed model IDs are `glm-5.3-flash` and `qwen3.8-max`. There is no fallback option, router, SDK default, redirect following or automatic retry. Responses must report the requested model and a completed output. Text and bounded inline image data are supported; arbitrary remote image URLs are rejected.

Request input, output tokens, response bytes and request time are bounded. Aggregate clinical payload size is checked before confirmation or persistence (500,000 UTF-8 bytes), and each encoded FHIR component must fit the bounded receipt reader (at most 1,000,000 bytes). Provider error bodies and credentials are not logged or exposed in errors. The caller still owns concurrency, usage reservations, credit verification and unknown-receipt accounting before any actual inference call. This library makes no affordability, latency, quality, or provider qualification claim.

Optional configuration status checks use `QUALIFICATION_DO_ENDPOINT`, `QUALIFICATION_DO_API_KEY`, and `QUALIFICATION_DO_MODEL`; the CLI will validate configuration without making a request.

Relevant upstream behavior: [Medplum transaction versus batch semantics](https://www.medplum.com/docs/migration/validation-and-reconciliation), [FHIR Bundle reference](https://www.medplum.com/docs/api/fhir/resources/bundle), [DigitalOcean serverless inference](https://docs.digitalocean.com/products/inference/how-to/use-serverless-inference/). Runtime behavior must be observed on the selected project, not assumed from those references.
