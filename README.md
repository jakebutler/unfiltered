# Unfiltered

Unfiltered is an AI UX researcher that runs live moderated user interviews and surfaces friction moments automatically.

## What It Does

- Runs interview sessions against a prototype URL
- Streams participant transcription in real time
- Detects friction signals from speech and behavior
- Uses configurable decide policies (A, B, and A/B)
- Produces a findings dashboard with moment cards and exports

## Tech Stack

- Next.js 15 + React 19 + TypeScript
- Convex backend functions and schema
- Vitest for unit tests

## Quick Start

```bash
npm install
# terminal 1
npx convex dev

# terminal 2
npm run dev
```

Open `http://localhost:3000`.

## Environment

Create `.env.local` with required keys:

- `SPEECHMATICS_API_KEY`
- `FIREWORKS_API_KEY`
- `MINIMAX_API_KEY`
- `MINIMAX_MODEL` (optional, defaults to `MiniMax-Text-01`)
- `ELEVENLABS_API_KEY` (optional for narrated output)
- `POSTHOG_PROJECT_API_KEY` (optional, enables server-side experiment analytics events)
- `POSTHOG_HOST` (optional, defaults to `https://us.i.posthog.com`)

## Scripts

```bash
npm run dev      # local development
npm run test     # run unit tests
npm run lint     # lint codebase
npm run build    # production build
```

## Repo Status

Current implementation is V1/hackathon scope with study setup, interview runtime, signal processing, decide engine, and findings dashboard.
