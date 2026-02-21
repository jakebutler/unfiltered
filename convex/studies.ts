import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireAuthIfConfigured } from "./lib/security";

export const create = mutation({
  args: {
    title: v.string(),
    prototypeUrl: v.string(),
    prdText: v.optional(v.string()),
    tasks: v.array(v.object({ id: v.string(), label: v.string() })),
    decideMode: v.union(v.literal("A"), v.literal("B"), v.literal("AB")),
  },
  returns: v.id("studies"),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    return await ctx.db.insert("studies", { ...args, createdAt: Date.now() });
  },
});

export const get = query({
  args: { studyId: v.id("studies") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db.get(args.studyId);
  },
});

export const list = query({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db.query("studies").order("desc").take(50);
  },
});
