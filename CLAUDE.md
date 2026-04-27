<coding_guidelines>
# Unfiltered v2 — Codex Context

## What This Project Is
Unfiltered is an always-on AI voice interviewer for honest, multimodal user
research. Founders generate a research plan from messy inputs, run synthetic
users for pre-flight validation, then send a link to real customers who get
interviewed by an AI bot — full voice + camera + screen capture, batch
multimodal analysis, evidence-grounded findings.

This repo was rebuilt from scratch on a Cloudflare-native stack. The previous
implementation (Convex + Speechmatics + custom decide-engine) is archived under
`legacy-prompt-specs/` and `legacy-prompt-specs/legacy-docs/`.

## Start Here Each Session
1. `docs/v2-architecture-spec.md` — canonical reference: thesis, decisions,
   phased plan, data model, repo layout
2. `legacy-prompt-specs/` — archived V1 prompt specs and docs (still useful as
   prompt-engineering reference for analyzer stages)
3. `db/schema.ts` — current Drizzle schema (D1)
4. `wrangler.toml` — Cloudflare Workers + DO + D1 + R2 bindings

## Repo Structure (post-rebuild)
```text
unfiltered/
├── app/                          # Next.js App Router on Cloudflare Workers
│   ├── (marketing)/  page.tsx
│   ├── (app)/                    # authenticated app
│   │   ├── studies/
│   │   ├── studies/[id]/
│   │   └── settings/
│   ├── join/[invitationId]/      # participant consent
│   ├── interview/[sessionId]/    # conduction page
│   ├── share/finding/[slug]/     # public finding share
│   ├── p/[participantId]/delete/ # GDPR deletion
│   └── api/                      # Next.js API routes
├── components/
│   ├── ui/                       # shadcn primitives (do not edit)
│   ├── studies/  interview/  dashboard/  guide-creator/  shared/
├── workers/                      # Cloudflare Workers
│   ├── api/                      # main API Worker
│   ├── vapi-webhook/
│   ├── analyzer-workflow/
│   ├── synthetic-workflow/
│   ├── retention-cron/
│   └── reminder-cron/
├── durable-objects/
│   └── session.ts
├── db/
│   ├── schema.ts                 # Drizzle schema
│   ├── index.ts                  # getDb(d1) helper
│   └── migrations/
├── lib/
│   ├── ai/                       # AI Gateway clients (OpenRouter, GLM, OpenAI)
│   ├── email/                    # Cloudflare Email Service helpers
│   ├── prompts/                  # system prompts
│   ├── auth/                     # WorkOS helpers
│   ├── r2/                       # signed-URL upload helpers
│   ├── vapi/                     # Vapi config + tool defs
│   ├── stripe/                   # billing helpers (Phase 3)
│   ├── shared/types.ts           # Guide, Persona, Finding, etc.
│   └── utils.ts                  # cn() helper
├── hooks/
└── legacy-prompt-specs/          # archived V1 reference
```

## Tech Stack
- Frontend: Next.js 15 on Cloudflare Workers via `@opennextjs/cloudflare`
- Database: Cloudflare D1 + Drizzle ORM
- Real-time session state: Durable Objects (per-session)
- Long-running jobs: Cloudflare Workflows (analyzer, synthetic, guide creator)
- Object storage: Cloudflare R2 (recordings + analyzer stage outputs)
- AI: Cloudflare AI Gateway →
  - `openrouter` (Anthropic Claude + Google Gemini)
  - `compat` Custom Provider for GLM via Z.ai
  - `openai` for TTS validation
- Auth: WorkOS AuthKit
- Email: Cloudflare Email Service (`env.EMAIL.send`)
- Voice runtime: Vapi (orchestrator) + GLM (brain) + OpenAI tts-1 (validation)
- Unit tests: Vitest

## LLM Model Assignments (Canonical)
| Use Case | Model | Provider |
|---|---|---|
| Bot brain (voice + text) | `glm-5` | Z.ai (Custom Provider) |
| Guide creator chat agent | `glm-5` | Z.ai |
| Synthetic persona LLM | `glm-5` | Z.ai |
| Quote extraction, theme synthesis, session findings | `glm-5` | Z.ai |
| Camera frame classifier | `google/gemini-2.5-flash` | OpenRouter |
| Screen frame analyzer | `google/gemini-2.5-flash` | OpenRouter |
| Whole-video friction confirmation | `google/gemini-2.5-pro` | OpenRouter |
| Cross-session synthesis (study-wide) | `anthropic/claude-sonnet-4-5` | OpenRouter |
| TTS (validation) | `tts-1` | OpenAI direct |
| TTS (production / marketing) | ElevenLabs (reserved) | — |

## Code Conventions
- `lib/`: pure TS only, no Cloudflare bindings or browser globals
- `db/`: Drizzle schema + helpers; D1 is `env.DB`
- `workers/`: Cloudflare Workers, each with own entry, share `lib/` and `db/`
- `durable-objects/`: per-instance stateful classes
- `app/`: Next.js App Router; client components only when interactivity required
- `components/ui/`: generated shadcn primitives, do not modify
- Always guard JSON parsing for LLM responses with safe fallbacks (`zod`)
- Bot reasoning is a single agent + structured tool calls — no multi-agent

## Key Product Decisions
- Wedge: synthetic interviewer + guide creator on-ramp
- Conduction: always-on bot, interviewee picks own time, real-time voice
- Studies in V1: live URL (incl. hosted prototypes) + voice-only discovery
- Participants: BYO via founder name+email invite
- Bot disclosure: triple (consent screen, bot greeting, persistent UI badge)
- Capture: transcript + bot tool events + camera + screen + audio
- DOM-level signals: inferred by vision LLM in batch (no script injection)
- Findings: every claim links to evidence (quote, frame, session)
- Analyzer: multi-stage Cloudflare Workflow with checkpointed steps
- Synthetic users: text-text + URL-grounded screenshots + multimodal signals
- Persona source: AI-generated from Guide audience, founder-editable, persisted
- Sharing: per-finding shareable URLs with redaction toggles (Phase 3)
- Pricing: free during validation → hybrid base+metered post; synthetic-free,
  real interviews gated to paid

## Phased Build Plan (high level)
- Phase 0 (Week 1): Foundation — D1 + WorkOS + R2 + AI Gateway + UI shell
- Phase 1 (Weeks 2–5): Synthetic Demo Loop — guide creator + synthetic + analyzer (text)
- Phase 2 (Weeks 6–9): Real-Interview Wedge — invitations + conduction + multimodal
- Phase 3 (Weeks 10–12): Polish — cross-session + sharing + Stripe metering

See `docs/v2-architecture-spec.md` for full detail.

## Commands
```bash
# Local Next.js dev (http://localhost:3000)
npm run dev

# Worker dev (Cloudflare bindings — D1, R2, AI, DO)
npm run wrangler:dev

# OpenNext build + Cloudflare preview
npm run cf:preview

# Deploy to Cloudflare
npm run cf:deploy

# DB migrations
npm run db:generate          # generate from schema.ts
npm run db:migrate:local     # apply to local D1
npm run db:migrate:remote    # apply to remote D1
npm run db:studio

# Lint, typecheck, test
npm run lint
npm run typecheck
npm test
```

## Environment Variables
Public (in `wrangler.toml [vars]`):
- `ENVIRONMENT`, `PUBLIC_APP_URL`, `AI_GATEWAY_NAME`

Secrets (via `wrangler secret put`):
- `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_REDIRECT_URI`, `WORKOS_COOKIE_PASSWORD`
- `EMAIL_FROM_ADDRESS` (sending address on a domain verified in
  Cloudflare Email Service; the binding itself needs no API key)
- `OPENAI_API_KEY` (TTS + occasional LLM)
- `OPENROUTER_API_KEY` (Anthropic + Gemini, via OpenRouter)
- `GLM_API_KEY` (Z.ai, via Custom Provider on AI Gateway)
- `VAPI_PRIVATE_KEY`, `VAPI_PUBLIC_KEY` (Phase 2)
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (Phase 3)
- `INVITATION_HMAC_SECRET` (signing participant URLs, Phase 2)

For local dev: `.env.local` mirrors public vars; secrets via
`wrangler dev --local` and a `.dev.vars` file (gitignored).

## What We Are NOT Building (V1 scope discipline)
- No team UI (schema only)
- No native integrations to Linear/Intercom/Zendesk (paste suffices)
- No audio/video upload to guide creator
- No real-time camera-to-bot loop (batch only)
- No DOM-injection capture (vision LLM infers)
- No mid-session resume (full restart)
- No mobile participant flow
- No marketplace
- No face-blurring at storage time (only at share/export)
- No platform-mediated participant compensation
</coding_guidelines>
