import { NextResponse } from "next/server";

export async function GET() {
  const apiKey = process.env.SPEECHMATICS_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "SPEECHMATICS_API_KEY not set" }, { status: 500 });

  const res = await fetch("https://mp.speechmatics.com/v1/api_keys?type=rt", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ttl: 3600 }),
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ error: "Speechmatics token request failed", detail: text }, { status: 502 });
  }

  const data = await res.json();
  return NextResponse.json({ keyValue: data.key_value });
}
