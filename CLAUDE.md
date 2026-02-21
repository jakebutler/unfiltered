# Unfiltered — Codex Context

## What This Project Is
Unfiltered is an AI-powered UX interview platform. It runs live moderated sessions, detects friction from speech + camera + mouse signals, and generates evidence-backed findings.

## Start Here Each Session
1. `docs/projectstatus.md` — current implementation state and next step
2. `docs/spec.md` — product behavior and user flows
3. `docs/techspec.md` — technical architecture + current schema and file map
4. `docs/plans/2026-02-21-unfiltered-v1.md` — original implementation plan (reference)

## Repo Structure (Current)
```text
unfiltered/                       # repo root
├── app/                          # Next.js App Router
│   ├── studies/                  # founder study setup + management
│   ├── join/[studyId]/           # participant consent/start
│   ├── interview/[sessionId]/    # live interview room
│   ├── dashboard/[sessionId]/    # findings dashboard
│   └── api/speechmatics-token/   # Speechmatics JWT exchange
├── components/
│   ├── interview/                # interview UI panels
│   ├── dashboard/                # findings UI panels
│   └── ui/                       # shadcn/ui primitives (do not edit)
├── hooks/                        # client orchestration hooks
├── lib/                          # pure TypeScript logic (unit tested)
├── convex/                       # schema + queries/mutations/actions
├── docs/                         # product + technical docs
├── scripts/update-docs.py        # stop hook docs updater
├── .claude/settings.json         # stop hook config
└── [reference prompt docs at root]
```

## Tech Stack
- Frontend: Next.js 15, TypeScript, Tailwind, shadcn/ui
- Backend: Convex
- Realtime transcription: Speechmatics Realtime API (WebSocket)
- LLM reasoning + synthesis: GLM-5 via FireworksAI (OpenAI SDK)
- Camera classification: MiniMax Vision via MiniMax API (OpenAI SDK)
- Voice output: ElevenLabs neural TTS (with Web Speech fallback)
- Unit tests: Vitest

## LLM Model Assignments (Canonical)
| Use Case | Model |
|---|---|
| Policy B (realtime decide) | GLM-5 via FireworksAI |
| Post-session finding labeler | GLM-5 via FireworksAI |
| Themes summary | GLM-5 via FireworksAI |
| Camera classifier | MiniMax Vision via MiniMax API |
| Stop-hook doc generation | `claude-haiku-4-5-20251001` (utility only) |

## Code Conventions
- Convex mutations: write-only DB operations
- Convex actions: all external API calls (FireworksAI, MiniMax, Speechmatics JWT)
- `lib/`: pure TS only, no Convex/browser imports
- `hooks/`: client-only orchestration with `use*` naming
- `components/`: presentational composition; keep business logic in hooks/lib
- `components/ui/`: generated shadcn primitives, do not modify
- Always guard JSON parsing for LLM responses with safe fallbacks

## Key Product Decisions
- Friction score is numeric `0–100`, displayed as LOW/MED/HIGH
- Store full camera `signals` sub-object (all 4 booleans + notes)
- Store `verificationQuestion` in V1 (founder confirmation UI is V2)
- Run post-session labeler on all friction moments
- Canonical mouse summary shape: `{ inactiveSec, erraticness, repeatClicksSameRegion, scrollBursts }`
- Policy A and Policy B share one output schema

## Commands
```bash
npm test
npm run dev
npx convex dev
python3 scripts/update-docs.py
```

## Environment Variables (`.env.local`)
```bash
NEXT_PUBLIC_CONVEX_URL
SPEECHMATICS_API_KEY
FIREWORKS_API_KEY
MINIMAX_API_KEY
ELEVENLABS_API_KEY
ELEVENLABS_VOICE_ID
```

## Documentation Workflow
- Stop hook triggers `scripts/update-docs.py` after each turn if git changes exist.
- Auto-updated: `docs/projectstatus.md`, `docs/changelog.md`
- Manually update when behavior changes: `docs/spec.md`, `docs/techspec.md`, `docs/feature-*.md`

## Reference Docs (Prompt Specs)
- `behavioral-friction-signal-research.md`
- `camera-engagement-classifier.md`
- `decide-engine-policy-b-prompt.md`
- `determinstic-decide-policy.md`
- `post-session-candidate-finding-labeler.md`
- `multimodal-cross-reference-explainer.md` (V2)
