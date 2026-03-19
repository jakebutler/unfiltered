import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireAuthIfConfigured } from "./lib/security";

export const create = mutation({
  args: {
    name: v.string(),
    providers: v.array(v.string()),
    scenarios: v.array(v.string()),
    repetitions: v.number(),
    config: v.string(),
  },
  returns: v.id("benchmarkRuns"),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db.insert("benchmarkRuns", {
      ...args,
      startedAt: Date.now(),
      status: "running",
    });
  },
});

export const complete = mutation({
  args: {
    runId: v.id("benchmarkRuns"),
    status: v.union(v.literal("complete"), v.literal("failed")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    await ctx.db.patch(args.runId, {
      status: args.status,
      endedAt: Date.now(),
    });
  },
});

export const get = query({
  args: { runId: v.id("benchmarkRuns") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db.get(args.runId);
  },
});

export const list = query({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db.query("benchmarkRuns").order("desc").collect();
  },
});
