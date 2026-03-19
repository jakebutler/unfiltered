import type { VoiceProvider, VoiceEvent, SessionConfig, SessionResult, ProviderType } from "./types";
import { DEFAULT_COST_RATES } from "./types";

/**
 * OpenAI modular pipeline: Whisper (STT) -> GPT-4 (LLM) -> TTS (TTS).
 * Higher latency but full control over each component.
 * Calls go through /api/benchmark/openai-proxy to avoid exposing keys.
 */
export class OpenAIWhisperTTSProvider implements VoiceProvider {
  readonly type: ProviderType = "openai_whisper_tts";
  private messages: Array<{ role: string; content: string }> = [];
  private pendingTranscription = "";
  private pendingTranscriptionTimestamp = 0;

  constructor(_config: Record<string, unknown>) {}

  async connect(sessionConfig: SessionConfig): Promise<void> {
    this.messages = [{ role: "system", content: sessionConfig.systemPrompt }];
  }

  async sendAudio(data: ArrayBuffer, timestampMs: number): Promise<void> {
    const blob = new Blob([data], { type: "audio/webm" });
    const formData = new FormData();
    formData.append("file", blob, "audio.webm");
    formData.append("action", "transcribe");

    const response = await fetch("/api/benchmark/openai-proxy", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) throw new Error(`Whisper transcription failed: ${response.status}`);
    const { text } = await response.json();

    this.pendingTranscription = text;
    this.pendingTranscriptionTimestamp = Date.now();
    this.messages.push({ role: "user", content: text });
  }

  async *receiveResponse(): AsyncGenerator<VoiceEvent> {
    if (this.pendingTranscription) {
      yield {
        type: "transcript",
        content: this.pendingTranscription,
        timestampMs: this.pendingTranscriptionTimestamp,
      };
    }

    // Get LLM response
    const chatResponse = await fetch("/api/benchmark/openai-proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "chat", messages: this.messages }),
    });

    if (!chatResponse.ok) throw new Error(`GPT-4 chat failed: ${chatResponse.status}`);
    const { text: responseText, firstTokenTimestamp } = await chatResponse.json();

    if (firstTokenTimestamp) {
      yield { type: "first_token", content: "", timestampMs: firstTokenTimestamp };
    }

    yield { type: "text", content: responseText, timestampMs: Date.now() };
    this.messages.push({ role: "assistant", content: responseText });

    // Get TTS audio
    const ttsResponse = await fetch("/api/benchmark/openai-proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "tts", text: responseText }),
    });

    if (ttsResponse.ok) {
      const audioBuffer = await ttsResponse.arrayBuffer();
      yield { type: "audio", content: audioBuffer, timestampMs: Date.now() };
    }

    yield { type: "response_complete", content: "", timestampMs: Date.now() };
  }

  async sendText(text: string): Promise<void> {
    this.messages.push({ role: "user", content: text });
  }

  async disconnect(): Promise<void> {
    this.messages = [];
  }

  calculateCost(result: SessionResult): number {
    const rates = DEFAULT_COST_RATES.openai;
    const whisperCost = (result.audioDurationSeconds / 60) * rates.whisperPerMinute;
    const gptCost =
      (result.inputTokens / 1000) * rates.gpt4Per1kTokensInput +
      (result.outputTokens / 1000) * rates.gpt4Per1kTokensOutput;
    const totalChars = result.turns.reduce((sum, t) => sum + t.responseText.length, 0);
    const ttsCost = (totalChars / 1000) * rates.ttsPer1kCharacters;
    return whisperCost + gptCost + ttsCost;
  }

  validateConfig(): string[] {
    return [];
  }
}
