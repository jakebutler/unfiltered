# Unfiltered — Technical Spec

**Last updated:** 2026-03-19
**Status:** V1 complete + Experiments + Benchmark + Agent testing merged to main

---

## 1. Tech Stack

| Layer | Technology |
|---|---|
| Frontend framework | Next.js 15 (App Router) + TypeScript |
| UI | Tailwind CSS + shadcn/ui |
| Backend + DB | Convex |
| Realtime transcription | Speechmatics Realtime API (WebSocket) |
| Camera classifier | MiniMax Vision via MiniMax API (OpenAI-compatible SDK) |
| Decide engine + post-session synthesis | GLM-5 via FireworksAI (OpenAI-compatible SDK) |
| AI voice | Web Speech API (`speechSynthesis`) |
| Heatmap rendering | `simpleheat` |
| Unit tests | Vitest |
| **Agent testing (new)** | LiveKit Agents + Playwright |

---

## 2. Current Directory Structure

```text
.
├── app/
│   ├── page.tsx                           # studies landing
│   ├── studies/new/page.tsx               # create study
│   ├── studies/[studyId]/page.tsx         # study detail + sessions
│   ├── join/[studyId]/page.tsx            # participant consent/start
│   ├── interview/[sessionId]/page.tsx     # interview runtime orchestrator
│   ├── dashboard/[sessionId]/page.tsx     # findings dashboard
│   ├── experiments/page.tsx               # experiments console (NEW)
│   ├── benchmark/page.tsx                 # voice benchmark UI (NEW)
│   ├── benchmark/results/[runId]/page.tsx # benchmark results (NEW)
│   ├── benchmark/eval/[runId]/page.tsx    # benchmark evaluation (NEW)
│   ├── test-runner/page.tsx               # agent test configuration (NEW)
│   ├── test-runner/[runId]/page.tsx       # test run details (NEW)
│   ├── api/
│   │   ├── speechmatics-token/route.ts    # Speechmatics JWT exchange
│   │   ├── livekit-token/route.ts        # LiveKit token generation (NEW)
│   │   └── benchmark/
│   │       ├── openai-proxy/route.ts      # OpenAI API proxy (NEW)
│   │       ├── assemblyai-token/route.ts # AssemblyAI token (NEW)
│   │       └── vapi-proxy/route.ts        # Vapi API proxy (NEW)
├── components/
│   ├── interview/                         # interview room UI
│   ├── dashboard/
│   │   ├── ...                            # findings cards, summary, export, heatmap
│   │   ├── TranscriptReviewSidebar.tsx   # transcript verification (NEW)
│   │   └── AgentTraceViewer.tsx          # agent trace visualization (NEW)
│   ├── benchmark/                         # benchmark UI components (NEW)
│   ├── test-runner/                       # test runner UI components (NEW)
│   └── ui/                                # shadcn primitives
├── hooks/
│   ├── useSpeechmatics.ts
│   ├── useCamera.ts
│   ├── useMouseTracker.ts
│   ├── useSignalProcessor.ts
│   └── useDecideEngine.ts
├── lib/
│   ├── signals/{extractor.ts,scorer.ts}
│   ├── decide/{types.ts,policyA.ts,fastPath.ts,runtimeConfig.ts,turnTaking.ts,transcriptHeuristics.ts}
│   ├── mouse/tracker.ts
│   ├── friction/{detector.ts,snippets.ts}
│   ├── export/report.ts
│   ├── tts.ts
│   ├── voice/                             # voice provider abstraction (NEW)
│   │   ├── types.ts
│   │   ├── provider-registry.ts
│   │   ├── speechmatics.ts
│   │   ├── openai-whisper.ts
│   │   ├── openai-realtime.ts
│   │   ├── assemblyai.ts
│   │   └── vapi.ts
│   ├── benchmark/                         # benchmark runner (NEW)
│   │   ├── runner.ts
│   │   ├── analysis.ts
│   │   └── scenarios/
│   ├── experiments/                       # experiment orchestration (NEW)
│   ├── telemetry/                         # latency telemetry (NEW)
│   └── posthog/                           # PostHog analytics (NEW)
├── convex/
│   ├── schema.ts
│   ├── studies.ts
│   ├── sessions.ts
│   ├── transcripts.ts
│   ├── signals.ts
│   ├── mouse.ts
│   ├── engagements.ts
│   ├── classifyEngagement.ts
│   ├── decide.ts
│   ├── friction.ts
│   ├── findings.ts
│   ├── telemetry.ts                       # (NEW)
│   ├── experimentRuns.ts                  # (NEW)
│   ├── posthog.ts                         # (NEW)
│   ├── benchmarkRuns.ts                   # (NEW)
│   ├── benchmarkSessions.ts               # (NEW)
│   ├── benchmarkEvaluations.ts            # (NEW)
│   ├── personas.ts                        # (NEW)
│   ├── agentTraces.ts                     # (NEW)
│   └── testRuns.ts                        # (NEW)
└── tests/
    └── ... (36 files, 171 tests)
```

---

## 3. Runtime Architecture

### Interview runtime (`app/interview/[sessionId]/page.tsx`)

1. Starts Speechmatics transcription (`useSpeechmatics`)
2. Optionally starts camera capture (`useCamera`)
3. Tracks mouse events from the prototype frame (`useMouseTracker`)
4. Every 5 seconds, runs 15-second signal processing window (`useSignalProcessor`)
5. Triggers decide engine (`useDecideEngine`) when friction/signal thresholds are met
6. Speaks follow-up prompt via Web Speech API
7. On session completion: runs friction detection + finding labeler + themes generation, then routes to `/dashboard/[sessionId]`

### Signal pipeline

`transcript words -> lib/signals/extractor -> lib/signals/scorer -> convex.signals.addWindow`

### Mouse pipeline

`raw events -> lib/mouse/tracker -> convex.mouse.addWindow (summary + heatmapBins)`

### Camera pipeline

`frame capture -> convex.classifyEngagement.classifyEngagement -> MiniMax Vision -> convex.engagementEvents`

### Decide pipeline

- Policy A: `lib/decide/policyA.ts` (pure deterministic)
- Policy B: `convex/decide.ts` action calling GLM-5 via FireworksAI
- Persisted decision events: `decideEvents`

### Post-session findings pipeline

1. `convex/friction.ts` detects and stores friction moments
2. `convex/findings.ts` labels all moments using GLM-5
3. `convex/findings.ts` generates top 3 themes + session friction score
4. Dashboard reads reactive results from Convex

---

## 4. Current Convex Data Model (Implemented)

### Core Tables

#### `studies`
```ts
{
  title: string,
  prototypeUrl: string,
  prdText?: string,
  tasks: Array<{ id: string; label: string }>,
  decideMode: "A" | "B" | "AB",
  createdAt: number,
}
```

### `sessions`
```ts
{
  studyId: Id<"studies">,
  startedAt?: number,
  endedAt?: number,
  currentTaskIndex: number,
  status: "pending" | "active" | "complete",
  outputs?: {
    themes?: string[],
    summary?: string,
    sessionFriction?: number,
  },
}
```

### `transcriptSegments`
```ts
{
  sessionId: Id<"sessions">,
  speakerId: "participant" | "interviewer",
  text: string,
  words: Array<{ text: string; startTime: number; duration: number }>,
  startTime: number,
  endTime: number,
  taskId?: string,
}
```

### `signalWindows`
```ts
{
  sessionId: Id<"sessions">,
  tStart: number,
  tEnd: number,
  taskId?: string,
  promptType?: "moderator_question" | "user_action" | "system_error" | "free_explore",
  contextHint?: string,
  computedSignals: {
    filledPausePer100w: number,
    hedgesPer100w: number,
    explicitUncertaintyCount: number,
    longPauseCount: number,
    veryLongPauseCount: number,
    pauseTimeRatio: number,
    repairsPer100w: number,
    repetitionsPer100w: number,
    clarificationCount: number,
    negAffectCount: number,
    clarityIndex: number,
    backtrackCount: number,
    repeatAttemptLoopFlag: boolean,
  },
  friction0to100: number,
  severityHint: "LOW" | "MED" | "HIGH",
  flags: string[],
}
```

### `engagementEvents`
```ts
{
  sessionId: Id<"sessions">,
  taskId?: string,
  t: number,
  state: "engaged_active" | "engaged_stuck" | "disengaged_away" | "uncertain_low_confidence",
  confidence: number,
  signals: {
    facePresent: boolean,
    gazeTowardScreenLikely: boolean,
    attentionStableLikely: boolean,
    visibleFrustrationCuesLikely: boolean,
  },
  notes: string,
  frameHash?: string,
}
```

### `mouseWindows`
```ts
{
  sessionId: Id<"sessions">,
  tStart: number,
  tEnd: number,
  taskId?: string,
  summary: {
    inactiveSec: number,
    erraticness: number,
    repeatClicksSameRegion: number,
    scrollBursts: number,
  },
  heatmapBins?: Array<{ x: number; y: number; count: number }>,
}
```

### `decideEvents`
```ts
{
  sessionId: Id<"sessions">,
  t: number,
  policyUsed: "deterministic" | "llm",
  inputSummary: string,
  outputAction: "ask_followup" | "clarify_task" | "reflect_back" | "move_to_next_task" | "wait",
  outputPrompt: string,
  probeType: "expectation" | "comprehension" | "navigation" | "system_status" | "emotion_checkin" | "move_on" | "none",
  confidence: number,
}
```

### `frictionMoments`
```ts
{
  sessionId: Id<"sessions">,
  taskId: string,
  tStart: number,
  tEnd: number,
  frictionPeak: number,
  evidence: {
    transcriptSnippets: string[],
    pauseSpans: Array<{ start: number; end: number }>,
    matchedPhrases: string[],
  },
  signalTags: string[],
  engagementSnapshot?: { state: string; confidence: number },
  mouseSnapshot?: {
    inactiveSec: number,
    erraticness: number,
    repeatClicksSameRegion: number,
    scrollBursts: number,
  },
  candidateFindingLabel?: string,
  category?: "copy_language" | "discoverability" | "system_status_feedback" | "navigation_ia" | "form_field_friction" | "task_prompt_issue" | "error_recovery" | "other",
  interpretation?: string,
  recommendations?: string[],
  verificationQuestion?: string,
  labelConfidence?: number,
}
```

### Experiments/Telemetry Tables (NEW)

#### `telemetryExperiments`
```ts
{
  name: string,
  scriptId?: string,
  hypothesis?: string,
  methodology?: string,
  notes?: string,
  createdAt: number,
}
```

#### `experimentRuns`
```ts
{
  experimentId: Id<"telemetryExperiments">,
  status: "running" | "paused" | "complete" | "aborted",
  currentVariationIndex: number,
  totalVariations: number,
  startedAt: number,
  endedAt?: number,
  notes?: string,
}
```

#### `experimentVariations`
```ts
{
  runId: Id<"experimentRuns">,
  index: number,
  studyId: Id<"studies">,
  decisionEngineIdTarget: string,
  decisionEngineIdAssigned: string,
  repeatIndex: number,
  status: "pending" | "in_progress" | "complete" | "aborted",
  sessionId?: Id<"sessions">,
  startedAt?: number,
  endedAt?: number,
  checklistCompletedAt?: number,
  posthogExposureSentAt?: number,
}
```

#### `latencyEvents`
```ts
{
  sessionId: Id<"sessions">,
  runId?: Id<"telemetryRuns">,
  turnId?: string,
  stage: "participant_last_word_end" | "decide_trigger" | "policy_start" | "policy_end" | "prompt_selected" | "tts_request_start" | "tts_first_audio_byte" | "audio_play_start" | "timing_config_resolved",
  t: number,
  meta?: string,
}
```

### Benchmark Tables (NEW)

#### `benchmarkRuns`
```ts
{
  name: string,
  startedAt: number,
  endedAt?: number,
  status: "running" | "complete" | "failed",
  providers: string[],
  scenarios: string[],
  repetitions: number,
  config: string,
}
```

#### `benchmarkSessions`
```ts
{
  runId: Id<"benchmarkRuns">,
  provider: string,
  scenario: string,
  repetition: number,
  startedAt: number,
  endedAt?: number,
  success: boolean,
  avgTtftMs?: number,
  avgTranscriptionLatencyMs?: number,
  avgTotalLatencyMs?: number,
  overallWer?: number,
  estimatedCostUsd?: number,
  turns: string,
  errors?: string,
}
```

#### `benchmarkEvaluations`
```ts
{
  sessionId: Id<"benchmarkSessions">,
  evaluatorId: string,
  transcriptionAccuracy: number,
  responseRelevance: number,
  voiceNaturalness: number,
  conversationFlow: number,
  professionalism: number,
  overallQuality: number,
  notes?: string,
  evaluatedAt: number,
}
```

### Agent Testing Tables (NEW)

#### `personas`
```ts
{
  name: string,
  demographics: {
    age: string,
    occupation: string,
    techSavviness: string,
  },
  traits: string[],
  background: string,
}
```

#### `agentActionTraces`
```ts
{
  sessionId: Id<"sessions">,
  actionType: "click" | "type" | "navigate" | "scroll" | "wait",
  selector?: string,
  value?: string,
  timestamp: number,
  reasoning?: string,
}
```

#### `testRuns`
```ts
{
  status: "pending" | "running" | "complete" | "failed",
  personaId: Id<"personas">,
  studyId: Id<"studies">,
  startedAt: number,
  endedAt?: number,
  resultSummary?: string,
}
```

---

## 5. Model + Provider Assignments

| Use Case | Provider/Model |
|---|---|
| Policy B decide engine | FireworksAI `accounts/fireworks/models/glm-5` |
| Friction-moment labeler | FireworksAI `accounts/fireworks/models/glm-5` |
| Themes generation | FireworksAI `accounts/fireworks/models/glm-5` |
| Camera engagement | MiniMax Vision (via MiniMax API) |
| Voice benchmark STT | Speechmatics Realtime / OpenAI Whisper / AssemblyAI |
| Voice benchmark LLM | OpenAI GPT-4 |
| Voice benchmark TTS | OpenAI TTS / ElevenLabs |
| E2E agent voice | LiveKit Agents + Silero VAD |

All LLM calls must parse JSON defensively with safe fallback defaults.

---

## 6. Environment Variables

Set in `.env.local`:

```bash
# Core
NEXT_PUBLIC_CONVEX_URL
CONVEX_DEPLOYMENT

# Interview runtime
SPEECHMATICS_API_KEY
FIREWORKS_API_KEY
MINIMAX_API_KEY
ELEVENLABS_API_KEY
ELEVENLABS_VOICE_ID

# Voice benchmark (NEW)
OPENAI_API_KEY
ASSEMBLYAI_API_KEY
VAPI_API_KEY

# E2E agent testing (NEW)
LIVEKIT_URL
LIVEKIT_API_KEY
LIVEKIT_API_SECRET

# Analytics (optional)
POSTHOG_PROJECT_API_KEY
POSTHOG_HOST
```

---

## 7. Current Verification Snapshot

- Unit tests passing: 36 files / 171 tests (`npm test`)
- Build: Passing (`npm run build`)
- Dashboard route: `/dashboard/[sessionId]`
- End-session pipeline wiring present in interview page (detect -> label -> theme -> redirect)
- **New routes verified:**
  - `/experiments` - Experiments console
  - `/benchmark` - Voice provider benchmarking (E2E tested with OpenAI Whisper+TTS)
  - `/test-runner` - E2E agent testing configuration
- All PRs merged to main, branches cleaned up

---

## 8. Reference Docs (Do Not Edit During Build)

- [`behavioral-friction-signal-research.md`](../behavioral-friction-signal-research.md)
- [`camera-engagement-classifier.md`](../camera-engagement-classifier.md)
- [`decide-engine-policy-b-prompt.md`](../decide-engine-policy-b-prompt.md)
- [`determinstic-decide-policy.md`](../determinstic-decide-policy.md)
- [`post-session-candidate-finding-labeler.md`](../post-session-candidate-finding-labeler.md)
- [`multimodal-cross-reference-explainer.md`](../multimodal-cross-reference-explainer.md)
