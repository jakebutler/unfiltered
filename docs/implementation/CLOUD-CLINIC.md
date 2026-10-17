# Corvo Clinic cloud deployment boundary

Status updated 2026-10-17: hosted stage8 at
[corvo-clinic-demo.vercel.app](https://corvo-clinic-demo.vercel.app) uses native-5 and
hands-free Deepgram voice (historical receipt: `cb0bfe8`, October 14). Its schema-2
qualification expires **2026-10-21T01:48:12Z**. D-f `07da259` passed independent review and
all six local hub gates on Node 22.23.3; schema-3 renewal is implemented, but owner
calibration and live re-qualification have not run in this continuation. The new session's
runtime OAuth and `/auth/me` work as the expected non-admin client. Own membership read
and AccessPolicy search return 403; server metadata reports `5.2.5-656286c`. Vercel and
canonical public pages are reachable. The corrected `inference.do-ai.run` allowlist now
passes authenticated model-list access (200, 83 models); Deepgram and optional ElevenLabs
metadata authentication also pass. These are metadata checks only. The effective runtime
policy has no Appointment rule; a native patient-scoped Appointment search returned 403.
Required read permission must be provisioned by an authorized administrator and verified before
release. Private config, named staff credentials and the frozen q4f runtime remain absent.
No live inference/audio call, Medplum FHIR write, elevation, policy change, secret rotation,
qualification renewal or deployment was performed by this continuation.
See [current task status](HANDOFF-CURRENT-WORK.md) and
[dated deployment receipts](OPUS-HANDOFF.md#historical-deployment-receipts).
This is a synthetic demonstration, not a clinical production deployment.

The October 10 [local evidence](evidence/CLOUD-CLINIC-LOCAL.json) and bootstrap procedures
below are historical context. The existing hosted project has already been bootstrapped;
routine renewal after the one-time D-h calibration does not require re-seeding or another
setup elevation. Owner-private configuration
and named staff credentials remain owner-local; commands below are operator instructions, not evidence
that those commands have been executed in this continuation.

## Exact Medplum target and bootstrap operation

The only cloud target is `https://api.medplum.com/`, project **Corvo Clinic** `13eaac67-a2c3-4aa1-aa9e-590a083e5fef`. Reuse the existing Default Client `50db76bd-d099-4305-8ec3-7439ffc38ca1`, membership `6e565de2-837d-4618-9578-f6428fbb0be1`. Both seed and qualifier pin these identities before FHIR writes; the seed rejects a different client before OAuth. The explicit local qualification override accepts only the loopback test stack. Jake authorized replacement of disposable project data. The package performs **no deletion**: adding explicitly identified synthetic fixtures is sufficient for initial qualification. A later cleanup needs a complete project-scoped enumeration; the current bounded inventory is not a deletion manifest.

The selected manifest contract is `conditional-resumable-v1`, with
`projectFeaturesRequired: []` and
`projectChange.operation: 'no-feature-change-required-for-selected-conditional-contract'`.
It does not require `transaction-bundles` enablement or a server Super Admin request.
Earlier atomic-transaction prerequisite notes are obsolete for this selected contract;
conditional-write acknowledgement, reconciliation and persisted-output checks remain mandatory.

Initial setup alone needs the existing client's narrowly scoped temporary project-admin
promotion so the seed can create explicit AccessPolicies and synthetic staff memberships.
Re-read its effective policy after promotion: an admin flag does not bypass a custom
AccessPolicy. If that policy denies setup operations, it must explicitly permit the
reviewed setup scope. Never grant server-wide administration. This is bootstrap context,
not an instruction to re-seed or elevate the current deployment for routine renewal.

The executable seed creates the runtime policy first, then two synthetic patients, three CareTeams, three staff access policies, and four named staff memberships. It passes `sendEmail:false` and `scope:'project'` explicitly. It generates independent private staff passwords and one deployment cookie secret. It leaves all existing records alone. Full patient intake is readable by both the assigned physician and RD. Responsibility ownership remains separate: medical, nutrition, and administrative work have their own care teams.

| Identity | Native data access | Work responsibility |
| --- | --- | --- |
| Dr. Morgan Lee, physician | Full assigned patient intake, source documents and clinical tasks; no unrelated patient | Medical |
| Sam Patel, RD | Same full assigned clinical visibility | Nutrition |
| Taylor Brooks, administrative | Only sanitized administrative Tasks; no patient chart, clinical questionnaire, source or Binary | Administrative |
| Dr. Quinn Parker, unrelated clinician | Only the unrelated test patient; negative control for Alex's records | None for Alex |
| Existing client after setup | Patient, CareTeam, QuestionnaireResponse, DocumentReference, Binary, Task and Provenance create/read/search/update/history/vread; no delete or policy/member/client administration | Narrow application persistence |

The finalizer updates the membership through the supported project admin endpoint to `admin:false` and the runtime AccessPolicy, confirms the effective policy, verifies the old token receives 403 when reading its own ProjectMembership, then revokes that bootstrap OAuth session. The client secret stays private and is reused. On a setup exception the finalizer still attempts demotion. If the network prevents confirmation, the journal explicitly records `cleanup-required` with the exact member endpoint; do not treat that as a completed rollback. [Medplum user management](https://www.medplum.com/docs/auth/user-management-guide), [Access Policies](https://www.medplum.com/docs/access/access-policies).

The cleanup endpoint is persisted as soon as the authenticated target membership is known. If its subsequent native membership read is unavailable, setup records `cleanup-required` and stops without guessing an administrative update body.

Each write has a private durable intent before dispatch, a content fingerprint, and native ID/version readback. Conditional fixture identifiers and exact policy names allow reconciliation. An unresolved invite or update is never blindly replayed. A completed seed invocation is a zero-network no-op on repeat. The lock prevents concurrent seed processes. A process killed before its `finally` block leaves a lock and journal; inspect both and restore the temporary member privilege with the project administrator before retrying. Never delete a lock merely because a command timed out.

## Initial bootstrap commands (historical; not routine renewal)

Use Node 22. Commands run from the implementation checkout. The credentials file must be private and contain `MEDPLUM_CLIENT_ID` and `MEDPLUM_CLIENT_SECRET`; these are never printed. For a new initial bootstrap, substitute the intended HTTPS clinic origin before seeding. The existing hosted origin is `https://corvo-clinic-demo.vercel.app`; do not re-seed it merely to renew qualification.

```bash
node infra/cloud/medplum-preflight.mjs plan --output infra/cloud/.private/seed-plan.json
node infra/cloud/medplum-preflight.mjs inventory --credentials /Volumes/rexy/GitHub/unfiltered/.env.local --output infra/cloud/.private/inventory-next.json --allow-cloud-read
node infra/cloud/seed-clinic.mjs --credentials /Volumes/rexy/GitHub/unfiltered/.env.local --origin https://CHOSEN-CLINIC-ORIGIN --private-directory infra/cloud/.private/corvo-clinic --allow-synthetic-project-writes
node_modules/.bin/vite-node scripts/qualification/qualify-clinic-deployment.ts --config infra/cloud/.private/corvo-clinic/clinic-config.json --output infra/cloud/.private/corvo-clinic/clinic-config.qualified.json --allow-synthetic-qualification-writes
```

The seed emits `clinic-config.json`, `clinic-users.json`, a re-seed Project feature record and intent journal only inside a mode-0700 ignored directory, with mode-0600 files. The qualifier no longer reads that admin record: it observes the Project projection through the demoted runtime client's own `/auth/me` before any write and again when sealing (see below), so qualification no longer needs to run within 15 minutes of an admin elevation. Existing output paths are never overwritten by qualification. A failed qualification retains its evidence and native fixture identifiers; inspect the receipt before another explicit run. Provider calls, emails, deletion and hosting changes are absent from these commands.

The selected qualification executes conditional create/concurrency, version conflict/history, lost acknowledgement recovery, partial and zero-task resume, source verification, and conflicting-payload checks; it requires a received handoff. It does not claim atomic rollback. It then tests the four named roles against actual Patient, QuestionnaireResponse, source DocumentReference, security-context Binary and Task resources; the administrative logistics positive control; unrelated-patient/source denials; runtime administrative denials; cross-instance staff authentication; native logout; and refresh/restart without FHIR writes. Only after all checks pass is a qualified configuration written. The existing direct FHIR and application security tests remain required for a hosted release; these required native checks are a bounded deployment gate, not an exhaustive authorization audit.

Before authentication or writes, the qualifier requires the exact four synthetic staff fixtures with distinct native identities and their correct primary/unrelated patient assignments, plus a Medplum server (≥ 5.1.4) whose `/auth/me` projects Project features. Each logout check requires native `auth/me` to return HTTP 401 and a bounded JSON FHIR `OperationOutcome` with error/fatal code `login`. Network failures, timeouts, 403/5xx responses and other response bodies remain inconclusive and fail qualification.

Auxiliary Tasks and DocumentReferences have stable conditional identifiers, durable intents, native ID/version acknowledgement and content readback receipts. Binary intents retain a unique content marker/digest and the qualified source DocumentReference security context; acknowledged IDs are recorded before readback. An unknown Binary acknowledgement cannot be reconciled through identifier search: retain its evidence for native operator inspection and do not replay. Failed or interrupted runs never automatically resubmit those writes. The corrected gate passed all 39 checks locally, with three confirmed auxiliary receipts and zero refresh FHIR writes; [independent review](evidence/CLOUD-INDEPENDENT-REVIEW.md) covers 23 adversarial regressions. The earlier native receipt remains historical and is superseded for logout proof.

## Qualification without request-time writes

The previous runtime executed the full synthetic write suite whenever its OAuth token cache expired or a process started. `runtimeProvider` now accepts a **signed deployment attestation** in server-only configuration. Both local and live runtime modes require it. A missing `storageQualification` fails closed with `storage-deployment-qualification-required` before OAuth; neither mode automatically runs the synthetic write suite.

The attestation binds the exact FHIR endpoint, local/live mode, project, client, membership, effective authorization policy digest, Medplum software version, clinic origin, original qualification report digest, all required conditional storage checks, the runtime-observed `/auth/me` Project projection (schema 3), original qualification time and expiry. HMAC integrity uses a domain-separated deployment cookie secret. It is configuration supplied by the deployment operator, never request input. Its maximum validity is seven days for this synthetic demo. Rotation of the cookie secret invalidates both staff sessions and this attestation.

Cold start or token refresh obtains a token, reads authenticated `/auth/me` and FHIR `metadata`, and compares identity, effective policy, server version and (schema 3) the Project projection digest with the sealed evidence. Resolved AccessPolicy transient `id`/`meta` fields are excluded from the policy digest; all authorization-bearing fields, including `basedOn`, remain. Missing, altered, expired or mismatched proof fails closed. Refresh occurs at most five minutes apart and before token/proof expiry. The resulting in-memory qualification binds the **current access token fingerprint**, so `MedplumClient.deliver()` retains its existing token gate and per-handoff persisted-output reconciliation.

**Project feature observation (attestation schema 3).** Since Medplum server 5.1.4 ([medplum PR #8713](https://github.com/medplum/medplum/pull/8713)), `/auth/me` returns `project.{id,name,features,description,strictMode,superAdmin}` to any authenticated member, so the least-privileged runtime client can observe Project feature flags itself. At seal time the qualifier builds `projectFeature = {source:'auth-me', projectId, features, projectionDigest, projectVersion, observedAt}` inline from the runtime client's `/auth/me`: `features` are sorted; absent or null `features` means `[]` only when the sealed server version is ≥ 5.1.4 (any older or unparseable version fails closed); `projectionDigest` is SHA-256 of canonical JSON `{id, name, features, strictMode?, checkReferencesOnWrite?}`, retaining optional fields only when present (`name` is also omitted if absent). `description` is excluded; `superAdmin:true` is rejected independently. `projectVersion` records `projection-sha256:<hex>` with that digest, replacing the historical `Project.meta.versionId`: the full native resource version is no longer observed or claimed. The inline observation must be within 15 minutes of the original qualification proof; this seal-time freshness check does not shorten the proof's seven-day validity. The same digest is sealed into `identity.projectionDigest`, re-observed on every cold start/refresh, and any difference fails closed with `project-projection-drift` (`featureDriftContract: 'runtime-observed-auth-me-projection'`). A feature, `strictMode`, projected `checkReferencesOnWrite` or name change by an administrator therefore stops the runtime at its next refresh (at most five minutes) instead of relying on the operator to requalify. Schema 3 also refuses to seal or accept a runtime effective policy containing a `*`, `AccessPolicy`, `ProjectMembership`, `ClientApplication`, `Project`, `User`, `Login` or `Bot` rule. Every delivery still checks the actual persisted components and never reports a partial write as a received handoff. Runtime is never elevated to admin.

Schema-2 attestations (the earlier admin-observed `project-feature-observation.json`, with the `admin-change-requires-requalification-not-runtime-observed` contract) still verify unchanged until their own expiry, without a projection drift check, so deploying this code before re-qualification does not invalidate the currently deployed proof (its expiry is 2026-10-21T01:48:12Z). New seals are always schema 3. The continuation helpers under `scripts/qualification/continue-clinic-*.mjs` seal schema 3 through the current-source `.qualification-build` sealer, whose complete import closure is bundled and pinned (including every source dependency and the bundle bytes) in the reviewed preparation receipt, because the frozen q4f runtime only contains the schema-2 sealer.

**D-f local validation limits.** Projection/drift/freshness checks and complete sealing
source/bundle pins passed locally. The separate frozen continuation smoke is blocked because
both continuation test modules import the absent private q4f runtime file
`.factory/private/native-questionnaire-integration/runtime-2026-10-10-q4f/.qualification-build/packages/clinical-core/src/domain.js`.
It is outside the restored historical fixtures; it was not regenerated. Local bundle tests
are not a substitute for this owner-local continuation smoke or live renewal.

**D-h owner's one-time checklist before 2026-10-21T01:48:12Z:**

1. Rotate the runtime ClientApplication secret and update the Vercel environment and owner-local private credentials/configuration; never print it.
2. Temporarily grant the runtime membership project admin and run the one-time calibration, which reads both the admin `Project/{id}` and `/auth/me` and requires their features to match (it writes a private, secret-free record with `writePrivate`):
   `node infra/cloud/medplum-preflight.mjs observe-features --credentials <private-credentials> --output infra/cloud/.private/feature-calibration.json --allow-cloud-read --calibrate`
3. Demote the membership to `admin:false` with the runtime AccessPolicy and confirm `demotion-verified` (the seed's finalizer does this when it holds the elevation; otherwise do it through the project admin endpoint and confirm the token receives 403 on its own ProjectMembership).
4. Check that the runtime AccessPolicy has no `*` rule (and no AccessPolicy rule): since [medplum PR #10826](https://github.com/medplum/medplum/pull/10826) non-admins may read AccessPolicy when granted `AccessPolicy` or `*`. The qualifier's `runtime-access-policies-denied` check and the schema-3 policy guard enforce this too.
5. Restore/inspect the frozen private continuation runtime and complete its offline smoke
   before using the continuation helpers. Run the qualifier as the demoted runtime using
   the existing private configuration and a fresh output path. Preserve failed or uncertain
   receipts rather than replaying writes. Without `--calibrate`, `observe-features` is a
   read-only check usable by the demoted client at any time.
6. Review the qualification evidence, deploy the bundled ready changes with the qualified
   private configuration, and run the owner-only synthetic hosted smoke (including PHQ
   buttons and staff visibility). Do not change the questionnaire digest inside the current
   window; digest-changing D-k or pack work waits for this reviewed renewal bundle.
7. Record the actual new expiry here and in the hub only after qualification succeeds.
   Until then, **2026-10-21T01:48:12Z remains the current expiry**.

After the one-time calibration, subsequent renewals use the demoted runtime client (steps 5–7): run the deployment qualification, review the evidence, and replace the private qualified configuration. No admin elevation is needed unless the project itself must be re-seeded (`seed-clinic.mjs`, which still requires temporary admin). Server upgrades, runtime policy/client changes and clinic origin changes still require requalification, and a projection drift requires it before traffic resumes. A cached runtime is not a deployment proof.

## Portable staff sessions

Staff OAuth tokens now live only inside AES-256-GCM encrypted, authenticated HttpOnly cookies with `SameSite=Strict`, `/api` scope and `Secure` on HTTPS. HKDF separates this key from other cookie uses and binds it to clinic origin, Medplum origin and project. The cookie carries no role authority; every request derives the assignment from current server configuration and verifies live Medplum membership/policy. Cookies are bounded below browser size limits and expire within 30 minutes. Old process-local staff cookies require signing in again after rollout.

Different server instances can read the same opaque cookie. Native `/oauth2/logout` revokes the underlying token, so a copied cookie is denied by every instance's live membership check. An ambiguous logout returns `staff-logout-unconfirmed`; it does not claim token revocation. The normal patient capability cookie API and clinic provider interfaces are unchanged. [Medplum logout](https://www.medplum.com/docs/auth/logout).

## Hosting alternatives and remaining qualification (historical assessment)

**Original hosting assessment (before the stage8 deployment): prefer trying the existing Node adapter on Vercel for the personal synthetic hiring demo**, provided account eligibility/headroom are verified. Current official documentation says native WebSockets are in **beta on all plans**, supports `ws` with an exported `http.Server`, and requires Fluid compute. A connection stays on one instance, while reconnects may reach a different instance. This allows reuse of the tested Node speech transport, but beta availability is not a stability guarantee. Connections end at the function's maximum duration. [Vercel WebSockets](https://vercel.com/docs/functions/websockets).

Hobby's 300-second function limit exceeds this application's bounded 60-second capture socket. Its listed allowances are 4 CPU-hours, 360 GB-hours memory and one million invocations, with active WebSocket usage counting as Function usage. The plan is restricted to personal noncommercial use: a synthetic personal hiring demonstration may fit, while actual Corvo client service needs a suitable later plan. Existing account usage, eligibility and headroom remain unverified. No specific WebSocket concurrency allowance was established from the documentation. Keep application admission conservative: one active clinic speech session during qualification, and retain the durable per-session/account provider leases across instances. Do not rely on a process-local socket map or rate limiter as an account-wide cap. [Hobby plan](https://vercel.com/docs/plans/hobby), [Function duration](https://vercel.com/docs/functions/configuring-functions/duration).

Cloudflare is still a candidate: it supports inbound/outbound WebSockets and unbounded HTTP wall time while connected, but Workers Free has 10 ms CPU, 50 subrequests per invocation and 128 MB memory. Network wait does not consume CPU. The application needs a separate Worker speech adapter and measured worst-case CPU/subrequest results before claiming free fit; the Node `ws` transport is not already a Worker implementation. Keep portable domain/state code and Medplum authority independent of either host. [Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/), [WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/).

Medplum Free is intended for low-volume tests/prototypes, with Access Policies designated testing-only, no Bots/email and no BAA. Our HTTP polling and app-owned speech sockets do not require paid Medplum WebSocket subscriptions. Cloud project capability, policy and usage behavior must still pass actual qualification; local results are not cloud acceptance. [Medplum pricing](https://www.medplum.com/pricing).

The [hosting package](HOSTING-CLINIC.md) originally deferred local build/tests during host resource recovery; current hub gates supersede that historical local status. The stage8 receipt establishes the limited hosted checks listed above. Remaining broader release checks include: generated bundle, deploy-time secret delivery, shared admission/abuse limits under multiple instances, real hosted microphone/streaming behavior, cold-start latency, all seven hosted patient-to-staff workflows, and the independently deployable second clinic/AWS package. No hosting or HIPAA-readiness claim follows from this package alone.
