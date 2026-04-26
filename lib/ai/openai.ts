/**
 * OpenAI — primarily for TTS during validation (tts-1 with `shimmer`
 * or `alloy` voice). Also available as a fallback chat brain if GLM
 * has an outage.
 */

import { GatewayClient } from "./gateway";

export type OpenAIVoice = "alloy" | "ash" | "ballad" | "coral" | "echo" | "fable" | "onyx" | "nova" | "sage" | "shimmer";

export interface OpenAITtsRequest {
  model: "tts-1" | "tts-1-hd" | "gpt-4o-mini-tts";
  input: string;
  voice: OpenAIVoice;
  response_format?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
  speed?: number;
}

export async function openaiTts(
  gateway: GatewayClient,
  apiKey: string,
  req: OpenAITtsRequest,
): Promise<Response> {
  // The gateway just forwards the body and returns the upstream response.
  // We need raw audio bytes back, so we bypass the JSON convenience method.
  const url = `https://gateway.ai.cloudflare.com/v1/${
    (gateway as unknown as { accountId: string }).accountId
  }/${(gateway as unknown as { gatewayName: string }).gatewayName}/openai/audio/speech`;
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(req),
  });
}
