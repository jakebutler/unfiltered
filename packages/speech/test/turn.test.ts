import { describe, expect, it, vi } from 'vitest';
import { createVoiceDraft, parseDeepgramMessage, reduceVoiceDraft, voiceTurnInput, type RecognitionSegment } from '../src/turn.js';
import { SpeechPlayback } from '../src/playback.js';

const scope = { sessionId: 'session-a', promptId: 'prompt-1', requestId: 'request-1', expectedRevision: 3 };
const final = (text: string, start = 0, speechFinal = true): RecognitionSegment => ({ text, start, duration: 1, isFinal: true, speechFinal });
describe('voice draft lifecycle', () => {
  it('collects final segments and duplicate finals without sending on a pause', () => {
    let draft = createVoiceDraft(scope);
    draft = reduceVoiceDraft(draft, { type: 'recognition', generation: 1, segment: final('I do not', 0, false) });
    const last = { type: 'recognition' as const, generation: 1, segment: final('take that medicine.', 1) };
    draft = reduceVoiceDraft(reduceVoiceDraft(draft, last), last);
    expect(draft.text).toBe('I do not take that medicine.');
    expect(draft.phase).toBe('listening'); expect(draft.speechEnded).toBe(true);
    expect(() => voiceTurnInput(draft)).toThrow('invalid-request');
    draft = reduceVoiceDraft(draft, { type: 'finish' });
    draft = reduceVoiceDraft(draft, { type: 'send' });
    expect(voiceTurnInput(draft)).toEqual({ requestId: 'request-1', promptId: 'prompt-1', expectedRevision: 3, action: 'answer', text: draft.text });
  });
  it('preserves unsent provisional words on interruption and ignores old socket events', () => {
    let draft = reduceVoiceDraft(createVoiceDraft(scope), { type: 'recognition', generation: 1, segment: { ...final('about ten'), isFinal: false } });
    draft = reduceVoiceDraft(draft, { type: 'interrupt' });
    expect(draft.text).toBe('about ten');
    draft = reduceVoiceDraft(draft, { type: 'resume' });
    expect(reduceVoiceDraft(draft, { type: 'recognition', generation: 1, segment: final('obsolete') })).toBe(draft);
    draft = reduceVoiceDraft(draft, { type: 'recognition', generation: draft.generation, segment: final('years ago') });
    expect(draft.text).toBe('about ten years ago'); expect(draft.scope).toEqual(scope);
  });
  it('preserves current provisional words when an older finalized frame repeats', () => {
    let draft = createVoiceDraft(scope);
    const first = { type: 'recognition' as const, generation: 1, segment: final('No', 0, false) };
    draft = reduceVoiceDraft(draft, first);
    draft = reduceVoiceDraft(draft, { type: 'recognition', generation: 1, segment: { ...final('allergies', 1), isFinal: false } });
    draft = reduceVoiceDraft(draft, first);
    expect(draft.interim).toBe('allergies');
    draft = reduceVoiceDraft(draft, { type: 'recognition', generation: 1, segment: final('allergies', 1) });
    expect(draft.text).toBe('No allergies'); expect(draft.interim).toBe('');
  });
  it('freezes an ambiguous send and requires a matching session receipt', () => {
    let draft = createVoiceDraft(scope, 'I am not sure.');
    draft = reduceVoiceDraft(draft, { type: 'finish' });
    draft = reduceVoiceDraft(draft, { type: 'send' });
    draft = reduceVoiceDraft(draft, { type: 'save-unknown' });
    const original = voiceTurnInput(draft);
    for (const event of [{ type: 'edit', text: 'different' }, { type: 'resume' }, { type: 'send' }] as const) expect(reduceVoiceDraft(draft, event)).toBe(draft);
    expect(voiceTurnInput(draft)).toEqual(original);
    expect(reduceVoiceDraft(draft, { type: 'saved', sessionId: 'other', requestId: scope.requestId })).toBe(draft);
    draft = reduceVoiceDraft(draft, { type: 'saved', sessionId: scope.sessionId, requestId: scope.requestId });
    expect(draft.phase).toBe('saved'); expect(reduceVoiceDraft(draft, { type: 'resume' })).toBe(draft);
  });
  it('bounds transcript input and strips provider metadata', () => {
    const parsed = parseDeepgramMessage(JSON.stringify({ type: 'Results', start: 0, duration: 1, is_final: true, speech_final: false,
      channel: { alternatives: [{ transcript: 'two milligrams', confidence: 0.99 }] }, metadata: { secret: 'not-forwarded' } }));
    expect(parsed).toEqual(final('two milligrams', 0, false));
    expect(() => parseDeepgramMessage('x'.repeat(64001))).toThrow('limit');
    expect(() => parseDeepgramMessage('{bad')).toThrow('invalid-provider-response');
    expect(() => parseDeepgramMessage('{"type":"Error","description":"sensitive"}')).toThrow('unavailable');
  });
});

describe('speech playback generations', () => {
  it('immediately stops audio and aborts work on interruption, including late attachments', () => {
    const playback = new SpeechPlayback(); const first = playback.begin(); const stop = vi.fn();
    first.attach(stop); playback.interrupt();
    expect(stop).toHaveBeenCalledOnce(); expect(first.signal.aborted).toBe(true); expect(first.isCurrent()).toBe(false);
    const late = vi.fn(); expect(first.attach(late)).toBe(false); expect(late).toHaveBeenCalledOnce();
    const second = playback.begin(); first.complete();
    expect(second.isCurrent()).toBe(true); playback.interrupt();
  });
});
