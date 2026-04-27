/**
 * OpenRouter — unified gateway for Anthropic (Claude) and Google (Gemini)
 * model calls, routed through Cloudflare AI Gateway's native `openrouter`
 * provider. OpenAI-compatible chat completion shape.
 *
 * Endpoint: https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/openrouter/chat/completions
 *
 * Models we use (canonical, override per-call if needed):
 *   - anthropic/claude-sonnet-4-5      (cross-session synthesis)
 *   - anthropic/claude-opus-4-5        (premium synthesis fallback)
 *   - google/gemini-2.5-flash          (vision frame classification, sampled)
 *   - google/gemini-2.5-flash-lite     (cheap text passes)
 *   - google/gemini-2.5-pro            (whole-video friction confirmation)
 *
 * The `Authorization: Bearer ...` header carries the OpenRouter API key.
 * Multimodal inputs use the OpenAI content-array format with `image_url`
 * parts; OpenRouter handles the upstream conversion for Gemini/Claude.
 */

import { GatewayClient } from "./gateway";

export type OpenRouterTextPart = { type: "text"; text: string };
export type OpenRouterImagePart = {
  type: "image_url";
  image_url: { url: string; detail?: "low" | "high" | "auto" };
};
export type OpenRouterContentPart = OpenRouterTextPart | OpenRouterImagePart;

export interface OpenRouterMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenRouterContentPart[];
  name?: string;
  tool_call_id?: string;
}

export interface OpenRouterChatRequest {
  model: string;
  messages: OpenRouterMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: { type: "json_object" | "text" };
  stream?: false;
}

export interface OpenRouterChatResponse {
  id: string;
  model: string;
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
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenRouterChatOptions {
  /** Per-call cache TTL (seconds). 0 / undefined = no cache. */
  cacheTtl?: number;
  /** Optional Cloudflare AI Gateway BYOK / authenticated-gateway token. */
  cfAigAuthorization?: string;
  signal?: AbortSignal;
}

export async function openrouterChat(
  gateway: GatewayClient,
  apiKey: string,
  req: OpenRouterChatRequest,
  opts: OpenRouterChatOptions = {},
): Promise<OpenRouterChatResponse> {
  return gateway.post<OpenRouterChatResponse>({
    provider: "openrouter",
    path: "chat/completions",
    authHeader: `Bearer ${apiKey}`,
    body: req,
    cacheTtl: opts.cacheTtl,
    extraHeaders: opts.cfAigAuthorization
      ? { "cf-aig-authorization": `Bearer ${opts.cfAigAuthorization}` }
      : undefined,
    signal: opts.signal,
  });
}

/** First text choice from a chat response (best-effort). */
export function openrouterText(res: OpenRouterChatResponse): string {
  return res.choices[0]?.message?.content ?? "";
}
