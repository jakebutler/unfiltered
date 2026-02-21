import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireAuthIfConfigured } from "./lib/security";

export const addWindow = mutation({
  args: {
    sessionId: v.id("sessions"),
    tStart: v.number(),
    tEnd: v.number(),
    taskId: v.optional(v.string()),
    promptType: v.optional(v.union(
      v.literal("moderator_question"), v.literal("user_action"),
      v.literal("system_error"), v.literal("free_explore"),
    )),
    contextHint: v.optional(v.string()),
    computedSignals: v.object({
      filledPausePer100w: v.number(), hedgesPer100w: v.number(),
      explicitUncertaintyCount: v.number(), longPauseCount: v.number(),
      veryLongPauseCount: v.number(), pauseTimeRatio: v.number(),
      repairsPer100w: v.number(), repetitionsPer100w: v.number(),
      clarificationCount: v.number(), negAffectCount: v.number(),
      clarityIndex: v.number(), backtrackCount: v.number(),
      repeatAttemptLoopFlag: v.boolean(),
    }),
    friction0to100: v.number(),
    severityHint: v.union(v.literal("LOW"), v.literal("MED"), v.literal("HIGH")),
    flags: v.array(v.string()),
  },
  returns: v.id("signalWindows"),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db.insert("signalWindows", args);
  },
});

export const listBySession = query({
  args: { sessionId: v.id("sessions") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db.query("signalWindows").withIndex("by_session", (q) => q.eq("sessionId", args.sessionId)).collect();
  },
});
