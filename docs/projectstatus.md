# Project Status
**Last updated:** 2026-03-19

## What Happened This Session
- Checked out `feature/voice-benchmark` branch
- Fixed Vercel build errors:
  - Removed unused imports in `lib/benchmark/analysis.ts`
  - Added eslint-disable comments for intentionally unused constructor params in voice provider files
  - Fixed TypeScript type error in benchmark results page evaluation aggregation
  - Manually updated `convex/_generated/api.d.ts` to include benchmark modules (workaround since `npx convex dev` requires interactive auth)
- Build now passes: `npm run build` succeeds
- All 110 tests passing across 18 files
- Pushed fix commit (de35d32) to `feature/voice-benchmark`
- Dev server running at `http://localhost:3000`, benchmark page verified accessible

## Issues / Watch Out For
- `scripts/update-docs.py` uses Anthropic API and will no-op when `ANTHROPIC_API_KEY` is missing
- MiniMax and Fireworks model names should still be re-verified against provider docs before production deploy
- A/B mode policy assignment currently uses local runtime alternation in `hooks/useDecideEngine.ts`
- **Benchmark still needs live E2E test with real API providers**
- The OpenAI Realtime token proxy (`/api/benchmark/openai-proxy`) passes the API key to the client for WebSocket auth — acceptable for dev/benchmark but should use ephemeral session tokens in production
- `recharts` dependency was planned for charts but not yet added to package.json (current charts use CSS-based bars)

## Where We Left Off
- Voice benchmark build errors are fixed and pushed
- **NEXT: Run live E2E benchmark test using browser automation**
- Core V1 interview implementation is unchanged (Speechmatics + ElevenLabs locked)
- Unit test suite: 18 files, 110 tests passing

## How to Continue: Live E2E Benchmark Test

### Environment Variables Required
The Factory Cloud Workspace must have these env vars configured:
```
NEXT_PUBLIC_CONVEX_URL=https://whimsical-badger-116.convex.cloud
CONVEX_DEPLOYMENT=dev:whimsical-badger-116
SPEECHMATICS_API_KEY=***
ELEVENLABS_API_KEY=***
ELEVENLABS_VOICE_ID=***
FIREWORKS_API_KEY=***
MINIMAX_API_KEY=***
OPENAI_API_KEY=***        # NEW - for Whisper + GPT-4 + TTS + Realtime
ASSEMBLYAI_API_KEY=***    # NEW - for AssemblyAI Universal-Streaming
VAPI_API_KEY=***          # NEW - for Vapi voice platform
```

### Quick Start Instructions
1. **Verify env vars loaded**: Run `printenv | grep -E "^(OPENAI|ASSEMBLYAI|VAPI)_" | sed 's/=.*/=***/'`
2. **Sync Convex schema**: Run `npx convex dev --once` (requires interactive auth - may need to handle differently)
3. **Start dev server**: `npm run dev` (or verify it's already running)
4. **Run E2E test using browser automation**:
   - Navigate to `http://localhost:3000/benchmark`
   - Configure benchmark: Select 1-2 providers (Speechmatics + OpenAI Whisper+TTS recommended), select "session_intro" scenario, set repetitions=1
   - Click "Start Benchmark"
   - Verify results stored in Convex
   - Check `/benchmark/results/[runId]` for metrics

### What to Verify During Live Test
- [ ] Speechmatics provider connects and transcribes user text
- [ ] OpenAI Whisper+TTS pipeline: transcription -> GPT-4 response -> TTS audio
- [ ] Results are stored in Convex and visible on results page
- [ ] Latency and WER numbers look reasonable

### Other Unmerged Branches (for reference)
| Branch | Description |
|--------|-------------|
| `codex/pr1-experiments-telemetry` | Experiments infra, PostHog, telemetry |
| `codex/pr2-decide-dashboard` | PR1 + dashboard/interview improvements |
| `feature/e2e-agent-testing` | LiveKit + automated E2E test runner |

### Known Limitations
- Audio stimuli generation not yet wired into runner — sends text via `sendText()` rather than audio via `sendAudio()`
- To test real STT latency: generate audio via `/api/tts`, feed to `sendAudio()`
- CSS-based charts (recharts not added yet)
