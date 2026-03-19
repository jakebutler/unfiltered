export type ProviderType =
  | "speechmatics"
  | "elevenlabs"
  | "openai_whisper_tts"
  | "openai_realtime"
  | "assemblyai"
  | "vapi";

export type VoiceEventType =
  | "transcript"
  | "partial_transcript"
  | "text"
  | "first_token"
  | "audio"
  | "response_complete"
  | "session_start"
  | "session_end"
  | "error";

export interface VoiceEvent {
  type: VoiceEventType;
  content: string | ArrayBuffer;
  timestampMs: number;
  partial?: boolean;
}

export interface SessionConfig {
  scenarioName: string;
  provider: ProviderType;
  systemPrompt: string;
  voiceId?: string;
  language?: string;
  sampleRate?: number;
  noiseLevel?: number | null;
  metadata?: Record<string, unknown>;
}

export interface TurnMetrics {
  turnIndex: number;
  role: "user" | "interviewer";
  audioSentAt?: number;
  transcriptionReceivedAt?: number;
  llmResponseAt?: number;
  audioReceivedAt?: number;
  transcriptionText: string;
  responseText: string;
  referenceText: string;
  transcriptionLatencyMs?: number;
  ttftMs?: number;
  totalResponseLatencyMs?: number;
  wer?: number;
}

export interface SessionResult {
  sessionId: string;
  config: SessionConfig;
  provider: ProviderType;
  startedAt: number;
  endedAt?: number;
  turns: TurnMetrics[];
  totalDurationMs?: number;
  avgTtftMs?: number;
  avgTranscriptionLatencyMs?: number;
  avgTotalLatencyMs?: number;
  overallWer?: number;
  inputTokens: number;
  outputTokens: number;
  audioDurationSeconds: number;
  estimatedCostUsd: number;
  errors: Array<{ type: string; message: string; timestamp: string }>;
  success: boolean;
}

export interface VoiceProvider {
  readonly type: ProviderType;
  connect(config: SessionConfig): Promise<void>;
  sendAudio(data: ArrayBuffer, timestampMs: number): Promise<void>;
  receiveResponse(): AsyncGenerator<VoiceEvent>;
  sendText(text: string): Promise<void>;
  disconnect(): Promise<void>;
  calculateCost(result: SessionResult): number;
  validateConfig(): string[];
}

export interface CostRates {
  vapi: { perMinute: number };
  openai: {
    whisperPerMinute: number;
    gpt4Per1kTokensInput: number;
    gpt4Per1kTokensOutput: number;
    ttsPer1kCharacters: number;
    realtimePerMinute: number;
  };
  assemblyai: { streamingPerMinute: number };
  speechmatics: { realtimePerMinute: number };
  elevenlabs: { perCharacter: number };
}

export const DEFAULT_COST_RATES: CostRates = {
  vapi: { perMinute: 0.05 },
  openai: {
    whisperPerMinute: 0.036,
    gpt4Per1kTokensInput: 0.03,
    gpt4Per1kTokensOutput: 0.06,
    ttsPer1kCharacters: 0.015,
    realtimePerMinute: 0.06,
  },
  assemblyai: { streamingPerMinute: 0.00375 },
  speechmatics: { realtimePerMinute: 0.004 },
  elevenlabs: { perCharacter: 0.00003 },
};
