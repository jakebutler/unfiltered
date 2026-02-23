import { v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { requireAuthIfConfigured } from "./lib/security";
import type { Id } from "./_generated/dataModel";

const LATENCY_STAGE = v.union(
  v.literal("participant_last_word_end"),
  v.literal("decide_trigger"),
  v.literal("policy_start"),
  v.literal("policy_end"),
  v.literal("prompt_selected"),
  v.literal("tts_request_start"),
  v.literal("tts_first_audio_byte"),
  v.literal("audio_play_start"),
  v.literal("timing_config_resolved"),
);

export const createExperiment = mutation({
  args: {
    name: v.string(),
    scriptId: v.optional(v.string()),
    hypothesis: v.optional(v.string()),
    methodology: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  returns: v.id("telemetryExperiments"),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db.insert("telemetryExperiments", {
      name: args.name,
      scriptId: args.scriptId,
      hypothesis: args.hypothesis,
      methodology: args.methodology,
      notes: args.notes,
      createdAt: Date.now(),
    });
  },
});

export const startRun = mutation({
  args: {
    experimentId: v.id("telemetryExperiments"),
    variant: v.string(),
    prototypeId: v.optional(v.string()),
    sessionId: v.optional(v.id("sessions")),
    studyId: v.optional(v.id("studies")),
    operator: v.optional(v.string()),
    environment: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    configSnapshot: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  returns: v.id("telemetryRuns"),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    if (args.sessionId) {
      const sessionRuns = await ctx.db
        .query("telemetryRuns")
        .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
        .collect();
      const existingActiveRun = sessionRuns.find((run) => run.status === "running");
      if (existingActiveRun) {
        throw new Error("Session already has an active experiment run");
      }
    }
    return ctx.db.insert("telemetryRuns", {
      experimentId: args.experimentId,
      variant: args.variant,
      prototypeId: args.prototypeId,
      sessionId: args.sessionId,
      studyId: args.studyId,
      operator: args.operator,
      environment: args.environment,
      tags: args.tags,
      configSnapshot: args.configSnapshot,
      notes: args.notes,
      status: "running",
      startedAt: Date.now(),
    });
  },
});

export const finishRun = mutation({
  args: {
    runId: v.id("telemetryRuns"),
    status: v.optional(v.union(v.literal("complete"), v.literal("aborted"))),
    notes: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Run not found");

    await ctx.db.patch(args.runId, {
      status: args.status ?? "complete",
      endedAt: Date.now(),
      notes: args.notes ?? run.notes,
    });
    return null;
  },
});

export const listExperiments = query({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    await requireAuthIfConfigured(ctx);
    const experiments = await ctx.db.query("telemetryExperiments").collect();
    return experiments.sort((a, b) => b.createdAt - a.createdAt);
  },
});

export const listActiveRuns = query({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db
      .query("telemetryRuns")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .collect();
  },
});

export const getActiveRunBySession = query({
  args: { sessionId: v.id("sessions") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    const runs = await ctx.db
      .query("telemetryRuns")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    return runs
      .filter((run) => run.status === "running")
      .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
  },
});

export const recordLatencyEvent = mutation({
  args: {
    sessionId: v.id("sessions"),
    runId: v.optional(v.id("telemetryRuns")),
    turnId: v.optional(v.string()),
    stage: LATENCY_STAGE,
    t: v.optional(v.number()),
    meta: v.optional(v.string()),
  },
  returns: v.id("latencyEvents"),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db.insert("latencyEvents", {
      sessionId: args.sessionId,
      runId: args.runId,
      turnId: args.turnId,
      stage: args.stage,
      t: args.t ?? Date.now(),
      meta: args.meta,
    });
  },
});

export const listLatencyBySession = query({
  args: { sessionId: v.id("sessions") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db
      .query("latencyEvents")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
  },
});

export const listRunsByExperiment = query({
  args: { experimentId: v.id("telemetryExperiments") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db
      .query("telemetryRuns")
      .withIndex("by_experiment", (q) => q.eq("experimentId", args.experimentId))
      .collect();
  },
});

type StagePoint = {
  participant_last_word_end?: number;
  decide_trigger?: number;
  policy_start?: number;
  policy_end?: number;
  tts_request_start?: number;
  audio_play_start?: number;
};

function addDelta(samples: number[], start?: number, end?: number) {
  if (typeof start !== "number" || typeof end !== "number") return;
  const delta = end - start;
  if (delta < 0) return;
  samples.push(delta);
}

function percentile(samples: number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarizeSamples(samples: number[]) {
  if (samples.length === 0) {
    return { count: 0, p50: null, p90: null, p95: null, avg: null };
  }
  const sum = samples.reduce((acc, n) => acc + n, 0);
  return {
    count: samples.length,
    p50: percentile(samples, 50),
    p90: percentile(samples, 90),
    p95: percentile(samples, 95),
    avg: Math.round(sum / samples.length),
  };
}

async function computeRunMetrics(ctx: QueryCtx, runId: Id<"telemetryRuns">) {
  const events = await ctx.db
    .query("latencyEvents")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .collect();

  const perTurn = new Map<string, StagePoint>();
  for (const event of events) {
    if (!event.turnId) continue;
    const points = perTurn.get(event.turnId) ?? {};
    switch (event.stage) {
      case "participant_last_word_end":
        points.participant_last_word_end = event.t;
        break;
      case "decide_trigger":
        points.decide_trigger = event.t;
        break;
      case "policy_start":
        points.policy_start = event.t;
        break;
      case "policy_end":
        points.policy_end = event.t;
        break;
      case "tts_request_start":
        points.tts_request_start = event.t;
        break;
      case "audio_play_start":
        points.audio_play_start = event.t;
        break;
      default:
        break;
    }
    perTurn.set(event.turnId, points);
  }

  const responseStartSamples: number[] = [];
  const decisionSamples: number[] = [];
  const ttsStartupSamples: number[] = [];
  const triggerDelaySamples: number[] = [];

  for (const points of perTurn.values()) {
    addDelta(responseStartSamples, points.participant_last_word_end, points.audio_play_start);
    addDelta(decisionSamples, points.policy_start, points.policy_end);
    addDelta(ttsStartupSamples, points.tts_request_start, points.audio_play_start);
    addDelta(triggerDelaySamples, points.participant_last_word_end, points.decide_trigger);
  }

  return {
    turnsObserved: perTurn.size,
    eventCount: events.length,
    responseStartMs: summarizeSamples(responseStartSamples),
    decisionMs: summarizeSamples(decisionSamples),
    ttsStartupMs: summarizeSamples(ttsStartupSamples),
    triggerDelayMs: summarizeSamples(triggerDelaySamples),
  };
}

export const listRunSummaries = query({
  args: {
    experimentId: v.optional(v.id("telemetryExperiments")),
    limit: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    const max = Math.min(Math.max(args.limit ?? 24, 1), 100);
    const recentRuns = args.experimentId
      ? await ctx.db
        .query("telemetryRuns")
        .withIndex("by_experiment_started_at", (q) => q.eq("experimentId", args.experimentId!))
        .order("desc")
        .take(max)
      : await ctx.db
        .query("telemetryRuns")
        .withIndex("by_started_at")
        .order("desc")
        .take(max);

    const summaries = await Promise.all(
      recentRuns.map(async (run) => {
        const metrics = await computeRunMetrics(ctx, run._id);
        const experiment = await ctx.db.get(run.experimentId);
        return {
          run,
          experimentName: experiment?.name ?? "Unknown",
          metrics,
        };
      }),
    );
    return summaries;
  },
});
