# Shared clinic ingress admission

Status: static patch and regression sources only. No tests, builds, services, providers, cloud writes or credential reads were performed for this slice. Earlier hosting-package evidence predates this patch. Independent review and sequential checks remain pending.

## Scope and limits

The hosted server always constructs the real Medplum guard and injects it into the clinic handler and native speech transport. Local callers may omit the hook to retain their existing behavior. The guard admits downstream work only after an acknowledged, validated native CAS update. It does not establish a provider spending allowance or protect network/storage reads against DDoS.

| Attempt | Sliding minute | Sliding day | Lifetime |
| --- | ---: | ---: | ---: |
| New patient session | 6 | 50 | 200 |
| Staff login | 10 | 100 | 400 |
| Authenticated speech upgrade | 12 | 300 | 1,000 |

Speech additionally allows two pending/active sockets across the project and one per patient session. A claim holds capacity for 90 seconds unless authoritative native socket closure is observed earlier. The transport schedules termination before that lease deadline, retaining its existing 60-second capture and shorter setup/lifetime limits. Hosted scheduling, clock behavior and termination still require validation; this is not evidence of an absolute concurrency guarantee under arbitrary platform clock skew or suspended execution.

All attempts stay charged after downstream failure, denial after reservation, abort, timeout, unknown acknowledgement or socket closure. Successful native closure frees only socket capacity. An abandoned unknown socket claim expires for capacity purposes without deleting or refunding its attempt. A guard denial before reservation creates no claim and permits no downstream work.

## Storage and failure behavior

One project-scoped `DocumentReference` has identifier system `urn:corvo:clinic:ingress` and fixed value `corvo-clinic-public-ingress`. Neither value contains deployment ID, origin, policy version, user identity or IP. The payload holds random attempt UUIDs, kind, timestamps, closure state, a policy digest and a hash of a random session UUID for socket overlap control. It has no subject, clinical text, email, address or plaintext IP/session ID. Its append-only claim list is bounded at 1,600 records and its canonical payload at 450,000 bytes.

Policy ID/limit changes retain that same storage key and fail on digest mismatch. They require an explicit reviewed migration of retained counts; changing a policy name, deleting the ledger or switching projects must not be used as automatic quota renewal. Only the initial empty ledger can reconcile an uncertain create via readback because it admits no attempt. Reservation updates retry only explicit native 412 version conflicts, at most four times. Lost, malformed or stale acknowledgements yield no lease and no downstream dispatch. Retained unknown claims must be inspected rather than blindly replayed.

A timestamp earlier than the persisted last admission fails closed before CAS. The design assumes trusted, reasonably synchronized host clocks; a large forward jump cannot reset lifetime counts, but may age sliding windows or leases. Native/hosted verification must test the platform's clock and socket behavior. Storage corruption, changed policy, contention exhaustion and unavailable storage fail closed, trading demo availability for a bounded admitted workload.

## Placement and lifecycle

- Origin, body/schema and cheap process checks precede expensive admission. New-session admission runs only after the existing signed-cookie resume lookup establishes that a new draft is necessary. Valid same-scenario resume reuses its draft without a new claim. An uncertain resume read does not fall through to a new draft.
- Login admission runs before the native credential exchange. Failed credentials remain charged. A request aborted during reservation cannot proceed to draft creation or login.
- Speech checks the native upgrade shape and authenticates origin, patient cookie and scope before shared admission. No upstream provider connection or provider spending reservation occurs during this upgrade step.
- The raw socket close event is the sole early-release signal. Closing while reservation is pending records that event and releases the eventual lease only after it resolves. Destroyed-state checks, browser messages and timeout assumptions do not themselves release capacity. A lost release acknowledgement never refunds attempts.
- Existing provider admission remains separately required before paid inference/speech dispatch. Public endpoint protection, verified hosting headroom and platform firewall/DDoS controls remain separate release requirements.

## Changed files

`packages/clinic-api/src/ingress-admission.ts` owns bounded CAS storage and leases. Optional hooks are in `packages/clinic-api/src/handler.ts`; raw upgrade/close handling is in `apps/clinic-server/src/speech.ts`; mandatory hosted injection is in `infra/cloud/vercel/application.ts`.

Regression sources: `packages/clinic-api/test/ingress-admission.test.ts`, `packages/clinic-api/test/ingress-handler.test.ts`, `packages/speech/test/ingress-speech.test.ts`. They cover cross-instance contention/restart, sliding boundaries/lifetime, unknown reservation and close acknowledgements, persistent policy identity, backward clocks, origin/body checks, valid resume, abort during reservation, and native close before lease resolution. These tests have not yet run.

## Pending sequential verification

The root owns test execution scheduling. Run individually only when that slot is released; do not start Medplum or another VM for these injected/loopback checks:

```bash
PATH=/Users/jacobbutler/.nvm/versions/node/v22.22.3/bin:$PATH node_modules/.bin/tsc -p tsconfig.foundation.json --noEmit
PATH=/Users/jacobbutler/.nvm/versions/node/v22.22.3/bin:$PATH node_modules/.bin/tsc -p tsconfig.hosting.json
PATH=/Users/jacobbutler/.nvm/versions/node/v22.22.3/bin:$PATH node_modules/.bin/vitest run --config vitest.foundation.config.mts packages/clinic-api/test/ingress-admission.test.ts packages/clinic-api/test/ingress-handler.test.ts packages/speech/test/ingress-speech.test.ts packages/speech/test/node-transport.test.ts --maxWorkers=1 --no-file-parallelism
PATH=/Users/jacobbutler/.nvm/versions/node/v22.22.3/bin:$PATH node_modules/.bin/vitest run --config vitest.hosting.config.mts --maxWorkers=1 --no-file-parallelism
```

After independent review and local checks, qualify native conditional create/CAS under the restricted cloud policy, and hosted simultaneous-instance admission, disconnect/abort, killed-instance lease expiry, deployment restart and actual socket termination deadlines. Rebuild and smoke the isolated artifact after any accepted fixes. Provider activation and public release still require their existing qualifications; this static guard is not a new user permission gate.
