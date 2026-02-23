import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { requireAuthIfConfigured } from "./lib/security";
import {
  buildPostHogCaptureBody,
  buildExperimentProperties,
  getPostHogConfig,
  type PostHogCapturePayload,
} from "../lib/posthog/flags";
import { shouldSendExposure } from "../lib/experiments/exposure";

async function capturePostHogEvent(payload: PostHogCapturePayload): Promise<{ ok: true } | { ok: false; error: string }> {
  const config = getPostHogConfig(process.env);
  if (!config) {
    return { ok: false, error: "PostHog API key not configured" };
  }

  try {
    const response = await fetch(`${config.host}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPostHogCaptureBody(payload, config.apiKey)),
    });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, error: `PostHog capture failed (${response.status}): ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown PostHog error";
    return { ok: false, error: message };
  }
}

export const sendVariationExposure = internalAction({
  args: { variationId: v.id("experimentVariations") },
  returns: v.object({ sent: v.boolean() }),
  handler: async (ctx, args) => {
    const context = await ctx.runQuery(internal.experimentRuns.getVariationExposureContext, {
      variationId: args.variationId,
    });
    if (!context) return { sent: false };
    const { variation, run, experiment } = context;
    if (!shouldSendExposure(variation)) {
      return { sent: true };
    }

    const distinctId = `run:${String(run._id)}:variation:${variation.index}`;
    const properties = buildExperimentProperties({
      experimentId: String(experiment._id),
      runId: String(run._id),
      variationIndex: variation.index,
      studyId: String(variation.studyId),
      assignedEngineVariant: variation.decisionEngineIdAssigned,
    });
    const result = await capturePostHogEvent({
      event: "decision_engine_exposure",
      distinct_id: distinctId,
      properties,
    });

    if (result.ok) {
      await ctx.runMutation(internal.experimentRuns.setVariationExposureSent, {
        variationId: args.variationId,
        sentAt: Date.now(),
      });
      return { sent: true };
    }

    await ctx.runMutation(internal.experimentRuns.setVariationExposureFailed, {
      variationId: args.variationId,
      failedAt: Date.now(),
      error: result.error,
    });
    return { sent: false };
  },
});

export const emitRunLifecycleEvent = action({
  args: {
    runId: v.id("experimentRuns"),
    event: v.union(
      v.literal("experiment_run_started"),
      v.literal("experiment_run_paused"),
      v.literal("experiment_run_resumed"),
      v.literal("experiment_run_completed"),
      v.literal("experiment_run_aborted"),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    const run = await ctx.runQuery(api.experimentRuns.getRun, { runId: args.runId });
    if (!run) return null;
    const result = await capturePostHogEvent({
      event: args.event,
      distinct_id: `run:${String(run._id)}`,
      properties: {
        run_id: String(run._id),
        experiment_id: String(run.experimentId),
      },
    });
    if (!result.ok) {
      console.warn(`[PostHog] Failed to emit ${args.event}: ${result.error}`);
    }
    return null;
  },
});
