# Unfiltered v2 — Architecture & Build Plan

This is the canonical reference for the rebuild. It supersedes `docs/spec.md` and `docs/techspec.md` (both archived to `legacy-prompt-specs/legacy-docs/`).

## Product thesis

**Always-on AI voice interviewer** that lets founders run honest, multimodal user research at any hour, gated by an **intelligent guide creator** that turns messy founder context into executable interview plans, with **synthetic users** for pre-flight validation and **evidence-grounded findings** as the output.

The brand premise is psychological: humans are more honest with bots than with humans, and the bot is always available, so scheduling — the worst pain in user research — is eliminated. Every claim in every finding links to a quote, a clip, or a frame; nothing is asserted without evidence.

## Five feature areas

1. **Guide creator (on-ramp)** — turns paste/file/URL/GitHub-repo input into a typed, executable `Guide` with a human-readable form view.
2. **Real interview conduction** — always-on bot conducts live voice interviews with screenshare + camera + thinking-aloud; participant is invited by name+email.
3. **Multimodal analyzer** — multi-stage Cloudflare Workflow that turns transcripts, recordings, and bot tool events into evidence-grounded findings, themes, quotes, and friction moments.
4. **Synthetic users** — text-text persona simulation against the same `Guide`, producing the same `SessionAnalysis` shape; auto-runs on Guide finalization for an instant demo loop.
5. **Synthetic interviewer** — the wedge — explicitly bot-disclosed AI interviewer that participants trust to be patient, non-judgmental, and always available.

## Foundational decisions

| Area | Decision |
|---|---|
| Wedge | Synthetic interviewer + guide creator on-ramp |
| ICP | Founder/PM at early-stage company with a product or hosted prototype URL |
| Conduction format | Always-on bot, interviewee-scheduled, real-time voice loop, on-camera + screenshare + thinking-aloud |
| Studies in V1 | A: Live URL (incl. hosted prototypes from Figma/Framer/v0/Lovable/Bolt) + D: voice-only customer discovery |
| Studies NOT in V1 | Embedded prototype iframes, concept testing (use synthetic for that), static-asset/landing-page tests |
| Participant source | BYO via founder-provided name+email invite list, emailed at study launch |
| Bot disclosure | Triple: consent screen, bot's first sentence, persistent UI badge |
| Capture set | Transcript + bot events + camera video + screen video + participant audio |
| DOM-level signals | Inferred by vision LLM from screen recording in batch (no script injection, no extension, no iframe wrap) |
| Storage | Cloudflare R2 for video/audio blobs |
| Voice runtime | Vapi (orchestrator), GLM (brain — free via subscription), OpenAI tts-1 (validation TTS), ElevenLabs reserved for production/marketing |
| Bot reasoning | Single LLM agent + structured tool calls (`markFrictionMoment`, `advanceTask`, `saveQuote`, `endSession`) executing a typed `Guide` |
| Bot runtime mode | Voice (Vapi) and text (synthetic) — same system prompt, same tools, different I/O |
| Guide artifact | Typed JSON `Guide`; round-trippable to a structured human-readable form (controlled React form, not freeform prose) |
| Guide creator UX | Hybrid: 3–5 templates → chat refinement (AI agent with tools) → visual form |
| Guide creator inputs (V1) | Pasted text, file upload (PDF/image/md), URL fetch, shallow GitHub repo (README + package.json + recent issue titles) |
| Guide creator inputs (NOT V1) | Native Linear/Intercom/Zendesk/Notion integrations, audio/video uploads |
| Analyzer pipeline | Multi-stage Cloudflare Workflow with checkpointed steps |
| Analyzer sampling | Hybrid: low-cadence baseline (camera 0.1fps, screen 0.2fps) + dense sampling around bot-flagged friction moments |
| Vision models | Gemini 2.5 Flash for per-frame; Gemini 2.5 Pro for whole-video friction confirmation |
| Reasoning model | GLM-5 (free) for transcript reasoning, friction extraction, quote extraction, theme synthesis, session findings |
| Cross-session model | Claude Sonnet 4.5 for study-wide findings |
| Real-time analysis | NOT in V1 — batch only; V2 promotes camera-classifier to real-time so bot reacts |
| Findings grounding | Every claim links to evidence (quotes, frames, sessions). Schema enforces `evidenceRefs` on `Finding`. |
| Synthetic fidelity | Text-text + URL-grounded screenshots + synthetic multimodal signals (so analyzer pipeline is unchanged) |
| Persona source | AI-generated 3–5 from Guide audience field, founder-editable, persisted as reusable `Persona` records |
| Synthetic mode placement | Auto-pilot 1 mini synthetic session on Guide finalization (demo moment) + opt-in N-session deeper pilot |
| Tech stack | Next.js 15 on Cloudflare Workers (`@opennextjs/cloudflare`), D1 + Drizzle, Durable Objects (per-session state + WS fanout), Cloudflare Workflows (analyzer + synthetic + guide creator), R2 (recordings + stage outputs), AI Gateway (LLM proxy with caching/observability/fallback), Workers Cron Triggers (retention, reminders), Cloudflare Containers if Workers limits exceeded |
| Auth | WorkOS AuthKit (1M MAU free tier, SSO/SCIM included) |
| Email | Resend (invitations, reminders, deletion confirmations) |
| Repo strategy | Same repo, single rebuild commit deletes obsolete code, archives prompt specs to `legacy-prompt-specs/` |
| Workspace model | Schema day 1 (`Workspace`, `WorkspaceMember`, `Study.workspaceId`) — no team UI in V1; auto-create personal workspace |
| Pricing in V1 | Free during validation, invite-only / waitlist gating |
| Pricing post-validation | Hybrid: $99/$299/mo base subscription with included session pool + metered overages; synthetic-free-forever; real interviews gated to paid |
| Viral surface | Per-finding shareable URLs with redaction toggles; opt-in public showcase as V2 marketing project |
| Bot disclosure | Triple disclosure: consent screen, bot greeting first sentence, persistent UI badge |
| Consent scope | Camera, screen, microphone, transcript storage, AI analysis, retention, sharing-with-founder — all required checkboxes |
| Recording retention | 365d default, founder-extendable to 3y, participant-deletable anytime via signed link |
| Auto-redaction | None at storage time. Redaction happens at share/export time only (face blur V2, PII regex scrub V2) |
| Participant deletion | Signed `/p/[participantId]/delete?token=...` link in confirmation email; soft-delete session, hard-delete R2 objects, scrub PII from transcripts |
| Session resumption | Invite link valid 7d, multi-open until completed; >30s disconnect = restart from beginning (no mid-session resume in V1) |
| Compensation | Out of band — founders pay participants directly via their own channels |

## System architecture

```
Founder browser ── Next.js (OpenNext on Cloudflare Workers) ──────────┐
                                                                       │
Participant browser ── Next.js consent + interview pages ─┐            │
        │                                                  │            │
        ├── MediaRecorder ──► R2 (camera, screen, audio)    │            │
        ├── Vapi Web SDK ──► Vapi cloud ──► Webhook Worker ─┤            │
        │                                                  │            │
        └── WebSocket ──► Durable Object (per-session) ◄────┘            │
                                       │                                │
                                       └── transcript+events ──► D1 ◄───┤
                                                                        │
                                                  API Worker ◄──────────┘
                                                       │
                          Session.ended? ──► Cloudflare Workflow (analyzer)
                                                       │
                                                       ├── Camera vision (Gemini Flash)
                                                       ├── Screen vision (Gemini Flash)
                                                       ├── Friction confirm (Gemini Pro)
                                                       ├── Reasoning (GLM via AI Gateway)
                                                       └── Cross-session (Claude Sonnet)
                                                       │
                            Findings ──► D1 ──► Dashboard + share/export

Guide creator:    Founder chat ──► Workflow (URL/GitHub fetch + LLM) ──► typed Guide ──► D1
Synthetic users:  Guide ──► Workflow (persona-LLM ↔ bot-LLM text mode) ──► same analyzer
Auth:             WorkOS AuthKit
Email:            Resend (invitations, reminders, deletion confirmations)
Crons:            Retention sweep, reminder emails
```

## Data model (Drizzle, abbreviated)

```ts
// Tenancy
users:              { id, workosUserId, email, name, defaultWorkspaceId, createdAt }
workspaces:         { id, name, ownerId, billingPlan, retentionDays, createdAt }
workspace_members:  { id, workspaceId, userId, role, createdAt }

// Studies
studies:            { id, workspaceId, name, description, status, studyType, targetUrl, createdBy, createdAt }
guides:             { id, studyId, version, json, humanReadable, finalizedAt }
personas:           { id, workspaceId, studyId, name, demographics, goals, expertise, attitudes, antiPatterns, source }
invitations:        { id, studyId, name, email, signedToken, sentAt, openedAt, completedAt, expiresAt }

// Sessions
sessions:           { id, studyId, invitationId, personaId, isSynthetic, runtimeMode,
                      startedAt, endedAt, status, durableObjectId, deletedAt }
recordings:         { id, sessionId, kind: 'camera'|'screen'|'audio', r2Key, durationSec, sizeBytes }
transcript_chunks:  { id, sessionId, speaker, text, tStart, tEnd, sequence }
bot_events:         { id, sessionId, type, payload, ts }

// Analysis
session_analysis:   { id, sessionId, status, completedAt, errorMsg }
camera_signals:     { id, sessionId, t, emotion, focus, engagement, notes }
screen_signals:     { id, sessionId, t, page, action, inferredEvents, frictionFlags }
friction_moments:   { id, sessionId, tStart, tEnd, severity, description, evidenceJson }
quotes:             { id, sessionId, tStart, tEnd, text, significance, themeIds }
themes:             { id, studyId, name, description, evidenceCount }
findings:           { id, studyId, sessionId, title, description, severity, recommendation,
                      evidenceJson, status, shareSlug, shareSettings }

// Billing
billing_events:     { id, workspaceId, kind, quantity, ts, stripeMeterEventId }
```

## The `Guide` shape (the contract for #1, #4, #5)

```ts
type Guide = {
  studyId: string;
  goals: string[];                    // what we're trying to learn
  audience: string;                   // who the participant is supposed to be
  warmup: { questions: string[] };
  tasks: Array<{
    id: string;
    goal: string;                     // what success looks like for this task
    instruction: string;              // what we tell the participant to do
    probes: string[];                 // bot's hip-pocket follow-ups
    successSignal: string;            // for the analyzer
    failureSignal: string;            // for the analyzer
  }>;
  wrapup: { questions: string[] };
  systemPromptOverrides?: string;     // founder-level customization
};
```

## Repo layout (post-rebuild)

```
unfiltered/
├── app/                       # Next.js App Router
│   ├── (marketing)/           # public landing, pricing
│   ├── (app)/                 # authenticated app (sidebar shell)
│   │   ├── studies/
│   │   ├── studies/[id]/
│   │   ├── studies/[id]/sessions/[sid]/
│   │   └── settings/
│   ├── join/[invitationId]/   # participant consent
│   ├── interview/[sessionId]/ # conduction page
│   ├── share/finding/[slug]/  # public finding share (redacted)
│   ├── p/[participantId]/delete/ # GDPR deletion
│   └── api/                   # Next.js API routes (auth callbacks, lightweight)
├── components/
│   ├── ui/                    # shadcn primitives
│   ├── studies/  interview/  dashboard/  guide-creator/  shared/
├── workers/                   # Cloudflare Workers
│   ├── api/                   # main API Worker
│   ├── vapi-webhook/
│   ├── analyzer-workflow/
│   ├── synthetic-workflow/
│   ├── retention-cron/
│   └── reminder-cron/
├── durable-objects/
│   └── session.ts
├── db/
│   ├── schema.ts              # Drizzle schema
│   └── migrations/
├── lib/
│   ├── ai/                    # AI Gateway clients (Gemini, GLM, Claude, OpenAI)
│   ├── prompts/               # system prompts (bot, analyzer stages, persona, guide creator)
│   ├── auth/                  # WorkOS helpers
│   ├── r2/                    # signed-URL upload helpers
│   ├── vapi/                  # Vapi config, tool defs
│   ├── stripe/                # billing helpers (Phase 3)
│   └── shared/                # pure-TS types: Guide, Persona, Finding, etc.
├── hooks/
├── legacy-prompt-specs/       # archived from V1
├── wrangler.toml
├── next.config.ts
├── package.json
└── CLAUDE.md, README.md       # rewritten in Phase 0
```

## Phased build plan

### Phase 0 — Foundation (Week 1)

| Day | Deliverable |
|---|---|
| 1–2 | Rebuild commit (delete obsolete dirs, archive prompt specs); fresh `package.json`; OpenNext + Wrangler scaffold |
| 3–4 | D1 schema + Drizzle migrations; WorkOS AuthKit wired |
| 5 | R2 buckets, AI Gateway, secrets in Wrangler |
| 6–7 | UI shell, sidebar, empty states, shadcn primitives |

### Phase 1 — Synthetic Demo Loop (Weeks 2–5)

| Week | Deliverable |
|---|---|
| 2 | Guide creator: template picker, chat agent, tools (`fetchUrl`, `fetchGithubRepo`, `extractFromFile`, `produceGuide`, `requestClarification`), visual form |
| 3 | Synthetic Workflow: persona generator, persona-LLM ↔ bot-LLM (text mode), tool calls write to D1 |
| 4 | Analyzer Workflow (text-only stages): ingest → friction → quotes → themes → findings |
| 5 | Findings dashboard, auto-pilot on Guide finalize, manual "run pilot" button. **Phase 1 demo: full AI loop, no humans.** |

### Phase 2 — Real-Interview Wedge (Weeks 6–9)

| Week | Deliverable |
|---|---|
| 6 | Invitations + Resend email + signed URLs + consent screen with bot disclosure |
| 7 | Conduction page: Vapi Web SDK + MediaRecorder + R2 multipart + Durable Object per session |
| 8 | Vapi webhook → DO → D1; bot system prompt + tool defs; end-session triggers analyzer |
| 9 | Vision stages: camera (Gemini Flash) + screen (Gemini Flash) + friction confirm (Gemini Pro). **Phase 2 demo: real human → multimodal evidence findings.** |

### Phase 3 — Polish & Paying-Customer-Ready (Weeks 10–12)

| Week | Deliverable |
|---|---|
| 10 | Cross-session synthesis (Claude Sonnet); per-finding shareable URLs with redaction; PDF + Notion export |
| 11 | Founder watch-live via DO WS; reminder emails (cron); onboarding flow with sample study; settings/billing pages |
| 12 | Stripe metering (real + synthetic session meters); pre-session limit checks; beta launch |

## V2 / V3 backlog (deferred, not forgotten)

### V2 candidates
- Real-time vision-driven bot follow-ups (multimodal cross-reference explainer)
- Founder JS snippet for opt-in DOM-level capture (Pro mode)
- Mid-session resumption with Durable Object state preservation
- Transcript PII auto-scrub at ingest
- Face-blurring on shareable findings
- Team UI (invitations, roles)
- Native Linear / Intercom / Notion integrations
- 3rd-party panel integration (Respondent.io API)
- Audio/video uploads in guide creator
- Vectorize-powered cross-session search

### V3 candidates
- Full simulation synthetic users (Playwright + voice)
- Owned panel/marketplace
- Mobile participant flow
- Whole-video understanding (single-call replacing multi-stage vision)
- Founder-customizable bot voices per study
- Public showcase / "Findings of the Week" gallery

## Open risks / known unknowns

1. **OpenAI TTS quality** — if `shimmer`/`alloy` can't sustain the unfiltered-effect during validation, switch a few sessions to ElevenLabs early to A/B
2. **Vision-LLM friction extraction prompt iteration** — Phase 2 likely needs 1–2 weeks of prompt tuning beyond schedule
3. **MediaRecorder + Vapi simultaneous reliability** — known finicky in browsers; needs explicit cross-browser QA in Week 7
4. **Cloudflare Workflows maturity** — still maturing in early 2026; reserve budget for workarounds
5. **Cost ramp watch** — instrument vision-LLM cost-per-session from day 1 of Phase 2; flip to whole-video model if multi-stage drifts above $0.50/session
6. **Synthetic persona believability** — if Phase 1 personas come out generic, the demo loses bite; reserve a few days for persona-prompt iteration
7. **Stripe metering edge cases** — usage-based billing has many gotchas (proration, retries, failed payments); reserve buffer in Phase 3

## What we explicitly are NOT building (V1 scope discipline)

- No team UI (schema only)
- No native integrations (paste suffices)
- No audio/video upload to guide creator
- No real-time camera-to-bot loop (batch only)
- No DOM-injection capture (vision LLM infers)
- No mid-session resume (full restart)
- No mobile participant flow
- No marketplace
- No face-blurring at storage time
- No platform-mediated participant compensation

## Cost envelope (validation phase)

| Item | Source | Available | Estimated burn |
|---|---|---|---|
| Vapi orchestration | Vapi credits | $30 | ~600 min ≈ 20 × 30-min real sessions |
| GLM reasoning | Subscription | Effectively free | Unlimited for V1 |
| OpenAI TTS (validation) | OpenAI credits | $49 | ~$0.005/min spoken; trivial |
| ElevenLabs (reserved) | ElevenLabs credits | 10K | ~2–5 marketing/demo sessions |
| Gemini vision | Pay as you go | n/a | ~$0.05–$0.10 per 30-min session |
| Cloudflare (Workers, D1, R2, Workflows, DO, AI Gateway) | Free tiers | Generous | Effectively free during validation |
| WorkOS | Free tier | 1M MAU free | Free for entire lifetime probably |
| Resend | Free tier | 3K emails/mo free | Free during validation |
