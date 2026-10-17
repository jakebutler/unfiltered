import { describe, expect, it, vi } from 'vitest';
import { VoiceConversation, type ConversationVoiceContext } from '../src/voice-conversation';
import { exactSpokenChoice } from '../src/choice-voice';
import type { ClinicSessionView, PromptView } from '../../../packages/clinic-contract/src/index';
const prompt: PromptView = { id: 'W06:preferredDay', topicId: 'W06', mode: 'guided', text: 'Which day works for you?', choices: [{ value: 'Monday', label: 'Monday' }, { value: 'Tuesday', label: 'Tuesday' }, { value: 'Wednesday', label: 'Wednesday' }, { value: 'Thursday', label: 'Thursday' }] };
function harness() {
  let context: ConversationVoiceContext = { eligible: true, blocked: false, scope: { sessionId: 'session', expectedRevision: 3, promptId: prompt.id, requestId: 'option' }, choicePrompt: prompt, speech: { id: prompt.id, text: prompt.text } };
  let next = 0; const timers = new Map<number, () => void>();
  const clock = { after: (_ms: number, fn: () => void) => { timers.set(++next, fn); return next; }, clear: (id: unknown) => { timers.delete(id as number); } };
  const ports = { context: () => context, startCapture: vi.fn(), finishCapture: vi.fn(), stopCapture: vi.fn(), stopPlayback: vi.fn(), speak: vi.fn(), speakChoiceConfirmation: vi.fn(), changed: vi.fn(), abandonCapture: vi.fn(), restoreChoiceDraft: vi.fn(), prepareChoiceCapture: vi.fn(() => { context = { ...context, scope: { ...context.scope!, requestId: `capture-${++next}` } }; }), save: vi.fn(), interpret: vi.fn(), saveChoice: vi.fn(async () => ({ id: 'session', revision: 4, currentPrompt: { ...prompt, id: 'W06:preferredWindow' } } as ClinicSessionView)), saveChoiceAttempt: vi.fn(async () => ({ id: 'session', revision: 4 } as ClinicSessionView)) };
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
  it.each(['reconcile', 'completion', 'control'])('stops an active non-screening conversation when the next prompt becomes PHQ through %s', async path => {
    const h = harness(), phq = { ...prompt, id: 'Q16:MH01', topicId: 'Q16', choices: [{ label: 'Several days', value: '1' }] };
    h.ports.saveChoice.mockResolvedValue({ id: 'session', revision: 4, currentPrompt: phq } as ClinicSessionView);
    h.controller.start(); h.utterance('Tuesday'); h.controller.reconcile(); h.utterance('Yes'); await flush();
    const captures = h.ports.startCapture.mock.calls.length;
    h.set({ choicePrompt: phq, scope: { sessionId: 'session', expectedRevision: 4, promptId: phq.id, requestId: 'screening' } });
    if (path === 'reconcile') h.controller.reconcile();
    else if (path === 'completion') h.utterance('Several days');
    else await h.controller.confirmChoice('control');
    h.utterance('Several days'); h.utterance('Yes'); await h.controller.confirmChoice('control'); await flush();
    expect(h.controller.state.active).toBe(false); expect(h.controller.state.choice).toBeUndefined();
    expect(h.ports.startCapture).toHaveBeenCalledTimes(captures); expect(h.ports.saveChoice).toHaveBeenCalledOnce();
    expect(h.ports.save).not.toHaveBeenCalled(); expect(h.ports.interpret).not.toHaveBeenCalled();
  });
  it.each(['MH01', 'MH02', 'MH03', 'MH04'])('keeps %s buttons-only even when an erroneous caller marks voice eligible', async item => {
    const h = harness();
    h.set({ choicePrompt: { ...prompt, id: `Q16:${item}`, topicId: 'Q16' }, scope: { ...h.context().scope!, promptId: `Q16:${item}` } });
    h.controller.start(); h.utterance('Tuesday'); h.utterance('Yes'); await h.controller.confirmChoice('control'); await flush();
    expect(h.ports.startCapture).not.toHaveBeenCalled(); expect(h.ports.saveChoice).not.toHaveBeenCalled(); expect(h.ports.save).not.toHaveBeenCalled(); expect(h.ports.interpret).not.toHaveBeenCalled();
  });
  it.each(['Fine', 'sometimes', 'all zeros', '0', 'I used to have depression', 'Tuesday but actually not at all', 'not several days'])('does not map %s to a choice', text => { expect(exactSpokenChoice(prompt, text)).toBeUndefined(); });
  it('saves only after a separate exact confirmation, preserving both transcripts and skipping inference', async () => {
    const h = harness(); h.controller.start(); h.utterance('Tuesday.');
    expect(h.ports.saveChoice).not.toHaveBeenCalled(); expect(h.controller.state.choice?.label).toBe('Tuesday');
    h.controller.reconcile(); h.utterance('Yes.'); await flush();
    expect(h.ports.speakChoiceConfirmation).toHaveBeenCalledWith('Tuesday');
    expect(h.ports.saveChoice).toHaveBeenCalledExactlyOnceWith({ value: 'Tuesday', label: 'Tuesday', optionTranscript: 'Tuesday.' }, expect.objectContaining({ promptId: 'W06:preferredDay', requestId: 'option' }), { method: 'voice', transcript: 'Yes.' });
    expect(h.ports.save).not.toHaveBeenCalled(); expect(h.ports.interpret).not.toHaveBeenCalled();
  });
  it('cannot save from no confirmation, stopped voice or a different item/revision', async () => {
    for (const mode of ['stop', 'item', 'revision', 'ineligible']) {
      const h = harness(); h.controller.start(); h.utterance('Monday'); h.controller.reconcile();
      if (mode === 'stop') h.controller.stop();
      else if (mode === 'ineligible') h.set({ eligible: false });
      else h.set({ scope: { ...h.context().scope!, ...(mode === 'item' ? { promptId: 'W06:preferredWindow' } : { expectedRevision: 4 }) } });
      await h.controller.confirmChoice('control'); expect(h.ports.saveChoice).not.toHaveBeenCalled();
    }
  });
  it('retry and text switch do not write the previous choice', () => {
    const h = harness(); h.controller.start(); h.utterance('Tuesday'); h.controller.reconcile(); h.utterance('Retry');
    h.controller.reconcile(); expect(h.ports.saveChoice).not.toHaveBeenCalled(); expect(h.controller.state.choice).toBeUndefined();
    h.utterance('Monday'); h.controller.reconcile(); h.utterance('Switch to text'); expect(h.controller.state.active).toBe(false); expect(h.ports.saveChoice).not.toHaveBeenCalled(); expect(h.ports.restoreChoiceDraft).toHaveBeenCalled();
  });
  it('retains narrative and crisis confirmation words without scoring', async () => {
    const h = harness(); h.controller.start(); h.utterance('Monday'); h.controller.reconcile(); h.utterance('I may hurt myself tonight.'); await flush();
    expect(h.ports.saveChoiceAttempt).toHaveBeenCalledExactlyOnceWith('I may hurt myself tonight.', expect.objectContaining({ promptId: prompt.id }), 'Monday'); expect(h.ports.saveChoice).not.toHaveBeenCalled();
    const vague = harness(); vague.controller.start(); vague.utterance('Fine'); await flush(); expect(vague.ports.saveChoiceAttempt).toHaveBeenCalledWith('Fine', expect.any(Object), undefined); expect(vague.ports.saveChoice).not.toHaveBeenCalled();
  });
  it.each(['I may hurt myself tonight.', 'No', 'Yes'])('control confirmation drains already-heard %s rather than discarding it', async words => {
    const h = harness(); h.controller.start(); h.utterance('Monday'); h.controller.reconcile();
    const scope = h.context().scope!; h.controller.event({ type: 'ready', scope });
    h.controller.event({ type: 'recognition', scope, segment: { text: words, start: 0, duration: 1, isFinal: false, speechFinal: false }, interim: words });
    await h.controller.confirmChoice('control');
    expect(h.ports.saveChoice).not.toHaveBeenCalled(); expect(h.ports.abandonCapture).not.toHaveBeenCalled(); expect(h.ports.finishCapture).toHaveBeenCalled();
    h.controller.event({ type: 'completed', scope, clean: true, text: words }); await flush();
    if (words === 'Yes') expect(h.ports.saveChoice).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), { method: 'voice', transcript: 'Yes' });
    else if (words === 'No') { expect(h.ports.saveChoice).not.toHaveBeenCalled(); expect(h.controller.state.choice).toBeUndefined(); }
    else { expect(h.ports.saveChoice).not.toHaveBeenCalled(); expect(h.ports.saveChoiceAttempt).toHaveBeenCalledWith(words, scope, 'Monday'); }
  });
  it('the completed option utterance does not block immediate no-utterance control confirmation', async () => {
    const h = harness(); h.controller.start(); h.utterance('Tuesday');
    await h.controller.confirmChoice('control'); expect(h.ports.saveChoice).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), { method: 'control', transcript: '' });
  });
  it('control confirmation without any heard utterance can still save the visible choice', async () => {
    const h = harness(); h.controller.start(); h.utterance('Tuesday'); h.controller.reconcile(); h.controller.event({ type: 'ready', scope: h.context().scope! });
    await h.controller.confirmChoice('control'); expect(h.ports.saveChoice).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), { method: 'control', transcript: '' });
  });
  it('duplicate confirmation controls and a late save acknowledgement cannot repeat or resume', async () => {
    const h = harness(); let resolve!: (v: ClinicSessionView) => void; h.ports.saveChoice.mockImplementation(() => new Promise(done => { resolve = done; }));
    h.controller.start(); h.utterance('Monday'); h.controller.reconcile(); void h.controller.confirmChoice('control'); void h.controller.confirmChoice('control');
    h.controller.stop(); resolve({ id: 'session', revision: 4 } as ClinicSessionView); await flush(); expect(h.ports.saveChoice).toHaveBeenCalledOnce(); expect(h.controller.state.active).toBe(false);
  });
});
