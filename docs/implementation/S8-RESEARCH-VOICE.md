# Research scripted voice foundation

October 10, 2026. Local implementation and deterministic fake-provider evidence. This agent performed no provider calls, credential reads, service starts, policy provisioning or backend push. Root separately pushed the frozen backend to existing local3210 and proved bounded native quota counters; actual browser speech acceptance remains pending. The local transport mount is opt-in.

The research participant can stay in text or explicitly select voice in the same session. The question remains readable. Recognized words remain an unsaved editable draft until the participant saves; this foundation supports an explicit finish/review path, not an asserted continuous adaptive interviewer. The approved operator goals/script already exist in the immutable study. Goal-aware DigitalOcean interview follow-ups remain a separate missing integration; no reasoning provider is added here.

## Authority and evidence

`convex/researchSpeech.ts` uses the existing signed gateway proof plus the participant capability for status, exact current-question authorization, reservation, inspection, transcript save/readback and output resolution. The browser cannot write provider transcript sources. An absent/disabled `researchSpeechPolicy` denies speech; no allocation/configuration mutation or automatic enablement is provided. Activation requires a prospectively reviewed account allocation and explicit transport enablement.

Reservation charges the entire 60-second Deepgram bound or exact current-question ElevenLabs characters, under global one-per-provider and durable session/account allowances. Session limits cannot exceed 180 seconds / 3,600 characters; fixed provider routes/models/output limits come from `packages/speech`. Duplicate attempts cannot dispatch again. Unknown/interrupted attempts retain charges and occupy provider concurrency until a separately authorized reconciliation establishes remote settlement; no time-based free reset is provided.

Raw recognition is inserted once as an immutable `researchSources` entry with channel `unreviewed-transcript`. It changes source count/saved timestamp but never advances the script or conversation revision. Attempts store source references only, avoiding a duplicate transcript outside source retention. The reviewed answer uses `speechAttemptId`, verifies the same current question/revision/consent, supersedes that original source, preserves legitimately edited wording and advances the script once. Existing exact answer-request recovery remains idempotent. Ordinary correction cannot silently turn an unreviewed raw source into a completed answer. Source review labels the raw original and confirmed wording separately.

## Transport composition

`apps/research-server/src/research-speech.ts` exports `createResearchSpeechTransport`; it installs no listener and reads no environment/files. `enabled` defaults false. Enabled operation requires injected credentials, typed Convex authority and mandatory durable ingress. `speech-authority.ts` signs each native call and pins the deployment origin with bounded single-dispatch HTTP; a timeout never automatically repeats a mutation.

`speech-ingress.ts` provides an allocated adapter: acquire the existing hosted `voice` lease for STT upgrades/TTS and `operation` lease for status/readback, call native `beginWork` before returning, and expose the exact deadline plus release function. Each actual speech authority dispatch is preceded by current native inspection and one prospectively charged `reserveOperation`; no unallocated production fallback is provided. Inspection/reservation acknowledgements are serialized before each dispatch, with fresh sealed/deadline checks after awaits; concurrent audio/save calls cannot submit later operation ordinals first. Its release preserves unknown native ownership rather than resetting a held slot. Raw Host is canonical unless an explicit fixed local listener Host is supplied; forwarded Host is never authority. The host must forward incoming abort signals and stream HTTP response bodies with backpressure; upgraded sockets must be routed to `upgrade`. Neither a production WS host nor this account's beta eligibility has been qualified. Vercel's current documented Node WebSocket support is relevant, with account/platform qualification still pending.

| Request | Contract |
| --- | --- |
| WS `/api/research/speech/input` | Exact Origin/Host; no query/subprotocol; first bounded JSON `{type:"start",token,requestId,sessionId,promptId,expectedRevision}`; then ready-gated mono 16 kHz PCM16 frames or explicit `{type:"finish"}`. Token never enters a URL. |
| POST `/api/research/speech/output` | `X-Research-Participant`; exact current question via `{requestId,sessionId,sourceId,expectedRevision}`. No arbitrary browser text/model/voice/URL. |
| GET `/api/research/speech/status` | Same-origin/authenticated bounded capability check; generic enabled flag only. |
| POST `/api/research/speech/transcript` | `X-Research-Participant` plus original scope; returns owned immutable raw receipt without provider dispatch, including after pause/newer progress. It does not permit old-question answer advancement or replace edited composer text. |

HTTP work is bounded through stalled body reads, status/receipt authority waits, provider fetch/read/cancel/settlement and response lifetime. Late provider headers are canceled before ingress release. Pending cancellation/authority promises retain the native lease after the browser receives a timeout. WS admission remains occupied until browser and provider native closes plus all started authority/save/settlement work have actually settled; browser close alone is insufficient.

STT forwards prospectively authorized one-second PCM batches with a 64 KB total buffer, plus an immediate explicit finish batch; a check taking more than one second never forwards its queued samples. TTS rechecks at most once per second under its 35-second request envelope. Root approved this bounded cadence on October 10. Remote revocation from another tab has up to one second of exposure; same-browser pause/withdrawal closes locally immediately. This keeps the sixty-second attempt below the current 128-authority-operation lease cap instead of issuing a native query for every audio frame/provider chunk. Fresh authorization remains mandatory for raw save and answer acceptance.

## Browser behavior and remaining qualification

`ResearchSpeech` mounts in the current question, with `useResearchSpeechCapture` and `useResearchSpeechPlayback`. Browser-only PCM/audio helpers were copied into `packages/speech` from the accepted clinic helpers; clinic files remain unchanged in this slice. The worklet is a same-origin research asset. Existing recording microphone tracks can be borrowed; speech finish/interrupt removes only speech processors/listeners, preserving owner tracks and their recording indicator. A separately requested speech microphone stops its own tracks. Camera/screen/DOM controls remain independent. Interview pause interrupts speech and all recording before the durable transition. Hidden/unmounted pages stop speech; switching to text preserves recognized draft words.

Each explicit capture and TTS generation uses a new attempt ID. Connection loss never replays audio, and prepared audio playback retry uses the existing response buffer instead of regenerating speech. Browser-local VAD and explicit capture/mode/pause actions interrupt playback synchronously. This is an implementation mechanism, not measured 500 ms device/barge-in evidence. Unknown raw save is checked through the original receipt route. Where readback confirms no receipt, the participant can explicitly continue with visible typed wording, whose provenance remains separate from any later original voice source.

Passed using Node 22.22.3, 1 GiB heap, one worker and no file parallelism:

- `packages/research-core/test/speech.test.ts`: 8 checks: absent allocation, forged public raw writes/capabilities, unresolved charged concurrency, immutable raw save/recovery, edited acceptance/idempotency/one advancement, pause generation rejection, historical receipt read and exact server prompt output/provenance.
- `apps/research-server/test/research-speech.test.ts`: 6 checks: default disabled, Host/Origin before work, TTS ingress/server text/stream, stalled body unknown cancellation hold, late provider headers cancellation and bounded status read.
- `apps/research-server/test/research-speech-socket.test.ts`: 6 fake native-event checks covering cadence, stale/revoked PCM rejection, finish drain/raw once, pending settlement and immediate shutdown.
- `apps/research-server/test/speech-ingress.test.ts`: 5 checks covering allocated begin, quota denial, ordered concurrent acknowledgements and sealed queues.
- `apps/research/test/research-speech-browser.test.ts`: 4 focused hook checks covering borrowed/owned tracks, immediate barge-in, old-scope cleanup and typed edit preservation.
- Opt-in mount and synthetic provider-port checks: 4 passed.
- Existing `packages/research-core/test/research.test.ts`: 15 checks passed.
- Research frontend, research server and Convex scoped TypeScript noEmit passed.

Still required: explicit reviewed allocations and actual browser HTTP/WS handshake, raw/corrected provenance, prepared playback and shared recording/pause checks; simultaneous DOM+speech; permission denial, real PCM quality, echo/barge-in, mobile/background/Bluetooth; native/platform qualification. These fakes do not establish hosted/live-provider speech acceptance.

The approved EXPERIENCE conversational voice flow is still a separate acceptance gap: utterance completion should advance conversational turns without requiring Finish + Save every time; interrupt/type switching, visible transcripts and deliberate final-session review/corrections must remain. Automatic raw STT must never be mislabeled participant-confirmed or silently admitted to operator self-report analysis. The current raw-source whitelist remains correct until an explicit honest review/provenance mode is designed. Implement that bounded next slice after explicit-turn browser proof.


## Explicit local synthetic browser fixture

`startResearchServer(config, analysisRuntime?, speechRuntime?)` defaults to no speech transport. The optional transport handles HTTP/upgrade/shutdown; Vite5174 proxies research WS to loopback8789. `--synthetic-speech-allocation <immutable allocation ID>` composes the fixed local fake provider ports with real signed native authority and allocated ingress. The startup log identifies synthetic mode. Production/default startup is unchanged.

DEV-only `/participate/synthetic-voice#<invitation capability>` displays “Synthetic voice fixture · no microphone or provider”. Its injected device adapter creates browser AudioContext MediaStreams, supports only microphone recording and never calls microphone/camera/screen permission APIs. STT first borrows an already-live recorder stream; speech finish removes its own processor while recording stays live. Without recording it owns and stops its generated stream. The local recognizer emits exactly `I expected an email receipt` once after PCM; TTS responds with a valid 4510-byte, one-second660Hz mono MP3 tone, not synthetic spoken words. The binary is `apps/research-server/fixtures/synthetic-tone.mp3`; when emitting TypeScript to a separate directory, copy that file to the matching emitted `apps/research-server/fixtures` path before using the CLI. No fake port can fall through to an external provider.

Root-only local fixture policy administration uses `internal.researchSpeechFixture.provision`, `readiness` and `disable`. All require the built-in local `CONVEX_CLOUD_URL` exactly `http://127.0.0.1:3210`. Provision takes a finite prospective allowance, bounded to120seconds/400characters globally and120seconds/200characters per session. It refuses any existing policy, budget or attempt evidence, including a disabled policy; it never resets counters or re-enables. Readiness accepts at most four distinct session IDs and returns counters plus at most eight attempt references per session, no transcript/credentials. Disable stops new admission and preserves all budgets/sources/reservations/unknown holds. The separate native gateway allocation must also be provisioned prospectively by root; no helper bypasses that allocation.

A single raw+edited-answer browser proof needs one60-second STT reservation plus the exact current prompt characters. A second pause/shared-track STT attempt needs a separate approved session or an explicit120-second per-session allowance; unknown/interrupted provider holds are never reset to make the fixture pass. Root performs policy provision, readback, browser acceptance and disable; none has occurred in this agent’s checks.

Root-owned `infra/research/voice-fixture.mjs` now provides `prepare`, `readback` and `disable`. It reads setup-local `localConfig` and the shared bounded `privateJson` only at runtime; native calls are pinned to exact loopback3210 with10-second deadlines and no redirects. Prepare refuses an existing output/policy/allocation before mutations, signs in through normal operator Password auth, creates one two-question synthetic study and two invitations, stores each capability/URL in separate mode0600 files and signs out. Its private checkpoint records partial/unknown frontier and sign-out outcome; no action is automatically retried. Readback preserves the original allocation/attempts and captures session revision, raw/confirmed source linkage and counters. Disable preserves all holds and counters. CLI policy is120seconds/400characters global,60seconds/200characters per session; native gateway allocation is12requests/1readbyte/1storageoperation with a30-minute expiry. Authority operations consume the separate bounded per-lease authority envelope, not fake storage operations. Four native-helper, three injected CLI and two private-reader checks passed; the configuration extraction passed scoped TypeScript validation. Combined native types are deferred to the coordinated reports frontier.

Run from the worktree, after root's coordinated native push and explicit local approval:

```sh
node infra/research/voice-fixture.mjs prepare --allow-local-synthetic-voice --allocation voice-native-VF1 --output apps/research-server/runtime/voice-fixture.private.json
node infra/research/voice-fixture.mjs readback --allow-local-synthetic-voice --output apps/research-server/runtime/voice-fixture.private.json
node infra/research/voice-fixture.mjs disable --allow-local-synthetic-voice --output apps/research-server/runtime/voice-fixture.private.json
```

Prepare has not been executed by this agent. Root can bundle the opt-in listener later, after coordinated checks (no build performed here):

```sh
node_modules/.bin/esbuild apps/research-server/src/index.ts --bundle --platform=node --format=esm --packages=external --outfile=.qualification-build/research-voice/apps/research-server/src/index.mjs
mkdir -p .qualification-build/research-voice/apps/research-server/fixtures
cp apps/research-server/fixtures/synthetic-tone.mp3 .qualification-build/research-voice/apps/research-server/fixtures/synthetic-tone.mp3
node .qualification-build/research-voice/apps/research-server/src/index.mjs --config apps/research-server/runtime/capture.private.json --synthetic-speech-allocation voice-native-VF1
```

Root must coordinate stopping any owned listener on8789 before starting this one; Vite5174 and existing native3210 remain the research facade/backend. Invitation URLs remain only in private files and browser memory. The current explicit-turn fixture does not establish approved continuous conversational voice acceptance.
