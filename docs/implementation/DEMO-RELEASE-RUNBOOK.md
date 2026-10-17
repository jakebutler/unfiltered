# Clinic demo release runbook

Target: `corvo-clinic-demo`, team `team_X86tAWYJjWM7n1BfDMTTLIat`, project `prj_8xxSBfpP2dhTpGxerHC34F5AaHfy`, canonical origin `https://corvo-clinic-demo.vercel.app`. Deploy the generated clinic package, not the repository's Next.js app or the research project. Verify these identifiers again at release time.

## Secret rotation: exact scope

The outstanding D-h item is the **Medplum runtime ClientApplication secret**, client `50db76bd-d099-4305-8ec3-7439ffc38ca1` in Medplum project `13eaac67-a2c3-4aa1-aa9e-590a083e5fef`.

1. In the Medplum project's administrative interface, rotate that ClientApplication's secret. This requires an account authorized to manage the client; the normal runtime account deliberately cannot administer itself.
2. Update the owner-local private credentials and the `clientSecret` in the relevant private clinic configuration under `infra/cloud/.private/`. If using the cloud workspace, update its `MEDPLUM_CLIENT_SECRET` binding through environment configuration. Do not paste it into chat or commit it.
3. In Vercel → **corvo-clinic-demo → Settings → Environment Variables**, replace the server-only **`CLINIC_CONFIG_JSON`** with the full newly qualified configuration containing the new `clientSecret`. Preserve other fields; do not replace it with the secret alone or with an offline fixture. Use the production target and any intentionally supported preview target.
4. Qualify and redeploy as a coordinated operation. Existing deployments retain their old environment, so changing a variable alone does not update running functions. Rotation can interrupt the old deployment; retain a maintenance/recovery plan and do not assume rolling back code restores a revoked secret.
5. Verify new client authentication and least privilege, and confirm the old credential is no longer accepted without logging either value.

No evidence in the handoff requires blanket rotation of DigitalOcean, Deepgram, ElevenLabs or Vercel tokens. Rotate other credentials if separately compromised or required by their owner. The deployment cookie secret is a different value: changing it invalidates staff sessions and the signed qualification. It is not part of the documented outstanding rotation.

## Access and private inputs

The latest October 17 session fetched remote `codex/unfiltered-foundation` at `213ebfe`.
Current/observed environment revision 2 is running with observations current; policy and
variable readiness still report unknown. Both the status report and startup policy now list
**`inference.do-ai.run` correctly**. Actual proxied model-list requests returned 401 without
a credential and **200 with the configured credential** (83 models); the earlier CONNECT
403 blocker is resolved. No inference was generated and no account credit balance was established.
Deepgram project metadata and optional ElevenLabs subscription metadata each returned 200;
these are authenticated metadata checks, not real voice validation.

The exact Vercel project/team API returned 200 and still identifies the older READY production
`dpl_ECQpBeUZSvXipBuRErgyL1BMCMYR`. Medplum OAuth and `/auth/me` returned 200 as the pinned
runtime client with `admin:false`; own ProjectMembership read and AccessPolicy search returned
403. Server metadata remains `5.2.5-656286c`. The effective runtime policy has no wildcard or
administrative resource rule and still has **no Appointment rule**. A bounded Patient ID/metadata
search returned 200; an Appointment search scoped to that native patient returned **403**.
An authorized administrator must provision and verify only the required patient-scoped read
permission before qualification.
These negative controls do not establish complete role isolation.

The private config, named staff users and frozen q4f runtime remain absent at the documented
paths, with no matching supplied files found in the workspace shared/library locations.
The qualifier reads `clinic-users.json` **beside the selected config**; securely restore the
actual files in that layout. No administrative account was supplied for coordinated rotation
and calibration. Do not generate replacement identities, cookie secrets, budget state or
historical artifacts. Existing public-page checks concern the old release only.
See [latest preflight](HANDOFF-CURRENT-WORK.md#october-17-corrected-hostname-preflight-from-213ebfe).

Required destination access: `api.vercel.com`, the canonical clinic origin and intended deployment URL, `api.medplum.com`, `inference.do-ai.run`, and `api.deepgram.com` for live voice. `api.elevenlabs.io` is only needed if optional ElevenLabs output is tested. Use the supported environment configuration workflow; do not bypass the proxy.

The workspace also needs the actual owner-held private clinic configuration and named synthetic staff credentials. Provider environment variables alone do not supply patient bindings, staff policies or a signed qualification. The frozen q4f continuation runtime is an additional private artifact; do not fabricate it or reconstruct its historical receipts. See [CLOUD-CLINIC.md](CLOUD-CLINIC.md) for its exact path and the distinction between current-source seals and historical continuation evidence.

## Qualification and policy prerequisites

The existing recorded qualification expires **October 20, 2026 at 6:48:12 PM America/Los_Angeles** (`2026-10-21T01:48:12Z`). It has not been renewed merely by building or testing this branch.

Follow the D-h checklist in [CLOUD-CLINIC.md](CLOUD-CLINIC.md): one-time project-feature calibration with the authorized owner, verified return to the non-admin runtime policy, no wildcard/AccessPolicy read grant, private continuation checks, then fresh qualification as the demoted runtime client. Do not independently grant admin or change the shared research allowances.

For the newly implemented reach features, verify narrowly scoped invitation Task creation/read/consume permissions; patient-scoped read-only Appointment access; immutable source reads; and cross-patient denials. Do not add Appointment to a broad helper that also grants writes.

Keep email disabled: omit the Resend configuration from this release. Copy-link delivery is the agreed mode.

The new W08 pack remains excluded. Proposed crisis-phrase changes remain review material until their wording and questionnaire digest changes are explicitly included in the qualification bundle. Never silently change the protected native questionnaire pin.

## Local release gates

Use Node 22 and install both locked dependency sets as described in the handoff. A fresh checkout also needs the original `historical-fixtures-v1` GitHub release archive. Verify its published checksum, validate safe relative regular-file paths and existing-content conflicts, then restore only missing files and verify all 109 manifest size/SHA-256 pins. Leave these historical evidence/private/staged modules uncommitted. The earlier October 17 session reproduced the 2,266-test result after this restoration. The latest session restored the same pins but encountered real-clock test failures; its current results and preserved failures are in the handoff. Missing fixtures must not be replaced with generated evidence. This archive does **not** provide the frozen q4f runtime or current private clinic/staff inputs.

Run sequentially and retain failure logs:

```sh
npm run foundation:build
npx vitest run -c vitest.foundation.config.mts
npx vitest run -c apps/clinic/vitest.config.mts
npx vitest run -c vitest.hosting.config.mts
npx tsc -p tsconfig.foundation.json --noEmit
npx tsc -p tsconfig.clinic.json --noEmit
npm run hosting:typecheck
```

The latest session passed all 2,266 foundation tests using the same suite with
`--maxWorkers=1` after the default run and a two-file diagnostic hit real-clock timing
failures. Preserve those failure logs; the passing serial run does not establish hosted
latency. Use the documented Node 22 version and keep assertions/deadlines unchanged.

Run the real browser suite in [DEMO-ACCEPTANCE.md](DEMO-ACCEPTANCE.md), then build into a **new** ignored output directory:

```sh
node infra/cloud/vercel/package-clinic.mjs --output infra/cloud/.private/clinic-demo-RELEASE-ID
node scripts/qualification/qualify-clinic-package.mjs infra/cloud/.private/clinic-demo-RELEASE-ID
```

The package smoke uses synthetic server configuration and denies outbound fetch. Its receipt is local packaging evidence, not a signed Medplum qualification or a deploy authorization substitute.

## Deploy and validate

1. Verify the branch commit and package manifest. Ensure all required checks pass and the real configuration has a current qualification.
2. Check the exact Vercel team/project and current production environment. Preserve the existing provider budget policy; a new policy ID is not permission to reset usage.
3. Deploy the generated package using the existing project's production settings. Prefer staging production without domain assignment so the exact build can be checked before promotion. Canonical-origin checks mean a preview URL must not be treated as interchangeable with the configured origin; use the approved deployment/protection mechanism rather than weakening host checks.
4. Verify runtime startup, static assets, authentication, then the full hosted acceptance checklist. Validate native storage and role denials, not just screenshots.
5. Promote only the qualified and verified build. Record deployment URL/id, source commit, package digest, qualification expiry, actual test evidence and any excluded features in the handoff.
6. After promotion, repeat invitation → identity → patient answers → review → send → assigned staff review on the canonical URL, including mobile and real microphone. Scan runtime errors and measure cold/warm turn latency.

If access, credentials, calibration, qualification or live acceptance is blocked, record the specific missing prerequisite and keep the deployment status **not deployed**. Never label the static frontend, mocked backend or an older hosted release as the newly verified release.
