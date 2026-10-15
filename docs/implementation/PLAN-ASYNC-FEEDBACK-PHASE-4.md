# Phase 4: Cross-session synthesis → review → publish/share

Read [PLAN-ASYNC-FEEDBACK-AT-SCALE.md](PLAN-ASYNC-FEEDBACK-AT-SCALE.md) §0 first. The design rationale is in §7 of that file. Paths are relative to the worktree root.

**Phase goal.**
- The operator requests a synthesis, or one is auto-drafted.
- Draft findings arrive. Each has a model-written statement grounded in a bounded evidence sample, **deterministic prevalence** computed in code, and links to every supporting observation.
- The operator edits findings, approves excerpts and chooses a citation mode per finding, then publishes an immutable versioned report.
- The client opens it through the existing password share flow (`researchShares`, `researchViewerSessions`).
- New sessions never change a published report. Withdrawal after publication marks the report for review.

**Phase acceptance**
- All task tests pass. Typechecks are clean against baseline.
- **The holdout eval meets the thresholds in T4.7.**
- One end-to-end run is recorded.

**Phase out of scope**
- Changing the demo's manual analysis/report path, or `ANALYSIS_LIMITS`.
- Charts and exports (CSV/PDF).
- Report diffing between versions.
- Client comments.

---

## T4.1 `synthesis.ts`: sampling, prevalence, prompt, validation (M)

**File (new):** `packages/research-core/src/synthesis.ts`

```ts
export const SYNTHESIS_LIMITS = Object.freeze({ findings: 40, supportsSample: 12, counterSample: 6, minSessions: 2, maxRequestBytes: 48_000, maxOutputTokens: 1_200, autoMinNewSessions: 10, autoGrowth: 0.2, autoMinIntervalMs: 3_600_000 });
export type SynthesisObservation = { observationId: string; sessionId: string; sourceId: string; questionId: string; start: number; end: number; quote: string; paraphrase: string; valence: Valence; sessionCreatedAt: number; consentEpoch: number; sharingEpoch: number; retainApprovedExcerpts: boolean; sourceHash: string };
export function sampleSupports(obs: SynthesisObservation[], k: number, seed: string): SynthesisObservation[];   // <=1 per session first; spread across arrival quartiles; deterministic for a seed
export function sampleCounter(obs: SynthesisObservation[], codeValence: Valence, k: number, seed: string): SynthesisObservation[]; // opposite valence, same questions
export function toEvidence(o: SynthesisObservation): Evidence;   // kind 'self-report', id sourceId, start/end, text = quote (Evidence from analysis.ts)
export function synthesisMessages(input: { goals: string[]; question: string; code: { label: string; definition: string }; prevalenceText: string; supports: Evidence[]; counter: Evidence[] }): ChatMessage[];
export function validateSynthesisFinding(raw: unknown, evidence: Evidence[]): Finding;  // wraps validateFindings([raw], evidence) from analysis.ts; type must be 'self-report' or 'interpretation'
export function prevalence(sessions: number, denominator: number): { sessions: number; denominator: number; percent: number };  // percent rounded to integer; denominator 0 -> percent 0
export function renderPrevalence(p: ReturnType<typeof prevalence>): string;  // "31 of 212 participants who answered (15%)"
export function shouldAutoSynthesize(s: { mappedNow: number; mappedAtLast: number; lastAt: number | null; now: number }): boolean;
```

The model writes only the statement, the type, supports/counterevidence ids drawn from the sample, and limitations. **The model never writes counts.** The prompt receives the prevalence text as read-only context and is told not to restate numbers. Validation rejects any digit sequence in `statement` that is not present in `prevalenceText` or a quote.

**Tests:** `packages/research-core/test/synthesis.test.ts`
- `sampleSupports deterministic per seed and prefers distinct sessions`
- `counter sample uses opposite valence`
- `finding citing an id outside the sample rejected`
- `statement with invented number rejected`
- `prevalence and render text`
- `auto-synthesis thresholds`
- `toEvidence output passes validateFindings provenance rules for self-report`

**Command:** `npx vitest run --config packages/research-core/vitest.config.mts packages/research-core/test/synthesis.test.ts`
**Depends on:** T3.1. **Model fit:** a stronger model.

---

## T4.2 Schema: syntheses, findings, report evidence, report fields (S)

**File:** `convex/schema.ts`

```ts
researchSyntheses: defineTable({ campaignId: v.id('researchCampaigns'), version: v.number(), codebookVersion: v.number(), mappedSessions: v.number(),
  state: v.union(v.literal('running'), v.literal('draft'), v.literal('failed')), trigger: v.union(v.literal('manual'), v.literal('auto')), jobId: v.id('researchJobs'), createdAt: v.number(), finishedAt: v.union(v.number(), v.null()) })
  .index('by_campaignId_and_version', ['campaignId', 'version']),
researchSynthesisFindings: defineTable({ synthesisId: v.id('researchSyntheses'), campaignId: v.id('researchCampaigns'), findingId: v.string(), codeId: v.string(), questionId: v.string(),
  modelStatement: v.string(), statement: v.string(), type: v.union(v.literal('self-report'), v.literal('interpretation')), limitations: v.string(),
  supports: v.array(v.string()), counterevidence: v.array(v.string()),       // observation ids from the sample
  sessions: v.number(), denominator: v.number(), singleParticipant: v.boolean(),
  citationMode: v.union(v.literal('excerpts'), v.literal('count-only')), approvedExcerpts: v.array(v.string()), // observation ids
  hidden: v.boolean(), order: v.number(), revision: v.number() })
  .index('by_synthesisId_and_order', ['synthesisId', 'order']).index('by_synthesisId_and_findingId', ['synthesisId', 'findingId']),
researchReportEvidence: defineTable({ reportId: v.id('researchReports'), findingId: v.string(), observationId: v.id('researchObservations'), sessionId: v.id('researchSessions'), evidenceId: v.string(), role: v.union(v.literal('supports'), v.literal('counter')), excerpt: v.union(v.string(), v.null()) })
  .index('by_reportId_and_findingId', ['reportId', 'findingId']).index('by_sessionId', ['sessionId']),
researchReportFindings: defineTable({ reportId: v.id('researchReports'), findingId: v.string(), statement: v.string(), type: v.string(), limitations: v.string(), prevalenceText: v.string(), sessions: v.number(), denominator: v.number(), citationMode: v.string(), order: v.number() })
  .index('by_reportId_and_order', ['reportId', 'order']),
```

Add to `researchReports`, all optional:

```ts
synthesisId: v.id('researchSyntheses'),
publishState: v.union(v.literal('publishing'), v.literal('published')),
needsReview: v.boolean(),
```

The existing inline arrays stay; campaign reports store `findings: []`, `evidence: []`.

Add to `researchCampaigns`: `lastSynthesisAt: v.optional(v.number())`, `mappedAtLastSynthesis: v.optional(v.number())`.

**Tests:** `packages/research-core/test/synthesis-schema-native.test.ts`: `round-trip; existing report fixtures unchanged`.
**Commands:** codegen, `npx tsc -p convex/tsconfig.json`, the test. **Depends on:** T3.3. **Model fit:** Haiku.

---

## T4.3 Synthesis job (M)

**File (new):** `convex/researchSynthesis.ts`

```ts
export const request = operatorMutation({ args: { campaignId }, returns: v.id('researchJobs') }); // enqueueJob('synthesize'), trigger manual
export const material = internalQuery({ args: { jobId, owner, cursor: v.union(v.string(), v.null()) }, returns: … }); // eligible codes: active, not hidden, sessionCount >= 2 or pinned; top 40 by sessionCount; per code its non-excluded observations (paged)
export const run = internalAction({ args: { jobId, owner }, returns: v.null() });
export const writeFinding = internalMutation({ args: { synthesisId, jobId, owner, finding: …, costMicros: v.number() }, returns: v.boolean() });
export const finishSynthesis = internalMutation({ args: { synthesisId, jobId, owner, state: v.union(v.literal('draft'), v.literal('failed')) }, returns: v.null() });
```

**run**
1. Create the synthesis row (`running`, version + 1).
2. Process codes in descending `sessionCount`. For each code:
   - load its observations (paged; ≤2,000 per code are considered for sampling);
   - sample with seed `synthesisId:codeId`;
   - call DO (`analysisModel`, temperature 0, json);
   - run `validateSynthesisFinding`;
   - on success, `writeFinding` with `sessions = code.sessionCount` and `denominator = questionStats.answered` for the code's primary question (the most frequent `questionId` among its observations);
   - on validation failure, record a finding row with `hidden:true` and statement `"[synthesis failed validation]"` so the operator sees the gap. Do not retry.
3. Check the budget before each call, the same way as T3.6. If it is insufficient, stop and finish `draft` with the findings so far, setting `limitations` on the synthesis.
4. Process codes sequentially in one action; 40 calls at ~5 s is well under the action limit.
5. Update `campaign.lastSynthesisAt` and `mappedAtLastSynthesis`.

**Auto-trigger.** In `applyMap` (T3.5), when `shouldAutoSynthesize` is true, call `enqueueJob('synthesize')` with trigger `auto`.

**Tests:** `packages/research-core/test/synthesis-native.test.ts` (fake fetch)
- `draft has one finding per eligible code with prevalence equal to code-session count over answered`
- `single-session pinned code flagged singleParticipant`
- `invalid model output yields hidden failed finding, others unaffected`
- `budget exhaustion stops early with draft state`
- `auto trigger fires once per threshold crossing and respects the hourly interval`

**Command:** `npx vitest run --config packages/research-core/vitest.config.mts packages/research-core/test/synthesis-native.test.ts`
**Depends on:** T4.1, T4.2, T3.4. **Model fit:** a stronger model.

---

## T4.4 Operator review mutations (S)

**File:** `convex/researchSynthesis.ts`

```ts
export const editFinding = operatorMutation({ args: { findingRowId: v.id('researchSynthesisFindings'), expectedRevision: v.number(), statement: v.optional(v.string()), limitations: v.optional(v.string()), hidden: v.optional(v.boolean()), order: v.optional(v.number()), citationMode: v.optional(v.union(v.literal('excerpts'), v.literal('count-only'))) }, returns: v.number() });
export const approveExcerpt = operatorMutation({ args: { findingRowId, observationId: v.id('researchObservations'), approved: v.boolean() }, returns: v.null() });
export const listFindings = operatorQuery({ args: { synthesisId, paginationOpts }, returns: page(findingView) });
export const findingEvidence = operatorQuery({ args: { findingRowId, role: v.union(v.literal('supports'), v.literal('all')), paginationOpts }, returns: page(observationView) }); // 'all' pages every observation of the code
```

**Rules**
- An edited statement keeps `modelStatement` and is still checked by the invented-number rule (T4.1). The statement is ≤2,000 characters (`ANALYSIS_LIMITS.text`).
- `approveExcerpt` requires the observation to belong to the finding's code (resolved) and not be excluded. Its session's consent must have `shareTranscript` or `retainApprovedExcerpts` true, the same rule as the existing excerpt approval in the report path.
- Excerpts are ≤12 per finding.

**Tests:** `packages/research-core/test/synthesis-review-native.test.ts`
- `edit keeps modelStatement and bumps revision`
- `approve rejects observation from another code`
- `approve rejects session without sharing consent`
- `excerpt cap 12`
- `other operator denied`

**Command:** `npx vitest run --config packages/research-core/vitest.config.mts packages/research-core/test/synthesis-review-native.test.ts`
**Depends on:** T4.3. **Model fit:** Haiku.

---

## T4.5 Publish from synthesis and client report queries (M)

**Files:** `convex/researchReports.ts` (add functions; do not change existing ones), `convex/reportAccess.ts` (add campaign queries), `convex/researchAnalysisHooks.ts` (withdrawal → `needsReview`).

```ts
export const publishSynthesis = operatorMutation({ args: { clientId, projectId, synthesisId, requestId: v.string(), title: v.string(), expiresInDays: v.number() }, returns: v.id('researchReports') }); // <= ANALYSIS_LIMITS.reportDays
export const snapshotReport = internalMutation({ args: { reportId, cursor: v.union(v.string(), v.null()), findingIndex: v.number() }, returns: v.null() }); // pages of 200 evidence rows; sets publishState 'published' at end
// reportAccess.ts (viewer-session authorized like the existing report queries)
export const campaignFindings = query({ args: { viewerToken: v.string(), paginationOpts }, returns: page(clientFindingView) });
export const campaignExcerpts = query({ args: { viewerToken: v.string(), findingId: v.string(), paginationOpts }, returns: page(v.object({ excerpt: v.string(), evidenceId: v.string() })) });
```

**publishSynthesis**
- The synthesis must be `draft`. Every visible finding with `citationMode:'excerpts'` needs ≥1 approved excerpt.
- Each approved excerpt must still equal `source.text.slice(start,end)` (re-read). This is the same "exact source excerpt" guarantee as `validatePublication`.
- Insert the report (`publishState:'publishing'`, `synthesisId`, `findings:[]`, `evidence:[]`, `previewHash` = hash of the finding rows). Copy the visible findings to `researchReportFindings`, with `prevalenceText` frozen.
- Schedule `snapshotReport`, which copies **all** current supporting observation ids per finding into `researchReportEvidence`. The `excerpt` text is set only for approved ones. It also inserts `researchDerivedDependencies` rows `{sessionId, reportId, active:true}` (one per distinct session).

**Client queries**
- They return only `publishState:'published'` reports and only `excerpt !== null` rows.
- `count-only` findings return prevalence and no excerpts.
- Raw grants and downloads are not offered for campaign reports in v1.

**Withdrawal after publish.** Extend `excludeSessionFromAnalysis` (T3.7): for each active `researchDerivedDependencies` row with a `reportId`, patch the report `needsReview:true` and null out that session's excerpts in `researchReportEvidence`. The client view then drops them immediately. The operator UI shows the review banner.

**Tests:** `packages/research-core/test/synthesis-publish-native.test.ts`
- `publish blocked when an excerpts-mode finding has no approved excerpt`
- `publish rejects excerpt whose source text changed`
- `snapshot copies every supporting observation in pages`
- `report is immutable: 20 new mapped sessions leave previewHash and client findings unchanged`
- `client sees only approved excerpts; count-only shows prevalence only`
- `withdrawal after publish sets needsReview and removes that session's excerpt from client view`
- `unpublished (publishing) report invisible to client`

**Command:** `npx vitest run --config packages/research-core/vitest.config.mts packages/research-core/test/synthesis-publish-native.test.ts packages/research-core/test/reports.test.ts`
**Depends on:** T4.4. **Out of scope:** raw media grants, report versions diff. **Model fit:** a stronger model.

---

## T4.6 Findings, preview and client report UI (M)

**Files**
- `apps/research/src/FindingsWorkspace.tsx`: a campaign branch. When the project has campaigns, show a "Synthesis" panel: request, version list, findings editor (statement, limitations, order, hide, citation mode) and an evidence drawer with approve toggles.
- `apps/research/src/PublicationPreview.tsx`: a campaign preview rendering exactly what `campaignFindings` returns.
- `apps/research/src/ClientReportApp.tsx`: a campaign report layout with paginated findings, the prevalence line and approved excerpts.

Existing demo report rendering is unchanged.

**Tests**
- `apps/research/test/synthesis-workspace.test.tsx`:
  - `edits persist with revision`
  - `approve toggles update count`
  - `publish button disabled with reason until excerpts present`
  - `needsReview banner`
- `apps/research/test/client-campaign-report.test.tsx`:
  - `renders prevalence text verbatim`
  - `count-only finding shows no quotes`
  - `paginates findings`

**Command:** `npm run research:test -- apps/research/test/synthesis-workspace.test.tsx apps/research/test/client-campaign-report.test.tsx`
**Depends on:** T4.5. **Model fit:** Haiku.

---

## T4.7 Holdout eval and end-to-end acceptance (M)

1. Extend `scripts/dev/feedback-eval.mts` with `--synthesize`. It runs synthesis over the clustered output and adds finding-level metrics (each planted theme is recovered by a non-hidden finding).
2. The **holdout** run (200 responses) needs owner authorization and a call cap (≈ 200 map + ~10 consolidation + ~90 synthesis calls; ≈ $5 on `qwen3.8-max`). Use `--holdout-ack`. Thresholds:
   - planted-theme recall ≥ 90% for themes with ≥5% prevalence;
   - prevalence absolute error ≤ 5 points for themes with ≥10%;
   - ≤ 2 unmatched (non-planted) findings per study;
   - ARI ≥ 0.7 between two runs with different `--shuffle-seed`;
   - 100% of stored quotes equal their source slices.
3. **Owner audit:** 50 random observation→code assignments, sampled by the script into `docs/implementation/feedback-eval/audit-<date>.csv`. Pass if ≥ 85% are judged correct.
4. **End to end on the feedback deployment:** campaign link → ≥20 responses (owner-invited people or synthetic) → map → consolidate → synthesize → edit → publish → client password view → one withdrawal → `needsReview` shown. Record the results in `docs/implementation/FEEDBACK-MEASUREMENTS.md`.

If a threshold fails, fix the prompts or limits on the **dev** split only, then re-run the holdout once more with owner approval. After two holdout failures, stop and escalate to the owner. Do not keep tuning against the holdout.

**Depends on:** T4.1–T4.6. **Model fit:** a stronger model.
