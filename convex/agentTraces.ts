import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Add an action trace
export const addAction = mutation({
  args: {
    sessionId: v.id("sessions"),
    personaId: v.id("personas"),
    action: v.union(
      v.literal("click"),
      v.literal("type"),
      v.literal("hover"),
      v.literal("navigate"),
      v.literal("select"),
      v.literal("scroll"),
      v.literal("wait"),
      v.literal("think_aloud"),
    ),
    target: v.optional(v.string()),
    text: v.optional(v.string()),
    description: v.string(),
    screenshot: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("agentActionTraces", {
      sessionId: args.sessionId,
      personaId: args.personaId,
      action: args.action,
      target: args.target,
      text: args.text,
      description: args.description,
      t: Date.now(),
      screenshot: args.screenshot,
    });
  },
});

// List action traces for a session
export const listBySession = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agentActionTraces")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .order("asc")
      .collect();
  },
});

// Add a reasoning trace
export const addReasoning = mutation({
  args: {
    sessionId: v.id("sessions"),
    personaId: v.id("personas"),
    type: v.union(
      v.literal("observation"),
      v.literal("reflection"),
      v.literal("plan"),
      v.literal("friction"),
    ),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("agentReasoningTraces", {
      sessionId: args.sessionId,
      personaId: args.personaId,
      type: args.type,
      content: args.content,
      t: Date.now(),
    });
  },
});

// List reasoning traces for a session
export const listReasoningBySession = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agentReasoningTraces")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .order("asc")
      .collect();
  },
});

// Get combined traces for a session (actions + reasoning)
export const getCombinedTraces = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const [actions, reasoning] = await Promise.all([
      ctx.db
        .query("agentActionTraces")
        .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
        .order("asc")
        .collect(),
      ctx.db
        .query("agentReasoningTraces")
        .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
        .order("asc")
        .collect(),
    ]);

    return { actions, reasoning };
  },
});
