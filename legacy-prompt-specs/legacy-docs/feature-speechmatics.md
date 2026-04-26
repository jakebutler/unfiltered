# Feature: Speechmatics Realtime Transcription

**Status:** Implemented (retry hardening pending)
**Plan tasks:** Task 7, Task 12

---

## What It Does

Streams participant speech to Speechmatics and writes timestamped transcript segments to Convex.

---

## Implemented Architecture

### Server token exchange
- File: `app/api/speechmatics-token/route.ts`
- Returns short-lived JWT from `SPEECHMATICS_API_KEY`

### Client realtime hook
- File: `hooks/useSpeechmatics.ts`
- Opens Speechmatics WebSocket with JWT
- Streams audio from `public/audio-processor.js`
- Emits final transcript segments with word timing

### Persistence
- File: `convex/transcripts.ts`
- Writes transcript segments to `transcriptSegments`

---

## Notes

- Microphone permission required
- Audio is encoded as PCM and streamed over WebSocket
- Transcript segments feed `useSignalProcessor` for friction analysis
