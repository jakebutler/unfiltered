import { describe, expect, it, vi } from 'vitest';
import { VoiceConversation, type ConversationVoiceContext } from '../src/voice-conversation';
import { exactSpokenChoice } from '../src/choice-voice';
import type { ClinicSessionView, PromptView } from '../../../packages/clinic-contract/src/index';
const prompt: PromptView = { id: 'Q16:MH01', topicId: 'Q16', mode: 'guided', text: 'Over the last 2 weeks, how often have you been bothered by the following problems?\nFeeling nervous, anxious or on edge', choices: [{ value: '0', label: 'Not at all' }, { value: '1', label: 'Several days' }, { value: '2', label: 'More than half the days' }, { value: '3', label: 'Nearly every day' }] };
function harness() {
  let context: ConversationVoiceContext = { eligible: true, blocked: false, scope: { sessionId: 'session', expectedRevision: 3, promptId: prompt.id, requestId: 'option' }, choicePrompt: prompt, speech: { id: prompt.id, text: prompt.text } };
  let next = 0; const timers = new Map<number, () => void>();
  const clock = { after: (_ms: number, fn: () => void) => { timers.set(++next, fn); return next; }, clear: (id: unknown) => { timers.delete(id as number); } };
  const ports = { context: () => context, startCapture: vi.fn(), finishCapture: vi.fn(), stopCapture: vi.fn(), stopPlayback: vi.fn(), speak: vi.fn(), speakChoiceConfirmation: vi.fn(), changed: vi.fn(), abandonCapture: vi.fn(), restoreChoiceDraft: vi.fn(), prepareChoiceCapture: vi.fn(() => { context = { ...context, scope: { ...context.scope!, requestId: `capture-${++next}` } }; }), save: vi.fn(), interpret: vi.fn(), saveChoice: vi.fn(async () => ({ id: 'session', revision: 4, currentPrompt: { ...prompt, id: 'Q16:MH02' } } as ClinicSessionView)), saveChoiceAttempt: vi.fn(async () => ({ id: 'session', revision: 4 } as ClinicSessionView)) };
  const controller = new VoiceConversation(ports, clock);
  function utterance(text: string) {
    const scope = context.scope!; controller.event({ type: 'ready', scope });
    controller.event({ type: 'recognition', scope, segment: { text, start: 0, duration: 1, isFinal: true, speechFinal: true }, interim: '' });
    for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
    controller.event({ type: 'completed', scope, clean: true, text });
  }
  return { controller, ports, utterance, context: () => context, set: (patch: Partial<ConversationVoiceContext>) => { context = { ...context, ...patch }; } };
}
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
describe('exact presented choice voice confirmation', () => {
  it.each(['Fine', 'sometimes', 'all zeros', '0', 'I used to have depression', 'Several days but actually not at all', 'not several days'])('does not map %s to a score', text => { expect(exactSpokenChoice(prompt, text)).toBeUndefined(); });
  it('saves only after a separate exact confirmation, preserving both transcripts and skipping inference', async () => {
    const h = harness(); h.controller.start(); h.utterance('Several days.');
    expect(h.ports.saveChoice).not.toHaveBeenCalled(); expect(h.controller.state.choice?.label).toBe('Several days');
    h.controller.reconcile(); h.utterance('Yes.'); await flush();
    expect(h.ports.speakChoiceConfirmation).toHaveBeenCalledWith('1');
    expect(h.ports.saveChoice).toHaveBeenCalledExactlyOnceWith({ value: '1', label: 'Several days', optionTranscript: 'Several days.' }, expect.objectContaining({ promptId: 'Q16:MH01', requestId: 'option' }), { method: 'voice', transcript: 'Yes.' });
    expect(h.ports.save).not.toHaveBeenCalled(); expect(h.ports.interpret).not.toHaveBeenCalled();
  });
  it('cannot save from no confirmation, stopped voice or a different item/revision', async () => {
    for (const mode of ['stop', 'item', 'revision', 'ineligible']) {
      const h = harness(); h.controller.start(); h.utterance('Not at all'); h.controller.reconcile();
      if (mode === 'stop') h.controller.stop();
      else if (mode === 'ineligible') h.set({ eligible: false });
      else h.set({ scope: { ...h.context().scope!, ...(mode === 'item' ? { promptId: 'Q16:MH02' } : { expectedRevision: 4 }) } });
      await h.controller.confirmChoice('control'); expect(h.ports.saveChoice).not.toHaveBeenCalled();
    }
  });
  it('retry and text switch do not write the previous choice', () => {
    const h = harness(); h.controller.start(); h.utterance('Several days'); h.controller.reconcile(); h.utterance('Retry');
    h.controller.reconcile(); expect(h.ports.saveChoice).not.toHaveBeenCalled(); expect(h.controller.state.choice).toBeUndefined();
    h.utterance('Not at all'); h.controller.reconcile(); h.utterance('Switch to text'); expect(h.controller.state.active).toBe(false); expect(h.ports.saveChoice).not.toHaveBeenCalled(); expect(h.ports.restoreChoiceDraft).toHaveBeenCalled();
  });
  it('retains narrative and crisis confirmation words without scoring', async () => {
    const h = harness(); h.controller.start(); h.utterance('Not at all'); h.controller.reconcile(); h.utterance('I may hurt myself tonight.'); await flush();
    expect(h.ports.saveChoiceAttempt).toHaveBeenCalledExactlyOnceWith('I may hurt myself tonight.', expect.objectContaining({ promptId: prompt.id }), 'Not at all'); expect(h.ports.saveChoice).not.toHaveBeenCalled();
    const vague = harness(); vague.controller.start(); vague.utterance('Fine'); await flush(); expect(vague.ports.saveChoiceAttempt).toHaveBeenCalledWith('Fine', expect.any(Object), undefined); expect(vague.ports.saveChoice).not.toHaveBeenCalled();
  });
  it.each(['I may hurt myself tonight.', 'No', 'Yes'])('control confirmation drains already-heard %s rather than discarding it', async words => {
    const h = harness(); h.controller.start(); h.utterance('Not at all'); h.controller.reconcile();
    const scope = h.context().scope!; h.controller.event({ type: 'ready', scope });
    h.controller.event({ type: 'recognition', scope, segment: { text: words, start: 0, duration: 1, isFinal: false, speechFinal: false }, interim: words });
    await h.controller.confirmChoice('control');
    expect(h.ports.saveChoice).not.toHaveBeenCalled(); expect(h.ports.abandonCapture).not.toHaveBeenCalled(); expect(h.ports.finishCapture).toHaveBeenCalled();
    h.controller.event({ type: 'completed', scope, clean: true, text: words }); await flush();
    if (words === 'Yes') expect(h.ports.saveChoice).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), { method: 'voice', transcript: 'Yes' });
    else if (words === 'No') { expect(h.ports.saveChoice).not.toHaveBeenCalled(); expect(h.controller.state.choice).toBeUndefined(); }
    else { expect(h.ports.saveChoice).not.toHaveBeenCalled(); expect(h.ports.saveChoiceAttempt).toHaveBeenCalledWith(words, scope, 'Not at all'); }
  });
  it('the completed option utterance does not block immediate no-utterance control confirmation', async () => {
    const h = harness(); h.controller.start(); h.utterance('Several days');
    await h.controller.confirmChoice('control'); expect(h.ports.saveChoice).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), { method: 'control', transcript: '' });
  });
  it('control confirmation without any heard utterance can still save the visible choice', async () => {
    const h = harness(); h.controller.start(); h.utterance('Several days'); h.controller.reconcile(); h.controller.event({ type: 'ready', scope: h.context().scope! });
    await h.controller.confirmChoice('control'); expect(h.ports.saveChoice).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), { method: 'control', transcript: '' });
  });
  it('duplicate confirmation controls and a late save acknowledgement cannot repeat or resume', async () => {
    const h = harness(); let resolve!: (v: ClinicSessionView) => void; h.ports.saveChoice.mockImplementation(() => new Promise(done => { resolve = done; }));
    h.controller.start(); h.utterance('Not at all'); h.controller.reconcile(); void h.controller.confirmChoice('control'); void h.controller.confirmChoice('control');
    h.controller.stop(); resolve({ id: 'session', revision: 4 } as ClinicSessionView); await flush(); expect(h.ports.saveChoice).toHaveBeenCalledOnce(); expect(h.controller.state.active).toBe(false);
  });
});
