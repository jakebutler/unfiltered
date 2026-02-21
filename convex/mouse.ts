import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireAuthIfConfigured } from "./lib/security";

export const addWindow = mutation({
  args: {
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
    heatmapBins: v.optional(v.array(v.object({ x: v.number(), y: v.number(), count: v.number() }))),
  },
  returns: v.id("mouseWindows"),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db.insert("mouseWindows", args);
  },
});

export const listBySession = query({
  args: { sessionId: v.id("sessions") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db.query("mouseWindows").withIndex("by_session", (q) => q.eq("sessionId", args.sessionId)).collect();
  },
});
