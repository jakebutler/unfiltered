# Project Status
**Last updated:** 2026-03-18

## What Happened This Session
- Built voice implementation benchmarking framework for comparing providers (Vapi, OpenAI Whisper+TTS, OpenAI Realtime, AssemblyAI, Speechmatics)
- Created provider abstraction layer in `lib/voice/` with unified VoiceProvider interface
- Added 19 UX research usability session scenarios in `lib/benchmark/scenarios/`
- Extended Convex schema with `benchmarkRuns`, `benchmarkSessions`, `benchmarkEvaluations` tables
- Built benchmark UI at `/benchmark` with run config, progress tracking, blind manual evaluation, and results dashboard
- Added API proxy routes for OpenAI, AssemblyAI, and Vapi token exchange
- Pure TypeScript WER (Word Error Rate) implementation in `lib/voice/metrics.ts`
- 110 tests passing across 18 test files (40 new tests added)
- Fixed pre-existing vitest 4.x ESM issue by renaming `vitest.config.ts` to `vitest.config.mts`

## Issues / Watch Out For
- `scripts/update-docs.py` uses Anthropic API and will no-op when `ANTHROPIC_API_KEY` is missing
- MiniMax and Fireworks model names should still be re-verified against provider docs before production deploy
- A/B mode policy assignment currently uses local runtime alternation in `hooks/useDecideEngine.ts`
- **Benchmark has NOT been live-tested yet** — unit tests pass but no end-to-end run with real API providers has been executed
- The OpenAI Realtime token proxy (`/api/benchmark/openai-proxy`) passes the API key to the client for WebSocket auth — acceptable for dev/benchmark but should use ephemeral session tokens in production
- `recharts` dependency was planned for charts but not yet added to package.json (current charts use CSS-based bars)

## Where We Left Off
- Voice benchmark framework is fully implemented but needs a live end-to-end test
- Core V1 interview implementation is unchanged (Speechmatics + ElevenLabs locked)
- Unit test suite: 18 files, 110 tests passing

## How to Continue: Run the Live Benchmark

### Prerequisites
Ensure these environment variables are set in `.env.local`:
```bash
# Existing (should already be configured)
NEXT_PUBLIC_CONVEX_URL=<your-convex-url>
SPEECHMATICS_API_KEY=<your-key>
ELEVENLABS_API_KEY=<your-key>
ELEVENLABS_VOICE_ID=<your-voice-id>
FIREWORKS_API_KEY=<your-key>
MINIMAX_API_KEY=<your-key>

# NEW — required for benchmark providers
OPENAI_API_KEY=<your-key>        # Whisper STT + GPT-4 + TTS + Realtime API
ASSEMBLYAI_API_KEY=<your-key>    # AssemblyAI Universal-Streaming
VAPI_API_KEY=<your-key>          # Vapi voice platform
```

### Step-by-step
1. **Install dependencies**: `npm install`
2. **Start Convex dev server**: `npx convex dev` (this will push the new benchmark schema tables)
3. **Start Next.js dev server**: `npm run dev`
4. **Navigate to** `http://localhost:3000/benchmark`
5. **Configure a run**: Select providers (start with Speechmatics + OpenAI Whisper+TTS for initial test), select scenarios (primary 8 recommended), set repetitions to 1 for first run
6. **Click "Start Benchmark"** — watch progress in real-time
7. **Review results** on the results page (linked from benchmark history)
8. **Evaluate sessions** via `/benchmark/eval/[runId]` — blind mode hides provider names until after rating

### What to verify during live test
- [ ] Speechmatics provider connects and transcribes user text
- [ ] OpenAI Whisper+TTS pipeline: transcription -> GPT-4 response -> TTS audio
- [ ] OpenAI Realtime API: single WebSocket conversation works
- [ ] AssemblyAI streaming transcription connects
- [ ] Vapi web call creation and WebSocket messaging
- [ ] Results are stored in Convex and visible on results page
- [ ] Manual evaluation form submits ratings to Convex
- [ ] Latency and WER numbers look reasonable

### Known limitations for first run
- Audio stimuli generation (ElevenLabs TTS for simulated user voices) is not yet wired into the runner — the current runner sends text via `sendText()` rather than audio via `sendAudio()`. This tests the LLM response pipeline but not the actual STT latency with real audio
- To test real STT latency, the next step would be to: (1) generate audio for each scenario turn using `/api/tts`, (2) feed that audio buffer to `sendAudio()` instead of `sendText()`
- The CSS-based charts work but could be upgraded to recharts for publication-quality output
