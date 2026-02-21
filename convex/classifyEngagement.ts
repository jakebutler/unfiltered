import { v } from "convex/values";
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import OpenAI from "openai";
import { requireAuthIfConfigured } from "./lib/security";

const SYSTEM_PROMPT = `You are an assistant that classifies user engagement state from a low-resolution webcam frame during a UX test.
You must be conservative: if unsure, output low confidence.
You must not infer sensitive attributes (age, race, health, etc.) or identity. Do not guess demographics.
You must not output medical/psychological claims. Only "engagement cues" relevant to usability testing.
Return ONLY valid JSON that matches the schema below. No extra keys, no markdown.

JSON_SCHEMA:
{
  "state": "engaged_active" | "engaged_stuck" | "disengaged_away" | "uncertain_low_confidence",
  "confidence": number,
  "signals": {
    "face_present": boolean,
    "gaze_toward_screen_likely": boolean,
    "attention_stable_likely": boolean,
    "visible_frustration_cues_likely": boolean
  },
  "notes": string
}`;

export const classifyEngagement = action({
  args: {
    sessionId: v.id("sessions"),
    taskId: v.optional(v.string()),
    frameBase64: v.string(),
    recentTranscriptSnippet: v.optional(v.string()),
    taskLabel: v.optional(v.string()),
    taskTimeSec: v.optional(v.number()),
    sessionTimeSec: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    const minimaxApiKey = process.env.MINIMAX_API_KEY;
    if (!minimaxApiKey) {
      // Camera analysis is optional in dev/manual test flows.
      // Skip cleanly if deployment env is missing.
      return null;
    }

    const client = new OpenAI({
      baseURL: "https://api.minimax.chat/v1",
      apiKey: minimaxApiKey,
    });

    const userContent: OpenAI.ChatCompletionContentPart[] = [
      {
        type: "text",
        text: [
          `Context:`,
          `- Study: "Unfiltered" AI UX interview`,
          `- Current task: ${args.taskLabel ?? "unknown"}`,
          `- Time in task (sec): ${args.taskTimeSec ?? 0}`,
          args.recentTranscriptSnippet ? `- Recent transcript: "${args.recentTranscriptSnippet}"` : "",
          `\nAnalyze the provided webcam frame and classify engagement state. Output JSON only.`,
        ].filter(Boolean).join("\n"),
      },
      {
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${args.frameBase64}` },
      },
    ];

    let parsed: { state: string; confidence: number; signals: { face_present: boolean; gaze_toward_screen_likely: boolean; attention_stable_likely: boolean; visible_frustration_cues_likely: boolean }; notes: string };

    try {
      const response = await client.chat.completions.create({
        // Verify model name at https://api.minimax.chat — check available vision models
        model: "MiniMax-VL-01",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        response_format: { type: "json_object" },
        max_tokens: 256,
      });
      parsed = JSON.parse(response.choices[0].message.content ?? "{}");
    } catch {
      // On any API or parse failure, store uncertain result rather than crashing session
      parsed = {
        state: "uncertain_low_confidence",
        confidence: 0,
        signals: { face_present: false, gaze_toward_screen_likely: false, attention_stable_likely: false, visible_frustration_cues_likely: false },
        notes: "Classification failed",
      };
    }

    const validStates = ["engaged_active", "engaged_stuck", "disengaged_away", "uncertain_low_confidence"];
    const state = validStates.includes(parsed.state) ? parsed.state : "uncertain_low_confidence";

    await ctx.runMutation(api.engagements.addEvent, {
      sessionId: args.sessionId,
      taskId: args.taskId,
      t: args.sessionTimeSec ?? 0,
      state: state as "engaged_active" | "engaged_stuck" | "disengaged_away" | "uncertain_low_confidence",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
      signals: {
        facePresent: parsed.signals?.face_present ?? false,
        gazeTowardScreenLikely: parsed.signals?.gaze_toward_screen_likely ?? false,
        attentionStableLikely: parsed.signals?.attention_stable_likely ?? false,
        visibleFrustrationCuesLikely: parsed.signals?.visible_frustration_cues_likely ?? false,
      },
      notes: (parsed.notes ?? "").slice(0, 160),
    });
    return null;
  },
});
