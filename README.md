# Unfiltered

Always-on AI voice interviewer for honest, multimodal user research.

- **Synthetic users** to pre-flight your interview guide before burning real-participant goodwill
- **Real interviews** by an AI bot, on demand, any time of day — no scheduling
- **Evidence-grounded findings** with clip links, quotes, and frames for every claim

## Status

**Phase 0 — Foundation.** The repo was just rebuilt from scratch on a Cloudflare-native stack. Active scaffolding; not yet deployable.

See [`docs/v2-architecture-spec.md`](docs/v2-architecture-spec.md) for the full plan, decisions, and phased build schedule.

## Tech Stack

- Next.js 15 on Cloudflare Workers (`@opennextjs/cloudflare`)
- Cloudflare D1 + Drizzle ORM
- Cloudflare Durable Objects (per-session state + WS fanout)
- Cloudflare Workflows (analyzer, synthetic, guide creator)
- Cloudflare R2 (recordings)
- Cloudflare AI Gateway → Gemini, GLM, Claude, OpenAI
- WorkOS (auth)
- Resend (email)
- Vapi (voice runtime)

## Getting Started

```bash
npm install
cp .env.example .env.local       # fill in development values
wrangler d1 create unfiltered-db # paste id into wrangler.toml
npm run db:generate              # generate migrations from schema
npm run db:migrate:local         # apply to local D1
npm run dev                      # http://localhost:3000
```

## Documentation

- **Canonical spec:** [`docs/v2-architecture-spec.md`](docs/v2-architecture-spec.md)
- **Legacy V1 reference (prompts, research notes, old docs):** [`legacy-prompt-specs/`](legacy-prompt-specs/)
- **Codex/agent context:** [`CLAUDE.md`](CLAUDE.md)
