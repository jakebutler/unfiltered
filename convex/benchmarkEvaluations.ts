import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireAuthIfConfigured } from "./lib/security";

export const create = mutation({
  args: {
    sessionId: v.id("benchmarkSessions"),
    evaluatorId: v.string(),
    transcriptionAccuracy: v.number(),
    responseRelevance: v.number(),
    voiceNaturalness: v.number(),
    conversationFlow: v.number(),
    professionalism: v.number(),
    overallQuality: v.number(),
    notes: v.optional(v.string()),
  },
  returns: v.id("benchmarkEvaluations"),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db.insert("benchmarkEvaluations", {
      ...args,
      evaluatedAt: Date.now(),
    });
  },
});

export const listBySession = query({
  args: { sessionId: v.id("benchmarkSessions") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db.query("benchmarkEvaluations")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
  },
});

export const listByRun = query({
  args: { runId: v.id("benchmarkRuns") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    const sessions = await ctx.db.query("benchmarkSessions")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .collect();
    const evals = [];
    for (const session of sessions) {
      const sessionEvals = await ctx.db.query("benchmarkEvaluations")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .collect();
      evals.push(...sessionEvals);
    }
    return evals;
  },
});
