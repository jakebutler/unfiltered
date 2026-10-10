# S4: local research authority and interview sources

This is the backend foundation for Corvo research, implemented against a separate local Convex instance. It does not complete research capture, adaptive interviewing, analysis, publication, the client portal, or hosted acceptance. The existing hosted Convex development and production deployments are untouched: the account’s shared included storage/I/O was exhausted when the coordinator checked. This local stack incurs no provider or hosting charge.

## Architectural choice

Research remains in Convex; clinic records remain in Medplum. The official self-hosted backend runs in the existing `colima-unfiltered-s0` Docker context as the **separate** Compose project `unfiltered-research-s4`. It has its own network and persistent volume, exposes only loopback ports 3210/3211, disables the usage beacon, and pins the official image by digest. The backend `/version` currently returns `unknown`; the digest, not that string, is the reproducible identity. No dashboard container is necessary for the CLI/native API qualification.

Named operator identity uses `@convex-dev/auth` 0.0.96 with its Password provider, not a custom password/session implementation. WorkOS configuration is unavailable. Public enrollment, email reset, verification, and anonymous auth are closed. One server-admin bootstrap creates the named local demo operator and binds its user ID to the single operator role. An unbound account cannot sign in or access research. Passwords use the library’s Scrypt implementation; login failures are rate limited by Convex Auth. Domain reads/writes check both the persisted role and the live Auth session, so sign-out is immediately effective for domain APIs even if a JWT’s five-minute lifetime has not elapsed. Session maximum is eight hours, with a one-hour inactivity limit. Admin-only password rotation invalidates sessions; self-service email is not configured or sent.

The API uses official Convex helper wrappers to resolve the operator once per call. Every registered domain function has argument and return validators. Client/project relations are checked server-side on every scoped call. The caller cannot nominate an owner. Lists use indexed pagination and permit 1–25 records per call. Archive is the reversible CRUD removal operation; it preserves studies and evidence, and stops participant access. No evidence-erasing delete is exposed.

Study edits create immutable numbered snapshots. An invitation pins one snapshot and creates exactly one session. Its random 256-bit capability is hashed before persistence, expires after seven days, and is returned in plaintext only once. A duplicate creation request returns the original receipt with `token: null`; the operator must revoke and deliberately replace it if the original response was lost. Tokens grant only their assigned session and cannot select another session, client, study, or project. Every participant call rechecks expiry, revocation, active client/project, and retention. Archival is reversible, so use invitation revocation when access must stay revoked after unarchiving.

`researchSources` holds immutable evidentiary records, not an LLM orchestration store. It preserves exact participant text, explicit confirmed-transcript authorship, server-authored script prompts, sequence, stable source ID, and correction lineage. Any future Agent component can own model execution while these records remain the authority for retained research evidence. No inference implementation or provider call is introduced in S4.

## Current API contract

Import the generated `api` from `convex/_generated/api` and use Convex’s generated `Id`/`FunctionReturnType` types. The operator UI can use `ConvexAuthProvider` and `useAuthActions().signIn('password', { flow: 'signIn', email, password })`; expose a sign-in form only. The private local configuration is never a frontend module or bundle input.

| API | Behavior |
| --- | --- |
| `research.me`, `clients`, `createClient`, `updateClient` | Named identity; bounded client list; create/edit/archive with revision checks |
| `research.projects`, `project`, `createProject`, `updateProject` | Explicit client/project scope; project detail, bounded list, edit/archive |
| `research.saveStudy`, `readStudy` | Expected project revision; immutable version returned; explicit version read |
| `invitations.create`, `list`, `revoke` | Operator-only creation, scoped metadata with no secret/hash exposure, immediate revocation |
| `research.sessions`, `sessionSources` | Scoped operator review metadata and bounded immutable source pages |
| `participant.resume` | Capability-only public study introduction, state, current question, progress, save/retention/expiry times; no private goals or repository context |
| `participant.agree` | Versioned storage/analysis/capture/sharing choices, distinct from browser permissions; begins the first script prompt only after required storage and analysis consent |
| `participant.sources` | Assigned session’s bounded source pages; no arbitrary session selector |
| `participant.answer` | Current question + expected revision + unique request ID; text or explicitly confirmed transcript; saves source and next script prompt atomically |
| `participant.correct` | Appends a source superseding the latest participant source in that correction chain; original stays readable |
| `participant.transition` | Pause/resume/finish partial/finish completed; completed requires all script questions answered; final sessions are closed for edits |

`paginationOpts` is `{ numItems: 1..25, cursor: string | null }`; pages return `{ page, isDone, continueCursor }`. Continuation cursors are opaque. Do not claim a full result count until all pages were read. Invitation links should carry their capability in a fragment, remove it from the address bar after reading, and avoid telemetry/referrer leakage; a later same-origin facade may exchange it for an HttpOnly session. S4 currently exposes Convex capability APIs, not that browser/session facade.

Mutation revision conflicts mean refresh and reconcile; never blindly overwrite. Answer/correction retries with the same request ID and exact content return the existing source receipt, even when the revision has since advanced. Reusing that ID for different content is rejected. A concurrent pair of different answers admits only one expected revision. A concurrent exact replay produces one source. An invitation lost-result retry does not mint another session or expose a stored token.

The current interviewer follows a versioned script; it is a functioning persistence path for the later adaptive interview. Participant source writes cannot claim to be model/assistant/script output. A confirmed-transcript source requires prior microphone consent. No raw audio is captured or retained here, and consent flags do not imply media exists. Completion is conversation completion only.

Study limits: 1–12 goals, 1–30 questions with unique IDs, eight authorized context files totaling at most 48 KB, 8,000 characters per participant source, and 200 sources per session. Repository references require a full commit hash; no repository fetch/build occurs. URLs cannot contain credentials, query strings, or fragments. Common credential patterns and secret-file paths are rejected; this is a guard against accidental secrets, not proof arbitrary context is secret-free. Future model input must treat all study/context/participant text as untrusted data.

Thirty-day source retention is an access boundary in this slice. Expired content is denied through source/session reads. **Physical deletion and retention jobs are not yet implemented** and must precede hosted acceptance. Consent withdrawal/change, post-completion amendments, upload admission and media grants are likewise later explicit lifecycle work; do not infer them from initial consent fields. Report clients have no role or route in this slice and cannot be routed to operator/participant APIs as a shortcut.

## Run and recover locally

Use Node 22 and the worktree root. The following script operates only on the pinned local Compose project and validates the exact loopback deployment URL before any admin action:

```sh
node infra/research/start-local.mjs
npx vitest run --config packages/research-core/vitest.config.mts
npx tsc -p convex/tsconfig.json --noEmit
node infra/research/qualify-local.mjs
```

`infra/research/.env.local` contains only the local admin deployment credential; `operator.private.json` contains the demo login and local JWT keys. Both are ignored and mode 0600. Preserve them with the volume. The Convex CLI additionally writes public local URLs to the ignored worktree-root `.env.local`; it has not read or changed the primary checkout’s provider credentials. Neither local file should be copied into a browser bundle or hosted deployment.

To push future Convex edits locally, always pass `--env-file infra/research/.env.local` to `npx convex dev --once`. Do not use a default hosted deployment or `--prod`. Do not delete the volume to fix a schema failure. Evolve populated schemas with optional fields and an explicit migration.

To verify persistence after a successful qualification whose UUID is recorded in its receipt:

```sh
node infra/research/check-persistence.mjs <qualification-uuid>
```

This restarts only `unfiltered-research-s4`’s backend, then verifies original sources, operator authentication and invitation revocation survived. Clinic containers are not restarted. This is persistence qualification, not a backup/restore exercise or AWS validation.

## Validation and remaining gates

Fifteen focused tests cover actual Convex function logic in `convex-test`, including public enrollment rejection, foreign identity and mixed-client IDs, capability expiry/revocation, private study context, immutable versions, consent, exact source text, stale revisions, replay, correction lineage, closure, bounds and live Auth-session checks. The separate native qualification uses real HTTP requests, real Password/Scrypt sign-in and signed JWTs against the pinned local backend. It performs nineteen checks, including concurrent conflicting writes and exact replay. All tests and the local push/typecheck pass. Native receipts are retained in `docs/implementation/evidence/research-*.json`; the latest extended receipt is `research-078374f7-1f08-449d-b004-e374af8c5b72.json`.

The isolated backend restart passed at `2026-10-10T02:39:17.441Z`: the same five source records, original exact source text, operator login and invitation revocation survived. Receipt: `research-persistence-078374f7-1f08-449d-b004-e374af8c5b72.json`. All four clinic containers retained their earlier uptime.

The dependency installation reports deprecated transitive Lucia/Oslo packages from Convex Auth. The current npm advisory result names none of `@convex-dev/auth`, `convex`, `convex-helpers`, `convex-test`, `lucia`, `jose`, or `@auth/core`; that does not prove the library is vulnerability-free. The repository’s inherited tree still reports 35 advisories, including existing Next/OpenNext/Drizzle/test tooling. No force upgrade was applied. A hosted release needs a scoped dependency/security review, a decision on long-term operator identity/recovery, browser auth/capability handling, retention deletion, actual research capture/analysis/publication, and qualified hosting headroom.

Sources: [official self-hosted Convex](https://github.com/get-convex/convex-backend/tree/main/self-hosted), [manual Convex Auth setup](https://labs.convex.dev/auth/setup/manual), [Password provider](https://labs.convex.dev/auth/config/passwords), [Convex Auth server API](https://labs.convex.dev/auth/api_reference/server). Installed package source was checked for closed-flow enforcement, Scrypt hashing, bootstrap/rotation and session claims; native execution qualifies this local configuration only.
