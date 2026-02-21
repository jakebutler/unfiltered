import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireAuthIfConfigured } from "./lib/security";

export const addSegment = mutation({
  args: {
    sessionId: v.id("sessions"),
    speakerId: v.union(v.literal("participant"), v.literal("interviewer")),
    text: v.string(),
    words: v.array(v.object({ text: v.string(), startTime: v.number(), duration: v.optional(v.number()) })),
    startTime: v.number(),
    endTime: v.number(),
    taskId: v.optional(v.string()),
  },
  returns: v.id("transcriptSegments"),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    const normalizedWords = args.words
      .filter((w) => w.text.trim())
      .map((w, i, arr) => {
        if (typeof w.duration === "number" && Number.isFinite(w.duration) && w.duration > 0) {
          return { text: w.text, startTime: w.startTime, duration: w.duration };
        }
        const next = arr[i + 1];
        const inferred =
          next && Number.isFinite(next.startTime) && next.startTime > w.startTime
            ? next.startTime - w.startTime
            : 0.25;
        return { text: w.text, startTime: w.startTime, duration: inferred };
      });

    const startTime = normalizedWords[0]?.startTime ?? args.startTime;
    const endTime = normalizedWords.length
      ? normalizedWords[normalizedWords.length - 1].startTime + normalizedWords[normalizedWords.length - 1].duration
      : args.endTime;

    return await ctx.db.insert("transcriptSegments", {
      ...args,
      words: normalizedWords,
      startTime,
      endTime,
    });
  },
});

export const listBySession = query({
  args: { sessionId: v.id("sessions") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db.query("transcriptSegments").withIndex("by_session", (q) => q.eq("sessionId", args.sessionId)).collect();
  },
});
