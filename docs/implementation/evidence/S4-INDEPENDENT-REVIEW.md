# S4 independent backend review

Root reviewed the research backend authored by the research agent on October 9, 2026. Scope: current operator identity, client/project authorization, version-pinned invitations, capability-scoped scripted interviews and immutable sources. Media, model interviewing, reports and hosting are not included.

Five independent probes pass alongside the fifteen author tests (20/20): existing identity after operator deactivation; expired persisted Auth session; capture/sharing consent and speech-source admission; two valid participant capabilities with foreign source correction; retention denial for both operator and participant on server re-execution. Command: `npx vitest run --config packages/research-core/vitest.config.mts`. The author's separate native HTTP and restart receipts were inspected; they are distinct from root's independent test evidence.

No current cross-client/source write or read bypass was found in the reviewed functions. Registered domain APIs use validators, operator identity comes from persisted Auth identity/session, capabilities are random and stored hashed, list queries use bounded indexed pagination, and retries preserve immutable original sources. The internal bootstrap and password-reset functions are not public enrollment routes. Scripted interviewer output is authored server-side.

## Open lifecycle finding

**P2: elapsed time alone does not expire a quiet subscription.** `access.ts` and source reads compare expiry to `Date.now()`, which denies requests when the function runs again. An existing subscription does not re-run simply because the deadline arrives. Add scheduled server lifecycle changes for invitation expiry and retention, retain server clock enforcement for calls, and verify an active subscription becomes inaccessible at expiry. A browser deadline improves UX but is not the security authority. The official [Convex best practices](https://docs.convex.dev/understanding/best-practices#dont-use-datenow-in-queries) documents this reactivity limitation.

Physical retention deletion is explicitly unfinished in S4 and must precede hosted acceptance. This review does not treat a query-time expiry check as deletion or claim already downloaded bytes can be recalled. The current local foundation can proceed to UI development with this finding tracked; expiry lifecycle is not accepted yet.

## Subsequent review boundary

Review browser capability handling, real capture consent changes, private media access/ranges, inference prompt boundaries, explicit immutable publication and report-password sessions when those slices exist. No provider generation or cloud writes were performed for this independent review.
