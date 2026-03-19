import type { VoiceProvider, VoiceEvent, SessionConfig, SessionResult, ProviderType } from "./types";
import { DEFAULT_COST_RATES } from "./types";
import type { VoiceStyleProfile } from "@/lib/elevenlabs";

/**
 * ElevenLabs TTS provider.
 * Wraps the existing /api/tts route to provide TTS through the provider abstraction.
 * Used as the TTS component when combined with a separate STT provider.
 */
export class ElevenLabsProvider implements VoiceProvider {
  readonly type: ProviderType = "elevenlabs";
  private styleProfile: VoiceStyleProfile = "default";

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- config comes from env vars via API route
  constructor(_config: Record<string, unknown>) {
    // Config comes from env vars via the API route; no client-side keys needed
  }

  async connect(sessionConfig: SessionConfig): Promise<void> {
    this.styleProfile = (sessionConfig.metadata?.styleProfile as VoiceStyleProfile) ?? "default";
  }

  async sendAudio(): Promise<void> {
    // ElevenLabs is TTS-only, no audio input
  }

  async *receiveResponse(): AsyncGenerator<VoiceEvent> {
    // No-op: responses are generated via synthesize()
  }

  async sendText(text: string): Promise<void> {
    // Synthesize speech from text using the existing /api/tts route
    const response = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, profile: this.styleProfile }),
    });

    if (!response.ok) {
      throw new Error(`ElevenLabs TTS failed: ${response.status}`);
    }
  }

  async disconnect(): Promise<void> {
    // No persistent connection
  }

  calculateCost(result: SessionResult): number {
    const totalChars = result.turns.reduce((sum, t) => sum + t.responseText.length, 0);
    return totalChars * DEFAULT_COST_RATES.elevenlabs.perCharacter;
  }

  validateConfig(): string[] {
    return [];
  }
}
