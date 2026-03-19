import { NextResponse } from "next/server";

export async function GET() {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ASSEMBLYAI_API_KEY not set" }, { status: 500 });
  }

  const res = await fetch("https://api.assemblyai.com/v2/realtime/token", {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expires_in: 3600 }),
  });

  if (!res.ok) {
    const detail = await res.text();
    return NextResponse.json({ error: "AssemblyAI token request failed", detail }, { status: 502 });
  }

  const data = await res.json();
  return NextResponse.json({ token: data.token });
}
