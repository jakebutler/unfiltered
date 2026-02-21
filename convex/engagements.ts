import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireAuthIfConfigured } from "./lib/security";

export const addEvent = mutation({
  args: {
    sessionId: v.id("sessions"),
    taskId: v.optional(v.string()),
    t: v.number(),
    state: v.union(
      v.literal("engaged_active"), v.literal("engaged_stuck"),
      v.literal("disengaged_away"), v.literal("uncertain_low_confidence"),
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
  },
  returns: v.id("engagementEvents"),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db.insert("engagementEvents", args);
  },
});

export const getLatest = query({
  args: { sessionId: v.id("sessions") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    const events = await ctx.db
      .query("engagementEvents")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .order("desc")
      .take(1);
    return events[0] ?? null;
  },
});

export const listBySession = query({
  args: { sessionId: v.id("sessions") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db.query("engagementEvents").withIndex("by_session", (q) => q.eq("sessionId", args.sessionId)).collect();
  },
});
