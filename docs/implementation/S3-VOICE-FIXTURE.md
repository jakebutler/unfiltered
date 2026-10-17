# Synthetic browser voice integration fixture

This explicitly named development page runs the actual `PatientApp`, React capture/playback hooks, `AudioWorklet`, PCM resampler, same-origin WebSocket transport, signed identity-confirmed patient cookie, Medplum draft persistence and durable provider admission. A source factory supplies a generated signal instead of requesting a microphone. Existing server adapter injection points supply fake transcription, deterministic extraction and streamed MP3 tone. No external provider key is loaded and the runtime fetcher accepts only the configured loopback Medplum origin.

The source factory is an optional `PatientApp`/`useSpeechCapture` dependency. Normal application callers provide none and retain the existing microphone behavior. The fixture HTML is absent from the production build; its module additionally rejects non-development builds and origins other than `http://localhost:5190`.

## Run

Use Node 22 with local Medplum already running and `infra/local/.clinic-config.json` available as a private file:

```sh
npm run foundation:build
node scripts/qualification/serve-voice-integration-fixture.mjs
```

In a second terminal:

```sh
npx vite --config apps/clinic/vite.voice-fixture.config.ts
```

Open `http://localhost:5190/voice-integration-fixture.html`. `localhost` keeps the fixture patient cookie separate from the regular `127.0.0.1:5173` clinic. API and fake transcription bind only to loopback ports 8790 and 8791. The regular API on 8787 and its SP-B1 allocation remain unchanged. Each fixture process has a separate, bounded durable **fake-provider** allocation and a 45-minute lifetime. Restart creates a new synthetic allocation, not new live credit authority.

The script prints its receipt path under ignored `.qualification-build/voice-integration/`. It writes private configuration and a synthetic-only diagnostic receipt there. No secrets appear in the console or receipt. The report is not an acceptance result by itself.

## Visible browser sequence

1. Choose first intake, acknowledge synthetic details, start, and confirm the fictional persona using the ordinary UI.
2. Open **Use voice**, select its consent checkbox, and **Start voice conversation**. The fixture source never calls `getUserMedia`; normal UI permission wording remains visible because this is the real application component.
3. With capture listening, use the fixture's **Send synthetic utterance**. It emits a 450 ms signal. Fake STT must receive nonzero PCM through the actual socket before it returns the selected phrase; silence alone never generates a transcript.
4. The default phrase maps Q01 reason. After a clean final drain, verify one durable unreviewed source and one interpretation, followed by the next capture and streamed tone. The tone lasts eight seconds so the next pulse can exercise local barge-in.
5. Select the priority phrase and pulse while the tone plays. The third phrase supplies explicit no-current-symptoms. Use **Inspect fixture evidence** to read durable sources, operation identities/statuses and request/stream counts without resetting patient identity.
6. Use **Disconnect fake transcription** during listening to test interruption and absence of automatic reconnect. Explicit resume remains subject to the real durable admission lease; an interrupted claim remains occupied until its deadline.
7. Switch to typing and submit one of the exact disclosed phrases, then stop voice, open **Review my answers**, inspect provenance and confirm a partial handoff if that is part of the coordinator's test.

The deterministic proposer recognizes only the three displayed phrases. Other text stays durable but fails synthetic interpretation; it is not sent to an external fallback. Provider admission bounds are real, but the fixture does not establish live quota accuracy. Playback is an MP3 tone, so it does not establish intelligibility, model response quality, human microphone behavior, acoustic echo handling or real end-to-end latency. Autoplay behavior must be observed in the actual target browser; a tone stream receipt alone is insufficient.

## Verification at creation

- Clinic typechecking, foundation compilation and 91 clinic tests passed.
- The clinic production build passed; generated files contain neither fixture HTML nor the fixture strings/route/proposer.
- Loopback server startup completed its existing Medplum runtime qualification. Browser flow validation remains separate coordinator evidence.

No live provider request, microphone grant, cloud write, hosted deployment or production authentication bypass is part of this fixture.

## Admission timing investigation

The initial browser runs are preserved as failures/partial evidence, not counted as acceptance:

- `SP-F2-381b975f-1bba-4dd4-ad19-0de09cf30ed1` did not open a provider socket.
- `SP-F2-923be25e-f4fe-45a0-80dd-a57c5d4c710e` completed the first synthetic audio-to-durable-source-to-interpretation-to-tone turn. Its second source was saved once, but interpretation became unresolved before the fixture logged a successful reservation. The active claim was retained.
- Read-only Medplum history confirms that second reservation's CAS was persisted at `2026-10-10T03:25:51.589Z`, close to its client-side start at `03:25:51.296Z`; these are different clocks, so that difference is not a precise latency measurement. The application never logged return from reservation. A delayed/lost acknowledgement or local process stall remains unresolved. There is no evidence of a malformed claim or repeat provider dispatch. See [sanitized history](evidence/SP-F2-history-1c9ac313-0e64-4137-a2a5-c5fa9b0d68e8.json).
- A separate native diagnostic reserved and settled six fake-provider claims in three overlapping pairs against one new ledger. All passed; 42 loopback dependency requests, cold reservations 1.72–1.83 seconds and later reservations 71–295 milliseconds. This establishes that concurrent CAS admission can succeed; it does not explain the earlier intermittent stall. See [native timing receipt](evidence/SP-F2-admission-4d24dbb6-232d-48a7-9fc2-90da9a949b99.json).

New fixture runs record dependency method/path, HTTP status, header/body completion timing, admission reservation/settlement stages, and maximum event-loop delay. Query strings, headers, tokens, request/response bodies and error messages are excluded from these diagnostics. Dependency/admission record counts are bounded. Streaming responses still pass through, and existing transport abort signals are preserved. A focused helper check covered pass-through JSON, exclusion of secrets, rejection of non-loopback requests and reservation/settlement timing; both fixture scripts passed Node syntax checking.

The native diagnostic can be reproduced with `node scripts/qualification/diagnose-voice-admission.mjs`. It authenticates to the configured loopback project, creates its own bounded synthetic budget, and never alters prior ledgers or invokes providers. Each run leaves a separate receipt. Coordinate a fixture restart with the browser operator before using new timing diagnostics; refreshing the page alone does not reload the server script. No production timeout or admission semantics were changed during this investigation.
