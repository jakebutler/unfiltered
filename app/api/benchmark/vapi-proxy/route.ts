import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const apiKey = process.env.VAPI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "VAPI_API_KEY not set" }, { status: 500 });
  }

  let body: { action: string; systemPrompt?: string; voiceId?: string; callId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.action === "create_call") {
    const res = await fetch("https://api.vapi.ai/call/web", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        assistant: {
          model: { provider: "openai", model: "gpt-4", messages: [{ role: "system", content: body.systemPrompt ?? "" }] },
          voice: body.voiceId ?? "alloy",
        },
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      return NextResponse.json({ error: "Vapi call creation failed", detail }, { status: 502 });
    }

    const data = await res.json();
    return NextResponse.json({ callId: data.id, webCallUrl: data.webCallUrl });
  }

  if (body.action === "end_call" && body.callId) {
    await fetch(`https://api.vapi.ai/call/${body.callId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    }).catch(() => {});
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
