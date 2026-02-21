import { NextResponse } from "next/server";
import {
  buildElevenLabsRequestConfig,
  normalizeSpeechText,
  normalizeVoiceStyleProfile,
} from "@/lib/elevenlabs";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ELEVENLABS_API_KEY not set" }, { status: 500 });
  }

  let text = "";
  let profileRaw: string | undefined;
  try {
    const body = await request.json();
    text = typeof body.text === "string" ? body.text : "";
    profileRaw = typeof body.profile === "string" ? body.profile : undefined;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const normalizedText = normalizeSpeechText(text);
  if (!normalizedText) {
    return NextResponse.json({ error: "Text is required" }, { status: 400 });
  }

  let config: ReturnType<typeof buildElevenLabsRequestConfig>;
  try {
    config = buildElevenLabsRequestConfig(
      normalizedText,
      process.env as Record<string, string | undefined>,
      normalizeVoiceStyleProfile(profileRaw),
    );
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }

  const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${config.voiceId}/stream?output_format=${encodeURIComponent(config.outputFormat)}`;
  let upstream: Response;
  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify(config.body),
      cache: "no-store",
    });
  } catch (error) {
    return NextResponse.json(
      { error: "ElevenLabs request failed to execute", detail: String(error) },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    const detail = await upstream.text();
    return NextResponse.json(
      { error: "ElevenLabs TTS request failed", detail },
      { status: 502 },
    );
  }

  const contentType = upstream.headers.get("content-type") || "audio/mpeg";
  if (!upstream.body) {
    const bytes = await upstream.arrayBuffer();
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
      },
    });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "X-TTS-Voice-Style": config.styleProfile,
      "X-TTS-Provider": "elevenlabs",
    },
  });
}
