import { AccessToken } from "livekit-server-sdk";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const { roomName, participantName, isAgent } = await request.json();

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;

    if (!apiKey || !apiSecret) {
      return NextResponse.json(
        { error: "LiveKit credentials not configured" },
        { status: 500 }
      );
    }

    const token = new AccessToken(apiKey, apiSecret, {
      identity: participantName,
      name: participantName,
    });

    token.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      // Agent participants get additional permissions
      ...(isAgent && {
        canUpdateOwnMetadata: true,
        hidden: false,
      }),
    });

    return NextResponse.json({
      token: token.toJwt(),
      identity: participantName,
    });
  } catch (error) {
    console.error("Failed to generate LiveKit token:", error);
    return NextResponse.json(
      { error: "Failed to generate token" },
      { status: 500 }
    );
  }
}
