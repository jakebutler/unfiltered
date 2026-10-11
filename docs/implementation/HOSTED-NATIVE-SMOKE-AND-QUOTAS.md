# Local native smoke and next aggregate quota slice

2026-10-10. Static preparation only. Hosted configuration remains OFF. Native push/smoke requires root's explicit execution slot; no credentials are read during preparation.

## Local acceptance

From the foundation worktree, run the existing local-only configuration with a 60-second process bound and sanitized, bounded output:

```sh
/Users/jacobbutler/.nvm/versions/node/v22.22.3/bin/node --max-old-space-size=1024 node_modules/convex/bin/main.js dev --once --env-file infra/research/.env.local
```

Stop if the CLI target is not the existing local 3210 deployment, compilation fails, or the outcome is unknown. Do not deploy the hosted target, print secrets, reset tables, or rerun an ambiguous mutation automatically.

Use the existing `convexHostedAuthority` with explicit local runtime configuration and fresh owner/request nonces. Write an exclusive smoke intent/receipt before mutations. First inspect bounded slot metadata (maximum five rows) and due cleanup metadata (maximum eleven indexed rows); existing unknown work is not released. If any foreign due cleanup row could be claimed, stop the cleanup portion before claiming.

1. Acquire two competing upload leases; exactly one must succeed. Inspect the winner, reject wrong-owner release, release the exact winner, reacquire, and reject its stale generation. Acquire four operation leases and deny a fifth. Release only the exact owned identities.
2. Begin one owned operation once, reject repeated begin, inspect its identity, then release after the local synthetic work is known settled. Prove a successor generation is available. This establishes native ownership and known settlement; it does not establish real-time expiry recovery or remote cancellation.
3. Reuse ordinary Password auth and participant/capture APIs from `apps/research-server/scripts/qualify-reports.ts` to create one uniquely labeled synthetic client/project/study/invitation and screen-only consent. Reserve one bounded synthetic media row, upload it through the existing media gateway against an in-memory private port, then stop capture and withdraw storage consent. Provider runtime stays absent. Verify the owned source becomes unreadable.
4. Acquire/begin one cleanup lease. Reject an unstarted claim and stale owner/generation completion; after a started claim, require exactly the owned media ID, attempt and key before touching storage. Any unexpected claim stops storage/completion. Retire that key through the in-memory tombstone port, independently read it back, then complete the exact claim. Verify native media state and reserved-byte release through bounded owned-row readback. A malformed/stale completion must not change either. Release the exact cleanup lease only once all local work settles.
5. Retain fixture IDs and honest terminal status, stop any owned gateway, sign out, and leave unrelated rows unchanged. No R2/provider call or new VM is needed. Unknown state is retained for root reconciliation. The tombstone portion proves **native authority plus the injected private port**, not R2 parity or physical cloud deletion.

## Required next slice: finite deployment allocation

Concurrency, per-row cleanup attempts and provider reservations do not bound aggregate request/read/storage use. Activation requires the following small durable quota boundary; this is a proposal, not implemented behavior.

Add one indexed allocation row for the demo: root-only immutable allocation ID, expiry, request/read-payload-byte/storage-operation ceilings, and monotonically consumed counters. There is no clock-period reset, environment-derived replenishment, or public budget setter. Root provisions explicit finite numbers before activation. A new allocation requires a separate prospective root decision and preserves historical counters; process restart never replenishes an allocation. Missing, expired or exhausted allocation returns truthful unavailable capacity before work.

Lease acquisition atomically checks allocation validity, consumes one admitted request, and creates the native lease in the same mutation. Existing exact-identity acquisition readback does not consume again; a new acquisition does. Failed begin, cancelled work and unknown outcomes receive no refund. Allocation identity is pinned to the lease and retained independently of slot reuse. Existing provider reservations, media attempts and cleanup-attempt budgets remain separate and never reset.

Before each private-store call, a signed mutation checks the exact begun lease, allocation and monotonically increasing operation ordinal, then atomically reserves the conservative wire-operation and payload-read upper bounds. Await a known positive acknowledgement before dispatch. A lost acknowledgement consumes the allowance and forbids dispatch/retry; repeating an ordinal cannot authorize another call. Per-request operation ceiling also stays finite. The host selects only fixed operation classes; it cannot supply arbitrary ceilings.

Use the current adapter's bounded paths: HEAD reserves two wire operations and one probe byte; `putIfAbsent` reserves three operations and one possible probe byte; ranged `read` reserves its exact requested payload bytes plus two operations and one possible probe byte; retirement reserves three operations and one possible probe byte. A cleanup retirement plus independent HEAD conservatively consumes five aggregate operation units while retaining the existing actual four-wire-operation claim bound. Unused conservative reservations are not refunded. These counters describe admitted upper bounds, not observed billing. Response/body limits remain 4,000,000 bytes and successful truncation remains forbidden.

Also cap guarded native authority checks/chunk count per request so tiny chunks cannot cause unbounded consent-query traffic within one admission. Current consent still runs before every released chunk; exhaustion fails closed and cancels the stream. This is a finite demo boundary, not a generic billing framework. Pre-auth invalid-host traffic and platform invocation cost require a separate platform ingress/rate gate; these native counters cannot claim to bound requests rejected before authority admission.

Acceptance for that next implementation: concurrent callers cannot overspend the final unit; two reads consume separate exact range allowances; unknown storage acknowledgement remains consumed; same ordinal replay cannot dispatch; lease expiry/restart/known release never replenishes totals; cleanup cannot bypass aggregate storage allowance; absent/exhausted allocation stays OFF. Root chooses the actual allocation and activation only after native proof and independent review.
