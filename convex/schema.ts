import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  studies: defineTable({
    title: v.string(),
    prototypeUrl: v.string(),
    prdText: v.optional(v.string()),
    tasks: v.array(v.object({ id: v.string(), label: v.string() })),
    decideMode: v.union(v.literal("A"), v.literal("B"), v.literal("AB")),
    createdAt: v.number(),
  }),

  sessions: defineTable({
    studyId: v.id("studies"),
    startedAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    currentTaskIndex: v.number(),
    status: v.union(v.literal("pending"), v.literal("active"), v.literal("complete")),
    decideMode: v.optional(v.union(v.literal("A"), v.literal("B"))),
    outputs: v.optional(v.object({
      themes: v.optional(v.array(v.string())),
      summary: v.optional(v.string()),
      sessionFriction: v.optional(v.number()),
    })),
  }).index("by_study", ["studyId"]),

  transcriptSegments: defineTable({
    sessionId: v.id("sessions"),
    speakerId: v.union(v.literal("participant"), v.literal("interviewer")),
    text: v.string(),
    words: v.array(v.object({
      text: v.string(),
      startTime: v.number(),
      duration: v.number(),
    })),
    startTime: v.number(),
    endTime: v.number(),
    taskId: v.optional(v.string()),
  }).index("by_session", ["sessionId"]),

  signalWindows: defineTable({
    sessionId: v.id("sessions"),
    tStart: v.number(),
    tEnd: v.number(),
    taskId: v.optional(v.string()),
    promptType: v.optional(v.union(
      v.literal("moderator_question"),
      v.literal("user_action"),
      v.literal("system_error"),
      v.literal("free_explore"),
    )),
    contextHint: v.optional(v.string()),
    computedSignals: v.object({
      filledPausePer100w: v.number(),
      hedgesPer100w: v.number(),
      explicitUncertaintyCount: v.number(),
      longPauseCount: v.number(),
      veryLongPauseCount: v.number(),
      pauseTimeRatio: v.number(),
      repairsPer100w: v.number(),
      repetitionsPer100w: v.number(),
      clarificationCount: v.number(),
      negAffectCount: v.number(),
      clarityIndex: v.number(),
      backtrackCount: v.number(),
      repeatAttemptLoopFlag: v.boolean(),
    }),
    friction0to100: v.number(),
    severityHint: v.union(v.literal("LOW"), v.literal("MED"), v.literal("HIGH")),
    flags: v.array(v.string()),
  }).index("by_session", ["sessionId"]),

  engagementEvents: defineTable({
    sessionId: v.id("sessions"),
    taskId: v.optional(v.string()),
    t: v.number(),
    state: v.union(
      v.literal("engaged_active"),
      v.literal("engaged_stuck"),
      v.literal("disengaged_away"),
      v.literal("uncertain_low_confidence"),
    ),
    confidence: v.number(),
    signals: v.object({
      facePresent: v.boolean(),
      gazeTowardScreenLikely: v.boolean(),
      attentionStableLikely: v.boolean(),
      visibleFrustrationCuesLikely: v.boolean(),
    }),
    notes: v.string(),
    frameHash: v.optional(v.string()),
  }).index("by_session", ["sessionId"]),

  mouseWindows: defineTable({
    sessionId: v.id("sessions"),
    tStart: v.number(),
    tEnd: v.number(),
    taskId: v.optional(v.string()),
    summary: v.object({
      inactiveSec: v.number(),
      erraticness: v.number(),
      repeatClicksSameRegion: v.number(),
      scrollBursts: v.number(),
    }),
    heatmapBins: v.optional(v.array(v.object({
      x: v.number(),
      y: v.number(),
      count: v.number(),
    }))),
  }).index("by_session", ["sessionId"]),

  decideEvents: defineTable({
    sessionId: v.id("sessions"),
    t: v.number(),
    policyUsed: v.union(v.literal("deterministic"), v.literal("llm")),
    inputSummary: v.string(),
    outputAction: v.union(
      v.literal("ask_followup"),
      v.literal("clarify_task"),
      v.literal("reflect_back"),
      v.literal("move_to_next_task"),
      v.literal("wait"),
    ),
    outputPrompt: v.string(),
    probeType: v.union(
      v.literal("expectation"),
      v.literal("comprehension"),
      v.literal("navigation"),
      v.literal("system_status"),
      v.literal("emotion_checkin"),
      v.literal("move_on"),
      v.literal("none"),
    ),
    confidence: v.number(),
  }).index("by_session", ["sessionId"]),

  // ── Benchmark tables ──────────────────────────────────────────────

  benchmarkRuns: defineTable({
    name: v.string(),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    status: v.union(v.literal("running"), v.literal("complete"), v.literal("failed")),
    providers: v.array(v.string()),
    scenarios: v.array(v.string()),
    repetitions: v.number(),
    config: v.string(),
  }).index("by_status", ["status"]),

  benchmarkSessions: defineTable({
    runId: v.id("benchmarkRuns"),
    provider: v.string(),
    scenario: v.string(),
    repetition: v.number(),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    success: v.boolean(),
    avgTtftMs: v.optional(v.number()),
    avgTranscriptionLatencyMs: v.optional(v.number()),
    avgTotalLatencyMs: v.optional(v.number()),
    overallWer: v.optional(v.number()),
    estimatedCostUsd: v.optional(v.number()),
    turns: v.string(),
    errors: v.optional(v.string()),
  }).index("by_run", ["runId"])
    .index("by_provider", ["provider"]),

  benchmarkEvaluations: defineTable({
    sessionId: v.id("benchmarkSessions"),
    evaluatorId: v.string(),
    transcriptionAccuracy: v.number(),
    responseRelevance: v.number(),
    voiceNaturalness: v.number(),
    conversationFlow: v.number(),
    professionalism: v.number(),
    overallQuality: v.number(),
    notes: v.optional(v.string()),
    evaluatedAt: v.number(),
  }).index("by_session", ["sessionId"]),

  // ── Existing tables ─────────────────────────────────────────────

  frictionMoments: defineTable({
    sessionId: v.id("sessions"),
    taskId: v.string(),
    tStart: v.number(),
    tEnd: v.number(),
    frictionPeak: v.number(),
    evidence: v.object({
      transcriptSnippets: v.array(v.string()),
      pauseSpans: v.array(v.object({ start: v.number(), end: v.number() })),
      matchedPhrases: v.array(v.string()),
    }),
    signalTags: v.array(v.string()),
    engagementSnapshot: v.optional(v.object({
      state: v.string(),
      confidence: v.number(),
    })),
    mouseSnapshot: v.optional(v.object({
      inactiveSec: v.number(),
      erraticness: v.number(),
      repeatClicksSameRegion: v.number(),
      scrollBursts: v.number(),
    })),
    candidateFindingLabel: v.optional(v.string()),
    category: v.optional(v.union(
      v.literal("copy_language"),
      v.literal("discoverability"),
      v.literal("system_status_feedback"),
      v.literal("navigation_ia"),
      v.literal("form_field_friction"),
      v.literal("task_prompt_issue"),
      v.literal("error_recovery"),
      v.literal("other"),
    )),
    interpretation: v.optional(v.string()),
    recommendations: v.optional(v.array(v.string())),
    verificationQuestion: v.optional(v.string()),
    labelConfidence: v.optional(v.number()),
  }).index("by_session", ["sessionId"]),
});
