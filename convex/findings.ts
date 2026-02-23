import { v } from "convex/values";
import { action, mutation } from "./_generated/server";
import { api } from "./_generated/api";
import OpenAI from "openai";
import { requireAuthIfConfigured } from "./lib/security";

const LABELER_SYSTEM = `You are a UX research synthesis assistant for "Unfiltered."
You convert a single friction moment (timestamped evidence) into a candidate UX finding label and recommendation.
You must be conservative, evidence-first, and avoid overclaiming.
Do not assume the UI; only use what is in the evidence.
Return ONLY valid JSON matching the schema below. No extra keys, no markdown.

IMPORTANT:
- Provide recommendations as hypotheses to test.
- If evidence points to script/task wording rather than product, say so.
- If uncertainty is high, mark low confidence and request verification.

JSON_SCHEMA:
{
  "candidate_finding_label": string,
  "category": "copy_language" | "discoverability" | "system_status_feedback" | "navigation_ia" | "form_field_friction" | "task_prompt_issue" | "error_recovery" | "other",
  "evidence": {
    "timestamp_range": {"start_sec": number, "end_sec": number},
    "quotes": string[],
    "signal_tags": string[],
    "metrics": object
  },
  "interpretation": string,
  "recommendations": string[],
  "verification_question": string,
  "confidence": number
}`;

const VALID_CATEGORIES = ["copy_language", "discoverability", "system_status_feedback", "navigation_ia", "form_field_friction", "task_prompt_issue", "error_recovery", "other"];

export const labelAllMoments = action({
  args: { sessionId: v.id("sessions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    const fireworksApiKey = process.env.FIREWORKS_API_KEY;
    if (!fireworksApiKey) {
      return null;
    }

    const moments = await ctx.runQuery(api.friction.listBySession, { sessionId: args.sessionId });
    const session = await ctx.runQuery(api.sessions.get, { sessionId: args.sessionId });
    if (!session) return null;
    const study = await ctx.runQuery(api.studies.get, { studyId: session.studyId });
    const client = new OpenAI({
      baseURL: "https://api.fireworks.ai/inference/v1",
      apiKey: fireworksApiKey,
    });

    for (const moment of moments) {
      const task = study?.tasks.find((t: { id: string; label: string }) => t.id === moment.taskId) ?? { id: moment.taskId, label: "Unknown task" };

      const userMessage = `Generate a candidate UX finding for this friction moment.

MOMENT:
- task: ${JSON.stringify(task)}
- timestamp_range_sec: {"start": ${moment.tStart}, "end": ${moment.tEnd}}
- transcript_snippets: ${JSON.stringify(moment.evidence.transcriptSnippets)}
- conversation_signal_summary: ${JSON.stringify({ signal_tags: moment.signalTags })}
- mouse_summary_near_moment: ${JSON.stringify(moment.mouseSnapshot ?? {})}
- engagement_state_near_moment: ${JSON.stringify(moment.engagementSnapshot ?? {})}
- reviewer_verification: ${JSON.stringify({
  status: moment.verificationStatus ?? "unreviewed",
  feedback: moment.verificationFeedback ?? "",
})}

Guidance:
Use these mapping heuristics (choose best fit):
- High hedges + explicit uncertainty + clarification → copy/terminology unclear OR task prompt unclear
- Repeat attempt loop + "did that work?" + pauses → system status/feedback unclear
- "where is…" + backtracking + long pauses → discoverability/navigation issue
- Many pauses/hesitation on form fields → form field friction/micro-friction
- Confusion immediately after interviewer task prompt → task_prompt_issue
- If reviewer feedback says this analysis is incorrect, revise your interpretation and recommendations to address that feedback directly.

Output JSON only.`;

      let parsed: Record<string, unknown>;
      try {
        const response = await client.chat.completions.create({
          // Verify model name at https://fireworks.ai/models — search "glm"
          model: "accounts/fireworks/models/glm-5",
          max_tokens: 1024,
          messages: [{ role: "system", content: LABELER_SYSTEM }, { role: "user", content: userMessage }],
          response_format: { type: "json_object" },
        });
        const text = response.choices[0].message.content ?? "{}";
        parsed = JSON.parse(text);
      } catch {
        continue; // skip this moment on failure; don't crash the whole pipeline
      }

      const category = VALID_CATEGORIES.includes(parsed.category as string) ? parsed.category as string : "other";

      await ctx.runMutation(api.friction.patchLabel, {
        momentId: moment._id,
        candidateFindingLabel: ((parsed.candidate_finding_label as string) ?? "").slice(0, 90),
        category: category as "copy_language" | "discoverability" | "system_status_feedback" | "navigation_ia" | "form_field_friction" | "task_prompt_issue" | "error_recovery" | "other",
        interpretation: typeof parsed.interpretation === "string" ? parsed.interpretation.trim() : "",
        recommendations: Array.isArray(parsed.recommendations) ? (parsed.recommendations as string[]).slice(0, 4) : [],
        verificationQuestion: (parsed.verification_question as string) ?? "",
        labelConfidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      });
    }
    return null;
  },
});

export const generateThemes = action({
  args: { sessionId: v.id("sessions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    const moments = await ctx.runQuery(api.friction.listBySession, { sessionId: args.sessionId });
    if (moments.length === 0) return null;
    const fireworksApiKey = process.env.FIREWORKS_API_KEY;

    const summaryInput = moments
      .filter((m: { candidateFindingLabel?: string }) => m.candidateFindingLabel)
      .map((m: { category?: string; candidateFindingLabel?: string; interpretation?: string; verificationStatus?: string; verificationFeedback?: string }) => {
        const verification = m.verificationStatus ? ` verification=${m.verificationStatus}` : "";
        const feedback = m.verificationFeedback ? ` feedback="${m.verificationFeedback}"` : "";
        return `- [${m.category}] ${m.candidateFindingLabel}: ${m.interpretation}${verification}${feedback}`;
      })
      .join("\n");

    let themes: string[] = [];
    if (fireworksApiKey) {
      const client = new OpenAI({
        baseURL: "https://api.fireworks.ai/inference/v1",
        apiKey: fireworksApiKey,
      });
      try {
        const response = await client.chat.completions.create({
          model: "accounts/fireworks/models/glm-5",
          max_tokens: 512,
          messages: [{
            role: "user",
            content: `From these UX findings, identify the top 3 friction themes. Return a JSON array of 3 short strings (each ≤80 chars). No extra keys.\n\nFindings:\n${summaryInput}\n\nReturn: ["theme 1", "theme 2", "theme 3"]`,
          }],
        });
        const text = response.choices[0].message.content ?? "[]";
        themes = JSON.parse(text);
        if (!Array.isArray(themes)) themes = [];
      } catch {
        themes = [];
      }
    }

    // Compute session friction score
    const allScores = await ctx.runQuery(api.signals.listBySession, { sessionId: args.sessionId });
    const scores = allScores.map((w: { friction0to100: number }) => w.friction0to100);
    const avg = scores.length ? scores.reduce((a: number, b: number) => a + b, 0) / scores.length : 0;
    const peak = scores.length ? Math.max(...scores) : 0;
    const timeInHigh = scores.length ? (scores.filter((s: number) => s >= 75).length / scores.length) * 100 : 0;
    const sessionFriction = Math.round(0.45 * avg + 0.35 * peak + 0.2 * timeInHigh);

    await ctx.runMutation(api.findings.patchOutputs, {
      sessionId: args.sessionId,
      themes: themes.slice(0, 3),
      sessionFriction,
    });
    return null;
  },
});

export const patchOutputs = mutation({
  args: {
    sessionId: v.id("sessions"),
    themes: v.array(v.string()),
    sessionFriction: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    await ctx.db.patch(args.sessionId, {
      outputs: { themes: args.themes, sessionFriction: args.sessionFriction },
    });
    return null;
  },
});
