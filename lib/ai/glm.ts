/**
 * GLM (Z.ai / Fireworks) — OpenAI-compatible chat completions, routed
 * through Cloudflare AI Gateway as a Custom Provider.
 *
 * GLM is the bot's brain (voice + text mode), the guide creator's chat
 * agent, the synthetic persona LLM, and the analyzer's reasoning model
 * for friction extraction, quote extraction, theme synthesis, and
 * session-level findings. Free for us via Z.ai subscription, so it's the
 * default choice unless quality demands otherwise.
 *
 * AI Gateway integration uses the Unified API (`/compat/chat/completions`)
 * with the Custom Provider slug prefixed onto the model name. Set up:
 *
 *   1. Dashboard → AI Gateway → Custom Providers → Add
 *      slug:     z-ai
 *      base_url: https://api.z.ai
 *      enabled:  true
 *
 *   2. Pass the Z.ai API key as the `Authorization: Bearer ...` header
 *      and set `model: "custom-z-ai/glm-5"` (or whichever GLM model).
 *
 *   3. AI Gateway forwards to:
 *      https://api.z.ai/api/coding/paas/v4/chat/completions
 *
 * Same pattern works for Fireworks AI by configuring a `fireworks`
 * custom provider with `base_url: https://api.fireworks.ai`.
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

/** Default custom-provider slug for GLM. Override per workspace if needed. */
export const GLM_DEFAULT_PROVIDER_SLUG = "z-ai";

/** Default GLM model name. Bump to "glm-5" once Z.ai sub is on GLM-5. */
export const GLM_DEFAULT_MODEL = "glm-5";

export interface GlmChatOptions {
  /** Custom Provider slug configured in AI Gateway. Default: "z-ai". */
  providerSlug?: string;
  /** Optional Cloudflare AI Gateway BYOK / authenticated-gateway token. */
  cfAigAuthorization?: string;
}

export async function glmChat(
  gateway: GatewayClient,
  apiKey: string,
  req: GlmChatRequest,
  opts: GlmChatOptions = {},
): Promise<GlmChatResponse> {
  const slug = opts.providerSlug ?? GLM_DEFAULT_PROVIDER_SLUG;
  // Unified API requires the model to be prefixed with `custom-{slug}/`.
  const prefixedModel = req.model.startsWith("custom-")
    ? req.model
    : `custom-${slug}/${req.model}`;
  return gateway.post<GlmChatResponse>({
    provider: "compat",
    path: "chat/completions",
    authHeader: `Bearer ${apiKey}`,
    body: { ...req, model: prefixedModel },
    extraHeaders: opts.cfAigAuthorization
      ? { "cf-aig-authorization": `Bearer ${opts.cfAigAuthorization}` }
      : undefined,
  });
}
