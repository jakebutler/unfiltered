import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { requireAuthIfConfigured } from "./lib/security";
import type { Id } from "./_generated/dataModel";
import { generateVariationMatrix } from "../lib/experiments/variationGenerator";
import { getDecideModeForEngine } from "../lib/experiments/decisionEngineRegistry";
import { shouldSendExposure } from "../lib/experiments/exposure";
import { makeFunctionReference } from "convex/server";

const sendVariationExposureRef = makeFunctionReference<"action", { variationId: Id<"experimentVariations"> }>(
  "posthog:sendVariationExposure",
);

async function getGlobalStateDocId(ctx: MutationCtx): Promise<Id<"experimentGlobalState"> | null> {
  const docs = await ctx.db.query("experimentGlobalState").collect();
  return docs[0]?._id ?? null;
}

async function setGlobalActiveRun(ctx: MutationCtx, runId: Id<"experimentRuns"> | undefined) {
  const stateId = await getGlobalStateDocId(ctx);
  if (stateId) {
    await ctx.db.patch(stateId, { activeRunId: runId, updatedAt: Date.now() });
    return;
  }
  await ctx.db.insert("experimentGlobalState", {
    activeRunId: runId,
    updatedAt: Date.now(),
  });
}

export const startRun = mutation({
  args: {
    experimentId: v.id("telemetryExperiments"),
    studyIds: v.array(v.id("studies")),
    decisionEngineIds: v.array(v.string()),
    repeatsPerCell: v.number(),
    notes: v.optional(v.string()),
  },
  returns: v.id("experimentRuns"),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);

    const existingRunning = await ctx.db
      .query("experimentRuns")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .take(1);
    if (existingRunning.length > 0) {
      throw new Error("Only one active experiment run is allowed at a time");
    }

    const variations = generateVariationMatrix({
      studyIds: args.studyIds,
      decisionEngineIds: args.decisionEngineIds,
      repeatsPerCell: args.repeatsPerCell,
    });
    if (variations.length === 0) {
      throw new Error("No experiment variations were generated");
    }

    const now = Date.now();
    const runId = await ctx.db.insert("experimentRuns", {
      experimentId: args.experimentId,
      status: "running",
      currentVariationIndex: 0,
      totalVariations: variations.length,
      startedAt: now,
      notes: args.notes,
    });

    for (const variation of variations) {
      await ctx.db.insert("experimentVariations", {
        runId,
        index: variation.index,
        studyId: variation.studyId,
        decisionEngineIdTarget: variation.decisionEngineIdTarget,
        decisionEngineIdAssigned: variation.decisionEngineIdAssigned,
        repeatIndex: variation.repeatIndex,
        status: "pending",
      });
    }

    await setGlobalActiveRun(ctx, runId);
    return runId;
  },
});

export const startNextSession = mutation({
  args: { runId: v.id("experimentRuns") },
  returns: v.object({
    runId: v.id("experimentRuns"),
    variationId: v.id("experimentVariations"),
    variationIndex: v.number(),
    sessionId: v.id("sessions"),
    decisionEngineIdAssigned: v.string(),
  }),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Run not found");
    if (run.status !== "running") {
      throw new Error("Run must be running to start the next session");
    }

    const existingInProgress = await ctx.db
      .query("experimentVariations")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .collect();
    const inProgress = existingInProgress
      .filter((variation) => variation.status === "in_progress")
      .sort((a, b) => a.index - b.index)[0];
    if (inProgress?.sessionId) {
      return {
        runId: args.runId,
        variationId: inProgress._id,
        variationIndex: inProgress.index,
        sessionId: inProgress.sessionId,
        decisionEngineIdAssigned: inProgress.decisionEngineIdAssigned,
      };
    }

    const nextPending = existingInProgress
      .filter((variation) => variation.status === "pending")
      .sort((a, b) => a.index - b.index)[0];

    if (!nextPending) {
      throw new Error("No pending variations remain");
    }

    const decideMode = getDecideModeForEngine(nextPending.decisionEngineIdAssigned);
    const sessionId = await ctx.db.insert("sessions", {
      studyId: nextPending.studyId,
      currentTaskIndex: 0,
      status: "active",
      startedAt: Date.now(),
      decideMode,
      experimentRunId: args.runId,
      experimentVariationId: nextPending._id,
    });
    const now = Date.now();

    await ctx.db.patch(nextPending._id, {
      status: "in_progress",
      sessionId,
      startedAt: now,
    });
    await ctx.db.patch(args.runId, {
      currentVariationIndex: nextPending.index,
    });

    if (shouldSendExposure(nextPending)) {
      await ctx.scheduler.runAfter(0, sendVariationExposureRef, {
        variationId: nextPending._id,
      });
    }

    return {
      runId: args.runId,
      variationId: nextPending._id,
      variationIndex: nextPending.index,
      sessionId,
      decisionEngineIdAssigned: nextPending.decisionEngineIdAssigned,
    };
  },
});

export const finishVariation = mutation({
  args: {
    variationId: v.id("experimentVariations"),
    status: v.union(v.literal("complete"), v.literal("aborted")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    const variation = await ctx.db.get(args.variationId);
    if (!variation) throw new Error("Variation not found");
    const now = Date.now();
    await ctx.db.patch(args.variationId, {
      status: args.status,
      endedAt: now,
    });
    if (args.status === "complete") {
      await ctx.db.patch(args.variationId, {
        checklistCompletedAt: now,
      });
    }

    const run = await ctx.db.get(variation.runId);
    if (!run) return null;
    const allVariations = await ctx.db
      .query("experimentVariations")
      .withIndex("by_run", (q) => q.eq("runId", variation.runId))
      .collect();
    const unfinished = allVariations.some((entry) => entry.status === "pending" || entry.status === "in_progress");
    if (!unfinished) {
      await ctx.db.patch(variation.runId, {
        status: "complete",
        endedAt: now,
      });
      await setGlobalActiveRun(ctx, undefined);
    }
    return null;
  },
});

export const pauseRun = mutation({
  args: { runId: v.id("experimentRuns") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Run not found");
    if (run.status !== "running") return null;
    await ctx.db.patch(args.runId, { status: "paused" });
    return null;
  },
});

export const resumeRun = mutation({
  args: { runId: v.id("experimentRuns") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Run not found");

    const existingRunning = await ctx.db
      .query("experimentRuns")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .collect();
    const differentRunning = existingRunning.find((entry) => entry._id !== args.runId);
    if (differentRunning) {
      throw new Error("Another run is already active");
    }

    await ctx.db.patch(args.runId, { status: "running" });
    await setGlobalActiveRun(ctx, args.runId);
    return null;
  },
});

export const abortRun = mutation({
  args: { runId: v.id("experimentRuns") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Run not found");
    await ctx.db.patch(args.runId, { status: "aborted", endedAt: Date.now() });
    await setGlobalActiveRun(ctx, undefined);
    return null;
  },
});

export const getActiveGlobal = query({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    await requireAuthIfConfigured(ctx);
    const docs = await ctx.db.query("experimentGlobalState").collect();
    const state = docs[0] ?? null;
    if (!state?.activeRunId) return null;
    const run = await ctx.db.get(state.activeRunId);
    if (!run) return null;
    const variations = await ctx.db
      .query("experimentVariations")
      .withIndex("by_run", (q) => q.eq("runId", run._id))
      .collect();
    const inProgress = variations
      .filter((entry) => entry.status === "in_progress")
      .sort((a, b) => a.index - b.index)[0] ?? null;
    const nextPending = variations
      .filter((entry) => entry.status === "pending")
      .sort((a, b) => a.index - b.index)[0] ?? null;
    return { run, inProgress, nextPending };
  },
});

export const listVariationsByRun = query({
  args: { runId: v.id("experimentRuns") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    const rows = await ctx.db
      .query("experimentVariations")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .collect();
    return rows.sort((a, b) => a.index - b.index);
  },
});

export const getVariationExposureContext = internalQuery({
  args: { variationId: v.id("experimentVariations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const variation = await ctx.db.get(args.variationId);
    if (!variation) return null;
    const run = await ctx.db.get(variation.runId);
    if (!run) return null;
    const experiment = await ctx.db.get(run.experimentId);
    if (!experiment) return null;
    return { variation, run, experiment };
  },
});

export const setVariationExposureSent = internalMutation({
  args: {
    variationId: v.id("experimentVariations"),
    sentAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.variationId, {
      posthogExposureSentAt: args.sentAt,
      posthogExposureLastErrorAt: undefined,
      posthogExposureLastError: undefined,
    });
    return null;
  },
});

export const setVariationExposureFailed = internalMutation({
  args: {
    variationId: v.id("experimentVariations"),
    failedAt: v.number(),
    error: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.variationId, {
      posthogExposureLastErrorAt: args.failedAt,
      posthogExposureLastError: args.error.slice(0, 400),
    });
    return null;
  },
});

export const getRun = query({
  args: { runId: v.id("experimentRuns") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db.get(args.runId);
  },
});
