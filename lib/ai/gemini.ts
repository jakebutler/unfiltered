/**
 * Gemini (Google AI Studio) — vision + text via AI Gateway.
 *
 * V1 use cases:
 * - Camera frame classifier (Gemini 2.5 Flash, sampled frames)
 * - Screen frame analyzer (Gemini 2.5 Flash, sampled frames)
 * - Whole-video friction confirmation (Gemini 2.5 Pro)
 * - Persona URL grounding screenshot (synthetic users)
 */

import { GatewayClient } from "./gateway";

export type GeminiModel =
  | "gemini-2.5-flash"
  | "gemini-2.5-flash-lite"
  | "gemini-2.5-pro";

export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType: string; fileUri: string };
}

export interface GeminiContent {
  role?: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig?: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    responseMimeType?: "text/plain" | "application/json";
    responseSchema?: unknown;
  };
}

export interface GeminiResponse {
  candidates: Array<{
    content: { role: string; parts: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

export async function geminiGenerate(
  gateway: GatewayClient,
  apiKey: string,
  model: GeminiModel,
  req: GeminiRequest,
): Promise<GeminiResponse> {
  return gateway.post<GeminiResponse>({
    provider: "google-ai-studio",
    path: `v1beta/models/${model}:generateContent`,
    body: req,
    extraHeaders: { "x-goog-api-key": apiKey },
  });
}

/** Best-effort first text candidate. */
export function geminiText(res: GeminiResponse): string {
  return res.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text ?? "";
}
