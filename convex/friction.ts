import { v } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import { api } from "./_generated/api";
import { clusterFrictionWindows } from "../lib/friction/detector";
import { pickTranscriptSnippetsForMoment } from "../lib/friction/snippets";
import { requireAuthIfConfigured } from "./lib/security";

export const detectAndStore = action({
  args: { sessionId: v.id("sessions") },
  returns: v.object({ momentsCreated: v.number() }),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    // Load all signal windows for this session
    const windows = await ctx.runQuery(api.signals.listBySession, { sessionId: args.sessionId });
    const transcripts = await ctx.runQuery(api.transcripts.listBySession, { sessionId: args.sessionId });
    const engagements = await ctx.runQuery(api.engagements.listBySession, { sessionId: args.sessionId });
    const mouseWindows = await ctx.runQuery(api.mouse.listBySession, { sessionId: args.sessionId });

    const clusters = clusterFrictionWindows(windows, 40);

    for (const cluster of clusters) {
      const participantSegments = transcripts.filter(
        (s: { speakerId: string; taskId?: string }) =>
          s.speakerId === "participant" &&
          (!cluster.taskId || cluster.taskId === "unknown" || !s.taskId || s.taskId === cluster.taskId),
      );

      // Pick snippets from the actual moment window (task-aware, overlap-aware).
      const relevantSegments = pickTranscriptSnippetsForMoment(
        { tStart: cluster.tStart, tEnd: cluster.tEnd, taskId: cluster.taskId },
        participantSegments,
      );

      // Extract pause spans from words
      const allWords = participantSegments
        .filter((s: { startTime: number; endTime?: number; words?: { startTime: number; duration: number }[] }) => {
          const start = Number.isFinite(s.startTime) ? s.startTime : (s.words?.[0]?.startTime ?? 0);
          const end = Number.isFinite(s.endTime)
            ? (s.endTime as number)
            : (s.words?.[s.words.length - 1]?.startTime ?? start) + (s.words?.[s.words.length - 1]?.duration ?? 0.25);
          return end > cluster.tStart && start < cluster.tEnd;
        })
        .flatMap((s: { words: { startTime: number; duration: number }[] }) => s.words)
        .sort((a: { startTime: number }, b: { startTime: number }) => a.startTime - b.startTime);
      const pauseSpans: { start: number; end: number }[] = [];
      for (let i = 1; i < allWords.length; i++) {
        const prevEnd = allWords[i - 1].startTime + allWords[i - 1].duration;
        const gap = allWords[i].startTime - prevEnd;
        if (gap >= 1.5) pauseSpans.push({ start: prevEnd, end: allWords[i].startTime });
      }

      // Find nearest engagement snapshot
      const nearestEngagement = engagements
        .filter((e: { t: number }) => e.t >= cluster.tStart && e.t <= cluster.tEnd)
        .sort((a: { confidence: number }, b: { confidence: number }) => b.confidence - a.confidence)[0];

      // Find nearest mouse window
      const nearestMouse = mouseWindows
        .find((m: { tStart: number; tEnd: number }) => m.tStart <= cluster.tEnd && m.tEnd >= cluster.tStart);

      await ctx.runMutation(api.friction.storeMoment, {
        sessionId: args.sessionId,
        taskId: cluster.taskId,
        tStart: cluster.tStart,
        tEnd: cluster.tEnd,
        frictionPeak: cluster.frictionPeak,
        evidence: {
          transcriptSnippets: relevantSegments,
          pauseSpans: pauseSpans.slice(0, 5),
          matchedPhrases: [],
        },
        signalTags: cluster.signalTags,
        engagementSnapshot: nearestEngagement ? { state: nearestEngagement.state, confidence: nearestEngagement.confidence } : undefined,
        mouseSnapshot: nearestMouse ? nearestMouse.summary : undefined,
      });
    }

    return { momentsCreated: clusters.length };
  },
});

export const storeMoment = mutation({
  args: {
    sessionId: v.id("sessions"),
    taskId: v.string(),
    tStart: v.number(),
    tEnd: v.number(),
    frictionPeak: v.number(),
    evidence: v.object({
      transcriptSnippets: v.array(v.string()),
      pauseSpans: v.array(v.object({ start: v.number(), end: v.number() })),
      matchedPhrases: v.array(v.string()),
    }),
    signalTags: v.array(v.string()),
    engagementSnapshot: v.optional(v.object({ state: v.string(), confidence: v.number() })),
    mouseSnapshot: v.optional(v.object({
      inactiveSec: v.number(), erraticness: v.number(),
      repeatClicksSameRegion: v.number(), scrollBursts: v.number(),
    })),
  },
  returns: v.id("frictionMoments"),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db.insert("frictionMoments", args);
  },
});

export const patchLabel = mutation({
  args: {
    momentId: v.id("frictionMoments"),
    candidateFindingLabel: v.string(),
    category: v.union(
      v.literal("copy_language"), v.literal("discoverability"), v.literal("system_status_feedback"),
      v.literal("navigation_ia"), v.literal("form_field_friction"), v.literal("task_prompt_issue"),
      v.literal("error_recovery"), v.literal("other"),
    ),
    interpretation: v.string(),
    recommendations: v.array(v.string()),
    verificationQuestion: v.string(),
    labelConfidence: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    const { momentId, ...fields } = args;
    await ctx.db.patch(momentId, fields);
    return null;
  },
});

export const setVerification = mutation({
  args: {
    momentId: v.id("frictionMoments"),
    status: v.union(v.literal("confirmed"), v.literal("incorrect")),
    feedback: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    const feedback = (args.feedback ?? "").trim();
    if (args.status === "incorrect" && feedback.length === 0) {
      throw new Error("Feedback is required when marking an analysis as incorrect.");
    }
    await ctx.db.patch(args.momentId, {
      verificationStatus: args.status,
      verificationFeedback: args.status === "incorrect" ? feedback : "",
      verifiedAt: Date.now(),
    });
    return null;
  },
});

export const listBySession = query({
  args: { sessionId: v.id("sessions") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db.query("frictionMoments").withIndex("by_session", (q) => q.eq("sessionId", args.sessionId)).collect();
  },
});
