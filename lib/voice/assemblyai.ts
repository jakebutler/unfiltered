import type { VoiceProvider, VoiceEvent, SessionConfig, SessionResult, ProviderType } from "./types";
import { DEFAULT_COST_RATES } from "./types";

/**
 * AssemblyAI Universal-Streaming provider for STT.
 * Connects through /api/benchmark/assemblyai-token for session tokens.
 * Response generation requires pairing with an LLM (handled by the benchmark runner).
 */
export class AssemblyAIProvider implements VoiceProvider {
  readonly type: ProviderType = "assemblyai";
  private ws: WebSocket | null = null;
  private messageQueue: VoiceEvent[] = [];
  private messageResolve: (() => void) | null = null;
  private done = false;

  constructor(_config: Record<string, unknown>) {}

  async connect(sessionConfig: SessionConfig): Promise<void> {
    const tokenRes = await fetch("/api/benchmark/assemblyai-token");
    if (!tokenRes.ok) throw new Error("Failed to get AssemblyAI session token");
    const { token } = await tokenRes.json();

    const sampleRate = sessionConfig.sampleRate ?? 16000;
    const ws = new WebSocket(`wss://api.assemblyai.com/v2/realtime/ws?sample_rate=${sampleRate}&token=${token}`);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const onMessage = (event: MessageEvent) => {
        const data = JSON.parse(event.data);
        if (data.message_type === "SessionBegins") {
          ws.removeEventListener("message", onMessage);
          resolve();
        }
      };
      ws.addEventListener("message", onMessage);
      ws.onerror = () => reject(new Error("AssemblyAI WebSocket error"));
      ws.onopen = () => {
        // Connection opened, waiting for SessionBegins
      };
    });

    this.setupMessageHandler();
  }

  private setupMessageHandler(): void {
    if (!this.ws) return;

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      const now = Date.now();

      switch (data.message_type) {
        case "PartialTranscript":
          if (data.text) {
            this.enqueue({
              type: "partial_transcript",
              content: data.text,
              timestampMs: now,
              partial: true,
            });
          }
          break;
        case "FinalTranscript":
          if (data.text) {
            this.enqueue({
              type: "transcript",
              content: data.text,
              timestampMs: now,
            });
          }
          break;
        case "SessionTerminated":
          this.enqueue({ type: "session_end", content: "", timestampMs: now });
          this.done = true;
          break;
      }

      this.messageResolve?.();
      this.messageResolve = null;
    };

    this.ws.onclose = () => {
      this.done = true;
      this.messageResolve?.();
    };
  }

  private enqueue(event: VoiceEvent): void {
    this.messageQueue.push(event);
  }

  async sendAudio(data: ArrayBuffer): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const bytes = new Uint8Array(data);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const b64 = btoa(binary);

    this.ws.send(JSON.stringify({ audio_data: b64 }));
  }

  async *receiveResponse(): AsyncGenerator<VoiceEvent> {
    while (!this.done) {
      if (this.messageQueue.length > 0) {
        yield this.messageQueue.shift()!;
      } else {
        await new Promise<void>((r) => { this.messageResolve = r; });
      }
    }
    while (this.messageQueue.length > 0) {
      yield this.messageQueue.shift()!;
    }
  }

  async sendText(): Promise<void> {
    // AssemblyAI is STT-only
  }

  async disconnect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ terminate_session: true }));
      this.ws.close();
    }
    this.ws = null;
    this.done = true;
  }

  calculateCost(result: SessionResult): number {
    const durationMinutes = (result.totalDurationMs ?? 0) / 60000;
    return durationMinutes * DEFAULT_COST_RATES.assemblyai.streamingPerMinute;
  }

  validateConfig(): string[] {
    return [];
  }
}
