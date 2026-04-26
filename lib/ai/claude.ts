/**
 * Claude (Anthropic) — used for cross-session synthesis (study-wide
 * findings) where reasoning quality matters most and volume is lowest.
 */

import { GatewayClient } from "./gateway";

export type ClaudeModel =
  | "claude-sonnet-4-5-20250929"
  | "claude-opus-4-5-20250929";

export interface ClaudeMessage {
  role: "user" | "assistant";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | {
            type: "image";
            source: {
              type: "base64";
              media_type: string;
              data: string;
            };
          }
      >;
}

export interface ClaudeRequest {
  model: ClaudeModel;
  max_tokens: number;
  system?: string;
  messages: ClaudeMessage[];
  temperature?: number;
  top_p?: number;
  tools?: unknown[];
  tool_choice?: unknown;
}

export interface ClaudeResponse {
  id: string;
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  >;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

export async function claudeMessage(
  gateway: GatewayClient,
  apiKey: string,
  req: ClaudeRequest,
): Promise<ClaudeResponse> {
  return gateway.post<ClaudeResponse>({
    provider: "anthropic",
    path: "v1/messages",
    body: req,
    extraHeaders: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });
}

/** Best-effort first text block. */
export function claudeText(res: ClaudeResponse): string {
  for (const part of res.content) {
    if (part.type === "text") return part.text;
  }
  return "";
}
