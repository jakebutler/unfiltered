import { describe, expect, it, vi } from 'vitest';
import { createVoiceDraft, reduceVoiceDraft, type RecognitionSegment } from '../../../packages/speech/src/index';
import { VoiceConversation, type ConversationVoiceContext } from '../src/voice-conversation';

const scope = { sessionId: 'synthetic-session', promptId: 'Q08:actualUse', expectedRevision: 4, requestId: 'one-answer' };

/** Feed the production transcript reducer before forwarding the exact event shape used by the capture hook. */
function harness() {
  let now = 0, id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const context: ConversationVoiceContext = { scope, eligible: true, blocked: false };
  const ports = {
    context: () => context, startCapture: vi.fn(), finishCapture: vi.fn(), stopCapture: vi.fn(), stopPlayback: vi.fn(), speak: vi.fn(),
    save: vi.fn(async () => undefined), interpret: vi.fn(async () => undefined), changed: vi.fn(),
  };
  const controller = new VoiceConversation(ports, {
    after(ms, fn) { timers.set(++id, { at: now + ms, fn }); return id; }, clear(timer) { timers.delete(timer as number); },
  });
  let draft = createVoiceDraft(scope);
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const timer = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!timer || timer[1].at > end) break;
      now = timer[1].at; timers.delete(timer[0]); timer[1].fn();
    }
    now = end;
  };
  const recognition = (segment: RecognitionSegment) => {
    draft = reduceVoiceDraft(draft, { type: 'recognition', generation: draft.generation, segment });
    controller.event({ type: 'recognition', scope, segment, interim: draft.interim });
  };
  controller.start(); controller.event({ type: 'ready', scope });
  return { controller, ports, recognition, advance, draft: () => draft };
}

describe('independent natural voice event ordering', () => {
  it('does not let a late provisional segment already covered by a final strand the completed answer', () => {
    const h = harness();
    h.recognition({ start: 0, duration: 2, text: 'I take five milligrams.', isFinal: true, speechFinal: true });
    h.advance(300);
    h.recognition({ start: 0, duration: 1, text: 'I take five', isFinal: false, speechFinal: false });
    expect(h.draft().text).toBe('I take five milligrams.');
    expect(h.draft().interim).toBe('');
    h.advance(1000);
    expect(h.ports.finishCapture).toHaveBeenCalledTimes(1);
    expect(h.ports.save).not.toHaveBeenCalled();
  });

  it('retains the later endpoint when an earlier final arrives out of order', () => {
    const h = harness();
    h.recognition({ start: 1, duration: 1, text: 'not fifty.', isFinal: true, speechFinal: true });
    h.advance(300);
    h.recognition({ start: 0, duration: 1, text: 'I take five milligrams,', isFinal: true, speechFinal: false });
    expect(h.draft().text).toBe('I take five milligrams, not fifty.');
    expect(h.draft().interim).toBe('');
    h.advance(1000);
    expect(h.ports.finishCapture).toHaveBeenCalledTimes(1);
    expect(h.ports.save).not.toHaveBeenCalled();
  });

  it('keeps newer unresolved provisional words unsent even after the earlier endpoint deadline', () => {
    const h = harness();
    h.recognition({ start: 0, duration: 1, text: 'I take five milligrams.', isFinal: true, speechFinal: true });
    h.advance(300);
    h.recognition({ start: 1, duration: 1, text: 'Actually not', isFinal: false, speechFinal: false });
    expect(h.draft().interim).toBe('Actually not');
    h.advance(1000);
    expect(h.ports.finishCapture).not.toHaveBeenCalled();
    expect(h.ports.save).not.toHaveBeenCalled();
  });

  it('does not save a clean-looking late drain after explicit Stop', () => {
    const h = harness();
    h.recognition({ start: 0, duration: 1, text: 'Five milligrams.', isFinal: true, speechFinal: true });
    h.advance(600);
    expect(h.ports.finishCapture).toHaveBeenCalledTimes(1);
    h.controller.stop('Use typing');
    h.controller.event({ type: 'completed', scope, text: h.draft().text, clean: true });
    expect(h.ports.save).not.toHaveBeenCalled();
    expect(h.ports.startCapture).toHaveBeenCalledTimes(1);
    expect(h.ports.stopCapture).toHaveBeenLastCalledWith('Use typing', false);
  });
});
