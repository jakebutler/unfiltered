# Phase 1: Campaign link → async text responses with budget and abuse controls

Overview, workspace rules, constraints and the status table are in [PLAN-ASYNC-FEEDBACK-AT-SCALE.md](PLAN-ASYNC-FEEDBACK-AT-SCALE.md) §0. Read §0 first. Paths are relative to `/Volumes/rexy/GitHub/codex-worktrees/unfiltered-foundation/unfiltered`.

**Phase goal.** An operator creates and opens a campaign. Anyone with `/c/<slug>` passes Turnstile and consents, answers the study's questions by text and gets ≤2 adaptive follow-ups per question. Everything stays inside a hard per-campaign budget, per-IP and per-link limits, and a global DO concurrency cap. The operator sees started/completed counts and spend.

**Phase acceptance** (reviewed once at the end):
- Every task's named tests pass.
- `npx tsc -p convex/tsconfig.json`, `npm run research:typecheck` and `npx tsc -p tsconfig.research-hosting.json` are clean relative to baseline.
- Existing demo tests `packages/research-core/test/interview-native.test.ts` and `packages/research-core/test/interview.test.ts` still pass unchanged.
- T1.11's measurements are recorded.

**Phase out of scope.** Email (Phase 2), analysis (Phase 3), voice and read-aloud (Phase 5), any change to demo code paths, any cloud deployment other than the owner-provisioned feedback projects.

**Design rule for the whole phase.** Campaign sessions are ordinary `researchSessions` with `campaignId` set. Every new branch is `if (session.campaignId)`. Demo sessions (`campaignId` undefined) must take exactly the old code path.

---

## T1.1 Runtime-neutral kit: DO client, exact quote locator, cost math (S)

**Why.** `packages/clinical-core/src/digitalocean.ts` imports `ClinicalError` from `domain.ts`, which pulls clinic modules into any bundle. Convex V8 actions need a fetch + WebCrypto client with no `node:` imports. This is a copy, not a move; the clinic is untouched.

**Files (new)**
- `packages/research-core/src/kit/digitalocean.ts`
- `packages/research-core/src/kit/quote.ts`
- `packages/research-core/src/kit/cost.ts`
- `packages/research-core/src/kit/json.ts`

**Signatures**
```ts
// kit/digitalocean.ts
export const DO_CHAT_URL = 'https://inference.do-ai.run/v1/chat/completions';
export const FEEDBACK_MODELS = ['qwen3.8-max', 'glm-5.3-flash', 'deepseek-v4.1-flash'] as const;
export type FeedbackModel = typeof FEEDBACK_MODELS[number];
export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
export type DoRequest = { model: FeedbackModel; messages: ChatMessage[]; maxOutputTokens: number; temperature: number; timeoutMs: number; json: boolean; maxRequestBytes: number };
export type DoUsage = { promptTokens: number; completionTokens: number };
export type DoResult = { requestId: string; model: string; text: string; usage: DoUsage | null; requestBytes: number; elapsedMs: number };
export type DoErrorCode = 'unsupported-model' | 'request-too-large' | 'timeout' | 'network' | 'http' | 'invalid-response' | 'model-mismatch' | 'incomplete-output';
export class DoError extends Error { constructor(readonly code: DoErrorCode, readonly status?: number) }
export function isFeedbackModel(value: string): value is FeedbackModel;
export async function callDigitalOcean(apiKey: string, request: DoRequest, fetcher?: typeof fetch): Promise<DoResult>;
// kit/quote.ts
export function locateExact(text: string, quote: string): { start: number; end: number } | null; // unique occurrence only, UTF-16 offsets
// kit/cost.ts
export type ModelPrice = { inputMicrosPerMTok: number; outputMicrosPerMTok: number };
export const PRICES_20261014: Record<FeedbackModel, ModelPrice>; // qwen3.8-max 2_000_000/6_000_000; glm-5.3-flash 150_000/500_000; deepseek-v4.1-flash 300_000/1_200_000
export function costMicros(model: FeedbackModel, usage: DoUsage, prices?: Record<FeedbackModel, ModelPrice>): number; // ceil
export function worstCaseMicros(model: FeedbackModel, maxRequestBytes: number, maxOutputTokens: number, prices?: Record<FeedbackModel, ModelPrice>): number; // treats bytes as an upper bound on input tokens
// kit/json.ts
export function canonicalJson(value: unknown): string; // sorted keys; same output as research-capture canonical() for plain JSON
export async function sha256Hex(text: string): Promise<string>; // crypto.subtle
```

**Behaviour**
- The request body is `{model, messages, max_tokens, temperature, stream:false, response_format: json ? {type:'json_object'} : undefined}`.
- Before fetching, reject with `request-too-large` if the UTF-8 body exceeds `maxRequestBytes`. Use an `AbortSignal.timeout(timeoutMs)`; on abort, throw `timeout`.
- A non-2xx response throws `http` with the status; the provider body must never appear in the message.
- Parse with zod: `id`, `model`, `choices[0].message.content`, `choices[0].finish_reason`, optional `usage`. Any `finish_reason !== 'stop'` throws `incomplete-output`. A response `model` that differs from the requested one throws `model-mismatch`.
- No retries.

**Tests:** `packages/research-core/test/kit.test.ts`
- `rejects a model outside FEEDBACK_MODELS before fetch`
- `sends json_object, max_tokens and temperature; never sends to another host`
- `maps finish_reason length to incomplete-output`
- `timeout aborts with code timeout`
- `http error hides provider body`
- `locateExact returns UTF-16 offsets around an emoji`
- `locateExact returns null for zero or two occurrences`
- `costMicros rounds up`
- `worstCaseMicros >= costMicros for any usage within bounds (200 random cases)`

**Boundary test:** `packages/research-core/test/kit-boundary.test.ts`
- `kit sources import nothing from clinic packages, clinical-core or node:` (reads each `kit/*.ts` file and regex-checks the imports)

**Command:** `npx vitest run --config packages/research-core/vitest.config.mts packages/research-core/test/kit.test.ts packages/research-core/test/kit-boundary.test.ts`

**Depends on:** none.
**Out of scope:** streaming, vision payloads, retries, changing `packages/clinical-core`.
**Model fit:** Haiku.

---

## T1.2 `campaign.ts`: pure limits, budget and rate decisions (S)

**File (new):** `packages/research-core/src/campaign.ts`

```ts
export const CAMPAIGN_LIMITS = Object.freeze({
  maxResponsesCeiling: 5000, maxSessionCallsCeiling: 20, followUpsPerQuestion: 2, shards: 8, inferenceSlots: 6,
  perIpDailyStartsDefault: 3, perLinkHourlyStarts: 120, velocityWindowMs: 600_000, velocityStarts: 60,
  sessionActiveMs: 45 * 60_000, idleSettleMs: 24 * 3_600_000, slotLeaseMs: 30_000,
  turnTimeoutMs: 15_000, turnMaxRequestBytes: 48_000, turnMaxOutputTokens: 400,
  mapMaxRequestBytes: 48_000, mapMaxOutputTokens: 2_000, slugBytes: 16,
});
export type CampaignState = 'draft' | 'open' | 'paused' | 'closed' | 'exhausted';
export type CampaignBudget = { model: FeedbackModel; allocatedMicros: number; maxSessionCalls: number };
export type ShardTotals = { started: number; completed: number; reservedMicros: number; chargedMicros: number };
export function sumShards(rows: readonly ShardTotals[]): ShardTotals;
export function shardFor(key: string): number;                       // FNV-1a mod CAMPAIGN_LIMITS.shards
export function turnWorstCaseMicros(b: CampaignBudget): number;      // worstCaseMicros(model, turnMaxRequestBytes, turnMaxOutputTokens)
export function mapWorstCaseMicros(b: CampaignBudget): number;
export function sessionReservationMicros(b: CampaignBudget): number; // maxSessionCalls*turn + map
export type StartRefusal = 'not-open' | 'not-yet-open' | 'closed' | 'campaign-full' | 'campaign-exhausted';
export function decideStart(c: { state: CampaignState; opensAt: number | null; closesAt: number | null; maxResponses: number }, totals: ShardTotals, b: CampaignBudget, now: number): { ok: true; reserveMicros: number } | { ok: false; reason: StartRefusal };
export function decideTurn(s: { calls: number; inFlight: boolean }, b: CampaignBudget): { ok: true } | { ok: false; reason: 'in-flight' | 'session-call-cap' };
export function settle(s: { reservedMicros: number; knownMicros: number; unknownCalls: number }, b: CampaignBudget): { chargedMicros: number; releaseMicros: number };
export function validateCampaignSettings(input: unknown): CampaignSettings; // zod; enforces ceilings, model in FEEDBACK_MODELS, temperature 0..1
```

**Rules**
- `decideStart` refuses with `campaign-exhausted` when `charged + reserved + reserveMicros > allocatedMicros`, and with `campaign-full` when `started >= maxResponses`.
- In `settle`, `chargedMicros = knownMicros + unknownCalls*turnWorstCase`, and `releaseMicros = reservedMicros - chargedMicros`, never negative. Phase 3 consumes the map portion; until it does, the map portion stays reserved (see T1.7).

**Tests:** `packages/research-core/test/campaign.test.ts`
- `decideStart refuses each StartRefusal`
- `property: 200 seeded interleavings of start/turn/settle keep charged+reserved <= allocated` (deterministic PRNG, no `Math.random`)
- `settle never releases more than reserved`
- `shardFor is stable and within range`
- `validateCampaignSettings rejects out-of-ceiling values and gpt-oss/anthropic model ids`

**Command:** `npx vitest run --config packages/research-core/vitest.config.mts packages/research-core/test/campaign.test.ts`
**Depends on:** T1.1. **Out of scope:** speech budgets (T5.1). **Model fit:** a stronger model for the property test and settle semantics; Haiku for the rest.

---

## T1.3 Schema: campaigns, shards, slots, turns, rate limits, session fields (S)

**File:** `convex/schema.ts`. Every new session field is `v.optional`, so existing rows stay valid.

```ts
researchCampaigns: defineTable({ ownerId: v.id('users'), clientId: v.id('researchClients'), projectId: v.id('researchProjects'), studyId: v.id('researchStudies'),
  slug: v.string(), requestId: v.string(), state: v.union(v.literal('draft'), v.literal('open'), v.literal('paused'), v.literal('closed'), v.literal('exhausted')),
  pausedReason: v.union(v.null(), v.literal('operator'), v.literal('velocity')), opensAt: v.union(v.number(), v.null()), closesAt: v.union(v.number(), v.null()),
  maxResponses: v.number(), perIpDailyStarts: v.number(), model: v.union(v.literal('qwen3.8-max'), v.literal('glm-5.3-flash'), v.literal('deepseek-v4.1-flash')),
  temperature: v.number(), promptVersion: v.string(), allocatedMicros: v.number(), maxSessionCalls: v.number(),
  voice: v.union(v.literal('off'), v.literal('dictation')), tts: v.union(v.literal('browser'), v.literal('elevenlabs')),
  allocatedSpeechSeconds: v.number(), allocatedTtsCharacters: v.number(), revision: v.number(), createdAt: v.number(), updatedAt: v.number() })
  .index('by_slug', ['slug']).index('by_projectId_and_state', ['projectId', 'state']).index('by_studyId', ['studyId']).index('by_projectId_and_requestId', ['projectId', 'requestId']),
researchCampaignShards: defineTable({ campaignId: v.id('researchCampaigns'), shard: v.number(), started: v.number(), completed: v.number(), reservedMicros: v.number(), chargedMicros: v.number(), speechSeconds: v.number(), ttsCharacters: v.number() })
  .index('by_campaignId_and_shard', ['campaignId', 'shard']),
researchInferenceSlots: defineTable({ slot: v.number(), holder: v.union(v.null(), v.object({ sessionId: v.id('researchSessions'), turnId: v.id('researchCampaignTurns') })), leaseUntil: v.number() })
  .index('by_slot', ['slot']),
researchCampaignTurns: defineTable({ campaignId: v.id('researchCampaigns'), sessionId: v.id('researchSessions'), requestId: v.string(), promptId: v.string(), contextHash: v.string(),
  state: v.union(v.literal('admitted'), v.literal('ready'), v.literal('failed'), v.literal('unknown'), v.literal('skipped')), skipReason: v.optional(v.string()),
  slot: v.union(v.number(), v.null()), model: v.string(), configDigest: v.string(), costMicros: v.union(v.number(), v.null()),
  usage: v.union(v.null(), v.object({ promptTokens: v.number(), completionTokens: v.number() })), errorCode: v.union(v.string(), v.null()), createdAt: v.number(), finishedAt: v.union(v.number(), v.null()) })
  .index('by_sessionId_and_requestId', ['sessionId', 'requestId']).index('by_sessionId_and_state', ['sessionId', 'state']).index('by_campaignId_and_createdAt', ['campaignId', 'createdAt']),
...rateLimitTables, // from 'convex-helpers/server/rateLimit' (already a dependency, convex-helpers@0.1.128)
```

Add to `researchSessions`, all optional:

```ts
campaignId: v.id('researchCampaigns'),
entry: v.union(v.literal('link'), v.literal('email')),
shard: v.number(),
lastActivityAt: v.number(),
completedAt: v.number(),
campaignReservedMicros: v.number(),
campaignKnownMicros: v.number(),
campaignUnknownCalls: v.number(),
campaignCalls: v.number(),
pendingMapMicros: v.number(),
campaignSettledAt: v.number(),
promptVersion: v.string(),
model: v.string(),
```

Also add the index `.index('by_campaignId_and_state_and_lastActivityAt', ['campaignId', 'state', 'lastActivityAt'])`.

Add to `researchInvitations`: `source: v.optional(v.union(v.literal('operator'), v.literal('campaign-link'), v.literal('campaign-email')))`.

**Tests:** `packages/research-core/test/campaign-schema-native.test.ts`
- `existing demo session/invitation fixtures insert unchanged`
- `campaign rows round-trip with every index queryable`

**Commands:** codegen (§0), then `npx tsc -p convex/tsconfig.json`, then the test above.
**Depends on:** T1.2. **Out of scope:** email and analysis tables (T2.2, T3.3). **Model fit:** Haiku.

---

## T1.4 Operator campaign API (M)

**File (new):** `convex/researchCampaigns.ts`. Use the patterns from `convex/access.ts` (`operatorMutation`, `operatorQuery`, `projectFor`, `revision`, `pageSize`, `pageResult`) and `convex/invitations.ts` (action generates the randomness, then an internal mutation).

```ts
export const create = action({ args: { clientId, projectId, studyVersion: v.number(), requestId: v.string(), settings: campaignSettings }, returns: v.object({ campaignId: v.id('researchCampaigns'), slug: v.string() }) });
export const insertCampaign = internalMutation({ args: { ...createArgs, slug: v.string() }, ... }); // idempotent on (projectId, requestId); seeds 8 shard rows
export const update = operatorMutation({ args: { campaignId, expectedRevision: v.number(), settings: campaignSettings }, returns: v.number() }); // draft|paused only
export const open = operatorMutation({ args: { campaignId, expectedRevision }, returns: v.number() });    // draft|paused -> open; seeds researchInferenceSlots 0..5 if absent
export const pause = operatorMutation({ args: { campaignId, expectedRevision }, returns: v.number() });   // open -> paused (pausedReason 'operator')
export const close = operatorMutation({ args: { campaignId, expectedRevision }, returns: v.number() });   // any -> closed (terminal)
export const get = operatorQuery({ args: { campaignId }, returns: campaignView });
export const list = operatorQuery({ args: { projectId, clientId, paginationOpts }, returns: page(campaignView) });
export const stats = operatorQuery({ args: { campaignId }, returns: v.object({ started, completed, reservedMicros, chargedMicros, allocatedMicros, state, pausedReason }) }); // sums 8 shard rows
export const publicView = query({ args: { slug: v.string() }, returns: v.union(v.null(), v.object({ title, introduction, state: v.union(v.literal('open'), v.literal('unavailable')), voice, tts })) }); // no counts, ids or budget
```

- `campaignSettings` is a Convex validator mirroring `validateCampaignSettings`; call the pure validator inside handlers too.
- The slug is 16 random bytes, base64url, generated in the action with `crypto.getRandomValues`.
- Any other operator gets `denied()` (cross-tenant).

**Tests:** `packages/research-core/test/campaign-operator-native.test.ts`
- `create is idempotent per requestId and seeds 8 shards`
- `another operator cannot read or change the campaign`
- `update rejected while open`
- `state machine: draft->open->paused->open->closed; closed is terminal`
- `stale expectedRevision rejected`
- `publicView exposes no ids, counts or budget`
- `open seeds exactly 6 inference slots once`

**Command:** `npx vitest run --config packages/research-core/vitest.config.mts packages/research-core/test/campaign-operator-native.test.ts`
**Depends on:** T1.3. **Out of scope:** UI (T1.9), recipients (Phase 2). **Model fit:** Haiku.

---

## T1.5 Link start: Turnstile, IP hash, signed start mutation (M)

**Files**
- `convex/researchCampaigns.ts` (add `startFromGateway`)
- `infra/cloud/vercel/research/feedback-start.ts` (new)
- `infra/cloud/vercel/research/application.ts` (register the route only when `config.product === 'feedback'`, see T1.10)

**Convex**
```ts
export const startFromGateway = mutation({
  args: { slug: v.string(), requestId: v.string(), tokenHash: v.string(), ipHash: v.string(), proof: gatewayProof },
  returns: v.union(v.object({ ok: v.literal(true), sessionId: v.id('researchSessions') }), v.object({ ok: v.literal(false), reason: v.union(StartRefusal…, v.literal('rate-limited'), v.literal('paused')) })),
});
```
1. `verifyGateway(process.env.FEEDBACK_GATEWAY_SECRET, 'feedback:start', input, proof)` (from `packages/research-capture/src/proof.ts`), else `denied()`.
2. Idempotent on `(campaign.projectId, requestId)` through `researchInvitations.by_projectId_and_requestId`.
3. Rate limits with `defineRateLimits` (convex-helpers):
   - `feedbackIp` fixed window 24 h, key `campaignId:ipHash`, rate = `campaign.perIpDailyStarts`;
   - `feedbackLink` fixed window 1 h, key `campaignId`, rate 120;
   - `feedbackVelocity` fixed window 10 min, key `campaignId`, rate 60. On a breach, patch the campaign to `paused`/`velocity` and return `paused`.
4. Read all 8 shards, `sumShards`, then `decideStart`. On a refusal with reason `campaign-exhausted`, patch the campaign to `exhausted`.
5. Insert the session (copy the field set used in `invitations.issue`, plus `campaignId`, `entry:'link'`, `shard: shardFor(requestId)`, `campaignReservedMicros`, `pendingMapMicros: mapWorstCaseMicros`, `campaignCalls:0`, `campaignKnownMicros:0`, `campaignUnknownCalls:0`, `interviewEnabled:true`, `promptVersion`, `model`, `lastActivityAt`).
6. Insert the invitation (`source:'campaign-link'`, `tokenHash`, `expiresAt = min(closesAt ?? ∞, now + 7 d)`). Increment `shard.started` and `shard.reservedMicros`. Call `scheduleInvitation` and `scheduleRetention` exactly as `invitations.issue` does.
7. Do **not** modify `invitations.issue`.

**Vercel handler**
```ts
export type FeedbackStartDeps = { convex: { startFromGateway(args): Promise<…> }; secret: string; ipSalt: string; turnstileSecret: string; canonicalOrigin: string; fetcher?: typeof fetch; now?: () => number };
export async function handleFeedbackStart(request: Request, deps: FeedbackStartDeps): Promise<Response>;
```
- Accept POST only. `Origin` must equal `canonicalOrigin`. The JSON body `{slug, requestId, turnstileToken}` must be ≤2,048 bytes, else 413.
- POST `https://challenges.cloudflare.com/turnstile/v0/siteverify` (form `secret`, `response`, `remoteip`); `success !== true` returns 403 and the handler **does not call Convex**.
- The IP is the first `x-forwarded-for` entry. `ipHash = sha256Hex(ipSalt + ':' + utcDay + ':' + ip)`. Never forward or log the raw IP.
- The token is 32 random bytes as hex. `tokenHash = sha256Hex(token)` (matches `hashCapability`).
- Status mapping: ok → 201 `{token}`; `rate-limited` → 429; `paused`/`not-open`/`closed` → 409; `campaign-full`/`campaign-exhausted` → 410. Every response sets `cache-control: no-store`.

**Tests**
- `infra/cloud/vercel/research/test/feedback-start.test.ts`:
  - `turnstile failure returns 403 and makes no Convex call`
  - `wrong Origin returns 403 before Turnstile`
  - `oversize body returns 413`
  - `success returns a 64-hex token whose sha256 is the tokenHash sent to Convex`
  - `ipHash changes across UTC days and raw IP never appears in Convex args`
  - `refusal reasons map to 429/409/410`
- `packages/research-core/test/campaign-start-native.test.ts`:
  - `60 concurrent starts with maxResponses 50 yield exactly 50 sessions and 10 campaign-full; shard sums equal row counts`
  - `4th start from one ipHash within 24h is rate-limited`
  - `61 starts in 10 minutes pause the campaign with reason velocity`
  - `invalid proof is denied with no writes`
  - `budget refusal marks campaign exhausted`
  - `replayed requestId returns the same session`

**Commands**
- `npx vitest run --config vitest.research-hosting.config.mts infra/cloud/vercel/research/test/feedback-start.test.ts`
- `npx vitest run --config packages/research-core/vitest.config.mts packages/research-core/test/campaign-start-native.test.ts`

**Depends on:** T1.4, T1.10. **Out of scope:** email-invite starts (T2.6), CAPTCHA alternatives. **Model fit:** a stronger model for the mutation (concurrency, idempotency); Haiku for the Vercel handler.

---

## T1.6 Campaign turn path: `feedbackTurn.run` (L)

**Files**
- `convex/feedbackTurn.ts` (new; Convex runtime, **no** `"use node"`)
- `convex/researchCampaignTurns.ts` (new)
- `packages/research-core/src/campaign-prompt.ts` (new)

**Do not edit** the global `by_active` check in `convex/researchInterview.ts:62`. The campaign path never calls `researchInterview.admit`.

**Prompt module**
```ts
// copy of the demo instruction and packet from apps/research-server/src/interview.ts:39-50, using kit/json canonicalJson
export const CAMPAIGN_PROMPT_VERSION = 'feedback-interview-v1';
export function campaignInterviewMessages(context: InterviewContext): ChatMessage[];
export async function campaignConfigDigest(c: { model: string; temperature: number; promptVersion: string; maxOutputTokens: number }): Promise<string>;
```

**Action**
```ts
export const run = action({ args: { token: v.string(), requestId: v.string() },
  returns: v.object({ outcome: v.union(v.literal('follow-up'), v.literal('advanced'), v.literal('in-flight'), v.literal('nothing-pending')) }) });
```
Steps:
1. `admit = await ctx.runMutation(internal.researchCampaignTurns.admit, { token, requestId })` returns one of:
   - `{kind:'dispatch', turnId, slot, request: DoRequest, contextHash, nextPromptId}`
   - `{kind:'done', outcome}`: admit already installed a scripted advance
   - `{kind:'in-flight'}` or `{kind:'nothing-pending'}`
2. On `dispatch`, call `callDigitalOcean(process.env.DIGITALOCEAN_MODEL_ACCESS_KEY!, request)`. Parse the text with `JSON.parse` inside try/catch (parse failure → proposal `null`).
3. `await ctx.runMutation(internal.researchCampaignTurns.finish, { turnId, contextHash, nextPromptId, result })`, where `result` is `{state:'ready', proposal, usage, requestId}` or `{state:'unknown'|'failed', errorCode}`. `timeout`, `network` and `http` 5xx count as `unknown`; `http` 4xx, `incomplete-output` and `invalid-response` count as `failed`.

**`researchCampaignTurns.admit`** (internal mutation):
1. Resolve the session with `participant(ctx, token)` and require `session.campaignId` and `session.pendingInterview`. Otherwise return `nothing-pending`.
2. If a turn for this session is in state `admitted` → `in-flight`.
3. Build the context with `interviewMaterial` (exported from `convex/researchInterview.ts`).
4. If `interviewStopReason(context)` is set, install `advanceInterview(context, reason)` via `installInterviewDecision` and record turn `skipped/<reason>`.
5. `decideTurn` refusal (`session-call-cap`), a campaign not `open`, or no free slot (each of the 6 slot rows must have `holder === null` or `leaseUntil < now`) → install `advanceInterview(context, 'disabled')` and record turn `skipped/<reason>`.
6. Otherwise claim the slot (`leaseUntil = now + 30 s`), insert the turn `admitted`, increment `session.campaignCalls`, set `lastActivityAt`, and return the request with `maxRequestBytes = turnMaxRequestBytes`, `maxOutputTokens = turnMaxOutputTokens`, `timeoutMs = 15_000`, `json: true` and the campaign's model and temperature. `nextPromptId` is `fu-<turnId>`.

**`researchCampaignTurns.finish`** (internal mutation):
1. Load the turn. If it is not `admitted`, return (idempotent). Recompute the material; a context-hash change means advance with `'recovery'`.
2. On `ready`, call `decideInterview(context, proposal, nextPromptId)` inside try/catch:
   - success → `installInterviewDecision`;
   - `InterviewError` → install `advanceInterview(context, 'recovery')` and set the turn's `errorCode` to the error code.
   - Record `costMicros = costMicros(model, usage)`, or the turn worst case when `usage` is null. Add it to `session.campaignKnownMicros`.
3. On `unknown`, increment `session.campaignUnknownCalls`. On `failed`, add the turn worst case to `campaignKnownMicros` (conservative). Both then install `advanceInterview(context, 'recovery')`.
4. Release the slot only if `holder.turnId` matches.

**Client contract.** After `participant.answer` succeeds for a campaign session, call `api.feedbackTurn.run`. The UI side is in T1.8.

**Tests:** `packages/research-core/test/campaign-turn-native.test.ts` (convex-test; `vi.stubGlobal('fetch')` returns canned DO JSON):
- `valid follow-up proposal installs a follow-up prompt and records costMicros from usage`
- `proposal quoting text absent from the answer advances with recovery`
- `two sessions dispatch concurrently (fake fetch observes 2 in flight)`
- `second run for the same session while admitted returns in-flight`
- `seventh concurrent session finds no slot and advances scripted without fetch`
- `session at maxSessionCalls advances scripted without fetch`
- `timeout records unknown, advances, and settle later charges worst case`
- `expired slot lease is reclaimed`
- `finish is idempotent`
- `demo session (no campaignId) returns nothing-pending and demo interview-native tests still pass`

**Commands**
- `npx vitest run --config packages/research-core/vitest.config.mts packages/research-core/test/campaign-turn-native.test.ts packages/research-core/test/interview-native.test.ts packages/research-core/test/interview.test.ts`
- `npx tsc -p convex/tsconfig.json`

**Depends on:** T1.1, T1.3, T1.5. **Out of scope:** guards beyond `decideInterview` (T5.4), saturation (T5.5), retries. **Model fit:** a stronger model.

---

## T1.7 Session settlement and idle sweep (S)

**Files:** `convex/researchCampaignTurns.ts` (helper), `convex/participant.ts` (hook calls only), `convex/crons.ts`.

```ts
export async function settleCampaignSession(ctx: MutationCtx, session: Doc<'researchSessions'>, reason: 'completed' | 'partial' | 'idle'): Promise<void>;
export const sweepIdle = internalMutation({ args: { cursor: v.union(v.string(), v.null()) }, returns: v.null() }); // pages of 50 open campaigns' sessions with lastActivityAt < now - idleSettleMs
```
- The helper is a no-op unless `session.campaignId` is set and `campaignSettledAt` is undefined.
- It applies `settle()` to the turn portion only. `pendingMapMicros` stays reserved and is released by T3.5; if Phase 3 is not deployed, T1.7 releases it too behind the constant `MAP_ENABLED = false`, defined in `campaign.ts`.
- It writes `shard.reservedMicros -= released+charged`, `shard.chargedMicros += charged` and `shard.completed += 1` when the reason is `completed`. It sets `completedAt` and `campaignSettledAt`.
- Call it at the end of `participant.transition` when the new state is `completed` or `partial`, and in `participant.confirmFinalReview`. Each call is one line guarded by `if (session.campaignId)`.
- Add `crons.interval('Feedback idle settlement', { minutes: 15 }, internal.researchCampaignTurns.sweepIdle, { cursor: null })`. Its handler returns immediately when no campaign is `open`.
- This track never deploys to `elegant-crane-662`, so the demo never runs this cron.

**Tests:** `packages/research-core/test/campaign-settle-native.test.ts`
- `completion settles once; second call is a no-op`
- `known costs charge actual, unknown calls charge worst case, remainder released`
- `idle sweep settles sessions idle > 24h as idle and ignores demo sessions`
- `after settlement a previously exhausted campaign can admit a new start`

**Command:** `npx vitest run --config packages/research-core/vitest.config.mts packages/research-core/test/campaign-settle-native.test.ts`
**Depends on:** T1.6. **Out of scope:** map-job settlement (T3.5). **Model fit:** a stronger model.

---

## T1.8 Participant campaign entry UI (M)

**Files**
- `apps/research/src/CampaignEntry.tsx` (new)
- `apps/research/src/main.tsx` (route `/c/:slug`)
- `apps/research/src/interview-automatic.ts` (campaign branch)
- `convex/participant.ts` (`resume` returns `campaign: v.optional(v.boolean())`)
- `infra/cloud/vercel/research/static-assets.ts` (CSP: allow `https://challenges.cloudflare.com` in `script-src` and `frame-src` only when `product === 'feedback'`)

**Behaviour**
- `CampaignEntry` loads `api.researchCampaigns.publicView({slug})`. If the view is null or `unavailable`, show "This study isn't accepting responses."
- Render Turnstile explicitly with `VITE_TURNSTILE_SITE_KEY`. The Start button stays disabled until a token exists.
- POST `/api/feedback/start` with `{slug, requestId: crypto.randomUUID().replace(/-/g,''), turnstileToken}`. On 201, store the token in `localStorage['feedback:'+slug]` and go to `/participate#token=<token>`.
- If the stored token exists and `participant.resume` succeeds, skip the start.
- Copy for refusals:
  - 429: "You've already started this study from this device today."
  - 409/410: "This study isn't accepting responses."
- In `interview-automatic.ts`: when `resume.campaign` is true, call `useAction(api.feedbackTurn.run)` instead of POSTing `/api/research/interview`. The demo path is unchanged.

**Tests**
- `apps/research/test/campaign-entry.test.tsx`:
  - `unavailable campaign shows closed copy`
  - `start disabled until turnstile callback`
  - `429 shows device copy`
  - `success stores token and navigates`
  - `existing valid token skips start`
- `apps/research/test/interview-automatic-campaign.test.ts`:
  - `campaign session calls feedbackTurn.run and never fetches /api/research/interview`
  - `demo session still uses the gateway`

**Command:** `npm run research:test -- apps/research/test/campaign-entry.test.tsx apps/research/test/interview-automatic-campaign.test.ts`
**Depends on:** T1.5, T1.6. **Out of scope:** voice UI, mobile-specific layout work beyond existing styles. **Model fit:** Haiku.

---

## T1.9 Operator campaign UI (M)

**Files:** `apps/research/src/CampaignSettings.tsx` (new), `apps/research/src/ProjectWorkspace.tsx` (add a "Campaigns" tab).

- **List:** paginated `researchCampaigns.list`.
- **Create form:** study version, maxResponses, close date, budget in dollars (stored as micros), model select limited to `FEEDBACK_MODELS`, perIpDailyStarts, voice and tts toggles (disabled with "Phase 5" note until then).
- **Actions:** open, pause and close with confirm. "Copy link" copies `${origin}/c/${slug}`.
- **Stats card:** started, completed, spend (charged + reserved) versus allocated, and a paused-by-velocity banner with a Resume button (calls `open`).
- **Preview as participant:** reuse the existing readiness-test pattern only if trivial; otherwise defer to Phase 5 and note it in the status table.

**Tests:** `apps/research/test/campaign-settings.test.tsx`
- `create form validates ceilings and offers only FEEDBACK_MODELS`
- `copy link uses /c/<slug>`
- `velocity banner shows and resume calls open`
- `spend shows charged+reserved over allocated`

**Command:** `npm run research:test -- apps/research/test/campaign-settings.test.tsx`
**Depends on:** T1.4. **Out of scope:** recipients (T2.8), themes (T3.8). **Model fit:** Haiku.

---

## T1.10 Feedback deployment manifest, isolation guard, env names (S)

**Files**
- `infra/cloud/vercel/research/manifest.feedback.json` (new; placeholders only)
- `infra/cloud/vercel/research/config.ts` (parse `product: 'research' | 'feedback'`, default `'research'`)
- `infra/research/feedback.env.example` (new; variable names only, committed). It is deliberately not named `.env.*`: `.gitignore` ignores `.env*` except `.env.example`. The working copy `infra/research/.env.feedback.local` is created from it locally and stays ignored.

**Guard in `config.ts`**
```ts
export const DEMO_IDENTIFIERS = ['elegant-crane-662', 'corvo-research-demo'] as const;
export function assertFeedbackIsolation(config: { product: string; convexUrl: string; origin: string }): void; // throws if product==='feedback' and any DEMO_IDENTIFIERS substring appears
```
Call it from the existing config parser.

**Env names** (values are set by the owner, never committed):
- Convex: `DIGITALOCEAN_MODEL_ACCESS_KEY`, `FEEDBACK_GATEWAY_SECRET`
- Vercel: `FEEDBACK_GATEWAY_SECRET`, `FEEDBACK_IP_SALT`, `TURNSTILE_SECRET_KEY`, `VITE_TURNSTILE_SITE_KEY`, `VITE_RESEARCH_CONVEX_URL`
- Phase 2 adds `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `FEEDBACK_EMAIL_FROM`, `FEEDBACK_INVITE_SECRET`
- Phase 5 adds `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`

**Tests:** `infra/cloud/vercel/research/test/feedback-manifest.test.ts`
- `feedback manifest parses with product feedback`
- `isolation guard rejects elegant-crane-662 and corvo-research-demo`
- `existing deployable manifest still parses as research and registers no /api/feedback route`

**Command:** `npx vitest run --config vitest.research-hosting.config.mts infra/cloud/vercel/research/test/feedback-manifest.test.ts`
**Depends on:** none. **Out of scope:** creating cloud projects, which the owner does. **Model fit:** Haiku.

---

## T1.11 Local load measurement and owner-approved live smoke (S)

**Files:** `scripts/dev/feedback-load.mts` (new), `docs/implementation/FEEDBACK-MEASUREMENTS.md` (new; results).

- Run against a **local** Convex backend (`npx convex dev --once --env-file infra/research/.env.feedback.local`, then the local backend URL).
- Fake DO responder: the script sets Convex env `FEEDBACK_FAKE_DO=1`. In `feedbackTurn.run`, use the fake only when `FEEDBACK_FAKE_DO==='1'` **and** `process.env.CONVEX_CLOUD_URL` starts with `http://127.0.0.1`.
- Drive 50 sessions × 8 answers through the public functions. Record function calls per response (count client calls plus scheduled runs from the local dashboard/logs) and bytes returned by participant queries per response.
- Record the results in the measurements doc and update the overview's §2 "What breaks first" table if the ranking changes.

**Live smoke** (owner approval required; cap in the status notes): the owner deploys to the new feedback projects. Then ≤10 real sessions with `allocatedMicros` ≤ 2,000,000 ($2). Confirm that spend in `stats` equals the sum of turn `costMicros` plus worst cases, and that nothing references the demo.

**Command:** `node --experimental-strip-types scripts/dev/feedback-load.mts --sessions 50 --answers 8` (Node 22). **Depends on:** T1.1–T1.10. **Out of scope:** load against cloud deployments. **Model fit:** Haiku.
