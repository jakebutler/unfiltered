import { SpeechError, speechLimits, validScope, type SpeechTurnScope } from './contracts.js';

export interface RecognitionSegment {
  start: number;
  duration: number;
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
}

/** Parse only the single-channel Nova-3 contract. Never forward provider metadata/errors. */
export function parseDeepgramMessage(message: string): RecognitionSegment | 'speech-started' | undefined {
  if (new TextEncoder().encode(message).byteLength > speechLimits.providerMessageBytes) throw new SpeechError('limit');
  let item: unknown;
  try { item = JSON.parse(message); } catch { throw new SpeechError('invalid-provider-response'); }
  if (!item || typeof item !== 'object') throw new SpeechError('invalid-provider-response');
  const value = item as Record<string, unknown>;
  if (value.type === 'Error' || typeof value.err_code === 'string') throw new SpeechError('unavailable');
  if (value.type === 'SpeechStarted') return 'speech-started';
  if (value.type !== 'Results') return undefined;
  const channel = value.channel as { alternatives?: { transcript?: unknown }[] } | undefined;
  const text = channel?.alternatives?.[0]?.transcript;
  if (typeof text !== 'string' || text.length > speechLimits.transcriptCharacters
      || typeof value.start !== 'number' || !Number.isFinite(value.start) || value.start < 0
      || typeof value.duration !== 'number' || !Number.isFinite(value.duration) || value.duration < 0
      || typeof value.is_final !== 'boolean' || typeof value.speech_final !== 'boolean') throw new SpeechError('invalid-provider-response');
  return { start: value.start, duration: value.duration, text, isFinal: value.is_final, speechFinal: value.speech_final };
}

export interface VoiceDraft {
  scope: SpeechTurnScope;
  generation: number;
  phase: 'listening' | 'review' | 'saving' | 'save-unknown' | 'saved';
  text: string;
  interim: string;
  interimRange?: { start: number; duration: number };
  /** A provider pause is informational. It never sends an application turn. */
  speechEnded: boolean;
  segments: Record<string, RecognitionSegment>;
  prefix: string;
}

export type VoiceDraftEvent =
  | { type: 'recognition'; generation: number; segment: RecognitionSegment }
  | { type: 'finish' | 'interrupt' }
  | { type: 'resume' }
  | { type: 'edit'; text: string }
  | { type: 'send' }
  | { type: 'save-unknown' | 'save-failed' }
  | { type: 'saved'; requestId: string; sessionId: string };

export function createVoiceDraft(scope: SpeechTurnScope, prefix = ''): VoiceDraft {
  if (!validScope(scope) || prefix.length > speechLimits.transcriptCharacters) throw new SpeechError('invalid-request');
  return { scope: { ...scope }, generation: 1, phase: 'listening', text: prefix, prefix, interim: '', speechEnded: false, segments: {} };
}

const join = (...parts: string[]) => parts.filter(Boolean).join(' ').trim();

/** No network effects. The host sends only after a deliberate send event. */
export function reduceVoiceDraft(state: VoiceDraft, event: VoiceDraftEvent): VoiceDraft {
  if (event.type === 'saved') return event.requestId === state.scope.requestId && event.sessionId === state.scope.sessionId
    && ['saving', 'save-unknown'].includes(state.phase) ? { ...state, phase: 'saved' } : state;
  if (state.phase === 'saved') return state;
  if (event.type === 'save-unknown') return state.phase === 'saving' ? { ...state, phase: 'save-unknown' } : state;
  if (event.type === 'save-failed') return ['saving', 'save-unknown'].includes(state.phase) ? { ...state, phase: 'review' } : state;
  // Unknown delivery freezes the exact submitted payload until receipt reconciliation.
  if (state.phase === 'saving' || state.phase === 'save-unknown') return state;
  if (event.type === 'finish' || event.type === 'interrupt') {
    return { ...state, generation: state.generation + 1, phase: 'review', text: join(state.text, state.interim), interim: '', interimRange: undefined };
  }
  if (event.type === 'edit') {
    if (state.phase !== 'review') return state;
    if (event.text.length > speechLimits.transcriptCharacters) throw new SpeechError('limit');
    return { ...state, text: event.text, prefix: event.text, segments: {}, interim: '', interimRange: undefined };
  }
  if (event.type === 'resume') return state.phase !== 'review' ? state : {
    ...state, phase: 'listening', generation: state.generation + 1, prefix: state.text, segments: {}, interim: '', interimRange: undefined, speechEnded: false,
  };
  if (event.type === 'send') return state.phase === 'review' && state.text.trim() ? { ...state, phase: 'saving' } : state;
  if (event.type !== 'recognition' || state.phase !== 'listening' || event.generation !== state.generation) return state;
  const segment = event.segment;
  if (segment.text.length > speechLimits.transcriptCharacters || !Number.isFinite(segment.start) || segment.start < 0
      || !Number.isFinite(segment.duration) || segment.duration < 0) throw new SpeechError('invalid-provider-response');
  // Range keys make duplicate finals idempotent; sorting tolerates out-of-order final delivery.
  const key = `${segment.start}:${segment.duration}`;
  const segments = segment.isFinal ? { ...state.segments, [key]: segment } : state.segments;
  if (Object.keys(segments).length > 256) throw new SpeechError('limit');
  const text = join(state.prefix, ...Object.values(segments).sort((a, b) => a.start - b.start).map(value => value.text));
  // Ignore late provisional updates whose range is already final.
  const alreadyFinal = Object.values(segments).some(value => value.start <= segment.start && value.start + value.duration >= segment.start + segment.duration);
  const coversInterim = state.interimRange && segment.start <= state.interimRange.start
    && segment.start + segment.duration >= state.interimRange.start + state.interimRange.duration;
  const keepInterim = segment.isFinal ? !coversInterim : alreadyFinal;
  const interim = keepInterim ? state.interim : segment.isFinal ? '' : segment.text;
  const interimRange = keepInterim ? state.interimRange : segment.isFinal ? undefined : { start: segment.start, duration: segment.duration };
  if (join(text, interim).length > speechLimits.transcriptCharacters) throw new SpeechError('limit');
  return { ...state, text, interim, interimRange, segments, speechEnded: segment.isFinal && segment.speechFinal };
}

/** Use the same request ID and revision in the host application's normal text turn path. */
export function voiceTurnInput(state: VoiceDraft) {
  if (!['saving', 'save-unknown'].includes(state.phase)) throw new SpeechError('invalid-request');
  return { requestId: state.scope.requestId, expectedRevision: state.scope.expectedRevision,
    promptId: state.scope.promptId, action: 'answer' as const, text: state.text };
}
