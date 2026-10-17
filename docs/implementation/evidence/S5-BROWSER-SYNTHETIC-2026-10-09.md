# Local synthetic browser capture qualification

October 10, 2026 UTC. GPT-6.1-sol High. Actual Chrome UI at `http://127.0.0.1:5174`, research Convex 3210/3211 and owned gateway 8789. Only generated oscillator/canvas tracks; actual MediaRecorder, ResearchCapture, upload queue, authenticated Convex functions and normal operator CaptureSources were used. No human device permission, hosted service, provider call or cash. The DEV fixture received an independent security/lifecycle review; its reported enable reentrancy/unmount/timer leak was repaired and independently accepted before media enablement.

Synthetic client label: `Browser capture 372895c1-849a-4250-bc62-5f1f4e9d4f66`; session `kd7dp2se5ymm9m8s8sg7xex7qn8g15rk`. One fixture creation, no unknown replay.

## Observed results

- First run recorded microphone, camera and screen concurrently. Pause showed devices off and normal operator UI showed six available sources, two per modality: 0–15/15–20 seconds for microphone and 1–16/16–20 seconds for camera/screen. All retained question `q1` and distinct stable source IDs.
- Normal operator protected playback used the real same-origin `/capture/media` player. Audio decoded with readyState 4/error null and time advanced 0.011235→6.598519 seconds. Camera decoded 320×180, readyState 4/error null, and advanced 0.581331→3.475622 seconds. Screen decoded 320×180, readyState 4/error null, and advanced 0.282978→14.9 seconds before ending. Players were closed afterward. Request header bytes and exact stored MIME labels were not independently exposed by the UI; code supplies bearer authentication and same-origin referrer policy. This is actual route delivery/decoding evidence, not direct gateway fetch evidence.
- Resume retained the common elapsed clock (447–467 seconds). Microphone permission withdrawal completed once, leaving camera/screen recording. Fresh operator results removed both prior microphone sources, retained all camera/screen sources and added four camera/screen sources. A controlled checkbox action initially reported its asynchronous state mismatch; fresh UI confirmed the original withdrawal, so it was not repeated.
- Exact-origin controlled prototype connected, and the operator displayed masked `connected`, `focus` and `click` observations using only `none`/`c1` and `none`/`button`. Stop changed the prototype to Disconnected; a subsequent c1 click added no batch. Reconnect accepted new c1 events under generation 3 after generation 2. Pause stopped the bridge again.
- Final participant was paused/devices off. Explicit Disable released generated sources; prototype was Disconnected; local operator signed out. Owned gateway/Vite processes stopped. Port checks showed only healthy research Convex 3210/3211; no 8789/5174 listener.

The fixture-local operator source panel initially reported Access unavailable, even after refresh. Acceptance above uses the normal operator workspace, which returned actual sources and protected playback. This fixture-local query issue is not counted as product playback acceptance or silently repaired.

## Production isolation and fingerprints

`NODE_OPTIONS=--max-old-space-size=1024 npm run research:build --silent` under Node 22.22.3: **exit 0**, 117 modules, 1.92 seconds. Output contains only normal index/assets/fonts, no fixture entries. A scan of emitted output found none of the fixture title, credential-import status, generated-media message or fixture URLs. DEV/fixed-origin guards precede Convex construction and prototype instrumentation. Private configuration was never served as an asset. Fixture credentials were imported through the authorized file input, discarded before awaited normal sign-in except validated email/password, then cleared; no unused signing fields were sent. Native chooser preview exposed existing private values in its accessibility output; root was notified, no values were copied into reports/files, and an exact-value evidence/fixture file scan returned zero matches. Credential rotation is outside this slice.

SHA-256:

- `apps/research/fixtures/capture.tsx`: `7585e5cbd37cf26b7c33168a2802c5e2c16ad0382a3011f0d01e071da56cc36e`
- `apps/research/fixtures/prototype.ts`: `aff455289144cae2aab17cd8c6dc042df38d191ca69049fb2ddf761ab515c9df`
- `apps/research/src/ResearchCapture.tsx`: `00866c3fe846024a4dd0e276dd1f919fc36a229e28ab6968ba6076fc6a51510a`
- Emitted `index-kgJQKKdv.js`: `363ef32c9813dcd7c067d387bdc74d0791cff94d31ae1df6bb0dc47785a0c342`

## Limits

No actual human microphone/camera, screen picker, mobile/other-browser permissions, hosted deployment or backend VM restart proof. Browser lost-ack recovery, exact six-slot exhaustion and spoofed/wrong-origin counterexamples remain covered by separate unit/native evidence, not this browser run. Native SIGKILL/lease/withdrawal/cleanup acceptance is separately preserved in immutable `S5-NATIVE-LOCAL-2026-10-09.json` (8/8), hash `691387c8b0256f2dad4f1c905657c1e14d45f56afcac832e0832fc4b4d559ea1`. No second native execution occurred.
