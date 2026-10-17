import { useEffect, useRef, useState } from 'react';
import { VoiceConversation, type ConversationVoicePorts, type ConversationVoiceState } from './voice-conversation';

export function useVoiceConversation(ports: Omit<ConversationVoicePorts, 'changed'>) {
  const latest = useRef(ports); latest.current = ports;
  const [state, setState] = useState<ConversationVoiceState>({ active: false, status: 'off', message: '' });
  const controller = useRef<VoiceConversation | undefined>(undefined);
  if (!controller.current) controller.current = new VoiceConversation({
    context: () => latest.current.context(), startCapture: () => latest.current.startCapture(), finishCapture: () => latest.current.finishCapture(),
    stopCapture: (reason, preserve) => latest.current.stopCapture(reason, preserve), stopPlayback: () => latest.current.stopPlayback(), speak: id => latest.current.speak(id),
    save: (text, scope) => latest.current.save(text, scope), interpret: operation => latest.current.interpret(operation), changed: setState,
    prepareChoiceCapture: () => latest.current.prepareChoiceCapture?.(), abandonCapture: () => latest.current.abandonCapture?.(),
    speakChoiceConfirmation: value => latest.current.speakChoiceConfirmation?.(value),
    saveChoice: (candidate, scope, confirmation) => latest.current.saveChoice?.(candidate, scope, confirmation) ?? Promise.resolve(undefined),
    restoreChoiceDraft: candidate => latest.current.restoreChoiceDraft?.(candidate),
    restoreDraft: text => latest.current.restoreDraft?.(text),
    saveChoiceAttempt: (text, scope, prior) => latest.current.saveChoiceAttempt?.(text, scope, prior) ?? Promise.resolve(undefined),
  });
  useEffect(() => {
    const hidden = () => { if (document.hidden) controller.current!.stop('Voice paused when this page was hidden. Your draft is still here.'); };
    document.addEventListener('visibilitychange', hidden);
    return () => { document.removeEventListener('visibilitychange', hidden); controller.current!.dispose(); };
  }, []);
  return { ...state, controller: controller.current };
}
