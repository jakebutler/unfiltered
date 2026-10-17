# S4 independent backend review

Root reviewed the research backend authored by the research agent on October 9, 2026. Scope: current operator identity, client/project authorization, version-pinned invitations, capability-scoped scripted interviews and immutable sources. Media, model interviewing, reports and hosting are not included.

Five independent probes pass alongside the fifteen author tests (20/20): existing identity after operator deactivation; expired persisted Auth session; capture/sharing consent and speech-source admission; two valid participant capabilities with foreign source correction; retention denial for both operator and participant on server re-execution. Command: `npx vitest run --config packages/research-core/vitest.config.mts`. The author's separate native HTTP and restart receipts were inspected; they are distinct from root's independent test evidence.

No current cross-client/source write or read bypass was found in the reviewed functions. Registered domain APIs use validators, operator identity comes from persisted Auth identity/session, capabilities are random and stored hashed, list queries use bounded indexed pagination, and retries preserve immutable original sources. The internal bootstrap and password-reset functions are not public enrollment routes. Scripted interviewer output is authored server-side.

## Lifecycle finding, closed after repair

**P2: elapsed time alone does not expire a quiet subscription.** `access.ts` and source reads compare expiry to `Date.now()`, which denies requests when the function runs again. An existing subscription does not re-run simply because the deadline arrives. Add scheduled server lifecycle changes for invitation expiry and retention, retain server clock enforcement for calls, and verify an active subscription becomes inaccessible at expiry. A browser deadline improves UX but is not the security authority. The official [Convex best practices](https://docs.convex.dev/understanding/best-practices#dont-use-datenow-in-queries) documents this reactivity limitation.

Physical retention deletion is explicitly unfinished in S4 and must precede hosted acceptance. This review does not treat a query-time expiry check as deletion or claim already downloaded bytes can be recalled. The current local foundation can proceed to UI development with this finding tracked; expiry lifecycle is not accepted yet.

## Subsequent review boundary

Review browser capability handling, real capture consent changes, private media access/ranges, inference prompt boundaries, explicit immutable publication and report-password sessions when those slices exist. No provider generation or cloud writes were performed for this independent review.

## Lifecycle repair acceptance

Root reviewed the actual scheduled callbacks, bounded indexes/batches, optional-field migration, retained server-clock checks, and local-only qualification controls on October 9. The unchanged five independent boundary probes and full research backend suite pass31/31. Native receipt `research-lifecycle-e41d32e8-18c6-4717-98db-dc508b321382.json` demonstrates quiet subscription denial, persistence across an isolated backend restart, physical deletion of prompt/original/correction rows, cleared consent, and metadata-only tombstones. Its request/response clock bounds and persisted server timestamps avoid comparing unrelated clocks as exact timestamps. Three earlier failed harness receipts remain preserved. No current lifecycle blocker remains for the text-source scope. Media, publication, backup retention and hosted execution require their own subsequent evidence.
