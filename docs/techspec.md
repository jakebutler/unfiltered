# Unfiltered — Technical Spec

**Last updated:** 2026-03-18
**Status:** V1 implementation in progress + Agent testing infrastructure added

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
│   ├── api/
│   │   ├── speechmatics-token/route.ts    # Speechmatics JWT exchange
│   │   └── livekit-token/route.ts         # LiveKit token generation (new)
│   ├── test-runner/page.tsx              # agent test configuration (new)
│   └── test-runner/[runId]/page.tsx       # test run details (new)
├── components/
│   ├── interview/                         # interview room UI
│   ├── dashboard/
│   │   ├── ...                            # findings cards, summary, export, heatmap
│   │   └── AgentTraceViewer.tsx          # agent trace visualization (new)
│   ├── test-runner/                       # test runner UI components (new)
│   └── ui/                                # shadcn primitives
├── hooks/
│   ├── useSpeechmatics.ts
│   ├── useCamera.ts
│   ├── useMouseTracker.ts
│   ├── useSignalProcessor.ts
│   └── useDecideEngine.ts
├── lib/
│   ├── signals/{extractor.ts,scorer.ts}
│   ├── decide/{types.ts,policyA.ts}
│   ├── mouse/tracker.ts
│   ├── friction/detector.ts
│   ├── export/report.ts
│   └── tts.ts
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
│   └── findings.ts
└── tests/
    ├── setup.test.ts
    ├── signals/{extractor,scorer}.test.ts
    ├── decide/policyA.test.ts
    ├── mouse/tracker.test.ts
    ├── friction/detector.test.ts
    └── export/report.test.ts
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

### `studies`
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

---

## 5. Model + Provider Assignments

| Use Case | Provider/Model |
|---|---|
| Policy B decide engine | FireworksAI `accounts/fireworks/models/glm-5` |
| Friction-moment labeler | FireworksAI `accounts/fireworks/models/glm-5` |
| Themes generation | FireworksAI `accounts/fireworks/models/glm-5` |
| Camera engagement | MiniMax Vision (via MiniMax API) |

All LLM calls must parse JSON defensively with safe fallback defaults.

---

## 6. Environment Variables

Set in `.env.local`:

```bash
NEXT_PUBLIC_CONVEX_URL
SPEECHMATICS_API_KEY
FIREWORKS_API_KEY
MINIMAX_API_KEY
```

---

## 7. Current Verification Snapshot

- Unit tests passing: 7 files / 38 tests (`npm test`)
- Dashboard route in code: `/dashboard/[sessionId]`
- End-session pipeline wiring present in interview page (detect -> label -> theme -> redirect)
- Remaining confidence work is primarily integration hardening and manual E2E validation

---

## 8. Reference Docs (Do Not Edit During Build)

- [`behavioral-friction-signal-research.md`](../behavioral-friction-signal-research.md)
- [`camera-engagement-classifier.md`](../camera-engagement-classifier.md)
- [`decide-engine-policy-b-prompt.md`](../decide-engine-policy-b-prompt.md)
- [`determinstic-decide-policy.md`](../determinstic-decide-policy.md)
- [`post-session-candidate-finding-labeler.md`](../post-session-candidate-finding-labeler.md)
- [`multimodal-cross-reference-explainer.md`](../multimodal-cross-reference-explainer.md)
