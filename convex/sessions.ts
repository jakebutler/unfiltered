import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireAuthIfConfigured } from "./lib/security";

export const create = mutation({
  args: { studyId: v.id("studies") },
  returns: v.id("sessions"),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    const study = await ctx.db.get(args.studyId);
    if (!study) throw new Error("Study not found");

    let resolvedMode: "A" | "B";
    if (study.decideMode === "AB") {
      const existingSessions = await ctx.db
        .query("sessions")
        .withIndex("by_study", (q) => q.eq("studyId", args.studyId))
        .collect();
      resolvedMode = existingSessions.length % 2 === 0 ? "A" : "B";
    } else {
      resolvedMode = study.decideMode;
    }

    return await ctx.db.insert("sessions", {
      studyId: args.studyId,
      currentTaskIndex: 0,
      status: "pending",
      decideMode: resolvedMode,
    });
  },
});

export const start = mutation({
  args: { sessionId: v.id("sessions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    await ctx.db.patch(args.sessionId, { status: "active", startedAt: Date.now() });
    return null;
  },
});

export const createForExperimentVariation = mutation({
  args: {
    studyId: v.id("studies"),
    decideMode: v.union(v.literal("A"), v.literal("B")),
    experimentRunId: v.optional(v.id("experimentRuns")),
    experimentVariationId: v.optional(v.id("experimentVariations")),
  },
  returns: v.id("sessions"),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    const study = await ctx.db.get(args.studyId);
    if (!study) throw new Error("Study not found");

    return ctx.db.insert("sessions", {
      studyId: args.studyId,
      currentTaskIndex: 0,
      status: "active",
      startedAt: Date.now(),
      decideMode: args.decideMode,
      experimentRunId: args.experimentRunId,
      experimentVariationId: args.experimentVariationId,
    });
  },
});

export const end = mutation({
  args: { sessionId: v.id("sessions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    await ctx.db.patch(args.sessionId, { status: "complete", endedAt: Date.now() });
    return null;
  },
});

export const advanceTask = mutation({
  args: { sessionId: v.id("sessions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    await ctx.db.patch(args.sessionId, { currentTaskIndex: session.currentTaskIndex + 1 });
    return null;
  },
});

export const get = query({
  args: { sessionId: v.id("sessions") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db.get(args.sessionId);
  },
});

export const getWithStudy = query({
  args: { sessionId: v.id("sessions") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    const session = await ctx.db.get(args.sessionId);
    if (!session) return null;
    const study = await ctx.db.get(session.studyId);
    return { session, study };
  },
});

export const listByStudy = query({
  args: { studyId: v.id("studies") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db.query("sessions").withIndex("by_study", (q) => q.eq("studyId", args.studyId)).collect();
  },
});
