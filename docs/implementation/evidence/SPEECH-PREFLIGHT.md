# Speech account and first round-trip evidence

October 9, 2026, Pacific time. These observations qualify a small synthetic API test, not the browser voice experience or clinical transcription accuracy.

The authenticated Deepgram dashboard and Billing Overview for the API key's project both showed $190.66 credit remaining, Pay As You Go, and auto-reload turned off. No billing settings changed. The key itself can list its project but cannot read balances (403); this limitation is retained in `provider-preflight.json`.

ElevenLabs subscription metadata showed Free, 10,000-character allowance, extension disabled. SP-Q1 generated exactly one 218-character synthetic utterance using the documented premade George voice and `eleven_flash_v2_5`. The response was HTTP200, 51,009 MP3 bytes, 829 ms. Deepgram `nova-3` transcribed those 12.6955 seconds in one HTTP200 response, 548 ms, reproducing the synthetic source exactly. The immediate ElevenLabs usage counter remained zero; that is delayed accounting, not evidence that generation was free of quota consumption.

`SP-Q1.json` retains provider request identifiers, source text, audio hash, durations and reservations. Generated audio is local at ignored `.qualification-build/speech/SP-Q1.mp3`; no real microphone or patient data was used. No request was retried. Retain the full 250-character and $0.05 credit reservation until account reconciliation. Cash used: zero.

This small test does not evaluate microphone permissions, browser capture, partial transcripts, socket reconnects, interruption, streaming latency, voice preference, or recognition under accents/noise. Those require the next voice slice.

Implementation references: [ElevenLabs speech conversion](https://elevenlabs.io/docs/api-reference/text-to-speech/convert), [ElevenLabs Flash example](https://elevenlabs.io/docs/eleven-api/guides/how-to/text-to-speech/streaming), [Deepgram prerecorded audio](https://developers.deepgram.com/docs/pre-recorded-audio).
