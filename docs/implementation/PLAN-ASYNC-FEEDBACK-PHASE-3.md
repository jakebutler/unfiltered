# Phase 3: Incremental per-session analysis and live themes

Read [PLAN-ASYNC-FEEDBACK-AT-SCALE.md](PLAN-ASYNC-FEEDBACK-AT-SCALE.md) §0 first. The design rationale is in §7 of that file. Paths are relative to the worktree root.

**Phase goal.** Every completed (or idle-partial) campaign session is mapped automatically into **observations**. An observation is a paraphrase plus an exact quote span from a participant source. Observations are assigned to codes in a per-campaign **codebook** that is consolidated and versioned. The operator sees a live themes board with deterministic counts and drill-down to quotes. Phase 3 does not replace `ANALYSIS_LIMITS` or the manual analysis path; the demo keeps them.

**Phase acceptance**
- All task tests pass. Typechecks are clean against baseline.
- The dev-split eval (T3.9) is reported. The **holdout split is not read in Phase 3**.
- T3.10's live map is recorded.

**Phase out of scope**
- Cross-session findings and publishing (Phase 4).
- Embeddings and vector search.
- Re-mapping already-mapped sessions after a codebook change (merges resolve through the merge map instead).
- Feeding codes back into interviews.
- Non-text evidence.

---

## T3.1 `observations.ts`: map prompt and validation (M)

**File (new):** `packages/research-core/src/observations.ts`

```ts
export const MAP_LIMITS = Object.freeze({ observationsPerSession: 40, paraphraseChars: 280, labelChars: 60, definitionChars: 280, maxRejectRatio: 0.5 });
export type MapSource = { sourceId: string; questionId: string; text: string };   // participant answers only, not superseded
export type CodeRef = { codeId: string; label: string; definition: string };
export type Valence = 'positive' | 'negative' | 'neutral' | 'mixed';
export type ValidObservation = { sourceId: string; questionId: string; start: number; end: number; quote: string; paraphrase: string; valence: Valence;
  codeId: string | null; proposed: { label: string; definition: string } | null };
export type MapRejection = { index: number; reason: 'schema' | 'unknown-source' | 'quote-not-found' | 'quote-ambiguous' | 'unknown-code' | 'both-code-and-proposal' | 'over-limit' };
export function mapMessages(input: { goals: string[]; questions: { id: string; question: string }[]; sources: MapSource[]; codes: CodeRef[] }): ChatMessage[];
export function validateMapOutput(raw: unknown, sources: MapSource[], codes: CodeRef[]): { observations: ValidObservation[]; rejected: MapRejection[]; failed: boolean };
```

**Prompt contract.** The system instruction says sources are untrusted data. It asks for `{"observations":[{"sourceId","quote","paraphrase","valence","codeId"?|"proposedCode"?:{"label","definition"}}]}`. Each quote is the shortest exact substring that supports the paraphrase. Exactly one of `codeId` or `proposedCode` is given. Reuse an existing code when its definition fits. There is no inference of emotion, intent or identity.
- Input is canonical JSON (`kit/json.ts`), bounded to `CAMPAIGN_LIMITS.mapMaxRequestBytes`. If the session exceeds it, truncate the oldest sources first and record `truncated: true` in the job receipt.

**Validation**
- Per item: zod schema; the source must be in the session; `locateExact` must succeed on that source's text (exact, unique; normalized matching is **not** used for evidence); the code must exist, or a proposal is given, not both. The item is dropped with a reason otherwise.
- Deduplicate identical `(sourceId,start,end,codeId|label)`.
- `failed = rejected/(total) > maxRejectRatio || total === 0 && sources.length > 0`. A session with zero substantive answers returns no observations and is not a failure.
- Offsets are UTF-16, the same coordinate system as `self-report` evidence in `apps/research-server/src/analysis.ts` `analysisMessages`, so `evidenceId({sessionId, kind:'self-report', id: sourceId, start, end})` from `packages/research-core/src/analysis.ts` is valid.

**Tests:** `packages/research-core/test/observations.test.ts`
- `invented quote rejected quote-not-found`
- `quote from another session's source rejected unknown-source`
- `duplicated quote occurrence rejected quote-ambiguous`
- `codeId and proposedCode together rejected`
- `offsets slice back to the quote including emoji`
- `>50% rejected marks failed`
- `prompt input never exceeds mapMaxRequestBytes and drops oldest sources first`
- `evidenceId built from an observation passes checkSelections shape`

**Command:** `npx vitest run --config packages/research-core/vitest.config.mts packages/research-core/test/observations.test.ts`
**Depends on:** T1.1. **Out of scope:** model calls. **Model fit:** a stronger model (prompt and validation); Haiku can write the test fixtures.

---

## T3.2 `codebook.ts`: consolidation invariants (M)

**File (new):** `packages/research-core/src/codebook.ts`

```ts
export const CODEBOOK_LIMITS = Object.freeze({ active: 60, pendingTrigger: 15, sessionsTrigger: 25, examplesPerPending: 3 });
export type Code = { codeId: string; label: string; definition: string; state: 'pending' | 'active' | 'merged'; mergedInto: string | null };
export type ConsolidationOp = { op: 'promote'; codeId: string } | { op: 'merge'; from: string; into: string } | { op: 'rename'; codeId: string; label: string; definition: string };
export function resolveCode(codes: ReadonlyMap<string, Code>, codeId: string): string;            // follows mergedInto; throws on cycle or missing
export function consolidationMessages(active: Code[], pending: (Code & { examples: string[] })[]): ChatMessage[];
export function applyConsolidation(codes: Code[], rawOps: unknown): { codes: Code[]; mergeMap: { from: string; to: string }[]; rejected: { index: number; reason: string }[] };
export function needsConsolidation(s: { pending: number; mappedSinceLastVersion: number }): boolean;   // pending >= 15 || mapped >= 25
```

**Invariants (enforced; ops that would break one are rejected individually)**
- Codes are never deleted. `merge` targets must be `active` (or `pending` promoted in the same op list, applied in order). A `from` code becomes `merged` with `mergedInto` set.
- No cycles. Every code resolves to exactly one `active` code.
- `rename` keeps `codeId`.
- After application, the active count is ≤ 60. If promotions would exceed it, the extra pending codes stay `pending`.
- Pending codes not mentioned stay pending.

**Tests:** `packages/research-core/test/codebook.test.ts`
- `property: 500 seeded random op lists keep every code resolvable to one active code with no cycles`
- `merge into merged code rejected`
- `rename keeps id`
- `active cap respected`
- `malformed ops rejected individually, valid ops still applied`
- `needsConsolidation thresholds`

**Command:** `npx vitest run --config packages/research-core/vitest.config.mts packages/research-core/test/codebook.test.ts`
**Depends on:** none (uses `ChatMessage` from T1.1). **Out of scope:** splitting codes (v1 cannot split; the operator can unpin or hide in T3.8). **Model fit:** a stronger model.

---

## T3.3 Schema: observations, codes, code-sessions, versions, jobs, question stats (S)

**File:** `convex/schema.ts`

```ts
researchObservations: defineTable({ campaignId: v.id('researchCampaigns'), sessionId: v.id('researchSessions'), questionId: v.string(), sourceId: v.string(),
  start: v.number(), end: v.number(), quoteHash: v.string(), paraphrase: v.string(), valence: v.union(v.literal('positive'), v.literal('negative'), v.literal('neutral'), v.literal('mixed')),
  codeId: v.string(), jobId: v.id('researchJobs'), consentEpoch: v.number(), sharingEpoch: v.number(), excluded: v.boolean(), createdAt: v.number() })
  .index('by_campaignId_and_codeId', ['campaignId', 'codeId']).index('by_sessionId', ['sessionId']).index('by_campaignId_and_questionId', ['campaignId', 'questionId']),
researchCodes: defineTable({ campaignId: v.id('researchCampaigns'), codeId: v.string(), label: v.string(), definition: v.string(),
  state: v.union(v.literal('pending'), v.literal('active'), v.literal('merged')), mergedInto: v.union(v.string(), v.null()),
  questionIds: v.array(v.string()), sessionCount: v.number(), observationCount: v.number(), pinned: v.boolean(), hidden: v.boolean(), createdInVersion: v.number(), updatedAt: v.number() })
  .index('by_campaignId_and_codeId', ['campaignId', 'codeId']).index('by_campaignId_and_state_and_sessionCount', ['campaignId', 'state', 'sessionCount']),
researchCodeSessions: defineTable({ campaignId: v.id('researchCampaigns'), codeId: v.string(), sessionId: v.id('researchSessions') })
  .index('by_campaignId_and_codeId_and_sessionId', ['campaignId', 'codeId', 'sessionId']).index('by_sessionId', ['sessionId']),
researchCodebookVersions: defineTable({ campaignId: v.id('researchCampaigns'), version: v.number(), mergeMap: v.array(v.object({ from: v.string(), to: v.string() })), mappedSessions: v.number(), jobId: v.union(v.id('researchJobs'), v.null()), createdAt: v.number() })
  .index('by_campaignId_and_version', ['campaignId', 'version']),
researchJobs: defineTable({ campaignId: v.id('researchCampaigns'), kind: v.union(v.literal('session-map'), v.literal('consolidate'), v.literal('synthesize')),
  sessionId: v.union(v.id('researchSessions'), v.null()), state: v.union(v.literal('queued'), v.literal('leased'), v.literal('done'), v.literal('failed'), v.literal('unknown')),
  owner: v.union(v.string(), v.null()), leaseUntil: v.number(), attempts: v.number(), notBefore: v.number(), requestId: v.string(),
  receipt: v.union(v.null(), v.object({ model: v.string(), usage: v.union(v.null(), v.object({ promptTokens: v.number(), completionTokens: v.number() })), costMicros: v.number(), truncated: v.boolean(), rejected: v.number(), errorCode: v.union(v.string(), v.null()) })),
  createdAt: v.number(), updatedAt: v.number() })
  .index('by_state_and_notBefore', ['state', 'notBefore']).index('by_sessionId_and_kind', ['sessionId', 'kind']).index('by_campaignId_and_kind_and_state', ['campaignId', 'kind', 'state']).index('by_state_and_leaseUntil', ['state', 'leaseUntil']),
researchQuestionStats: defineTable({ campaignId: v.id('researchCampaigns'), questionId: v.string(), answered: v.number(), mapped: v.number(), lastNewCodeAtMapped: v.number(), saturated: v.boolean(), saturationOverride: v.boolean() })
  .index('by_campaignId_and_questionId', ['campaignId', 'questionId']),
```

Add to `researchCampaigns`: `codebookVersion: v.optional(v.number())`, `mappedSinceVersion: v.optional(v.number())`, `analysisModel: v.optional(<FEEDBACK_MODELS union>)` (default `qwen3.8-max`).

Add to `researchSessions`: `mapState: v.optional(v.union(v.literal('pending'), v.literal('mapped'), v.literal('failed'), v.literal('excluded')))`.

**Tests:** `packages/research-core/test/analysis-schema-native.test.ts`: `round-trip and index queries`.
**Commands:** codegen, `npx tsc -p convex/tsconfig.json`, the test. **Depends on:** T1.3. **Model fit:** Haiku.

---

## T3.4 Job queue: enqueue, pump, lease, recover (M)

**File (new):** `convex/researchJobs.ts`

```ts
export const JOB_CONCURRENCY = 2; export const JOB_LEASE_MS = 10 * 60_000; export const JOB_MAX_ATTEMPTS = 2;
export async function enqueueJob(ctx: MutationCtx, input: { campaignId: Id<'researchCampaigns'>; kind: 'session-map' | 'consolidate' | 'synthesize'; sessionId?: Id<'researchSessions'>; notBefore?: number }): Promise<Id<'researchJobs'> | null>;
export const pump = internalMutation({ args: {}, returns: v.null() });
export const complete = internalMutation({ args: { jobId: v.id('researchJobs'), owner: v.string(), receipt: jobReceipt }, returns: v.boolean() });
export const fail = internalMutation({ args: { jobId: v.id('researchJobs'), owner: v.string(), state: v.union(v.literal('failed'), v.literal('unknown')), receipt: jobReceipt }, returns: v.boolean() });
export const recover = internalMutation({ args: {}, returns: v.null() });
```

**enqueueJob dedupe**
- `session-map`: one job per session (`by_sessionId_and_kind`) unless the previous one is `failed` and `attempts < JOB_MAX_ATTEMPTS`.
- `consolidate` and `synthesize`: at most one `queued|leased` job per campaign and kind.
- After inserting, `ctx.scheduler.runAfter(0, internal.researchJobs.pump, {})`.

**pump**
1. `leased = take(JOB_CONCURRENCY)` of state `leased` with an unexpired lease. If there are already `JOB_CONCURRENCY` → return.
2. Lease the oldest due `queued` jobs: `owner = random`, `leaseUntil = now + JOB_LEASE_MS`, `attempts += 1`, `requestId = '<jobId>-<attempts>'`.
3. Schedule the kind's action with `{jobId, owner}`: `internal.researchSessionMap.run`, `internal.researchConsolidate.run` or `internal.researchSynthesis.run`.

**complete/fail.** Both return `false` if the owner or lease does not match (stale worker). Both then `runAfter(0, pump)`.

**Unknown policy (owner decision D7).** An `unknown` job is re-queued **once** with a new `requestId` if `attempts < JOB_MAX_ATTEMPTS`; otherwise it becomes `failed`. Its worst-case cost is charged (the T3.5 settlement rule).

**recover** is added to the 15-minute feedback cron from T1.7:
1. Re-queue `leased` jobs whose lease expired, as `unknown` handling.
2. Enqueue `session-map` for idle sessions settled `idle` with ≥2 answers and no map job.
3. Call `pump`.

**Session completion hook.** In `settleCampaignSession` (T1.7), when the campaign is mappable, set `mapState:'pending'` and `enqueueJob(session-map)`. Flip `MAP_ENABLED` to `true`.

**Tests:** `packages/research-core/test/jobs-native.test.ts`
- `enqueue twice for one session creates one job`
- `pump never leases more than 2 concurrently`
- `stale owner cannot complete`
- `expired lease recovered exactly once then failed after max attempts`
- `completion schedules pump again`
- `demo sessions never enqueue`

**Command:** `npx vitest run --config packages/research-core/vitest.config.mts packages/research-core/test/jobs-native.test.ts`
**Depends on:** T3.3. **Out of scope:** priorities, per-campaign fairness beyond FIFO. **Model fit:** a stronger model.

---

## T3.5 Session map job (M)

**File (new):** `convex/researchSessionMap.ts` (Convex runtime action plus internal query and mutation).

```ts
export const material = internalQuery({ args: { jobId: v.id('researchJobs'), owner: v.string() }, returns: v.union(v.null(), mapMaterial) }); // sources: participant answers (isAnswerSource from convex/finalReview.ts), not superseded, consent.analysis true; codes: active + pending (<= 60+pending), campaign goals/questions
export const run = internalAction({ args: { jobId: v.id('researchJobs'), owner: v.string() }, returns: v.null() });
export const applyMap = internalMutation({ args: { jobId, owner, observations: v.array(validObservation), proposed: v.array(v.object({ label: v.string(), definition: v.string(), index: v.number() })), receipt: jobReceipt }, returns: v.boolean() });
```

**run**
1. `material`. If it is null (the session withdrew or was excluded), `complete` with `rejected:0` and do nothing else.
2. `callDigitalOcean` with `analysisModel`, `json:true`, temperature 0, and `mapMaxOutputTokens`.
3. `validateMapOutput`. Then `applyMap`, or `fail` with `failed|unknown` according to the T1.6 error mapping.

**applyMap**
1. Re-check the session's consent epoch. If it changed, discard everything.
2. Create each proposed code as `pending` (`codeId = 'c' + random 10 chars`) with the `questionIds` it was seen on. Deduplicate proposals by case-folded label against existing codes and reuse matches.
3. Insert observations, with `codeId` resolved through `resolveCode`.
4. For each distinct resolved code in this session, insert a `researchCodeSessions` row if absent; on insert, `sessionCount += 1`. Always increment `observationCount`.
5. Update `researchQuestionStats` per answered question: `answered`, `mapped`, and `lastNewCodeAtMapped` when a new pending code was created for that question. Set the session's `mapState:'mapped'`.
6. Settle the map budget: `shard.reservedMicros -= session.pendingMapMicros`, `shard.chargedMicros += receipt.costMicros` (worst case for `unknown`), `pendingMapMicros = 0`.
7. `campaign.mappedSinceVersion += 1`. If `needsConsolidation`, `enqueueJob('consolidate')`.

**Tests:** `packages/research-core/test/session-map-native.test.ts` (fake fetch with canned map outputs)
- `valid output writes observations whose stored offsets slice to the quote`
- `invented quotes dropped, rest kept`
- `>50% invalid marks job failed and session mapState failed`
- `withdrawn-before-apply session writes nothing`
- `sessionCount counts distinct sessions, not observations`
- `map budget settled from usage; unknown charges worst case`
- `25th mapped session enqueues one consolidate job`
- `300 fake sessions: each applyMap writes <= 200 docs and counters equal audit (T3.7)`

**Command:** `npx vitest run --config packages/research-core/vitest.config.mts packages/research-core/test/session-map-native.test.ts`
**Depends on:** T3.1, T3.4. **Out of scope:** multimodal evidence, re-mapping. **Model fit:** a stronger model.

---

## T3.6 Codebook consolidation job (M)

**File (new):** `convex/researchConsolidate.ts`

```ts
export const material = internalQuery({ args: { jobId, owner }, returns: consolidateMaterial }); // active codes + up to 30 pending with <=3 example paraphrases each
export const run = internalAction({ args: { jobId, owner }, returns: v.null() });
export const applyConsolidationResult = internalMutation({ args: { jobId, owner, ops: v.any(), receipt: jobReceipt }, returns: v.boolean() });
export const moveCodeSessions = internalMutation({ args: { campaignId, from: v.string(), to: v.string(), cursor: v.union(v.string(), v.null()) }, returns: v.null() }); // pages of 200
```

**applyConsolidationResult**
1. Run `applyConsolidation` over the current codes (reloaded) and write the code states.
2. Insert `researchCodebookVersions` with `version + 1` and the merge map. Reset `campaign.mappedSinceVersion = 0`.
3. For each merge, schedule `moveCodeSessions(from → to)`. This moves `researchCodeSessions` rows, deletes duplicates (the session is already counted under `to`), adjusts both `sessionCount`s, and patches matching observations' `codeId` to `to` in the same pages.
4. Page until done. Each page reschedules itself.

DO costs are recorded on the job receipt and charged to a shard (`shardFor(jobId)`) as campaign spend. There is no session reservation; consolidation spend is checked against `allocatedMicros − charged − reserved` before leasing. If it is insufficient, the job stays queued and the board shows "budget exhausted".

**Tests:** `packages/research-core/test/consolidate-native.test.ts`
- `merge moves code-session rows and keeps distinct session counts exact`
- `observations re-pointed in pages; no page exceeds 200 writes`
- `version increments and mergeMap stored`
- `malformed ops leave codes unchanged and job done with rejected count`
- `insufficient budget leaves job queued`

**Command:** `npx vitest run --config packages/research-core/vitest.config.mts packages/research-core/test/consolidate-native.test.ts`
**Depends on:** T3.2, T3.5. **Model fit:** a stronger model.

---

## T3.7 Withdrawal exclusion and counter audit (S)

**Files**
- `convex/researchAnalysisHooks.ts` (new)
- `convex/capture.ts` (`changeConsent`: add one guarded call after the existing `invalidateSession` scheduling)
- `convex/researchCampaigns.ts` (`excludeSession`/`includeSession` operator mutations)

```ts
export const excludeSessionFromAnalysis = internalMutation({ args: { sessionId: v.id('researchSessions'), reason: v.union(v.literal('withdrawn'), v.literal('operator'), v.literal('quality')), cursor: v.union(v.string(), v.null()) }, returns: v.null() });
export const includeSession = internalMutation({ args: { sessionId }, returns: v.null() }); // re-enqueues session-map if not withdrawn
export const audit = internalAction({ args: { campaignId: v.id('researchCampaigns') }, returns: v.object({ ok: v.boolean(), mismatches: v.array(v.object({ codeId: v.string(), stored: v.number(), actual: v.number() })) }) }); // paginated recount
```
- On a consent change where `analysis` becomes false or `storage` is revoked, schedule `excludeSessionFromAnalysis(withdrawn)`. This marks observations `excluded:true`, deletes the session's `researchCodeSessions` rows (decrementing `sessionCount`), decrements `observationCount` and `researchQuestionStats.answered/mapped`, and sets `mapState:'excluded'`. It pages at 200.
- Synthesis and report invalidation are Phase 4 (T4.5).

**Tests:** `packages/research-core/test/withdrawal-analysis-native.test.ts`
- `withdrawal excludes observations and decrements every counter`
- `audit reports no mismatches after 300 fake sessions with merges and withdrawals`
- `operator exclude then include restores counts`

**Command:** `npx vitest run --config packages/research-core/vitest.config.mts packages/research-core/test/withdrawal-analysis-native.test.ts`
**Depends on:** T3.5. **Model fit:** Haiku, with a stronger-model review.

---

## T3.8 Themes board UI (M)

**Files:** `apps/research/src/ThemesBoard.tsx` (new), a tab in `ProjectWorkspace.tsx` next to Campaigns, and `convex/researchThemes.ts` (new queries):

```ts
export const codes = operatorQuery({ args: { campaignId, questionId: v.optional(v.string()), paginationOpts }, returns: page(codeView) });   // active codes by sessionCount desc via by_campaignId_and_state_and_sessionCount
export const observations = operatorQuery({ args: { campaignId, codeId: v.string(), paginationOpts }, returns: page(observationView) });  // quote text sliced server-side from the source, session link, valence
export const pipeline = operatorQuery({ args: { campaignId }, returns: v.object({ completed: v.number(), mapped: v.number(), queued: v.number(), failed: v.number(), excluded: v.number(), codebookVersion: v.number(), oldestQueuedAt: v.union(v.number(), v.null()) }) });
export const setCodeFlags = operatorMutation({ args: { campaignId, codeId: v.string(), pinned: v.optional(v.boolean()), hidden: v.optional(v.boolean()) }, returns: v.null() });
```

- The UI shows the pipeline strip, a question filter, and the code list with `sessionCount` and `% of answered` (the denominator from `researchQuestionStats.answered`). Clicking a code drills down to paginated quotes linking to the session transcript (existing sessions tab). It has pin and hide controls and a "Re-run failed maps" button that calls `includeSession` for failed sessions.
- Copy states that counts are of participants, not mentions.

**Tests:** `apps/research/test/themes-board.test.tsx`
- `renders counts and percentages from fixture`
- `drill-down paginates`
- `hidden codes excluded by default`
- `pipeline shows backlog age`

**Command:** `npm run research:test -- apps/research/test/themes-board.test.tsx`
**Depends on:** T3.5. **Out of scope:** charts beyond a simple bar per code. **Model fit:** Haiku.

---

## T3.9 Eval corpus, metrics and eval script (M)

**Files**
- `packages/research-core/test/fixtures/feedback-eval/{study-a,study-b,study-c}.json`
- `packages/research-core/src/eval-metrics.ts`
- `scripts/dev/feedback-eval.mts`
- `scripts/dev/feedback-eval-generate.mts`

**Fixture format**
```json
{ "study": { "goals": ["…"], "questions": [{ "id": "q1", "question": "…" }] },
  "responses": [{ "id": "r001", "split": "dev|holdout", "answers": { "q1": "…" } }],
  "planted": [{ "themeId": "t1", "label": "…", "questionId": "q1", "responseIds": ["r001", "…"] }] }
```
- 100 responses per study, 300 in total. Planted prevalences are 40/15/5/2% plus distractors: sarcasm, multi-theme, off-topic, low-effort and duplicates. The split is 1/3 dev, 2/3 holdout.
- Generate once with `feedback-eval-generate.mts`. This is an owner-approved DO run with a stated cap, using an allowed model, and the owner hand-corrects the output. After that the fixtures are frozen. Record their SHA-256 in the overview status notes.

```ts
// eval-metrics.ts
export function themeRecovery(planted: { themeId: string; responseIds: string[] }[], codes: { codeId: string; responseIds: string[] }[], minJaccard?: number /* 0.5 */): { recovered: string[]; missed: string[]; unmatchedCodes: string[] };
export function prevalenceError(planted, codes, matches): { themeId: string; planted: number; estimated: number; absError: number }[];
export function adjustedRandIndex(a: Map<string, string>, b: Map<string, string>): number;
```

**Script:** `node --experimental-strip-types scripts/dev/feedback-eval.mts --split dev --model qwen3.8-max --cap-calls 150 [--shuffle-seed N]`
- It runs `mapMessages`, `validateMapOutput`, `consolidationMessages` and `applyConsolidation` in-process against DO (key from env `DIGITALOCEAN_MODEL_ACCESS_KEY`; the cap is enforced in-process).
- It writes `docs/implementation/feedback-eval/<date>-<split>-<model>.json` containing the metrics, cost and the p50/p95 latency.
- `--split holdout` requires `--holdout-ack <text>`. The status notes must record who authorized it. Phase 3 never uses the holdout.

**Tests:** `packages/research-core/test/eval-metrics.test.ts`
- `perfect clustering gives recall 1 and ARI 1`
- `Jaccard threshold boundary`
- `prevalence error computed per theme`
- `fixtures validate against the format and splits are disjoint`

**Command:** `npx vitest run --config packages/research-core/vitest.config.mts packages/research-core/test/eval-metrics.test.ts`
**Depends on:** T3.1, T3.2. **Out of scope:** LLM-as-judge scoring. **Model fit:** a stronger model for the corpus design and metrics; Haiku for the script plumbing.

---

## T3.10 Owner-approved live map (≤30 sessions) (S)

On the feedback deployment, with the cap stated in the status notes (≤60 DO calls), map ≤30 real or synthetic campaign sessions. Confirm:
- every stored quote equals its source slice;
- `audit` returns `ok`;
- the board renders;
- spend appears in `stats`.

Record the results in `docs/implementation/FEEDBACK-MEASUREMENTS.md`. **Depends on:** T3.5–T3.9.
