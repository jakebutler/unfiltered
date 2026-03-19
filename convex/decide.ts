import { v } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import { api } from "./_generated/api";
import OpenAI from "openai";
import { requireAuthIfConfigured } from "./lib/security";

const SYSTEM_PROMPT = `You are the "Unfiltered" interviewer policy module.
You must choose the next interviewer action using only the ALLOWED_ACTIONS.
You must be helpful, non-leading, and neutral. Do not shame the participant.
You must not ask for personal/sensitive information.
You must keep prompts short, plain-language, and task-oriented.
If the participant seems disengaged, offer an easy out or move on.
Return ONLY valid JSON with the exact keys in the schema. No extra keys, no markdown.

CRITICAL:
- Do NOT invent UI details that are not provided in context.
- Do NOT claim certainty about emotions. Treat engagement as an approximate cue.
- Avoid repeating the exact same follow-up wording across consecutive turns.
- Wait for a clear pause before asking follow-ups; do not jump in while the participant is still talking.
- If you interrupted the participant, briefly apologize and ask them to continue.
- Prefer varied expectation probes, e.g.:
  - "What did you expect would happen there, and why?"
  - "What outcome were you expecting at that point?"
  - "Before that action, what did you think would happen next?"
- If the participant sounds confused, use probes like:
  - "I heard you say you were confused. Is there any more detail you wanted to share about that?"
  - If they seem unsure what to do next: "Are you not sure what to do next? What do you think the next step should be?"
- If the participant shows affinity, probe with variety:
  - "Can you tell me more about what you liked about that?"
  - "Can you tell me more about why that was interesting to you?"

JSON_SCHEMA:
{
  "action": "ask_followup" | "clarify_task" | "reflect_back" | "move_to_next_task" | "wait",
  "next_prompt": string,
  "rationale": string,
  "probe_type": "expectation" | "comprehension" | "navigation" | "system_status" | "emotion_checkin" | "move_on" | "none",
  "confidence": number
}`;

const ALLOWED_ACTIONS = ["ask_followup", "clarify_task", "reflect_back", "move_to_next_task", "wait"];

export const runPolicyB = action({
  args: {
    sessionId: v.id("sessions"),
    prototypeUrl: v.string(),
    taskList: v.array(v.object({ id: v.string(), label: v.string() })),
    currentTask: v.object({ id: v.string(), label: v.string() }),
    taskTimeSec: v.number(),
    conversationCues: v.any(),
    engagementState: v.any(),
    mouseSummary: v.any(),
    lastInterviewerPrompt: v.string(),
    lastParticipantUtterance: v.string(),
    transcriptTail: v.string(),
    hardOverrides: v.object({ mustMoveOn: v.boolean(), reason: v.string() }),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    const fireworksApiKey = process.env.FIREWORKS_API_KEY;

    const userMessage = `You are running a live UX test. Decide the NEXT action and prompt.

STUDY_CONTEXT:
- prototype_url: ${args.prototypeUrl}
- task_list: ${JSON.stringify(args.taskList)}
- current_task: ${JSON.stringify(args.currentTask)}
- task_time_sec: ${args.taskTimeSec}
- policy_mode: "bounded_llm"

REALTIME_SIGNALS (most recent window):
- conversation_cues: ${JSON.stringify(args.conversationCues)}
- engagement_state: ${JSON.stringify(args.engagementState)}
- mouse_summary: ${JSON.stringify(args.mouseSummary)}

TRANSCRIPT_CONTEXT:
- last_interviewer_prompt: "${args.lastInterviewerPrompt}"
- last_participant_utterance: "${args.lastParticipantUtterance}"
- transcript_tail: "${args.transcriptTail}"

GUARDRAILS:
- allowed_actions: ${JSON.stringify(ALLOWED_ACTIONS)}
- hard_overrides: ${JSON.stringify(args.hardOverrides)}

Output JSON only.`;

    let parsed: { action: string; next_prompt: string; rationale: string; probe_type: string; confidence: number };

    if (!fireworksApiKey) {
      parsed = {
        action: "wait",
        next_prompt: "Take your time—tell me what you're thinking.",
        rationale: "FIREWORKS_API_KEY missing, defaulting to wait",
        probe_type: "none",
        confidence: 0.5,
      };
    } else {
      const client = new OpenAI({
        baseURL: "https://api.fireworks.ai/inference/v1",
        apiKey: fireworksApiKey,
      });
      try {
        const response = await client.chat.completions.create({
          // Verify model name at https://fireworks.ai/models — search "glm"
          model: "accounts/fireworks/models/glm-5",
          max_tokens: 512,
          messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userMessage }],
          response_format: { type: "json_object" },
        });
        const text = response.choices[0].message.content ?? "{}";
        parsed = JSON.parse(text);
      } catch {
        parsed = { action: "wait", next_prompt: "Take your time—tell me what you're thinking.", rationale: "LLM call failed, defaulting to wait", probe_type: "none", confidence: 0.5 };
      }
    }

    const validActions = ALLOWED_ACTIONS;
    const validProbes = ["expectation", "comprehension", "navigation", "system_status", "emotion_checkin", "move_on", "none"];
    const outputAction = validActions.includes(parsed.action) ? parsed.action : "wait";
    const probeType = validProbes.includes(parsed.probe_type) ? parsed.probe_type : "none";

    await ctx.runMutation(api.decide.storeEvent, {
      sessionId: args.sessionId,
      policyUsed: "llm",
      inputSummary: JSON.stringify({ cues: args.conversationCues, engagement: args.engagementState?.state }),
      outputAction: outputAction as "ask_followup" | "clarify_task" | "reflect_back" | "move_to_next_task" | "wait",
      outputPrompt: (parsed.next_prompt ?? "").slice(0, 220),
      probeType: probeType as "expectation" | "comprehension" | "navigation" | "system_status" | "emotion_checkin" | "move_on" | "none",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    });

    return { action: outputAction, nextPrompt: (parsed.next_prompt ?? "").slice(0, 220), probeType, confidence: parsed.confidence };
  },
});

export const storeEvent = mutation({
  args: {
    sessionId: v.id("sessions"),
    policyUsed: v.union(v.literal("deterministic"), v.literal("llm")),
    inputSummary: v.string(),
    outputAction: v.union(v.literal("ask_followup"), v.literal("clarify_task"), v.literal("reflect_back"), v.literal("move_to_next_task"), v.literal("wait")),
    outputPrompt: v.string(),
    probeType: v.union(v.literal("expectation"), v.literal("comprehension"), v.literal("navigation"), v.literal("system_status"), v.literal("emotion_checkin"), v.literal("move_on"), v.literal("none")),
    confidence: v.number(),
  },
  returns: v.id("decideEvents"),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db.insert("decideEvents", { ...args, t: Date.now() });
  },
});

export const listBySession = query({
  args: { sessionId: v.id("sessions") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuthIfConfigured(ctx);
    return ctx.db.query("decideEvents").withIndex("by_session", (q) => q.eq("sessionId", args.sessionId)).collect();
  },
});
