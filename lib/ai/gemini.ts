/**
 * Gemini (Google) — vision + text via OpenRouter through Cloudflare AI Gateway.
 *
 * V1 use cases:
 *   - Camera frame classifier (gemini-2.5-flash, sampled frames)
 *   - Screen frame analyzer (gemini-2.5-flash, sampled frames)
 *   - Whole-video friction confirmation (gemini-2.5-pro)
 *   - Persona URL grounding screenshot (synthetic users)
 *
 * Multimodal inputs use the OpenAI content-array format with `image_url`
 * parts; OpenRouter handles the upstream conversion to Gemini's native
 * multimodal shape.
 */

import { GatewayClient } from "./gateway";
import {
  openrouterChat,
  openrouterText,
  type OpenRouterChatOptions,
  type OpenRouterChatRequest,
  type OpenRouterChatResponse,
  type OpenRouterContentPart,
  type OpenRouterMessage,
} from "./openrouter";

export type GeminiModel =
  | "google/gemini-2.5-flash"
  | "google/gemini-2.5-flash-lite"
  | "google/gemini-2.5-pro";

export const GEMINI_FLASH: GeminiModel = "google/gemini-2.5-flash";
export const GEMINI_FLASH_LITE: GeminiModel = "google/gemini-2.5-flash-lite";
export const GEMINI_PRO: GeminiModel = "google/gemini-2.5-pro";

export interface GeminiChatRequest extends Omit<OpenRouterChatRequest, "model"> {
  model?: GeminiModel;
}

export type GeminiChatResponse = OpenRouterChatResponse;
export type GeminiMessage = OpenRouterMessage;
export type GeminiContentPart = OpenRouterContentPart;

export async function geminiChat(
  gateway: GatewayClient,
  openrouterApiKey: string,
  req: GeminiChatRequest,
  opts: OpenRouterChatOptions = {},
): Promise<GeminiChatResponse> {
  return openrouterChat(
    gateway,
    openrouterApiKey,
    { ...req, model: req.model ?? GEMINI_FLASH },
    opts,
  );
}

export const geminiText = openrouterText;

/** Convenience helper for vision calls. Pass image URLs (R2 signed URLs work). */
export function visionMessage(
  prompt: string,
  imageUrls: string[],
  detail: "low" | "high" | "auto" = "auto",
): GeminiMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: prompt },
      ...imageUrls.map(
        (url): GeminiContentPart => ({
          type: "image_url",
          image_url: { url, detail },
        }),
      ),
    ],
  };
}
