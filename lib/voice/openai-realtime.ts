import type { VoiceProvider, VoiceEvent, SessionConfig, SessionResult, ProviderType } from "./types";
import { DEFAULT_COST_RATES } from "./types";

/**
 * OpenAI Realtime API provider.
 * Single WebSocket connection handles STT, LLM, and TTS.
 * Connects through /api/benchmark/openai-proxy for ephemeral key exchange.
 */
export class OpenAIRealtimeProvider implements VoiceProvider {
  readonly type: ProviderType = "openai_realtime";
  private ws: WebSocket | null = null;
  private messageQueue: VoiceEvent[] = [];
  private messageResolve: (() => void) | null = null;
  private done = false;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- config reserved for future provider-specific options
  constructor(_config: Record<string, unknown>) {}

  async connect(sessionConfig: SessionConfig): Promise<void> {
    // Get ephemeral key from our API route
    const tokenRes = await fetch("/api/benchmark/openai-proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "realtime_token" }),
    });
    if (!tokenRes.ok) throw new Error("Failed to get OpenAI Realtime token");
    const { token, url } = await tokenRes.json();

    const ws = new WebSocket(url, [
      "realtime",
      `openai-insecure-api-key.${token}`,
      "openai-beta.realtime-v1",
    ]);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: "session.update",
          session: {
            modalities: ["text", "audio"],
            instructions: sessionConfig.systemPrompt,
            voice: sessionConfig.voiceId ?? "alloy",
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
          },
        }));
      };

      const onMessage = (event: MessageEvent) => {
        const data = JSON.parse(event.data);
        if (data.type === "session.created" || data.type === "session.updated") {
          ws.removeEventListener("message", onMessage);
          resolve();
        } else if (data.type === "error") {
          reject(new Error(data.error?.message ?? "Realtime session failed"));
        }
      };
      ws.addEventListener("message", onMessage);
      ws.onerror = () => reject(new Error("OpenAI Realtime WebSocket error"));
    });

    this.setupMessageHandler();
  }

  private setupMessageHandler(): void {
    if (!this.ws) return;

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      const now = Date.now();

      switch (data.type) {
        case "conversation.item.input_audio_transcription.completed":
          this.enqueue({ type: "transcript", content: data.transcript ?? "", timestampMs: now });
          break;
        case "response.text.delta":
          this.enqueue({ type: "text", content: data.delta ?? "", timestampMs: now, partial: true });
          break;
        case "response.audio.delta": {
          const raw = atob(data.delta ?? "");
          const buf = new ArrayBuffer(raw.length);
          const view = new Uint8Array(buf);
          for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
          this.enqueue({ type: "audio", content: buf, timestampMs: now });
          break;
        }
        case "response.done":
          this.enqueue({ type: "response_complete", content: "", timestampMs: now });
          break;
        case "error":
          this.enqueue({ type: "error", content: data.error?.message ?? "Unknown error", timestampMs: now });
          break;
      }
    };

    this.ws.onclose = () => {
      this.done = true;
      this.messageResolve?.();
    };
  }

  private enqueue(event: VoiceEvent): void {
    this.messageQueue.push(event);
    this.messageResolve?.();
    this.messageResolve = null;
  }

  async sendAudio(data: ArrayBuffer): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const bytes = new Uint8Array(data);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const b64 = btoa(binary);

    this.ws.send(JSON.stringify({
      type: "input_audio_buffer.append",
      audio: b64,
    }));
  }

  async *receiveResponse(): AsyncGenerator<VoiceEvent> {
    while (!this.done) {
      if (this.messageQueue.length > 0) {
        const event = this.messageQueue.shift()!;
        yield event;
        if (event.type === "response_complete") return;
      } else {
        await new Promise<void>((r) => { this.messageResolve = r; });
      }
    }
    while (this.messageQueue.length > 0) {
      yield this.messageQueue.shift()!;
    }
  }

  async sendText(text: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    }));
    this.ws.send(JSON.stringify({ type: "response.create" }));
  }

  async disconnect(): Promise<void> {
    this.done = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  calculateCost(result: SessionResult): number {
    const durationMinutes = (result.totalDurationMs ?? 0) / 60000;
    return durationMinutes * DEFAULT_COST_RATES.openai.realtimePerMinute;
  }

  validateConfig(): string[] {
    return [];
  }
}
