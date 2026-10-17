# Research invitation expiry and source retention

Implemented locally on October 9, 2026, after the S4 review found that `Date.now()` checks alone do not invalidate a quiet subscription. This slice schedules persisted state changes for seven-day invitations and thirty-day source retention. It retains server clock checks for every request. Root independent review is complete; see `evidence/S4-INDEPENDENT-REVIEW.md` for the separate review and re-run evidence.

## Persisted lifecycle

Invitation creation atomically creates its session and registers both scheduled mutations. At the invitation deadline, `expireInvitation` sets `expiredAt`, invalidating queries that read the invitation. Revocation, client/project archival, and wall-clock checks remain authoritative. An expired marker stays closed even if an internal caller later moves the numeric deadline forward.

At the retention deadline, `purgeSources` makes the session inaccessible and deletes at most 100 `researchSources` rows in one transaction. It deletes all channels and authors: original participant text, later corrections, confirmed transcripts and interviewer script prompts. It schedules another bounded mutation when a full batch was read. The final session is a metadata-only tombstone with `retentionState: purged`, `purgedAt`, zero sources, no consent choices, and no next-question progress. Existing IDs, scope, study reference, conversation state and historical activity times remain; no source text or excerpts are copied to the tombstone. Retention is measured from invitation/session creation, as in the existing thirty-day contract; answering does not extend it.

Every callback carries the original owner/client/project/study/session scope and exact deadline. A missing record, changed scope/deadline, early invocation or already-completed lifecycle is a no-op. Participant and operator source reads deny both `purging` and `purged` states even if their numeric deadline is moved. All participant writes share that same guard. No public endpoint can shorten or extend retention.

Three one-minute crons provide bounded recovery:

- Backfill reads up to 50 legacy invitations and 50 legacy sessions using indexes on missing optional lifecycle fields. It schedules their original deadlines and marks them migrated. Full batches schedule continuation.
- Invitation recovery reads at most 100 overdue, unexpired invitations through its compound index and expires them. Completed rows leave the queried range.
- Retention recovery reads up to 50 overdue retained sessions and 50 interrupted purges, then schedules bounded deletion callbacks. Due rows transition to purging immediately; interrupted work is safe to retry.

Schema additions are optional, so the populated local deployment can migrate without erasing records. No full-table scan, public cleanup function, custom queue, or external storage service was added. Exact-deadline jobs run subject to backend availability; the indexed cron sweeps recover delayed work. Query-time wall-clock denial remains in place during such delays. This is application-row deletion, not proof that previously downloaded bytes, database snapshots or historical backups have been erased. Backup expiry/restore controls remain part of the deployment package.

## Qualification

Commands, run from the implementation worktree with Node 22:

```sh
npx vitest run --config packages/research-core/vitest.config.mts
npx tsc -p convex/tsconfig.json --noEmit
npm run research:typecheck --silent
npx convex dev --once --env-file infra/research/.env.local
node infra/research/qualify-lifecycle.mjs
```

All 31 research backend tests pass: the 20 existing author/independent boundary tests plus 11 lifecycle tests. The new tests cover atomic scheduling, exact-deadline callbacks, wall-clock denial before job execution, stale scope/deadline rejection, early/repeated callbacks, physical deletion across authors and correction lineage, sibling preservation, 100-row deletion batches, partial-purge denial, bounded migration and interrupted deletion recovery. Existing test assertions were not changed; their timers now use Vitest fake timers because a real Node timeout cannot represent the thirty-day scheduled interval. Backend and research frontend typechecks pass. The exact local Convex push succeeded.

Native evidence: `evidence/research-lifecycle-e41d32e8-18c6-4717-98db-dc508b321382.json`, seven checks passed at `2026-10-10T03:09:03.667Z`.

- A real Password-authenticated operator created the study/invitation. The participant saved an answer and correction alongside two interviewer prompts.
- A live unauthenticated capability WebSocket subscription first read the scoped session, then received typed access denial at invitation expiry without issuing another client request. Observed delivery was 39–83 ms beyond the local deadline window; persisted server `expiredAt` was after the server deadline.
- A real operator WebSocket subscription initially read all four source records. Only the isolated research backend was restarted before retention. The reconnected subscription received access denial at retention, 103–147 ms beyond the local deadline window.
- An internal inspection found zero physical source rows, zero source count, cleared consent, and a purged tombstone with server `purgedAt` after its deadline. Subsequent HTTP source reads and source writes were denied.
- Normal operator and participant clients could not invoke the internal fixture. No hosted resources, inference or speech providers were used; cash cost was zero.

The native harness uses a deliberately named, fresh synthetic fixture. Its internal deadline override is guarded by both the exact loopback Convex site URL and a temporary server-admin environment flag. It cannot run on the hosted backend. The script removes that flag in `finally`; the passing receipt confirms removal. It reads credentials only from existing mode-0600 local files, and receipts contain neither capabilities, passwords, JWTs nor signing keys. Do not run it while someone is testing the local research UI: it restarts that backend. Its short deadlines are qualification-only; public invitation creation remains seven/thirty days.

Three failed receipts are preserved. `2c4a4b34-...` incorrectly classified the deployment's redacted error message; inspection confirmed that the typed `ConvexError.data` still carried the access-denied value. `fd388aa4-...` and `b2dd6b9e-...` exposed an invalid assumption that host and container clocks were identical (the latter observed denial 21 ms before the numeric server deadline). The final harness checks typed errors, bounds local timing using the request/response around server `preparedAt`, and separately checks persisted timestamps against server deadlines. No lifecycle behavior was changed to make these harness errors pass.

No frontend, media, publication or report retention work is included. Future media and published excerpts must join the same lifecycle deliberately before their hosting acceptance. Existing source retention consent flags do not currently exempt any source row from this deletion policy.
