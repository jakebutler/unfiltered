# S3 — bounded speech foundation

Status: reusable core plus local Node routes, clinic authorization and durable admission wiring implemented and tested; **not browser voice acceptance**. Local fake-provider sockets/HTTP verify the transport. No real microphone grant, provider WebSocket, hosted streaming, or mobile latency is established by these tests. Speech is explicitly disabled unless the operator enables it after root qualification. No live provider requests, token minting, account changes, process restarts or spend occurred while implementing this slice.

## Decision and provider evidence

The approved architecture proposes direct browser speech with short-lived credentials. Current provider documentation changes the safe integration choice: Deepgram temporary grants allow multiple inference APIs, and existing sockets can continue after the token expires. A token issued for the application cannot itself enforce this application's transcription-only route, session duration, input bytes, or concurrency. Therefore this implementation exposes **no browser provider token endpoint**. The coordinator selected a server WebSocket relay after this finding. The browser uses the application's authenticated same-origin socket; provider keys remain server-side. [Deepgram token authentication](https://developers.deepgram.com/guides/fundamentals/token-based-authentication).

ElevenLabs single-use tokens support `tts_websocket`, but their documented issuance parameters do not bind the exact session/source text or character allowance needed here. The chosen adapter resolves authorized text server-side and uses the HTTP audio stream endpoint. It pins George (`JBFqnCBsd6RMkjVDRZzb`), `eleven_flash_v2_5`, and `mp3_22050_32`, without a default SDK model, agent orchestration, or fallback. [Single-use tokens](https://elevenlabs.io/docs/api-reference/tokens/create), [stream speech](https://elevenlabs.io/docs/api-reference/text-to-speech/stream).

The coordinator reported SP-Q1: one 218-character synthetic sample produced roughly 51 KB/12.7 seconds of ElevenLabs audio with 829 ms elapsed generation; Nova-3 returned its text exactly in 548 ms. Those are supplied qualification observations for REST generation/transcription, **not results from this package or proof of live streaming, natural conversation, medical-word accuracy, or mobile performance**. The account observations supplied with that evidence were 190.66 Deepgram credits with auto-reload off, and an ElevenLabs free allowance of 10,000 characters without extension. Integration must refresh shared remaining headroom before admission; this document does not reserve it.

All reasoning remains in the existing DigitalOcean adapter. The speech package has no reasoning operation and no provider router.

## Package boundary

| File | Responsibility |
| --- | --- |
| `packages/speech/src/index.ts` | Browser-safe entrypoint only |
| `contracts.ts` | Scope, limits, errors, output references |
| `turn.ts` | Nova-3 result parser and explicit editable voice draft state |
| `playback.ts` | Synchronous stop plus abort/generation invalidation |
| `relay.ts` | Server-only raw PCM STT relay with injected native socket port |
| `server.ts` | Server-only authorized ElevenLabs fetch stream and mandatory admission contract |

No domain storage is introduced. The clinic's normal `TurnInput`/`requestId` remains the persistence path. STT words and TTS playback never persist a clinical answer by themselves.

## Node integration and browser contract

The local entrypoint now installs `apps/clinic-server/src/speech.ts` only when private provider settings contain both `speechEnabled: true` and `speechQualification: "root-reviewed-synthetic-speech"`. `DEEPGRAM_API_KEY` and `ELEVENLABS_API_KEY` remain in server runtime environment. Neither keys being present nor adaptive enablement turns speech on. The marker is an operator assertion, not an automated acceptance result. `packages/clinic-api/src/speech-access.ts` verifies exact Origin, identity-confirmed signed patient cookie, actual session/patient/scenario, current prompt and revision; it reads only and makes no clinical writes. The current prompt is rechecked after admission. TTS rechecks its source after admission too.

| Browser request | Response/behavior |
| --- | --- |
| WebSocket `/api/clinic/speech/input`, no query or subprotocol | Authenticate before upgrade; only one connection per local conversation |
| First JSON within five seconds: `{ "type": "start", "requestId": "<speech attempt UUID>", "sessionId": "<session UUID>", "promptId": "<currentPrompt.id>", "expectedRevision": 3 }` | Validate scope, durably reserve 60 STT seconds, recheck prompt, open fixed provider socket |
| Wait for `{ "type": "ready", "sampleRate": 16000, "channels": 1, "maxCaptureMs": 60000 }` | `maxCaptureMs` may be lower because admission/setup consumes the lease; no PCM before ready |
| Binary mono 16 kHz PCM16 LE frames | Recognition/speech-started events matching browser-safe `SpeechInputEvent` |
| `{ "type": "finish" }` | Drain final recognition, emit `ended`, then close; a network failure may close without a final event |
| Close socket | Interrupt; preserve visible unsent words; no automatic replay/reconnect |
| POST `/api/clinic/speech/output` with `{ "requestId": "<new speech attempt UUID>", "sessionId": "<session UUID>", "expectedRevision": 3, "sourceId": "<currentPrompt.id or adaptive.reply.id>" }` | Incremental `audio/mpeg`; no client text/model/voice/URL accepted |

Speech attempt IDs are distinct from the stable application answer request ID. Each explicit new capture uses a new attempt ID; reconnect never repeats prior audio. The reviewed answer goes through the existing guided/adaptive endpoint with `channel: "confirmed-transcript"`; this is patient-confirmed text provenance, not a claim of retained or independently verified audio. Frozen PHQ items `Q16:MH01`–`MH04` reject capture and transcript input; their exact explicit choices remain the only scoring path. TTS can read their current question.

Node uses pinned `ws` 8.22.0 with native maximum payloads (16 KB browser, 64 KB provider), at most 20,000 browser messages per connection, compression off, redirect following off and a five-second provider handshake timeout. Setup time reduces the remaining capture envelope so it cannot outlive the reserved concurrency lease. Provider URL and auth header are server chosen. Frames before ready, unknown control messages, socket loss and output backpressure close the relay. Socket listeners/timers are removed on terminal close; a temporary error sink covers termination. `http.ts` uses Node pipeline backpressure and request AbortSignal so disconnect cancels upstream TTS without buffering full audio. Vite's existing `/api` proxy has `ws: true`. [Official ws API](https://github.com/websockets/ws/blob/master/doc/ws.md).

The Medplum admission implementation now enforces a single active claim per provider/session as well as global concurrency, including unknown/interrupted claims until their deadline. The allocated allowance, maximum-reservation charge, duplicate denial and restart behavior are unchanged. No private settings or allocations were changed by implementation. Worker native upgrade wiring remains unimplemented and unqualified.

The reducer joins finalized Nova-3 segments and handles interim text separately. `is_final` applies to a segment; `speech_final` marks provider pause detection. Neither is application consent to send. The user explicitly finishes, reviews/corrects, then sends. Unknown save results freeze the exact request ID/payload until the clinic's existing receipt/idempotency path resolves the attempt. Text/voice switching and reconnect preserve the same scope and provisional text; old socket generations are ignored. Never replay previously captured audio automatically after reconnect. [Deepgram endpointing and interim results](https://developers.deepgram.com/docs/understand-endpointing-interim-results).

Explicit finish sends one `CloseStream`, accepts remaining final results, and waits for clean close for up to five seconds. That status completes transcription only. Keep the draft in `listening` while draining; then reduce `finish`. Interrupt immediately instead when the user switches modes, leaves, or loses capture, preserving provisional text as unsent. [Deepgram CloseStream](https://developers.deepgram.com/docs/close-stream).

## Enforced per-attempt limits

| Boundary | Current conservative bound |
| --- | --- |
| STT route | Only `wss://api.deepgram.com/v1/listen`, Nova-3, English, mono PCM16 LE at 16 kHz |
| Input audio | 60 seconds, 1,920,000 raw bytes, each nonempty/even frame at most 16,384 bytes |
| Send rate | At most elapsed audio time plus a two-second burst allowance |
| Upstream queue | At most 64,000 already-buffered bytes before another frame |
| Idle/capture lifetime | Ten seconds without a frame, 65 seconds absolute including final drain |
| Recognition frames | 64,000 bytes each, 600 messages and 2 MB cumulative per connection |
| Editable turn | 8,000 characters and 256 final segments |
| TTS input | 1,200 characters from one server-resolved source; longer text stays readable, never silently truncated |
| TTS output | 600,000 bytes; 30-second total request/body lifetime, including an unread/stalled stream |

Raw PCM has an enforceable duration-to-byte ratio; a compressed file's length would not establish its audio duration. The browser must actually resample its reported AudioContext rate to 16 kHz and send signed little-endian PCM. MediaRecorder WebM/MP4 bytes do not satisfy this relay's contract. These values need browser/network qualification, including Worker CPU; they are not demonstrated capacity. [Deepgram encoding contract](https://developers.deepgram.com/docs/encoding).

Provider concurrency and account-wide quota cannot be enforced by a generic stateless adapter. **Admission is mandatory and has no permissive default.** Before connecting STT, reserve a full 60 seconds; before TTS, `createSpeechOutput` reserves the exact text length. The integration must atomically enforce one active capture per conversation, one active request per provider/conversation, an explicit global provider concurrency limit, per-session totals, and qualified shared account headroom. The attempt key includes provider, session and request ID. Reject duplicate or unresolved attempts; no automatic retry. Settlement must never refund canceled/unknown work or immediately reuse a slot when remote termination is unconfirmed. If settlement fails, preserve the reservation for reconciliation. An in-memory ledger is suitable only for a declared single-process local qualification and is not distributed admission for multiple Workers/Node replicas. No claim of a provider-enforced spending cap follows from these local bounds.

## Required host integration

1. Add `packages/speech/src/**/*.ts` to foundation typechecking and `packages/speech/test/**/*.test.ts` to foundation Vitest. Browser imports must use `src/index`, never `server`/`relay` or runtime secret configuration.
2. Add a same-origin authenticated WebSocket upgrade route. Validate exact `Origin`, HttpOnly identity-confirmed patient capability, session, current prompt and expected revision before admission. The browser never chooses upstream URL, model, headers or provider control frames. Node needs an actual server upgrade implementation; Worker needs native WebSocketPair/fetch-upgrade wiring. Those entrypoints are deliberately not asserted interchangeable by this pure port.
3. Reserve, connect the exact `deepgramListenUrl` with server `Authorization: Token …`, and bound provider connection setup to ten seconds. On failed/unknown connection, settle conservatively and require explicit recovery. Construct `createSpeechRelay` only after the upstream is open; attach native message/close/error listeners and remove them on terminal state. Never let messages arrive before listeners are installed. An outbound server WebSocket API must support the auth header; native browser WebSocket is unsuitable for the server key.
4. Accept only binary PCM frames and the application-level explicit finish action; call `audio`, `finish`, `providerMessage`, `providerClosed`, `providerFailed`, or `interrupt` accordingly. Reject oversized frames at the native socket parser too, before they are fully buffered. Bound browser output queue to 64 KB and throw/close on backpressure. Forward normalized `RelayEvent` only, annotated with the current capture generation in the browser. No provider metadata, raw error body, key, token or clinical text belongs in logs.
5. For TTS, strictly validate `SpeechOutputRequest` on a same-origin POST and authorize against the authenticated session. Resolve `sourceId` to the current prompt or an allowed assistant source at the exact revision; reject patient turns and unrelated/older sources. Do not accept browser text. `createSpeechOutput` verifies the resolved scope and applies bounds. Forward its body incrementally with backpressure and tie request abort/client disconnect to its AbortSignal. The current Node handler must not call `response.arrayBuffer()` for this route.
6. The TTS `requestId` is a distinct speech attempt ID, reused to reconcile ambiguity, never a free regeneration token. Store only the necessary admission/receipt information within the app's authorized storage. Existing clinical `requestId` remains the application answer ID; speech completion is not its receipt.
7. Obtain microphone permission only from a deliberate gesture after the transcription/no raw clinic audio retention explanation. Request microphone only. On denial keep typing available. Stop all MediaStream tracks, capture processor and upstream on capture end, unmount, navigation, background suspension, revoked permission or lost authorization. The browser owns PCM conversion, audio level/voice activity detection, and the same-session composer binding.
8. Create `SpeechPlayback` for the conversation. On stop, text/voice switch, user voice activity, capture loss or navigation call `interrupt` immediately. For each response use `begin`, attach a synchronous stop function **before** awaiting audio play/decode/resume, and check `isCurrent` after asynchronous work. Resume/retry of blocked playback must not regenerate speech or resubmit a patient answer. To meet 500 ms barge-in, browser-local voice detection must stop playback; remote VAD alone is not a timing guarantee. Echo cancellation and speaker/headphone behavior need testing.

## Local evidence and remaining qualification

Run `npx vitest run --config packages/speech/vitest.config.mts` for the isolated suite. Local tests exercise final/interim accumulation, duplicate finals, reconnect generation, frozen uncertain submission, matching receipt, stale playback cancellation, fixed route, PCM/rate/time/backpressure/message bounds, finish/drain, authorization scope, quota denial, chunked output bounds, body timeout, disconnect, provider-error redaction and no automatic retry. The source is also checked with TypeScript using ES2022/DOM and NodeNext. These tests use synthetic fake fetch/socket ports and no provider calls.

Added native tests cover exact-origin/cookie/scope denial, disabled settings, native oversized frames, provider auth/config pinning, overlap denial, post-admission scope changes, rejected admission, readiness, final drain, listener/socket shutdown, and real local HTTP first-chunk delivery followed by client disconnect cancellation. All provider endpoints in those tests are local fakes; they spend no account credit.

Still required: root-approved speech allocation/enablement; actual microphone consent and denial; PCM capture/resampling quality; real browser STT/TTS stream and playback gesture handling; echo/barge-in; provider final drain; reconnect with uncertain receipt; same-session text/voice corrections; mobile lock/background/Bluetooth behavior; Worker upgrade/stream wiring and limits; provider cancellation and quota reconciliation. Qualify English desktop and mobile with at least 20 representative successful turns per device class plus all failures, p95 end-of-utterance to first usable text/audio at most five seconds, local feedback within one second, and stop/barge-in within 500 ms. At eight seconds show the approved still-working state and text controls without a second provider request. Test negation, amounts, units and medical names. Nothing here authorizes real PHI or establishes provider retention/compliance suitability.
