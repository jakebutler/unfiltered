# Bounded rendered choice and delayed-tail fixture

The existing integration fixture has a separately selected `--choice-tail` mode. It uses actual `PatientApp`, the signed clinic handler/session contract, local Medplum storage, the speech worklet/relay, and the repaired full compact parser/session coordinator. Local finite fake STT results, a tone, and injected SSE replace external providers. Production speech remains OFF. Initial rendered checks exposed integration defects; independently reviewed repairs now have bounded four-item voice, skipped/incomplete-score and nonempty-tail active-save proof. See evidence/S3-PHQ-CONTINUATION-AND-BROWSER.md for final receipts and limits. See evidence/S3-CHOICE-TAIL-ROLLOVER-REPAIR.md and evidence/S3-ROLLOVER-ROOT-REVIEW.md.

The original no-argument SP-F2 mode, its policy and historical `.qualification-build` remain available. SP-F3 uses a fresh `.voice-choice-build` and a unique private receipt/config directory per launch. It derives PHQ option labels from the approved register and exposes its complete finite utterance list in the UI. No model extracts PHQ responses. Topic setup invokes the authenticated existing `/api/clinic/topics` contract; it does not mutate storage directly. Only first intake is used for this bounded check.

Server syntax, clinic no-emit, fixture no-emit and the separate fixture emit passed. A compiled import/register/authored-capture check confirmed four exact PHQ labels and four expected full-source claims with zero provider and storage calls. Initial real Medplum/browser checks and retained failure receipts are described in the rollover repair evidence; a repaired positive confirmation/tail pass and subsequent full four-item voice battery passed. The skipped-item pass used voice for MH01 and visible text controls thereafter; no broader native-provider qualification is implied.

After root coordinates the existing local clinic containers, run from the worktree using Node 22 and one bounded heap:

```bash
NODE_OPTIONS=--max-old-space-size=1024 /Users/jacobbutler/.nvm/versions/node/v22.22.3/bin/node node_modules/typescript/bin/tsc -p tsconfig.voice-choice.json
/Users/jacobbutler/.nvm/versions/node/v22.22.3/bin/node scripts/qualification/serve-voice-integration-fixture.mjs --choice-tail
/Users/jacobbutler/.nvm/versions/node/v22.22.3/bin/node node_modules/vite/bin/vite.js --config apps/clinic/vite.voice-fixture.config.ts
```

Open `http://localhost:5190/voice-integration-fixture.html`. This exact origin is required and isolates its cookie from the ordinary `127.0.0.1` demo. Confirm the fictional persona before using controls. Stop voice before selecting a fixture topic; setup reloads the app and requires persona confirmation again. Do delayed-tail observation first, then PHQ and safety cases. For the held tail, select the height topic, enter voice, inject the listed authored full source, observe early advance and next-question tone/new capture, then release within 12 seconds. The 12-second synthetic hold is an observation window and does not qualify the full provider deadline. Subsequent listed free-text utterances produce empty captures with unresolved source evidence; this is only an ownership probe.

Five bounded assertions:

1. The displayed PHQ stem/item and all ordered labels equal the recorded server-resolved TTS text.
2. An exact option alone creates an unsaved confirmation; separate spoken Yes saves one direct score and retains distinct option and confirmation patient sources.
3. Vague speech and All zeros remain unscored; decline/skip retain missingness. A crisis utterance already heard when Confirm choice is pressed drains to safety handling and produces no score.
4. Retry, Stop and text switch preserve the actual item and unsent evidence; stale or replayed capture never adds a score. Verify rendered focus and controls alongside durable evidence.
5. While the synthetic full tail is held, the durable early question becomes audible and a new capture is usable. Releasing the tail preserves that question and any newer source, adds no duplicate score, and settles the original operation. Inspect the actual durable report before and after.

The report records actual TTS text, STT words, direct source turns, PHQ answers/safety, request IDs and stream operation phases. Its `syntheticTransport` markers and zero external-provider count are not provider success receipts. Real Medplum confirms local storage/authentication mechanics, but actual microphone permissions, native STT/TTS recognition/audio fidelity, mobile/declared-device latency, denied-network/background behavior and all seven review/delivery/staff workflows remain separate acceptance. No provider or cloud calls are authorized by this fixture.
