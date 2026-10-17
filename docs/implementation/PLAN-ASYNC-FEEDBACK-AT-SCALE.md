# Plan: Unfiltered as an async mass user-feedback platform

Status: proposal for owner review, written 2026-10-14. Nothing here is implemented, provisioned or approved. It makes no provider calls, account changes or deployments. Work starts once the clinic intake track and the questionnaire-template ("pack") track finish.

**Documents.** This file holds the overview, workspace rules, task status, design rationale and owner decisions. Task-level specs, written so another agent can implement each task from the doc alone, are in `PLAN-ASYNC-FEEDBACK-PHASE-1.md` … `PLAN-ASYNC-FEEDBACK-PHASE-5.md` (same directory).

**One-line recommendation.** Build "campaign mode" inside the existing research codebase (`apps/research`, `convex/`, `packages/research-core`). Keep research's own interview engine (`packages/research-core/src/interview.ts`). Share leaf primitives and the questionnaire-pack *format* with the clinic, but not the clinic turn engine. Deploy to a **new** Free Convex project and a **new** Vercel Hobby project, so the research demo and its allowances are never touched. Analysis becomes incremental: an extraction pass per session, then a versioned codebook with deterministic counts, then synthesis of bounded samples. Findings still cite exact quotes.

---

## 0. Workspace and implementation rules (read before any task)

### Where to work
- **Worktree:** `/Volumes/rexy/GitHub/codex-worktrees/unfiltered-foundation/unfiltered`. Do not create another worktree or clone. The primary checkout `/Volumes/rexy/GitHub/unfiltered` is a different branch with unrelated WIP; never edit it.
- **Branch:** `codex/unfiltered-foundation`. It is shared with the clinic track. Do not switch, rebase or force-push.
- The tree has a large pre-existing dirty/untracked set (`docs/implementation/evidence/*`, `.stream-chunk-diagnostic-stage/` and others). Preserve it. **Never** run `git add -A`, `git add .`, `git reset`, `git stash`, `git clean` or `git checkout -- <path>` on files you did not create.
- Use absolute paths. Agent shells reset cwd between calls.
- Node 22 is the known-good runtime (`/Users/jacobbutler/.nvm/versions/node/v22.22.3/bin/node`). `node_modules` is already installed. Add no dependency without listing it in the task.

### Commands (run from the worktree root)
| Purpose | Command |
|---|---|
| Convex functions typecheck | `npx tsc -p convex/tsconfig.json` |
| Research UI typecheck | `npm run research:typecheck` |
| Research hosting typecheck | `npx tsc -p tsconfig.research-hosting.json` |
| research-core and Convex tests (convex-test) | `npx vitest run --config packages/research-core/vitest.config.mts [file…]` |
| Research UI tests | `npm run research:test -- [file…]` (config `apps/research/vitest.config.mts`) |
| Research server tests | `npx vitest run --config apps/research-server/vitest.config.mts [file…]` |
| Research hosting tests | `npx vitest run --config vitest.research-hosting.config.mts [file…]` |
| Convex codegen (after any `convex/schema.ts` or new `convex/*.ts`) | `npx convex dev --once --env-file infra/research/.env.feedback.local`, against a **local** backend only (T1.10 creates the env file; it is gitignored by `.env*`). Commit the regenerated `convex/_generated/*` together with the schema change. |

- **Baseline first.** Before a task's first edit, run the suites that task names and record any pre-existing failures in the status table's Notes column. A task is done when its named tests pass and no previously passing test in those suites fails.
- **Do not run** the clinic suites (`foundation:test`, `clinic:*`) unless a task says so. This track must not edit `packages/clinic-*`, `packages/clinical-core`, `apps/clinic*` or `infra/cloud/vercel/*.ts` (clinic hosting).
- **Tests use fakes.** Stub `fetch` with `vi.stubGlobal('fetch', …)` or inject a `fetcher`. No test may reach DigitalOcean, Deepgram, ElevenLabs, Resend, Turnstile or any Convex/Vercel cloud deployment.

### Commit rules
- Commit only when the coordinator or owner asks. Use explicit pathspecs: `git add -- <file> <file>`; never a directory or glob.
- **Never commit** `docs/implementation/evidence/`, `infra/cloud/.private/`, any `.env*` file, `infra/research/operator.private.json` or `.stream-chunk-diagnostic-stage/`.
- Commit messages: `feedback(T<id>): <summary>`. One task per commit where practical.

### Constraints (non-negotiable)
1. **DigitalOcean inference only** for reasoning and vision. The allowed model ids are those in `FEEDBACK_MODELS` (T1.1): `qwen3.8-max`, `glm-5.3-flash`, `deepseek-v4.1-flash`. No OpenAI (including `gpt-oss`), Anthropic or Arcee runtime models, and no fallback to another provider. Speech may use Deepgram and ElevenLabs. Email uses Resend.
2. **No new hosting cost.** Vercel Hobby, Convex Free and Cloudflare Turnstile free only. No paid add-ons, no Vercel Pro, no Convex Starter.
3. **Preserve the research demo.** Never read, write, deploy to or configure `corvo-research-demo.vercel.app` or Convex `elegant-crane-662`, and never touch their `researchReadinessEnvelopes` or `researchGatewayAllocations` rows. Never use `infra/research/.env.local`, `infra/research/cloud-target.json` or `infra/research/operator.private.json`. Demo code paths must behave identically. Campaign behaviour is additive and keyed on `session.campaignId`.
4. **Live provider calls** need an owner-approved cap stated in the task's status notes, and an entry in `/Volumes/rexy/GitHub/unfiltered/docs/rebuild/USAGE-LEDGER.md` (credits versus cash). Never use the $25 cash fallback for this track.
5. Never print secrets. Do not read `infra/cloud/.private/`. Read nothing in `docs/implementation/evidence/` beyond file names.

### Task status (implementers update this table; keep one row per task)
Status values: `not started` · `in progress` · `blocked: <reason>` · `review` · `done (<commit>)`.

| ID | Task | Size | Depends on | Status | Notes |
|---|---|---|---|---|---|
| T1.1 | Runtime-neutral kit: DO client, exact quote locator, cost math | S | — | not started | |
| T1.2 | `campaign.ts` pure limits, budget and rate decisions | S | T1.1 | not started | |
| T1.3 | Schema: campaigns, shards, slots, turns, rate limits, session fields | S | T1.2 | not started | |
| T1.4 | Operator campaign API | M | T1.3 | not started | |
| T1.5 | Link start: Turnstile + IP hash + signed start mutation | M | T1.4, T1.10 | not started | |
| T1.6 | Campaign turn path (`feedbackTurn.run`) | L | T1.1, T1.3, T1.5 | not started | |
| T1.7 | Session settlement and idle sweep | S | T1.6 | not started | |
| T1.8 | Participant campaign entry UI | M | T1.5, T1.6 | not started | |
| T1.9 | Operator campaign UI | M | T1.4 | not started | |
| T1.10 | Feedback deployment manifest, isolation guard, env names | S | — | not started | |
| T1.11 | Local load measurement + owner-approved live smoke | S | T1.1–T1.10 | not started | |
| T2.1 | `email.ts` pure: normalize, CSV, tokens, templates, quota | S | — | not started | |
| T2.2 | Schema: recipients, suppressions, outbox, days, imports, events | S | T1.3 | not started | |
| T2.3 | Recipient import with dedupe | S | T2.1, T2.2 | not started | |
| T2.4 | Outbox pump + Resend batch send + invitation issue | M | T2.3 | not started | |
| T2.5 | Resend webhook + one-click unsubscribe | M | T2.2 | not started | |
| T2.6 | Invite resume + consent-time budget reservation | S | T2.4, T1.6 | not started | |
| T2.7 | Reminders | S | T2.4, T2.5 | not started | |
| T2.8 | Recipients panel UI | M | T2.3 | not started | |
| T2.9 | Owner-approved live send (≤5) | S | T2.4–T2.8 | not started | |
| T3.1 | `observations.ts` map prompt + validation | M | T1.1 | not started | |
| T3.2 | `codebook.ts` consolidation invariants | M | — | not started | |
| T3.3 | Schema: observations, codes, code-sessions, versions, jobs, question stats | S | T1.3 | not started | |
| T3.4 | Job queue: enqueue, pump, lease, recover | M | T3.3 | not started | |
| T3.5 | Session map job | M | T3.1, T3.4 | not started | |
| T3.6 | Codebook consolidation job | M | T3.2, T3.5 | not started | |
| T3.7 | Withdrawal exclusion + audit | S | T3.5 | not started | |
| T3.8 | Themes board UI | M | T3.5 | not started | |
| T3.9 | Eval corpus, metrics, eval script (dev split) | M | T3.1, T3.2 | not started | |
| T3.10 | Owner-approved live map (≤30 sessions) | S | T3.5–T3.9 | not started | |
| T4.1 | `synthesis.ts` sampling, prevalence, prompt, validation | M | T3.1 | not started | |
| T4.2 | Schema: syntheses, synthesis findings, report evidence, report fields | S | T3.3 | not started | |
| T4.3 | Synthesis job | M | T4.1, T4.2, T3.4 | not started | |
| T4.4 | Operator review mutations | S | T4.3 | not started | |
| T4.5 | Publish from synthesis + client report queries | M | T4.4 | not started | |
| T4.6 | Findings, preview and client report UI | M | T4.5 | not started | |
| T4.7 | Holdout eval + end-to-end acceptance | M | T4.1–T4.6 | not started | |
| T5.1 | Campaign speech budget + Deepgram token mint action | M | T1.6 | not started | |
| T5.2 | Dictation UI (push-to-dictate) | M | T5.1 | not started | |
| T5.3 | Read-aloud: browser default, ElevenLabs optional | M | T1.6 | not started | |
| T5.4 | Interview guards + `probeIntent` | S | T1.6 | not started | |
| T5.5 | Saturation detection | S | T3.5 | not started | |
| T5.6 | Response quality flags | S | T1.7, T3.4 | not started | |
| T5.7 | Interviewer health panel | M | T1.6 | not started | |
| T5.8 | Questionnaire-pack structured items (conditional) | M | pack track | not started | |
| T5.9 | Owner real-microphone run | S | T5.1–T5.3 | not started | |

---

## 1. Starting point (what exists, verified in source)

| Area | Current behaviour | File / symbol |
|---|---|---|
| Interview engine | Script questions, up to 2 model follow-ups per question. The model proposes `{decision, question, goalIndex, sourceId, quote}`. The quote must occur exactly once in the saved answer. There are guards against credential requests, diagnosis or emotion inference, and repeated questions. Explicit skip or resistance advances. | `packages/research-core/src/interview.ts` (`decideInterview`, `interviewStopReason`, `advanceInterview`) |
| Turn transport | Browser → `POST /api/research/interview` on the Node gateway → `runInterviewTurn` → signed Convex mutations `researchInterview.admit` → `begin` → `finish`. DO `qwen3.8-max` or `glm-5.3-flash`, ≤15 s, ≤512 output tokens, ≤64 KB input. | `apps/research-server/src/interview.ts` (`digitalOceanInterview`, `runInterviewTurn`), `apps/research-server/src/interview-gateway.ts`, `convex/researchInterview.ts` |
| DO transport | Generic chat-completions client for `https://inference.do-ai.run`. | `packages/clinical-core/src/digitalocean.ts` |
| Analysis | Manual. The operator hand-picks evidence, which produces **one** DO call over ≤6 sessions / ≤24 sources / ≤64 KB, returning ≤12 findings. `validateFindings` enforces cited-evidence existence and the provenance-type ↔ source-kind match. `validatePublication` requires approved excerpts to equal the source text exactly. | `packages/research-core/src/analysis.ts` (`ANALYSIS_LIMITS`, `checkSelections`, `validateFindings`, `validatePublication`, `validateCitationCoverage`), `apps/research-server/src/analysis.ts` (`runAnalysis`, `analysisMessages`) |
| Tenancy | operator → `researchClients` → `researchProjects` → immutable `researchStudies(version)`. Participants hold a capability token (`tokenHash`). | `convex/schema.ts:22-27`, `convex/access.ts` (`projectFor`, `participant`) |
| Invitations | One `invitations.create` action call issues one invitation **and pre-creates one session**. The operator copies the `/participate#token=` link by hand. No email. Fixed 7-day expiry, 30-day retention. | `convex/invitations.ts:12-35`, `apps/research/src/state.ts:42`, `RESEARCH_LIMITS` in `packages/research-core/src/limits.ts` |
| Budget ledger | Envelope (`researchReadinessEnvelopes`) partitioned to a per-study child (`researchStudyAdmission`), plus a per-study `researchInterviewPolicy`. Hard maxima: 1,000 interview calls, 100 analysis calls, 30-day expiry. | `convex/researchReadiness.ts:128,172` |
| Reports | Operator review, then publish (`researchReports`), then a password share (`researchShares`), viewer sessions and unlock buckets. Evidence and findings arrays are stored **inline** on the row. | `convex/schema.ts:28-33`, `convex/researchReports.ts` |
| Crons | Six crons, each running **every minute**. | `convex/crons.ts` |
| Speech | Deepgram REST, relay and token mint; ElevenLabs output contract. Already reused by research. | `packages/speech/src/{grant,transcribe,relay,server}.ts`, `apps/research-server/src/research-speech.ts` |

### Blockers to hundreds of sessions (each must be removed or bypassed in campaign mode)

1. **Deployment-wide single interview call.** `convex/researchInterview.ts:62` rejects a turn if *any* `researchInterviewAttempts` row is `active`. Every call also patches the single policy row (`:66`), a guaranteed OCC hot spot.
2. **Analysis is hand-picked and serialized.** It allows 6 sessions / 24 sources in one call. `convex/researchStudyAnalysis.ts:36` blocks while any project analysis is unresolved, and `apps/research-server/src/reports.ts:31` holds an in-process `analysisBusy` flag.
3. **Reports store evidence inline.** `researchAnalyses.evidence[]` and `researchReports.findings[]` are arrays on one document. Convex caps documents at 1 MiB, which hundreds of citations will exceed.
4. **Envelope maxima** (1,000 interview calls, 100 analysis calls) and the six global gateway slots and singletons (`researchCaptureCapacity 'demo'`, one active speech attempt per provider, `researchGatewaySlots` with 4 slots).
5. **Invitations** are issued one action per invite, with no bulk path, no email, no dedupe and no unsubscribe.
6. **Six per-minute crons.** If scheduled executions count as function calls (the Convex limits page says they do), these use about 259k of the 1M monthly Free function calls while idle.

Note on the questionnaire-pack track: no pack or compiler code exists in this tree yet. `packages/clinic-content/src/native-questionnaire.ts` compiles authored TypeScript topics into a FHIR-shaped Questionnaire with clinic-literal predicates. This plan depends on the pack only for **structured items** (rating, choice, NPS) in M5. M1–M4 run on the existing `study.definition.script` (open-text questions).

---

## 2. Constraints and platform budget

Hard constraints: application reasoning and vision use **DigitalOcean inference only**. No OpenAI, Anthropic or Arcee models, which also excludes DO-hosted `gpt-oss-*` because it is an OpenAI model family. There is **no new hosting cost**: Vercel Hobby, Convex Free and the existing Medplum. This track does not need Medplum. Speech may use Deepgram and ElevenLabs credits. Email uses Resend.

### Published limits (checked 2026-10-14)

| Platform | Limit that matters here |
|---|---|
| Vercel Hobby | 300 s max function duration (default and max). 2 GB / 1 vCPU fixed. Monthly: 1M invocations, **4 h Active CPU**, 360 GB-h provisioned memory, 100 GB Fast Data Transfer, 10 GB Fast Origin Transfer. Crons run **once per day**, ±59 min. 4.5 MB request body. **Non-commercial use only.** |
| Convex Free (limits are per team) | 1M function calls/month. 20 GB-h action compute. **0.5 GB DB storage. 1 GB/month DB I/O.** 1 GB file storage and 1 GB file egress. Concurrency: 16 queries, 16 mutations, 64 actions, **8 scheduled jobs**. Query/mutation user code ≤1 s. ≤32k docs scanned and ≤16k written per transaction. 1 MiB per document. Convex-runtime actions get 64 MiB; Node actions get 512 MiB. |
| Resend Free | **100 emails/day, 3,000/month**. 10 req/s per team. Batch send of ≤100 per call. `Idempotency-Key` (24 h). Webhooks: `email.bounced`, `email.complained`, `email.delivered`, `email.suppressed`, `suppression.added`. Automatic suppression after a hard bounce or complaint. Broadcasts are a separate product, free up to 1,000 contacts/month. |
| Cloudflare Turnstile | Free, unlimited challenges, 20 widgets. Account already exists (R2 is on it). |
| DO serverless inference ($/1M tokens, in/out) | `qwen3.8-max` 2.00/6.00. `glm-5.3-flash` 0.15/0.50. `deepseek-v4.1-flash` 0.30/1.20 (the only DeepSeek id in the repo allowlist `DO_MODELS`, `packages/clinical-core/src/digitalocean.ts:6`). `glm-5.3` 1.40/4.40. Gemma 4 0.18/0.50. Vision-capable: qwen3.8-max, glm-5.3-flash, DeepSeek V4.1 Flash. Embedding models are listed (GTE Large, BGE M3, Qwen3 Embedding 0.6B), but **serverless `/v1/embeddings` availability is not documented**, so the design must not depend on it. Account rate limits are not published. |
| Deepgram Nova-3 | Streaming $0.0048/min (promotional; list price $0.0077). Pre-recorded $0.0043/min. |
| ElevenLabs | Flash/Turbo $0.04 per 1k characters; Multilingual v2 $0.08 per 1k. |

### What breaks first, and at what volume

Assumed workload: one "response" is one completed async text session with 8 script questions, about 6 follow-ups, about 14 model turns, 1 extraction call and an amortized share of synthesis.

| Rank | Limit | Volume where it binds | Mitigation in this plan |
|---|---|---|---|
| 1 | **Resend 100/day** | ~45 new email invitees/day with one reminder each (≤90 sends/day; 10 held for operator mail). ~1,450 invitees/month. | The campaign **link** is the primary channel. Email is a throttled queue with a visible "sends on day N" ETA. Broadcasts are an open decision (§11). |
| 2 | **Convex DB I/O 1 GB/month** | A naive reactive transcript subscription re-reads the whole session every turn: ~0.5–1 MB per response, so 1,000–2,000 responses/month. | Rule: participant queries read only `currentPrompt` plus the last answer. Operator lists paginate. Aggregates come from counters. Target ≤150 KB I/O per response, so ~6,500/month. M1 measures it. |
| 3 | **Convex 1M function calls/month (team-wide)** | ~250 calls per response. The idle demo crons use ~259k, so ~3,000 responses/month remain (~4,000 after the demo's crons stop on 2026-10-18 or later). | Event-driven scheduling. One recovery cron every 15 min (2,880/month). No per-minute crons in the new deployment. |
| 4 | Vercel provisioned memory 360 GB-h | It would bind at ~9,000 responses if every turn waited on DO inside a 2 GB Vercel function (~5 s each). | Interactive turns run as **Convex-runtime actions** (64 MiB), not Vercel functions. Vercel serves static assets plus the Turnstile-checked session start. |
| 5 | Convex DB storage 0.5 GB | ~60 KB retained per response, so ~8,000 retained responses. | The existing 30-day retention (`RESEARCH_LIMITS.retentionDays`) recycles storage. No raw audio is stored. |
| 6 | Convex scheduled-job concurrency 8 | Not binding: ~2 concurrent analysis jobs × ~8 s each is about 900 extractions/hour. | Analysis pump capped at K=2. Interactive turns don't use the scheduler. |
| — | DO account rate limit | Unknown. | App-level semaphore of 6 in-flight calls. Fall back to the scripted question (§5). |

Volumes are estimates. M1 acceptance includes measuring real function calls and DB I/O per response on a 50-session fake-provider run, then re-ranking this table.

---

## 3. Decision: does research share the clinic conversation engine?

Current recommendation on file: "share the engine, separate storage". **My recommendation: separate storage, yes. Share the clinic turn engine, no. Instead, share three thin layers: the authoring format, leaf primitives and speech.**

What the clinic engine is (`packages/clinic-api/src/intake-interpreter.ts`, `adaptive-session.ts`, `dialogue.ts`):

- A slot-filling interpreter. One DO call maps patient text onto a typed field catalog (`facts/items/listsDone/questions/moveOn/ack`).
- Server validation: `locateQuote`, `lexicalProblem`, unit and number derivation, conflict and correction cues, list completion.
- **The next question is always authored.** `selectAdaptiveDialogue`, `scopedQuestion` and `guardNativePrompt` mean the model never writes a question.
- Every persistence path is Medplum: drafts (`store.ts`), the provider ledger (`provider-admission.ts`, `urn:corvo:clinic:provider-budget`), ingress and safety review. `clinic-content` types and predicates are closed clinic enums (`ScenarioId` W01–W07, `diabetes`, `sleep-apnea`). The native questionnaire digest is **pinned and qualified** (OPUS-HANDOFF: changes re-qualify the clinic).

What async feedback needs: open-ended opinions with no field catalog, plus **model-proposed, goal-relevant probes under a cap**. That is exactly `decideInterview` in research-core. It is already proven on hosted: the v6 text interview returned a follow-up in 2.4 s (`DELIVERY-ACCEPTANCE.md`).

| Option | For | Against |
|---|---|---|
| A. Share the clinic engine | One adaptive implementation; hands-free voice turn handling already built | Wrong abstraction: free text would become `text` slots holding the literal quote, plus clinical lexical-rejection noise. Every feedback change risks the clinic's pinned digest and qualification. Medplum in every path. Clinic PHQ-4, E-policy and handoff overhead. |
| **B. Research engine + shared primitives (recommended)** | Right abstraction, already hosted. Clinic qualification is untouchable. Convex-native. | Two turn loops to maintain. Voice turn UX must be ported, not imported. |
| C. New third engine | Clean slate | Repeats the over-building the pause doc warns against |

What to share, concretely:

1. **Authoring format.** When the pack lands, campaign studies embed pack items for structured questions (choice, integer, rating). Open-text items carry a `probe` extension (`goals`, `maxFollowUps ≤2`). The pack compiler must emit a storage-neutral compiled form; Medplum `Questionnaire` stays a clinic-side target. Ask the pack track to keep its compiler output free of `clinical-core/medplum` imports. This is the one coordination request to that track.
2. **Leaf primitives.** Copy (do not move) into `packages/research-core/src/kit/`, the seed of a future neutral package: `locateQuote` and `ackGrounded` (from `intake-interpreter.ts`), the reservation/charge/settle semantics of `createProviderAdmission` behind a storage port, and a runtime-neutral DO client (fetch + WebCrypto) adapted from `clinical-core/digitalocean.ts`. Clinic files are **not edited** in this track. The clinic can adopt the package later, at its own qualification cadence.
3. **Speech.** Use `packages/speech` as-is (token grant, transcribe). Feedback keeps its own keyterms; clinic medicine `keyterms.ts` is not used.

---

## 4. Target journeys (end to end)

**J1. Founder creates a campaign (operator)**
1. Sign in (existing Password auth), then pick or create a client and project (`ProjectWorkspace.tsx`).
2. Create a study version: title, intro, goals (≤12), questions (≤30, `RESEARCH_LIMITS`), each with an optional probe intent. Optional prototype URL, shown as a link only (no capture in this track).
3. Create a campaign on that study version, with:
   - mode (link, email, or both);
   - `maxResponses` and close date;
   - budget: DO calls, speech seconds, ElevenLabs characters;
   - voice on or off; ElevenLabs on or off (default off);
   - per-IP daily starts.
4. **Preview as participant.** This runs the real flow with the fake provider in a `purpose:'readiness-test'` session that is excluded from counts.
5. Open. The link `/c/<slug>` becomes active.

**J2. Distribution**
- **Link.** Copy `/c/<slug>`. Each visitor passes Turnstile and consents, which lazily creates a session and a capability token. The token goes in the URL fragment and localStorage, so a reload resumes the session.
- **Email.**
  1. Paste or upload a CSV (email, optional name). Addresses are normalized, then deduped against the campaign and the client's suppression list. The operator sees counts: queued / duplicate / invalid / suppressed.
  2. The queue sends ≤90/day with a one-click unsubscribe. Each email link is bound to one recipient, which maps to one session; clicking again resumes it.
  3. One reminder goes out at +72 h, only to recipients who have not started or finished and are not suppressed.
  4. Resend webhooks set the recipient state to delivered, bounced, complained or suppressed.

**J3. Participant responds asynchronously**
1. Welcome and consent use the existing `StudyWelcome` and `Consent` flow, with a bot disclosure.
2. Questions appear one at a time. The participant answers by text, or by voice dictation into the same box (they review and edit before sending; channel `confirmed-transcript`).
3. Read-aloud uses browser `speechSynthesis` by default. ElevenLabs is used only if the campaign enables it and budget remains.
4. After each answer, the system either shows a follow-up (≤2 per question) or moves to the next question. If inference is busy, over budget or fails, the next scripted question appears and the participant never sees an error.
5. They can stop at any time; a partial response is kept if they consent. At the end, the final review (existing `finalReview.ts`) and a thank-you screen.

**J4. Incremental analysis (automatic, private)**
1. On completion, or after 24 h idle with ≥2 answers, a `session-map` job is queued. It extracts observations (paraphrase plus exact quote span) and assigns codebook codes.
2. Every 25 new sessions, or when ≥15 proposed codes are pending, a `consolidate` job versions the codebook.
3. The operator's themes board shows live counts per code and per question, and quality flags.

**J5. Cross-session synthesis, then publish**
1. The operator requests "synthesize". Auto-drafting also runs when there is ≥20% growth or ≥10 new sessions, at most hourly.
2. A synthesis job writes draft findings. Each finding has a statement, deterministic prevalence ("31 of 212 completed responses") and sample quotes, and links to *all* supporting observations.
3. The operator reviews, edits, approves excerpts and chooses raw grants. Publishing snapshots a versioned report.
4. The client gets a password share link (the existing `researchShares` flow). New sessions never change a published report; the draft shows "N new since publish".

---

## 5. Architecture

### Deployment topology (isolation from the demo)
- **Code:** same repository and the same apps, behind a `campaign` capability on the study and a `RESEARCH_PRODUCT=feedback` build flag.
- **Runtime:** a **new Convex Free project** (for example `corvo-feedback`) and a **new Vercel Hobby project**. The research demo (`corvo-research-demo.vercel.app`, Convex `elegant-crane-662`) and its envelope and reader allocations are never read or written. A build-time check fails if the feedback manifest names `elegant-crane-662`.
- The Convex Free quota is team-wide. The demo's idle crons count against it until the owner turns that deployment off after the allowances expire on 2026-10-18.
- **Interactive turns** run as Convex-runtime actions (`convex/feedbackTurn.ts`) that the participant client calls with its token. The action calls `admit` (mutation), then DO fetch, then `finish` (mutation). This keeps the existing admit/begin/finish fence semantics but drops the Vercel hop and the 2 GB provisioned-memory cost.
- **Vercel** serves the static Vite build plus one function, `POST /api/feedback/start`. That function verifies Turnstile, derives the salted IP hash from `x-forwarded-for`, and calls a signed Convex mutation using the existing `signGateway` from `packages/research-capture/src/proof.ts`. Convex functions do not see client IPs, so this hop is required.
- **No R2, no FFmpeg, no WebSockets** in this track.

### Data model changes (`convex/schema.ts`)

New tables. All carry `ownerId`, `clientId` and `projectId` for tenancy checks through `projectFor`.

| Table | Key fields | Indexes |
|---|---|---|
| `researchCampaigns` | `studyId, slug, state: draft\|open\|paused\|closed\|exhausted, opensAt, closesAt, maxResponses, perIpDailyStarts, voice: off\|dictation, ttsProvider: browser\|elevenlabs, budget{allocatedCalls, maxSessionCalls, allocatedSpeechSeconds, allocatedTtsChars}, promptVersion, model, revision` | `by_slug`, `by_projectId_and_state`, `by_studyId` |
| `researchCampaignShards` | `campaignId, shard (0..7), started, completed, reservedCalls, chargedCalls, speechSeconds, ttsChars` | `by_campaignId_and_shard` |
| `researchRecipients` | `campaignId, emailHash, email, name?, state: queued\|sent\|delivered\|bounced\|complained\|unsubscribed\|suppressed\|failed\|started\|completed, invitationId?, resendId?, remindersSent, lastEventAt` | `by_campaignId_and_emailHash`, `by_campaignId_and_state`, `by_resendId` |
| `researchSuppressions` | `clientId, emailHash, reason: unsubscribe\|bounce\|complaint\|manual, at` | `by_clientId_and_emailHash` |
| `researchEmailOutbox` | `recipientId, kind: invite\|reminder, state: queued\|sending\|sent\|failed\|unknown, idempotencyKey, notBefore, attempt` | `by_state_and_notBefore`, `by_recipientId_and_kind` |
| `researchEmailDays` | `dayKey (UTC yyyy-mm-dd), sent, reserved` | `by_dayKey` |
| `researchRateBuckets` | Reuses the `convex-helpers/server/rateLimit` tables (already a dependency, `convex-helpers@0.1.128`), or generalizes `researchUnlockBuckets` | — |
| `researchInferenceSlots` | `slot (0..5), sessionId, attemptId, leaseUntil` (global DO semaphore) | `by_slot`, `by_leaseUntil` |
| `researchObservations` | `campaignId, sessionId, questionId, sourceId, start, end, quoteHash, paraphrase (≤280), valence: pos\|neg\|neutral\|mixed, codeId, mapJobId, consentEpoch, sharingEpoch, excluded` | `by_campaignId_and_codeId`, `by_sessionId`, `by_campaignId_and_questionId` |
| `researchCodes` | `campaignId, codeId, label, definition, questionIds[], state: pending\|active\|merged, mergedInto?, sessionCount, observationCount, firstSeenSession, createdInVersion` | `by_campaignId_and_state`, `by_campaignId_and_codeId` |
| `researchCodebookVersions` | `campaignId, version, codeIds[], mergeMap[{from,to}], basedOnSessions, jobId` | `by_campaignId_and_version` |
| `researchJobs` | `campaignId, kind: session-map\|consolidate\|synthesize, sessionId?, state: queued\|leased\|done\|failed\|unknown, owner, leaseUntil, attempts, notBefore, requestId, inputHash, receipt{model, usage, costMicros}` | `by_state_and_notBefore`, `by_sessionId_and_kind`, `by_campaignId_and_kind_and_state` |
| `researchSyntheses` | `campaignId, version, codebookVersion, denominator, state, createdAt, reviewedAt` | `by_campaignId_and_version` |
| `researchSynthesisFindings` | `synthesisId, findingId, statement, type, codeIds[], sessions, sampleObservationIds[≤12], counterObservationIds[≤6], limitations, singleParticipant` | `by_synthesisId` |

Changed tables:
- `researchSessions` gains `campaignId?`, `recipientId?`, `entry: link|email|operator`, `completedAt?`, `lastActivityAt`, `mapState`, `qualityFlags[]`, `promptVersion`, `model`, `reservedCalls`, and `ipHashDay?` (24 h salt, cleared at completion). Add the index `by_campaignId_and_state_and_lastActivityAt`.
- `researchInvitations` gains `source: operator|campaign-link|campaign-email` and `recipientId?`.
- `researchReports` gains `synthesisId?`. Findings and evidence for campaign reports are read from the synthesis tables through paginated queries instead of inline arrays. The existing inline path stays for the demo's manual analysis.
- Existing `ANALYSIS_LIMITS` stay as they are for the manual path. Add `CAMPAIGN_LIMITS` in a new `packages/research-core/src/campaign.ts`:
  - `maxSessionCalls 20`
  - `followUpsPerQuestion 2`
  - `codebookActive 60`
  - `samplePerFinding 12`
  - `findings 40`
  - `mapInputBytes 48_000`
  - `answerCharacters 8_000` (unchanged)

### Job orchestration within Free limits
- **Interactive turns are not queued.** `appendParticipantAnswer` (`convex/participant.ts`) saves first. The client then calls the `feedbackTurn` action:
  1. `admit` checks the session single-flight (one active attempt per session, which **replaces** the global `by_active` check), takes a slot from `researchInferenceSlots`, and charges against the session's `reservedCalls` (no hot row).
  2. The action calls DO (15 s timeout, no retry).
  3. `finish` re-runs `decideInterview` and installs the decision.
  4. If no slot is free, the budget is exhausted or the outcome is unknown, `advanceInterview(..., 'disabled'|'recovery')` immediately installs the next scripted prompt.
- **Background jobs** use the `researchJobs` rows:
  1. Enqueueing runs in the same mutation as the triggering state change, plus `ctx.scheduler.runAfter(0, internal.researchJobs.pump)`.
  2. `pump` (a mutation) leases at most **K=2** jobs whose `notBefore` has passed and schedules one action per lease.
  3. Each action ends by calling `pump` again.
  4. A **15-minute cron** `researchJobs.recover` re-queues expired leases and maps idle sessions (≥24 h since `lastActivityAt`, ≥2 answers). It scans in pages of 50.
- **Unknown outcome policy.** The pause doc demanded "no blind retries". The cost is a bounded ~$0.02. Rule: a map job with an unknown DO outcome is charged at its worst case and retried **once** with a new `requestId`, then marked `failed` for operator re-run. Interactive turns are never retried.
- **Aggregates are never scanned.** `researchCodes.sessionCount` and the shard counters update in the same mutation that writes observations. A paginated `audit` action recomputes them for tests and repair.

---

## 6. Scale design

### Invite dedupe, unsubscribe and bounces
- Normalize: trim, Unicode NFC, lowercase the whole address, validate with a conservative regex. Gmail dots and plus-tags are **not** stripped; those are different consented addresses.
- `emailHash = sha256(normalized)`. Uniqueness is enforced per campaign through `by_campaignId_and_emailHash` inside the import mutation. Imports are chunked at 200 rows per mutation to stay under the 1 s and 16k-write limits.
- Suppression is per client. An unsubscribe from one client's campaign does not suppress another client's.
- Every email carries:
  - `List-Unsubscribe: <https://…convex.site/email/unsubscribe?t=…>`
  - `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058).
  The token is an HMAC of `recipientId`. GET shows a confirmation page; POST suppresses idempotently.
- A Resend webhook handler (Convex `httpAction` in `convex/http.ts`) verifies the Svix signature. `email.bounced`, `email.complained` and `email.suppressed` set the recipient state and insert a suppression row. `delivered` and `delivery_delayed` update status only.
- **Send path:**
  1. `researchEmailDays` reserves capacity atomically: daily cap 90, monthly cap 2,700.
  2. The pump batches up to 100 per Resend batch call, stays under 10 req/s, and uses `Idempotency-Key = recipientId:kind:attempt`.
  3. A lost acknowledgement leaves the row `unknown`. It is reconciled against webhooks, and if nothing arrives within 24 h it is marked `failed` and never auto-resent.

### Rate limits and abuse protection
| Layer | Rule (defaults, campaign-configurable) |
|---|---|
| Turnstile | Required on `/api/feedback/start`. On failure, return 403 before any Convex write. |
| Per IP | ≤3 starts per campaign per 24 h, keyed by `sha256(dailySalt ‖ ip)`. The salt rotates daily and raw IPs are never stored. |
| Per link | ≤120 starts/hour. A velocity breach (>60 starts in 10 min) **auto-pauses** the campaign and shows an operator banner. |
| Per session | One in-flight turn. ≤20 DO calls. ≤45 min of activity. Answer ≤8,000 characters (existing). Follow-ups only after consent and after an answer of ≥1 word that isn't a skip. |
| Email links | One session per recipient. A link click never creates a second session. |
| Content | Low-quality flags: identical normalized answers across ≥3 sessions (hash), completion in less than 20% of the median duration, ≥50% of answers under 3 words, non-language text. Flagged sessions stay excluded from synthesis until the operator includes them. |

### Per-study budget caps with a hard stop
- Costs are tracked in **micro-dollars computed from DO `usage` × a pinned price table** in campaign config (2026-10-14 prices above), alongside call counts.
- **Session start** reserves the worst case: `maxSessionCalls × (maxInputTokens·inPrice + maxOutputTokens·outPrice)` + one map job. The start is refused (`campaign-exhausted`) if `charged + reserved + worstCase > allocated`. The check spans the shards, read in the same mutation: 8 shard rows, OCC-safe.
- Each turn charges against the session's reservation. **Settlement:** at completion or abandonment, known-completed calls settle to actual usage and the unused reservation is released. Unknown outcomes stay charged at worst case.
- Hard stop = no new sessions. In-flight sessions continue **without** follow-ups (scripted path). Speech and TTS budgets exhaust independently: the voice button hides and read-aloud falls back to the browser.
- The campaign state becomes `exhausted` and the operator sees spend versus allocation. There is no automatic top-up.

### Cost per response (DO list prices, estimated)
Assumptions: turn call ~1,800 input / 120 output tokens, 14 per response; map call ~5,000 / 1,000; consolidation ~6,000 / 2,000 every 25 sessions; synthesis ~30 codes × 4,000 / 600, run about once per 50 sessions.

| Component | qwen3.8-max | glm-5.3-flash | deepseek-v4.1-flash |
|---|---|---|---|
| 14 interview turns | $0.060 | $0.005 | $0.010 |
| Session map | $0.016 | $0.001 | $0.003 |
| Consolidation (amortized) | $0.001 | <$0.001 | <$0.001 |
| Synthesis (amortized) | $0.007 | $0.001 | $0.002 |
| **Text response total** | **≈ $0.084** | **≈ $0.007** | **≈ $0.015** |
| + voice dictation (~6 min Deepgram streaming) | +$0.029 | +$0.029 | +$0.029 |
| + ElevenLabs Flash read-aloud (~1,800 characters) | +$0.072 | +$0.072 | +$0.072 |

So 1,000 text responses cost about $84 on qwen3.8-max, or about $30 mixed (Flash for turns, qwen for map and synthesis). ElevenLabs costs more than all the reasoning combined, which is why browser read-aloud is the default. Worst-case reservation per session on qwen at 20 calls × (16k input + 512 output tokens) is ≈ $0.70. That is the number that limits concurrent starts under a small cap.

### Queueing and backpressure
- **Interactive path: degrade, don't queue.** With 6 slots, each ~4 s, throughput is ~90 turns/min, or ~6 concurrent active participants at full speed. Beyond that, extra participants get scripted questions only, still a valid response.
- **Background path:** the K=2 pump has an unbounded backlog. Backlog age shows on the themes board.
- Email: ≤90/day, with the ETA shown.

---

## 7. Analysis at scale (replacing the 6-session / 12-finding cap)

Pipeline: **map** (per session), then **incremental codebook**, then **deterministic counts**, then **reduce** (synthesis per finding on bounded samples).

1. **Session map** (`convex/researchSessionMap.ts`, prompt in `packages/research-core/src/prompts/feedback-map.ts`)
   - Input: the session's participant sources (only `author:'participant'`, `intent:'answer'`, not superseded), question texts, study goals, and the **active codebook** (≤60 codes: id, label, definition), all bounded to 48 KB.
   - Output: `observations[{sourceId, quote, paraphrase, valence, codeId | proposedCode{label, definition}}]`.
   - Validation (`packages/research-core/src/observations.ts`): the quote must occur exactly in that source's text. Use `kit/quote.ts` `locateExact` only; normalized matching is not used for evidence. The match yields `start/end` UTF-16 offsets, matching the existing `self-report` coordinate contract in `analysisMessages`. The `sourceId` must belong to this session. Codes must exist or be proposed. Invalid observations are dropped individually, never as a whole job. If the drop rate exceeds 50%, the job is marked `failed`.
   - The evidence id reuses `evidenceId({kind:'self-report', id:sourceId, start, end})`, so report and grant machinery keep working.
2. **Codebook consolidation** (`packages/research-core/src/codebook.ts`)
   - Pending proposals plus the active codes go to one DO call that returns `merge`, `rename` and `promote` operations.
   - Invariants, enforced in code:
     - Codes are never deleted, only merged. `mergedInto` chains resolve to an active code with no cycles.
     - Every observation always resolves to exactly one active code.
     - Renames keep the `codeId`.
     - Each version is immutable.
   - Already-mapped observations are **not** re-sent to the model. Their code resolves through the merge map.
   - Optional (only if DO embeddings prove available): BGE-M3 cosine similarity pre-filters duplicate proposals. Not on the critical path.
3. **Counts** are computed in code, never by the model. Prevalence for a code = distinct non-excluded consenting sessions with ≥1 observation in that code (or its merged descendants). Denominator = completed non-excluded sessions that were *asked* that question.
4. **Synthesis** (`convex/researchSynthesis.ts`, `packages/research-core/src/synthesis.ts`)
   - Covers codes with ≥2 sessions, or ≥1 if the operator pins them, up to 40 findings.
   - Per finding: a stratified sample of ≤12 supporting quotes (spread across sessions and early/late arrival) and ≤6 counter quotes (opposing valence on the same question).
   - The DO call returns `{statement, type:'self-report'|'interpretation', supports[], counterevidence[], limitations}`. This is validated by the **existing `validateFindings`** against the sampled evidence (with new limits).
   - The stored finding then links to *all* observations of its codes, deterministically. Prevalence text is rendered by code ("31 of 212"), not by the model.
   - A single-session finding is labelled "one participant".
5. **Evidence grounding is preserved end to end.** Quote = an exact source substring, with offsets. Finding → observation ids → source. Publication still runs through `validatePublication` and `validateCitationCoverage`. A new **count-only** citation mode lets a published finding show prevalence without exposing every quote: the client sees only approved excerpts. Withdrawn consent excludes observations, decrements counts and marks dependent drafts and reports `needs-review` (extending `researchDerivedDependencies`).

### Evaluating quality
- **Mechanical (CI, every change):**
  - 100% of stored quotes equal `source.text.slice(start,end)`.
  - Counter audit equals recomputation.
  - Merge-map invariants hold under randomized operation sequences.
  - Withdrawal removes evidence from drafts.
  - Published reports are immutable under new sessions.
- **Golden corpus** (`packages/research-core/test/fixtures/feedback-eval/`). Three fictional studies, 300 synthetic responses in total, with **planted themes at known prevalence** (40/15/5/2%). Includes distractors: sarcasm, multi-theme answers, off-topic and low-effort answers, duplicates.
  - Generated once with an allowed DO model, hand-corrected, frozen and hashed.
  - **Dev 100 / holdout 200.** The holdout is read only at M3/M4 acceptance, applying the lesson from the clinic's tuned dev set.
- **Thresholds (holdout):**
  - Planted-theme recall ≥90% for themes at ≥5% prevalence.
  - Prevalence absolute error ≤5 points for themes at ≥10%.
  - ≤2 findings per study with no planted counterpart, all labelled.
  - Observation→code precision ≥85% on an owner-audited random 50.
  - Order-shuffle stability: adjusted Rand index ≥0.7 between two runs.
  - Cost and p50/p95 job latency reported, not gated.

---

## 8. Interview quality across hundreds of sessions

- **Adaptive follow-ups** keep `decideInterview` and its guards. Add:
  - an optional per-question `probeIntent` (authored, ≤280 characters) in the packet;
  - a leading-question lexical guard ("don't you think", "wouldn't you agree", "isn't it", "how much did you love");
  - a "too-similar to script" guard: normalized token overlap ≥0.8 with any script question is rejected.
- **Consistency:**
  - The campaign pins `promptVersion`, `model`, `temperature` (0.2) and `max_tokens`. Each attempt records its config digest (the existing `configurationDigest`).
  - Changing any of these requires a new campaign revision. The dashboard splits metrics by revision.
  - **The codebook is not fed back into interviews in v1.** Late participants must get the same interviewer as early ones (consistency over adaptivity).
- **Saturation detection** (per question): after each map, compute new codes introduced in the last 20 mapped sessions for that question. If ≥30 sessions are mapped and 0 new codes appeared, the question is marked `saturated`:
  - follow-ups for it are disabled (cheaper and shorter interviews);
  - the operator can override;
  - when all open questions are saturated, the operator gets "consider closing". There is no auto-close in v1.
- **Stop rules:** script exhausted; explicit stop or skip (existing regex); ≤2 follow-ups per question; ≤20 DO calls per session; 45 min of activity; campaign closed or exhausted (the session finishes scripted).
- **Monitoring** (themes board, "Interviewer health" panel), per question and revision:
  - follow-up rate;
  - validator-rejection rate by code (`unbound-follow-up-evidence`, `repeated-or-invalid-follow-up` and so on);
  - median answer length after a follow-up versus after a script question;
  - skip/resistance rate.
  A question whose follow-up rate moves more than 2σ from its first-50-session baseline is flagged. Before M1 opens to real participants, the owner reviews 20 random transcripts.
- **Sensitive disclosures:** a lexical screen (adapted from the clinic tier-1 idea, not its code) flags the session for the operator and shows a fixed "this isn't monitored in real time" notice with general support resources. It does not escalate clinically.

---

## 9. Capture scope for v1 of this track

| Modality | v1 | Why |
|---|---|---|
| Text | **Yes** | Core |
| Voice dictation (STT) | **Yes** | The browser streams to Deepgram directly with short server-minted tokens (`packages/speech/src/grant.ts`, the clinic `deepgram-direct` pattern), so no audio passes through Vercel. The transcript is reviewed by the participant before saving (`confirmed-transcript`). |
| Read-aloud | **Browser by default**; ElevenLabs optional per campaign with a character cap | ElevenLabs costs ~$0.07 per response, more than all the reasoning |
| Raw audio retention | **No** | No R2 needed, smaller consent surface, no egress or cleanup machinery |
| Camera / screen / DOM | **No** | At async scale they would need: R2 bytes and operations budgets, the 4.5 MB Vercel body cap, FFmpeg on 4 h of Active CPU, vision cost per frame, and removal of the global `researchCaptureCapacity` singleton. They also add consent friction that lowers completion rates. Moderated multimodal research stays in the existing research product. |

---

## 10. Phases (task-level specs live in the phase files)

| Phase | File | Goal | Size | Depends on |
|---|---|---|---|---|
| 1 | [PLAN-ASYNC-FEEDBACK-PHASE-1.md](PLAN-ASYNC-FEEDBACK-PHASE-1.md) | Campaign link → async text responses with budget and abuse controls | L | clinic + pack tracks done; owner provisions new Convex/Vercel projects and a Turnstile widget |
| 2 | [PLAN-ASYNC-FEEDBACK-PHASE-2.md](PLAN-ASYNC-FEEDBACK-PHASE-2.md) | Email distribution: dedupe, unsubscribe, bounces, reminders | M | Phase 1 |
| 3 | [PLAN-ASYNC-FEEDBACK-PHASE-3.md](PLAN-ASYNC-FEEDBACK-PHASE-3.md) | Incremental per-session analysis and live themes | L | Phase 1 (can run in parallel with Phase 2) |
| 4 | [PLAN-ASYNC-FEEDBACK-PHASE-4.md](PLAN-ASYNC-FEEDBACK-PHASE-4.md) | Cross-session synthesis → review → publish/share | M | Phase 3 |
| 5 | [PLAN-ASYNC-FEEDBACK-PHASE-5.md](PLAN-ASYNC-FEEDBACK-PHASE-5.md) | Voice, interview-quality controls, optional pack items | M | Phase 1; Phase 3 for saturation; pack track for T5.8 |

Sequencing: 1 → (2 ∥ 3) → 4 → 5. The first useful demo comes after Phases 1 and 3 (link plus live themes). The full journey is complete after Phase 4. Each phase ends with one independent review of the whole slice, not of every task.

## 11. Open decisions for the owner (with recommended defaults)

1. **Shared engine.** Default: separate storage; keep the research engine; share primitives (`packages/research-core/src/kit/`), `packages/speech` and the pack format. The clinic turn engine is not shared (§3).
2. **Deployment.** Default: a new Convex Free project plus a new Vercel Hobby project. Alternative: reuse `elegant-crane-662` after the allowances expire on 2026-10-18 and its per-minute crons are retired.
3. **Interview model.** Default: `qwen3.8-max` for turns until a 20-case dev comparison shows `glm-5.3-flash` or `deepseek-v4.1-flash` within 1 case; qwen3.8-max for map and synthesis. This is roughly a 3–10× cost difference.
4. **Email channel.** Default: Resend transactional queue at ≤90/day, with one reminder at 72 h. Alternative: Resend Broadcasts (1,000 contacts/month free, built-in unsubscribe), but per-recipient session tokens need a custom-property check.
5. **Participant identity on links.** Default: anonymous, with an optional email at the end for follow-up consent.
6. **Default per-campaign budget.** Default: 300 responses, 6,000 DO calls, 1,800 speech minutes, ElevenLabs 0. All of it comes from credits, never the $25 cash fallback.
7. **Unknown-outcome retry for background jobs.** Default: one retry, charged at worst case. Interactive turns never retry.
8. **Feed the codebook into interviews.** Default: no in v1 (consistency).
9. **Raw audio retention.** Default: none; transcript only.
10. **Real participants.** Default: synthetic plus ≤20 owner-invited people until a privacy notice, data-controller wording and deletion flow are reviewed. Hobby is non-commercial: paid client work would require Vercel Pro (D2 conflict).

## 12. Risks

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| **Resend's free tier (100/day) caps email-driven studies** | High / Medium | Link-first; visible ETA; Broadcasts decision; Pro is a cost decision only |
| **Synthesis credibility.** Code drift or merged-away nuance gives plausible but wrong themes. | Medium / High | Deterministic counts; immutable codebook versions with a merge map; holdout gate; owner audit; samples include counterevidence |
| **Free-tier exhaustion is team-wide** (Convex function calls and DB I/O shared with the demo and clinic projects) | Medium / High | Event-driven jobs; I/O budget rule; measured in M1; demo crons retired after 10-18 with owner approval |
| DO serverless rate limits and latency at concurrency are unknown | Medium / Medium | Semaphore of 6; scripted fallback; no dependence on embeddings |
| A public link burns credits | Medium / Medium | Turnstile; per-IP, per-link and velocity limits; worst-case reservation; hard stop |
| PII in emails and free text | Medium / High | Hashed dedupe; per-client suppression; 30-day retention; excerpts need approval; no raw audio |
| Process relapse (manifests, micro-gates; see `PAUSE-AND-STRATEGY-RESET.md`) | Medium / High | Five vertical milestones, one review each; tests target actual risks |
| Accidental clinic coupling | Low / High | No edits under `packages/clinic-*`; `kit/` is copied out and the clinic migrates later |

## 13. Explicitly out of scope
- Camera, screen and DOM capture in campaign mode; raw audio storage; vision inference.
- Telephony; real-time moderated sessions; mid-session human takeover.
- Participant incentives or payments; panel recruitment; marketplace.
- Medplum and FHIR persistence of feedback; an AWS package for this track; multi-region.
- Team accounts and SSO; Linear, Intercom and other integrations; Stripe metering.
- Embeddings-dependent clustering; emotion, sentiment-as-truth or honesty inference.
- Auto-closing campaigns on saturation; feeding the codebook into live interviews.
- Multi-language interviews. Prompts are English-only in v1; flag non-English answers instead.
- Any change to `corvo-research-demo.vercel.app`, `elegant-crane-662`, or their envelope and reader allowances.

## Sources (checked 2026-10-14)
- Vercel limits: https://vercel.com/docs/limits ; fair-use allotments: https://vercel.com/docs/limits/fair-use-guidelines ; Hobby cron: https://vercel.com/docs/cron-jobs/usage-and-pricing
- Convex limits: https://docs.convex.dev/production/state/limits
- Resend pricing: https://resend.com/pricing ; rate limit: https://resend.com/docs/api-reference/rate-limit ; batch: https://resend.com/docs/api-reference/emails/send-batch-emails ; webhooks: https://resend.com/docs/dashboard/webhooks/event-types
- DigitalOcean pricing: https://docs.digitalocean.com/products/gradient-ai-platform/details/pricing/ ; models: https://docs.digitalocean.com/products/gradient-ai-platform/details/models/
- Deepgram: https://deepgram.com/pricing ; ElevenLabs: https://elevenlabs.io/pricing/api ; Turnstile: https://developers.cloudflare.com/turnstile/plans/
