# Phase 2: Email distribution with dedupe, unsubscribe and bounces

Read [PLAN-ASYNC-FEEDBACK-AT-SCALE.md](PLAN-ASYNC-FEEDBACK-AT-SCALE.md) §0 first (workspace, commands, commit rules, constraints, status table). Paths are relative to the worktree root.

**Phase goal.** The operator uploads a recipient list for a campaign. Addresses are normalized, deduped and checked against suppressions. Invites and one reminder go out through Resend within the free tier (≤90 per UTC day, ≤2,700 per month). Every email has a one-click unsubscribe. Bounces and complaints suppress further mail. Each recipient's link always resumes the same session.

**Phase acceptance:** all task tests pass; typechecks are clean against baseline; T2.9's live check is recorded.

**Phase out of scope**
- Resend Broadcasts/Audiences (owner decision D4).
- Attachments, HTML editors and per-recipient custom fields beyond `name`.
- Sending from more than one domain.
- SMS.

**Free-tier facts used** (checked 2026-10-14):
- 100 emails/day and 3,000/month.
- 10 requests/second per team.
- Batch endpoint `POST https://api.resend.com/emails/batch`, at most 100 emails per call.
- `Idempotency-Key` header, valid for 24 h.
- Webhooks are Svix-signed: `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.suppressed`, `email.failed`.
- Test addresses: `delivered@resend.dev`, `bounced@resend.dev`, `complained@resend.dev`.

---

## T2.1 `email.ts`: normalization, CSV, tokens, templates, quota math (S)

**File (new):** `packages/research-core/src/email.ts`. Pure TypeScript using WebCrypto only.

```ts
export const EMAIL_LIMITS = Object.freeze({ dailyCap: 90, monthlyCap: 2_700, batchSize: 100, importChunk: 200, maxRows: 5_000, reminderAfterMs: 72 * 3_600_000, maxReminders: 1, nameChars: 80 });
export function normalizeEmail(raw: string): string | null;    // trim, NFC, lowercase whole address; conservative RFC-5321-ish regex; length <= 254; no dot/plus stripping
export async function emailHash(normalized: string): Promise<string>; // sha256 hex
export type CsvRow = { email: string; name: string | null; line: number };
export function parseRecipientsCsv(text: string): { rows: CsvRow[]; invalid: { line: number; reason: 'no-email' | 'invalid-email' | 'too-long' }[] }; // header optional; columns email[,name]; quoted fields; max EMAIL_LIMITS.maxRows else throws
export function utcDayKey(now: number): string;                 // yyyy-mm-dd
export function utcMonthKey(now: number): string;               // yyyy-mm
export function sendCapacity(day: { sent: number; reserved: number }, month: { sent: number; reserved: number }): number; // min(dailyCap-…, monthlyCap-…, batchSize), >= 0
export async function inviteToken(secret: string, recipientId: string): Promise<string>;    // HMAC-SHA256('invite:'+recipientId) hex, 64 chars (a valid participant capability)
export async function unsubscribeSignature(secret: string, recipientId: string): Promise<string>; // HMAC-SHA256('unsub:'+recipientId) base64url
export async function verifyUnsubscribe(secret: string, recipientId: string, signature: string): Promise<boolean>; // constant-time compare
export function renderInvite(input: { kind: 'invite' | 'reminder'; studyTitle: string; introduction: string; senderName: string; link: string; unsubscribeUrl: string; recipientName: string | null }): { subject: string; text: string; html: string }; // HTML-escapes all inputs; includes bot-disclosure line and unsubscribe link
```

**Tests:** `packages/research-core/test/email.test.ts`
- `normalizeEmail lowercases, trims and keeps dots and plus tags`
- `normalizeEmail rejects invalid and >254 char addresses`
- `CSV with header, quotes, CRLF and blank lines parses with correct line numbers`
- `5001 rows throws`
- `sendCapacity never negative and respects day, month and batch caps`
- `inviteToken is 64 hex and stable per recipient`
- `verifyUnsubscribe rejects altered recipient or signature`
- `renderInvite escapes HTML in title, intro and name and always contains the unsubscribe URL`

**Command:** `npx vitest run --config packages/research-core/vitest.config.mts packages/research-core/test/email.test.ts`
**Depends on:** none. **Out of scope:** sending, templates in other languages. **Model fit:** Haiku.

---

## T2.2 Schema: recipients, suppressions, outbox, quota, imports, webhook events (S)

**File:** `convex/schema.ts`

```ts
researchRecipients: defineTable({ ownerId: v.id('users'), clientId: v.id('researchClients'), projectId: v.id('researchProjects'), campaignId: v.id('researchCampaigns'),
  emailHash: v.string(), email: v.string(), name: v.union(v.string(), v.null()),
  state: v.union(v.literal('queued'), v.literal('sent'), v.literal('delivered'), v.literal('bounced'), v.literal('complained'), v.literal('unsubscribed'), v.literal('suppressed'), v.literal('failed'), v.literal('started'), v.literal('completed')),
  invitationId: v.union(v.id('researchInvitations'), v.null()), sessionId: v.union(v.id('researchSessions'), v.null()),
  resendIds: v.array(v.string()), firstSentAt: v.union(v.number(), v.null()), remindersSent: v.number(), lastEventAt: v.number(), createdAt: v.number() })
  .index('by_campaignId_and_emailHash', ['campaignId', 'emailHash']).index('by_campaignId_and_state', ['campaignId', 'state'])
  .index('by_state_and_firstSentAt', ['state', 'firstSentAt']).index('by_sessionId', ['sessionId']),
researchRecipientResendIds: defineTable({ resendId: v.string(), recipientId: v.id('researchRecipients') }).index('by_resendId', ['resendId']),
researchSuppressions: defineTable({ clientId: v.id('researchClients'), emailHash: v.string(), reason: v.union(v.literal('unsubscribe'), v.literal('bounce'), v.literal('complaint'), v.literal('manual'), v.literal('provider')), at: v.number() })
  .index('by_clientId_and_emailHash', ['clientId', 'emailHash']),
researchEmailOutbox: defineTable({ recipientId: v.id('researchRecipients'), campaignId: v.id('researchCampaigns'), kind: v.union(v.literal('invite'), v.literal('reminder')),
  state: v.union(v.literal('queued'), v.literal('sending'), v.literal('sent'), v.literal('failed'), v.literal('unknown'), v.literal('cancelled')), notBefore: v.number(), batchKey: v.union(v.string(), v.null()), errorCode: v.union(v.string(), v.null()), updatedAt: v.number() })
  .index('by_state_and_notBefore', ['state', 'notBefore']).index('by_recipientId_and_kind', ['recipientId', 'kind']).index('by_batchKey', ['batchKey']),
researchEmailQuota: defineTable({ period: v.string() /* 'd:yyyy-mm-dd' | 'm:yyyy-mm' */, sent: v.number(), reserved: v.number() }).index('by_period', ['period']),
researchEmailImports: defineTable({ campaignId: v.id('researchCampaigns'), requestId: v.string(), result: v.object({ queued: v.number(), duplicate: v.number(), suppressed: v.number(), invalid: v.number() }) })
  .index('by_campaignId_and_requestId', ['campaignId', 'requestId']),
researchEmailEvents: defineTable({ svixId: v.string(), type: v.string(), at: v.number() }).index('by_svixId', ['svixId']),
```

Also add `recipientId: v.optional(v.id('researchRecipients'))` to `researchSessions`.

**Tests:** `packages/research-core/test/email-schema-native.test.ts`
- `rows round-trip; indexes queryable; demo fixtures unchanged`

**Commands:** codegen (§0), `npx tsc -p convex/tsconfig.json`, then the test.
**Depends on:** T1.3. **Out of scope:** deleting recipients (retention handles it in T2.7). **Model fit:** Haiku.

---

## T2.3 Recipient import with dedupe (S)

**File (new):** `convex/researchEmail.ts`

```ts
export const importRecipients = operatorMutation({
  args: { clientId, projectId, campaignId: v.id('researchCampaigns'), requestId: v.string(), rows: v.array(v.object({ email: v.string(), name: v.union(v.string(), v.null()) })) },
  returns: v.object({ queued: v.number(), duplicate: v.number(), suppressed: v.number(), invalid: v.number() }),
});
```
1. Require tenancy through `projectFor`, the campaign in that project in state `draft|open|paused`, and `rows.length <= EMAIL_LIMITS.importChunk`.
2. Replaying the same `requestId` returns the stored result with no writes.
3. For each row:
   - `normalizeEmail` fails → `invalid`;
   - the hash is already in `by_campaignId_and_emailHash` or earlier in the same chunk → `duplicate`;
   - `researchSuppressions.by_clientId_and_emailHash` hit → insert the recipient with state `suppressed` (for visibility) and count it `suppressed`;
   - otherwise insert the recipient as `queued` plus an outbox row (`kind:'invite'`, `notBefore: now`).
4. If anything was queued, `ctx.scheduler.runAfter(0, internal.researchEmail.pump, {})`.

**Tests:** `packages/research-core/test/email-import-native.test.ts`
- `1000 rows in 5 chunks (120 case/space duplicates, 30 invalid, 20 suppressed) yield exactly 830 queued and matching counts`
- `replay of a chunk requestId writes nothing`
- `duplicates across chunks are caught`
- `other operator denied`
- `closed campaign rejects import`

**Command:** `npx vitest run --config packages/research-core/vitest.config.mts packages/research-core/test/email-import-native.test.ts`
**Depends on:** T2.1, T2.2. **Out of scope:** CSV parsing on the server (the client parses with `parseRecipientsCsv`; the server re-validates each row). **Model fit:** Haiku.

---

## T2.4 Outbox pump, Resend batch send, invitation issue (M)

**Files:** `convex/researchEmail.ts`, `convex/researchEmailSend.ts` (new action file, Convex runtime).

```ts
export const pump = internalMutation({ args: {}, returns: v.null() });
export const issueRecipientInvitations = internalMutation({ args: { outboxIds: v.array(v.id('researchEmailOutbox')), tokenHashes: v.array(v.object({ recipientId: v.id('researchRecipients'), tokenHash: v.string() })) }, returns: v.null() });
export const recordBatch = internalMutation({ args: { batchKey: v.string(), outcome: v.union(v.object({ state: v.literal('sent'), ids: v.array(v.string()) }), v.object({ state: v.union(v.literal('failed'), v.literal('unknown')), errorCode: v.string() })) }, returns: v.null() });
// researchEmailSend.ts
export const sendBatch = internalAction({ args: { batchKey: v.string() }, returns: v.null() });
```

**`pump`**
1. If an outbox row is already in `sending`, return (one batch in flight at a time).
2. `capacity = sendCapacity(day, month)` from `researchEmailQuota`. If it is 0, `runAfter(ms until next UTC day + 60 s, pump)` and return.
3. Take ≤ `capacity` rows from `researchEmailOutbox.by_state_and_notBefore` with state `queued` and `notBefore <= now`. Skip and cancel rows whose recipient is suppressed, unsubscribed, bounced or complained, or whose campaign is not `open`.
4. Set those rows to `sending` with `batchKey = sha256(sorted ids)`. Add `reserved += n` to both day and month quota rows. Schedule `sendBatch`.

**`sendBatch`**
1. Load the batch through an internal query.
2. For invites without an invitation, compute `token = inviteToken(FEEDBACK_INVITE_SECRET, recipientId)` and call `issueRecipientInvitations` with `sha256Hex(token)`. Reminders recompute the same token.
3. `issueRecipientInvitations` creates the session and invitation exactly as T1.5 step 5, with these differences:
   - `entry:'email'`, `source:'campaign-email'`, `recipientId`;
   - state `invited`;
   - **no budget reservation and no `shard.started` increment yet** (T2.6 does both at consent);
   - invitation `expiresAt = closesAt ?? now + 14 d`.
   It is idempotent per recipient.
4. Build the emails:
   - link `${PUBLIC_ORIGIN}/participate#token=<token>`;
   - `unsubscribeUrl = ${CONVEX_SITE_URL}/email/unsubscribe?r=<recipientId>&s=<unsubscribeSignature>`;
   - headers `List-Unsubscribe: <unsubscribeUrl>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`;
   - tag `{name:'recipient', value: recipientId}`.
5. POST `https://api.resend.com/emails/batch` with `Authorization: Bearer RESEND_API_KEY` and `Idempotency-Key: batchKey`. Response `data[i].id` maps to `ids[i]`.
6. Outcomes:
   - 2xx → `recordBatch` `sent`;
   - 4xx other than 429 → `failed`;
   - 429, 5xx, network or timeout → `unknown`.

**`recordBatch`**
- `sent`: outbox → `sent`; recipient → `sent`; set `firstSentAt` for invites or increment `remindersSent`; insert `researchRecipientResendIds`; quota `reserved -= n`, `sent += n`; then `runAfter(0, pump)`.
- `failed`: outbox → `failed`; recipient → `failed`; quota `reserved -= n`.
- `unknown`: outbox → `unknown`; quota consumes the capacity (`reserved -= n`, `sent += n`). **No automatic resend.** T2.5 webhooks may later reconcile these to `sent`. After 24 h with no webhook, the recovery sweep (T2.7) marks them `failed`.

**Tests:** `packages/research-core/test/email-send-native.test.ts` (fake fetch)
- `two concurrent pumps never put more than 90 sends on one UTC day`
- `monthly cap 2700 respected across days`
- `batch of 100 maps provider ids to recipients in order`
- `Idempotency-Key equals batchKey and is stable for a re-scheduled identical batch`
- `suppressed or closed-campaign rows are cancelled, not sent`
- `429 marks unknown, consumes quota, never auto-resends`
- `invitation token issued once per recipient; reminder link equals invite link`
- `no budget reserved at issue time`

**Command:** `npx vitest run --config packages/research-core/vitest.config.mts packages/research-core/test/email-send-native.test.ts`
**Depends on:** T2.3. **Out of scope:** retries of unknown batches, per-recipient idempotency keys (the batch API takes one key per request). **Model fit:** a stronger model for quota and pump concurrency; Haiku for the HTTP wiring.

---

## T2.5 Resend webhook and one-click unsubscribe (M)

**Files:** `convex/http.ts` (register routes), `convex/researchEmailHttp.ts` (new; `httpAction`s), `convex/researchEmail.ts` (internal mutations).

```ts
export const resendWebhook = httpAction(async (ctx, request) => Response); // POST /email/resend-webhook
export const unsubscribe = httpAction(async (ctx, request) => Response);   // GET|POST /email/unsubscribe
export const applyEmailEvent = internalMutation({ args: { svixId: v.string(), type: v.string(), resendId: v.string(), at: v.number() }, returns: v.null() });
export const applyUnsubscribe = internalMutation({ args: { recipientId: v.id('researchRecipients') }, returns: v.null() });
export async function verifySvix(secret: string /* whsec_… */, headers: { id: string; timestamp: string; signature: string }, body: string, now: number): Promise<boolean>;
```

**Webhook**
- Read the raw body (≤256 KB, else 413).
- Verify the Svix signature: HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${body}` using the base64-decoded secret after `whsec_`. `svix-signature` may list several `v1,<sig>` values; any match passes. The timestamp must be within 300 s. Failure → 401 with no write.
- Parse `{type, data:{email_id}}`.
- `applyEmailEvent` is idempotent through `researchEmailEvents.by_svixId`:
  - `email.bounced` → recipient `bounced`, plus suppression `bounce`;
  - `email.complained` → `complained`, plus suppression `complaint`;
  - `email.suppressed` → `suppressed`, plus suppression `provider`;
  - `email.delivered` → `delivered` only if the current state is `sent`; it also reconciles an outbox `unknown` to `sent`;
  - `email.failed` → `failed`;
  - other types are ignored.
- Never downgrade `started` or `completed`.

**Unsubscribe**
- GET validates `r` and `s` with `verifyUnsubscribe(FEEDBACK_INVITE_SECRET, …)` and returns a minimal HTML page with a POST form.
- POST (one-click: body `List-Unsubscribe=One-Click`, or the form) calls `applyUnsubscribe`: recipient `unsubscribed`, plus suppression `unsubscribe` scoped to the recipient's `clientId`; queued outbox rows are cancelled. It is idempotent and returns 200 in both cases.
- An invalid signature returns 400 with no write.
- No session data is deleted. Withdrawal is a separate participant action.

**Tests:** `packages/research-core/test/email-webhook-native.test.ts`
- `valid signed bounced event suppresses and cancels queued reminder`
- `complained same`
- `bad signature 401 and no writes`
- `stale timestamp 401`
- `replayed svix-id applied once`
- `delivered never downgrades started`
- `delivered reconciles unknown outbox to sent`
- `one-click POST unsubscribes and is idempotent`
- `unsubscribe suppression is per client: another client's campaign still sends`
- `bad unsubscribe signature 400`

**Command:** `npx vitest run --config packages/research-core/vitest.config.mts packages/research-core/test/email-webhook-native.test.ts`
**Depends on:** T2.2 (and T2.4 for the reconciliation case). **Out of scope:** a suppression-management UI beyond the T2.8 list. **Model fit:** Haiku, with a stronger-model review of `verifySvix`.

---

## T2.6 Invite resume and consent-time budget reservation (S)

**Files:** `convex/participant.ts` (`agree`: a guarded call), `convex/researchCampaignTurns.ts` (helper).

```ts
export async function reserveOnConsent(ctx: MutationCtx, session: Doc<'researchSessions'>): Promise<{ ok: true } | { ok: false; reason: StartRefusal }>;
```
- The helper only acts when `session.campaignId && session.entry === 'email' && session.campaignReservedMicros === undefined`.
- It runs `decideStart` on the shard sums. On success it reserves (same fields as T1.5 step 5), increments `shard.started`, and sets the recipient to `started`.
- On refusal it throws `ConvexError('This study isn't accepting responses')` before consent is stored.
- Completion (T1.7) sets the recipient to `completed` when `recipientId` is present.
- The same link always resolves to the same session, because the token is deterministic and only one invitation exists per recipient.

**Tests:** `packages/research-core/test/email-resume-native.test.ts`
- `opening the link twice resumes the same session`
- `consent reserves budget once; second agree does not double-reserve`
- `exhausted campaign refuses consent with closed copy`
- `completion marks recipient completed`

**Command:** `npx vitest run --config packages/research-core/vitest.config.mts packages/research-core/test/email-resume-native.test.ts`
**Depends on:** T2.4, T1.6. **Out of scope:** anonymous link sessions (already covered by T1.5). **Model fit:** a stronger model.

---

## T2.7 Reminders and email recovery sweep (S)

**File:** `convex/researchEmail.ts`; extend the existing 15-minute feedback cron from T1.7 to also call `internal.researchEmail.sweep`.

```ts
export const sweep = internalMutation({ args: { cursor: v.union(v.string(), v.null()) }, returns: v.null() });
```
Each run handles a page of 100 recipients:
1. Recipients in `sent|delivered` with `firstSentAt + 72 h <= now`, `remindersSent === 0`, no started session, campaign `open`, and not suppressed get a `reminder` outbox row (unique per recipient through `by_recipientId_and_kind`).
2. Outbox rows in `unknown` older than 24 h become `failed`.
3. If anything was queued, `runAfter(0, pump)`.
4. Recipient emails for campaigns closed more than 30 days ago are replaced with `'[deleted]'`; `emailHash` is kept for suppression.

**Tests:** `packages/research-core/test/email-reminder-native.test.ts`
- `reminder only after 72h, only once, only for not-started and not-suppressed`
- `no reminder for closed campaign`
- `unknown older than 24h becomes failed`
- `addresses redacted 30 days after close; suppression still matches`

**Command:** `npx vitest run --config packages/research-core/vitest.config.mts packages/research-core/test/email-reminder-native.test.ts`
**Depends on:** T2.4, T2.5. **Out of scope:** a configurable reminder schedule (fixed at one reminder). **Model fit:** Haiku.

---

## T2.8 Recipients panel UI (M)

**Files:** `apps/research/src/RecipientsPanel.tsx` (new), mounted inside `CampaignSettings.tsx` (T1.9). Add `researchEmail.listRecipients` (operatorQuery, paginated, optional state filter) and `researchEmail.summary` (counts by state plus queued ETA) to `convex/researchEmail.ts`.

- File input or paste. Parse with `parseRecipientsCsv` client-side and show a preview with counts and the invalid lines.
- "Queue invites" sends chunks of 200 with `requestId = sha256(campaignId + chunkIndex + fileHash)`.
- Status table: email, name, state, last event, reminder sent. Filter by state.
- ETA line: `ceil(queued / 90)` days; "Sends at most 90 emails per day (free tier)."
- The summary from `researchEmail.summary` reads per-state counts through `by_campaignId_and_state` with `take(…)` pagination. It must not scan more than 5,000 rows; above that it shows "5,000+".

**Tests:** `apps/research/test/recipients-panel.test.tsx`
- `preview shows queued, duplicate and invalid counts before submit`
- `chunks of 200 with deterministic requestIds`
- `ETA copy for 450 queued is 5 days`
- `bounced rows show suppressed badge`

**Command:** `npm run research:test -- apps/research/test/recipients-panel.test.tsx`
**Depends on:** T2.3. **Out of scope:** editing or deleting individual recipients. **Model fit:** Haiku.

---

## T2.9 Owner-approved live send (≤5 emails) (S)

The owner verifies the sending domain in Resend and sets `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `FEEDBACK_EMAIL_FROM` and `FEEDBACK_INVITE_SECRET` on the feedback Convex deployment. They register the webhook URL `https://<feedback>.convex.site/email/resend-webhook`.

Import five addresses: `delivered@resend.dev`, `bounced@resend.dev`, `complained@resend.dev` and two owner inboxes. Expected outcomes:
- the delivered and owner rows reach `delivered`;
- the bounced row reaches `bounced` and the complained row reaches `complained`, with suppressions;
- an owner inbox shows the one-click unsubscribe in the mail client;
- clicking it suppresses that address;
- the second owner link opens the participant flow.

Record the results in `docs/implementation/FEEDBACK-MEASUREMENTS.md`. **Depends on:** T2.4–T2.8. **Out of scope:** volume sends.
