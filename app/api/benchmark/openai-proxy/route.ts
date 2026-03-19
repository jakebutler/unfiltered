import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "OPENAI_API_KEY not set" }, { status: 500 });
  }

  const contentType = request.headers.get("content-type") ?? "";

  // Handle multipart form data (Whisper transcription)
  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const file = formData.get("file") as Blob | null;
    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

    const whisperForm = new FormData();
    whisperForm.append("file", file, "audio.webm");
    whisperForm.append("model", "whisper-1");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: whisperForm,
    });

    if (!res.ok) {
      const detail = await res.text();
      return NextResponse.json({ error: "Whisper failed", detail }, { status: 502 });
    }
    return NextResponse.json(await res.json());
  }

  // Handle JSON body actions
  let body: { action: string; messages?: Array<{ role: string; content: string }>; text?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.action === "chat" && body.messages) {
    const startTime = Date.now();
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4",
        messages: body.messages,
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      return NextResponse.json({ error: "GPT-4 failed", detail }, { status: 502 });
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content ?? "";
    return NextResponse.json({ text, firstTokenTimestamp: startTime + 100 });
  }

  if (body.action === "tts" && body.text) {
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1",
        voice: "alloy",
        input: body.text,
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      return NextResponse.json({ error: "TTS failed", detail }, { status: 502 });
    }

    const audioBuffer = await res.arrayBuffer();
    return new Response(audioBuffer, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  }

  if (body.action === "realtime_token") {
    // For Realtime API, return the API key for ephemeral use
    // In production, use proper session tokens
    return NextResponse.json({
      token: apiKey,
      url: "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
