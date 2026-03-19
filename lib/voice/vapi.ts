import type { VoiceProvider, VoiceEvent, SessionConfig, SessionResult, ProviderType } from "./types";
import { DEFAULT_COST_RATES } from "./types";

/**
 * Vapi full-stack voice AI provider.
 * Handles STT, LLM, and TTS in a unified platform.
 * Creates web calls through /api/benchmark/vapi-proxy.
 */
export class VapiProvider implements VoiceProvider {
  readonly type: ProviderType = "vapi";
  private ws: WebSocket | null = null;
  private callId: string | null = null;
  private messageQueue: VoiceEvent[] = [];
  private messageResolve: (() => void) | null = null;
  private done = false;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- config reserved for future provider-specific options
  constructor(_config: Record<string, unknown>) {}

  async connect(sessionConfig: SessionConfig): Promise<void> {
    // Create a web call via our API proxy
    const response = await fetch("/api/benchmark/vapi-proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create_call",
        systemPrompt: sessionConfig.systemPrompt,
        voiceId: sessionConfig.voiceId,
      }),
    });

    if (!response.ok) throw new Error(`Vapi call creation failed: ${response.status}`);
    const { callId, webCallUrl } = await response.json();
    this.callId = callId;

    if (webCallUrl) {
      const ws = new WebSocket(webCallUrl);
      this.ws = ws;

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("Vapi WebSocket error"));
      });

      this.setupMessageHandler();
    }
  }

  private setupMessageHandler(): void {
    if (!this.ws) return;

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      const now = Date.now();

      switch (data.type) {
        case "transcript":
          this.enqueue({
            type: data.partial ? "partial_transcript" : "transcript",
            content: data.transcript ?? "",
            timestampMs: now,
            partial: data.partial,
          });
          break;
        case "assistant-message":
          this.enqueue({
            type: "text",
            content: data.message ?? "",
            timestampMs: now,
          });
          break;
        case "audio": {
          const raw = atob(data.audio ?? "");
          const buf = new ArrayBuffer(raw.length);
          const view = new Uint8Array(buf);
          for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
          this.enqueue({ type: "audio", content: buf, timestampMs: now });
          break;
        }
        case "error":
          this.enqueue({
            type: "error",
            content: data.error ?? "Unknown Vapi error",
            timestampMs: now,
          });
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

    this.ws.send(JSON.stringify({
      type: "audio",
      audio: btoa(binary),
    }));
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

  async sendText(text: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "text", text }));
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.callId) {
      await fetch("/api/benchmark/vapi-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "end_call", callId: this.callId }),
      }).catch(() => {});
      this.callId = null;
    }
    this.done = true;
  }

  calculateCost(result: SessionResult): number {
    const durationMinutes = (result.totalDurationMs ?? 0) / 60000;
    return durationMinutes * DEFAULT_COST_RATES.vapi.perMinute;
  }

  validateConfig(): string[] {
    return [];
  }
}
