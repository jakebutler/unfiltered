import { expect, test, vi } from 'vitest';
import { VoiceConversation, type ConversationVoiceContext } from '../src/voice-conversation';
import type { ClinicSessionView, PromptView } from '../../../packages/clinic-contract/src/index';

test('Confirm choice cannot discard already-recognized crisis words before confirmation drain', async () => {
  const prompt: PromptView = { id: 'W06:preferredDay', topicId: 'W06', mode: 'guided', text: 'Which day works for you?', choices: [{ value: 'Monday', label: 'Monday' }, { value: 'Tuesday', label: 'Tuesday' }] };
  let context: ConversationVoiceContext = { eligible: true, blocked: false, choicePrompt: prompt, scope: { sessionId: 'synthetic', promptId: prompt.id, expectedRevision: 3, requestId: 'original-option' } };
  let timerId = 0; const timers = new Map<number, () => void>();
  const ports = { context: () => context, startCapture: vi.fn(), finishCapture: vi.fn(), stopCapture: vi.fn(), stopPlayback: vi.fn(), speak: vi.fn(), speakChoiceConfirmation: vi.fn(), abandonCapture: vi.fn(), changed: vi.fn(), save: vi.fn(), interpret: vi.fn(),
    prepareChoiceCapture: vi.fn(() => { context = { ...context, scope: { ...context.scope!, requestId: 'distinct-confirmation' } }; }),
    saveChoice: vi.fn(async () => ({ id: 'synthetic', revision: 4 } as ClinicSessionView)),
    saveChoiceAttempt: vi.fn(async () => ({ id: 'synthetic', revision: 4 } as ClinicSessionView)),
  };
  const controller = new VoiceConversation(ports, { after: (_ms, fn) => { timers.set(++timerId, fn); return timerId; }, clear: id => { timers.delete(id as number); } });
  controller.start(); controller.event({ type: 'ready', scope: context.scope! });
  controller.event({ type: 'recognition', scope: context.scope!, segment: { start: 0, duration: 1, text: 'Monday', isFinal: true, speechFinal: true }, interim: '' });
  for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
  controller.event({ type: 'completed', scope: context.scope!, text: 'Monday', clean: true });
  controller.reconcile(); controller.event({ type: 'ready', scope: context.scope! });
  const crisis = 'I may hurt myself tonight.';
  controller.event({ type: 'recognition', scope: context.scope!, segment: { start: 0, duration: 2, text: crisis, isFinal: true, speechFinal: true }, interim: '' });
  ports.finishCapture.mockClear();
  // Click while endpoint grace/drain has not completed.
  await controller.confirmChoice('control');
  expect(ports.saveChoice).not.toHaveBeenCalled(); expect(ports.abandonCapture).not.toHaveBeenCalled(); expect(ports.finishCapture).toHaveBeenCalledOnce();
  controller.event({ type: 'completed', scope: context.scope!, text: crisis, clean: true });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  expect(ports.saveChoiceAttempt).toHaveBeenCalledExactlyOnceWith(crisis, expect.objectContaining({ promptId: prompt.id, requestId: 'distinct-confirmation' }), 'Monday');
  expect(ports.saveChoice).not.toHaveBeenCalled(); expect(ports.save).not.toHaveBeenCalled(); expect(ports.interpret).not.toHaveBeenCalled();
});
