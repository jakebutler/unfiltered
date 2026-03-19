# Project Status
**Last updated:** 2026-03-19

## What Happened This Session
- **Git cleanup and branch consolidation:**
  - Closed PRs #1 and #2 (superseded by PR #3)
  - Merged PR #5 (voice-benchmark) into main
  - Merged PR #3 (experiments console, telemetry, dashboard improvements) into main
  - Merged PR #4 (E2E agent testing with LiveKit) into main
  - Resolved merge conflicts in `convex/schema.ts` and `tsconfig.json`
  - Cleaned up local branches and remote tracking refs
- **Live E2E benchmark test completed:**
  - OpenAI Whisper+TTS provider tested successfully
  - 8/8 sessions passed with latency metrics captured
  - Results stored in Convex and visible on results page
- **All features now consolidated on `main` branch**

## Current State
- **Test suite:** 36 files, 171 tests passing
- **Build:** Passing (`npm run build` succeeds)
- **Dev server:** Running on port 3001 (when active)
- **Convex:** Schema deployed with all tables (core + experiments + benchmark + agent testing)

## Features Now in Main

| Route | Description | Status |
|-------|-------------|--------|
| `/studies` | Study management | V1 complete |
| `/interview/[sessionId]` | Live interview runtime | V1 complete |
| `/dashboard/[sessionId]` | Findings dashboard | V1 complete |
| `/experiments` | Experiments console | NEW - merged from PR #3 |
| `/benchmark` | Voice provider benchmarking | NEW - merged from PR #5 |
| `/test-runner` | E2E agent testing | NEW - merged from PR #4 |

## Issues / Watch Out For
- `scripts/update-docs.py` uses Anthropic API and will no-op when `ANTHROPIC_API_KEY` is missing
- MiniMax and Fireworks model names should be verified against provider docs before production deploy
- A/B mode policy assignment uses local runtime alternation in `hooks/useDecideEngine.ts`
- The OpenAI Realtime token proxy passes API key to client — should use ephemeral session tokens in production
- Speechmatics provider is transcription-only (doesn't support `sendText` for benchmark runner)

## Environment Variables Required
```
NEXT_PUBLIC_CONVEX_URL
CONVEX_DEPLOYMENT
SPEECHMATICS_API_KEY
ELEVENLABS_API_KEY
ELEVENLABS_VOICE_ID
FIREWORKS_API_KEY
MINIMAX_API_KEY
OPENAI_API_KEY          # For Whisper + GPT-4 + TTS + Realtime
ASSEMBLYAI_API_KEY      # For AssemblyAI Universal-Streaming
VAPI_API_KEY            # For Vapi voice platform
LIVEKIT_URL             # For E2E agent testing
LIVEKIT_API_KEY         # For E2E agent testing
LIVEKIT_API_SECRET      # For E2E agent testing
POSTHOG_PROJECT_API_KEY # Optional - for analytics
```

## How to Continue
1. **Deploy Convex schema:** `CONVEX_DEPLOY_KEY=<key> npx convex deploy`
2. **Start dev server:** `npm run dev`
3. **Run interviews:** Use `/studies` to create study, then `/interview/[sessionId]`
4. **Run benchmarks:** Use `/benchmark` to test voice providers
5. **Run experiments:** Use `/experiments` for A/B testing with telemetry

## Known Limitations
- Audio stimuli generation not wired into benchmark runner — uses `sendText()` rather than `sendAudio()`
- E2E agent testing requires separate `interviewee-agent` service (not in this repo)
- CSS-based charts (recharts not added yet)
