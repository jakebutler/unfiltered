/** Shared speech contracts; this file is safe to import in a browser. */
export const speechLimits = Object.freeze({
  captureMs: 60_000,
  audioBytes: 2_000_000,
  transcriptCharacters: 8_000,
  providerMessageBytes: 64_000,
  ttsCharacters: 1_200,
  ttsBytes: 600_000,
  providerTimeoutMs: 30_000,
});

export class SpeechError extends Error {
  constructor(public readonly code: 'invalid-request' | 'limit' | 'not-authorized' | 'unavailable' | 'timeout' | 'interrupted' | 'invalid-provider-response' | 'duplicate-attempt') {
    super(code); this.name = 'SpeechError';
  }
}

export interface SpeechTurnScope {
  sessionId: string;
  promptId: string;
  expectedRevision: number;
  /** Create once before capture, reuse for the same eventual application turn. */
  requestId: string;
}

export interface SpeechOutputRequest {
  requestId: string;
  sessionId: string;
  expectedRevision: number;
  /** Server resolves this to a current prompt or an authorized assistant source. */
  sourceId: string;
  /** Reference to a current offered choice, never caller-authored speech text. */
  choiceConfirmation?: { value: string };
}

export interface SpeechTranscript {
  text: string;
  provider: 'deepgram';
  model: 'nova-3';
  /** Recognition is always editable, never a clinical confidence assessment. */
  requiresReview: true;
}

export type SpeechInputEvent =
  | { type: 'ready'; sampleRate: 16000; channels: 1; maxCaptureMs: number }
  | { type: 'recognition'; segment: { start: number; duration: number; text: string; isFinal: boolean; speechFinal: boolean } }
  | { type: 'speech-started' }
  | { type: 'ended'; outcome: 'completed' | 'interrupted' | 'failed' | 'unknown' }
  | { type: 'error'; code: string; message: string };

export function validScope(scope: SpeechTurnScope): boolean {
  return Boolean(scope && typeof scope.sessionId === 'string' && scope.sessionId.length > 0 && scope.sessionId.length <= 100
    && typeof scope.promptId === 'string' && scope.promptId.length > 0 && scope.promptId.length <= 300
    && Number.isSafeInteger(scope.expectedRevision) && scope.expectedRevision >= 0
    && typeof scope.requestId === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(scope.requestId));
}
