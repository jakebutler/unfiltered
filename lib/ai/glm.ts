/**
 * GLM (Z.ai / Fireworks) — OpenAI-compatible chat completions.
 *
 * GLM is the bot's brain (voice + text mode), the guide creator's chat
 * agent, the synthetic persona LLM, and the analyzer's reasoning model
 * for friction extraction, quote extraction, theme synthesis, and
 * session-level findings. Free for us via subscription, so it's the
 * default choice unless quality demands otherwise.
 */

import { GatewayClient } from "./gateway";

export interface GlmChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  name?: string;
  tool_call_id?: string;
}

export interface GlmChatRequest {
  model: string;
  messages: GlmChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: { type: "json_object" | "text" };
  stream?: false; // streaming wired in Phase 1 when needed
}

export interface GlmChatResponse {
  id: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export const GLM_DEFAULT_MODEL = "glm-4-air"; // overridable when GLM-5 is available

export async function glmChat(
  gateway: GatewayClient,
  apiKey: string,
  req: GlmChatRequest,
): Promise<GlmChatResponse> {
  return gateway.post<GlmChatResponse>({
    provider: "compat",
    path: "/chat/completions",
    authHeader: `Bearer ${apiKey}`,
    body: req,
    extraHeaders: {
      // Cloudflare AI Gateway compat needs upstream URL when provider is "compat".
      "cf-aig-metadata": JSON.stringify({ upstream: "z.ai" }),
    },
  });
}
