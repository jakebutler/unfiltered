import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireAuthIfConfigured } from "./lib/security";

export const create = mutation({
  args: {
    runId: v.id("benchmarkRuns"),
    provider: v.string(),
    scenario: v.string(),
    repetition: v.number(),
    success: v.boolean(),
    avgTtftMs: v.optional(v.number()),
    avgTranscriptionLatencyMs: v.optional(v.number()),
    avgTotalLatencyMs: v.optional(v.number()),
    overallWer: v.optional(v.number()),
    estimatedCostUsd: v.optional(v.number()),
    turns: v.string(),
    errors: v.optional(v.string()),
  },
  returns: v.id("benchmarkSessions"),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db.insert("benchmarkSessions", {
      ...args,
      startedAt: Date.now(),
      endedAt: Date.now(),
    });
  },
});

export const listByRun = query({
  args: { runId: v.id("benchmarkRuns") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db.query("benchmarkSessions")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .collect();
  },
});

export const get = query({
  args: { sessionId: v.id("benchmarkSessions") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db.get(args.sessionId);
  },
});
