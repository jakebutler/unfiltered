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

The October 17 cloud instance had an enforced restricted network policy allowing package hosts and WorkOS, but not the clinic/Medplum/provider/Vercel endpoints. A direct request to the clinic returned proxy CONNECT 403. Environment credential readiness does not override that network policy.

Required destination access: `api.vercel.com`, the canonical clinic origin and intended deployment URL, `api.medplum.com`, `inference.do-ai.run`, and `api.deepgram.com` for live voice. `api.elevenlabs.io` is only needed if optional ElevenLabs output is tested. Use the supported environment configuration workflow; do not bypass the proxy.

The workspace also needs the actual owner-held private clinic configuration and named synthetic staff credentials. Provider environment variables alone do not supply patient bindings, staff policies or a signed qualification. The frozen q4f continuation runtime is an additional private artifact; do not fabricate it or reconstruct its historical receipts. See [CLOUD-CLINIC.md](CLOUD-CLINIC.md) for its exact path and the distinction between current-source seals and historical continuation evidence.

## Qualification and policy prerequisites

The existing recorded qualification expires **October 20, 2026 at 6:48:12 PM America/Los_Angeles** (`2026-10-21T01:48:12Z`). It has not been renewed merely by building or testing this branch.

Follow the D-h checklist in [CLOUD-CLINIC.md](CLOUD-CLINIC.md): one-time project-feature calibration with the authorized owner, verified return to the non-admin runtime policy, no wildcard/AccessPolicy read grant, private continuation checks, then fresh qualification as the demoted runtime client. Do not independently grant admin or change the shared research allowances.

For the newly implemented reach features, verify narrowly scoped invitation Task creation/read/consume permissions; patient-scoped read-only Appointment access; immutable source reads; and cross-patient denials. Do not add Appointment to a broad helper that also grants writes.

Keep email disabled: omit the Resend configuration from this release. Copy-link delivery is the agreed mode.

The new W08 pack remains excluded. Proposed crisis-phrase changes remain review material until their wording and questionnaire digest changes are explicitly included in the qualification bundle. Never silently change the protected native questionnaire pin.

## Local release gates

Use Node 22 and install both locked dependency sets as described in the handoff. Run sequentially and retain failure logs:

```sh
npm run foundation:build
npx vitest run -c vitest.foundation.config.mts
npx vitest run -c apps/clinic/vitest.config.mts
npx vitest run -c vitest.hosting.config.mts
npx tsc -p tsconfig.foundation.json --noEmit
npx tsc -p tsconfig.clinic.json --noEmit
npm run hosting:typecheck
```

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
