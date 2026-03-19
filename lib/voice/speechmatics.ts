import type { VoiceProvider, VoiceEvent, SessionConfig, SessionResult, ProviderType } from "./types";
import { DEFAULT_COST_RATES } from "./types";

interface SpeechmaticsConfig {
  apiKey?: string;
  language?: string;
  enablePartials?: boolean;
  maxDelay?: number;
  sampleRate?: number;
}

export class SpeechmaticsProvider implements VoiceProvider {
  readonly type: ProviderType = "speechmatics";
  private config: SpeechmaticsConfig;
  private ws: WebSocket | null = null;

  constructor(config: Record<string, unknown>) {
    this.config = {
      apiKey: config.apiKey as string | undefined,
      language: (config.language as string) ?? "en",
      enablePartials: (config.enablePartials as boolean) ?? false,
      maxDelay: (config.maxDelay as number) ?? 2.0,
      sampleRate: (config.sampleRate as number) ?? 44100,
    };
  }

  async connect(sessionConfig: SessionConfig): Promise<void> {
    const tokenRes = await fetch("/api/speechmatics-token");
    if (!tokenRes.ok) throw new Error("Failed to get Speechmatics token");
    const { keyValue } = await tokenRes.json();

    const ws = new WebSocket(`wss://eu2.rt.speechmatics.com/v2?jwt=${keyValue}`);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({
          message: "StartRecognition",
          transcription_config: {
            language: sessionConfig.language ?? this.config.language,
            operating_point: "enhanced",
            enable_partials: this.config.enablePartials,
            max_delay: this.config.maxDelay,
          },
          audio_format: {
            type: "raw",
            encoding: "pcm_s16le",
            sample_rate: sessionConfig.sampleRate ?? this.config.sampleRate,
          },
        }));
      };

      const onMessage = (event: MessageEvent) => {
        const msg = JSON.parse(event.data);
        if (msg.message === "RecognitionStarted") {
          ws.removeEventListener("message", onMessage);
          resolve();
        }
      };
      ws.addEventListener("message", onMessage);
      ws.onerror = () => reject(new Error("Speechmatics WebSocket error"));
    });
  }

  async sendAudio(data: ArrayBuffer): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  async *receiveResponse(): AsyncGenerator<VoiceEvent> {
    if (!this.ws) return;

    const messages: VoiceEvent[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      const now = Date.now();

      if (msg.message === "AddTranscript" && msg.results?.length > 0) {
        const words = msg.results
          .map((r: { alternatives?: { content?: string }[] }) => r.alternatives?.[0]?.content ?? "")
          .filter(Boolean);
        messages.push({
          type: "transcript",
          content: words.join(" "),
          timestampMs: now,
        });
      } else if (msg.message === "AddPartialTranscript" && msg.results?.length > 0) {
        const words = msg.results
          .map((r: { alternatives?: { content?: string }[] }) => r.alternatives?.[0]?.content ?? "")
          .filter(Boolean);
        messages.push({
          type: "partial_transcript",
          content: words.join(" "),
          timestampMs: now,
          partial: true,
        });
      } else if (msg.message === "EndOfTranscript") {
        messages.push({ type: "session_end", content: "", timestampMs: now });
        done = true;
      } else if (msg.message === "Error") {
        messages.push({ type: "error", content: msg.reason ?? "Unknown error", timestampMs: now });
      }

      if (resolve) {
        resolve();
        resolve = null;
      }
    };

    while (!done) {
      if (messages.length > 0) {
        yield messages.shift()!;
      } else {
        await new Promise<void>((r) => { resolve = r; });
      }
    }

    while (messages.length > 0) {
      yield messages.shift()!;
    }
  }

  async sendText(): Promise<void> {
    // Speechmatics is transcription-only
  }

  async disconnect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ message: "EndOfStream", last_seq_no: 0 }));
      this.ws.close();
    }
    this.ws = null;
  }

  calculateCost(result: SessionResult): number {
    const durationMinutes = (result.totalDurationMs ?? 0) / 60000;
    return durationMinutes * DEFAULT_COST_RATES.speechmatics.realtimePerMinute;
  }

  validateConfig(): string[] {
    return [];
  }
}
