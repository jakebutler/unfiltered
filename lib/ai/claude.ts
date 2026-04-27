/**
 * Claude (Anthropic) — used for cross-session synthesis (study-wide
 * findings) where reasoning quality matters most and volume is lowest.
 *
 * Routed through OpenRouter via Cloudflare AI Gateway. See
 * `./openrouter.ts` for the underlying client.
 */

import { GatewayClient } from "./gateway";
import {
  openrouterChat,
  openrouterText,
  type OpenRouterChatOptions,
  type OpenRouterChatRequest,
  type OpenRouterChatResponse,
  type OpenRouterMessage,
} from "./openrouter";

export type ClaudeModel =
  | "anthropic/claude-sonnet-4-5"
  | "anthropic/claude-opus-4-5";

export const CLAUDE_DEFAULT_MODEL: ClaudeModel = "anthropic/claude-sonnet-4-5";

export interface ClaudeChatRequest extends Omit<OpenRouterChatRequest, "model"> {
  model?: ClaudeModel;
}

export type ClaudeChatResponse = OpenRouterChatResponse;
export type ClaudeMessage = OpenRouterMessage;

export async function claudeChat(
  gateway: GatewayClient,
  openrouterApiKey: string,
  req: ClaudeChatRequest,
  opts: OpenRouterChatOptions = {},
): Promise<ClaudeChatResponse> {
  return openrouterChat(
    gateway,
    openrouterApiKey,
    { ...req, model: req.model ?? CLAUDE_DEFAULT_MODEL },
    opts,
  );
}

export const claudeText = openrouterText;
