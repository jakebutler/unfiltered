import { mutation, query, action } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";

// Create a new test run
export const create = mutation({
  args: {
    studyId: v.id("studies"),
    count: v.number(),
    distribution: v.optional(v.any()),
    parallel: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    // NOTE: This requires Convex types to be regenerated.
    // Run `npx convex dev` to generate the API types.
    // For now, return a placeholder.
    /*
    // Generate personas for the test run
    const personaIds = await ctx.runMutation(api.personas.generateMany, {
      count: args.count,
      distribution: args.distribution,
    });
    */

    // Placeholder: Create test run without persona generation
    const testRunId = await ctx.db.insert("testRuns", {
      studyId: args.studyId,
      status: "pending",
      personaIds: [], // Will be populated after Convex type regeneration
      config: {
        count: args.count,
        distribution: args.distribution,
        parallel: args.parallel,
      },
      createdAt: Date.now(),
    });

    return { testRunId, personaIds: [] };
  },
});

// Start a test run
export const start = mutation({
  args: { testRunId: v.id("testRuns") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.testRunId, {
      status: "running",
      startedAt: Date.now(),
    });
  },
});

// Complete a test run
export const complete = mutation({
  args: {
    testRunId: v.id("testRuns"),
    resultsSummary: v.object({
      completedCount: v.number(),
      avgFriction: v.optional(v.number()),
      avgSUS: v.optional(v.number()),
      totalActions: v.optional(v.number()),
    }),
    sessionIds: v.array(v.id("sessions")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.testRunId, {
      status: "complete",
      resultsSummary: args.resultsSummary,
      sessionIds: args.sessionIds,
      completedAt: Date.now(),
    });
  },
});

// Mark test run as failed
export const fail = mutation({
  args: { testRunId: v.id("testRuns") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.testRunId, {
      status: "failed",
      completedAt: Date.now(),
    });
  },
});

// Get a single test run
export const get = query({
  args: { testRunId: v.id("testRuns") },
  handler: async (ctx, args) => {
    const testRun = await ctx.db.get(args.testRunId);
    if (!testRun) return null;

    // Fetch associated personas
    const personas = await Promise.all(
      testRun.personaIds.map((id) => ctx.db.get(id))
    );

    return { ...testRun, personas };
  },
});

// List test runs for a study
export const listByStudy = query({
  args: { studyId: v.id("studies") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("testRuns")
      .withIndex("by_study", (q) => q.eq("studyId", args.studyId))
      .order("desc")
      .collect();
  },
});

// Run a single agent session (called from agent worker)
export const runAgentSession = action({
  args: {
    studyId: v.id("studies"),
    personaId: v.id("personas"),
    prototypeUrl: v.string(),
    tasks: v.array(v.object({ id: v.string(), label: v.string() })),
  },
  handler: async (ctx, args) => {
    // Create a new session for this agent run
    const sessionId = await ctx.runMutation(api.sessions.create, {
      studyId: args.studyId,
    });

    // In a real implementation, this would:
    // 1. Signal the agent worker to start
    // 2. Wait for completion
    // 3. Return results

    // For now, return the session ID
    return { sessionId };
  },
});
