import { useId, useState } from 'react';
import { Mic, MicOff, Square, Volume2 } from 'lucide-react';
import { Button } from './components';
import type { useSpeechCapture } from './useSpeechCapture';
import type { useSpeechPlayback } from './useSpeechPlayback';
import type { useVoiceConversation } from './useVoiceConversation';

export function VoiceControls({ available, explanation, conversation, conversationAllowed, captureAllowed, disabled, capture, playback, onListen, onListenReply, questionTooLong, replyTooLong, exactChoices }: {
  available: boolean; explanation?: string; conversation: ReturnType<typeof useVoiceConversation>; conversationAllowed: boolean; captureAllowed: boolean; disabled: boolean;
  capture: ReturnType<typeof useSpeechCapture>; playback: ReturnType<typeof useSpeechPlayback>;
  onListen: () => void; onListenReply?: () => void; questionTooLong: boolean; replyTooLong: boolean; exactChoices?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false), [consent, setConsent] = useState(false);
  const playing = ['loading', 'playing', 'blocked', 'finished'].includes(playback.status);
  if (!available) return <div className="voice-state"><MicOff size={17} aria-hidden="true" /><span>{explanation || 'Voice is unavailable. You can continue by typing.'}</span></div>;
  return <section className="voice-controls" aria-label="Optional voice controls">
    <div className="voice-toolbar">
      <Button variant="text" aria-expanded={open} aria-controls={`${id}-capture`} onClick={() => { if (open) { conversation.controller.stop('Voice paused. Continue typing in the same draft.'); capture.stop(); } else playback.stop(); setOpen(!open); }}><Mic size={17} aria-hidden="true" />{open ? 'Use typing' : 'Use voice'}</Button>
      <Button variant="text" onClick={onListen} disabled={disabled || conversation.active || questionTooLong || playing}><Volume2 size={17} aria-hidden="true" />Listen to question</Button>
      {onListenReply && <Button variant="text" onClick={onListenReply} disabled={disabled || conversation.active || replyTooLong || playing}><Volume2 size={17} aria-hidden="true" />Listen to reply</Button>}
      {conversation.active && <Button onClick={() => conversation.controller.stop()}><MicOff size={17} aria-hidden="true" />Stop conversation</Button>}
      {playing && <Button onClick={playback.stop}><Square size={15} aria-hidden="true" />Stop audio</Button>}
    </div>
    {(questionTooLong || (onListenReply && replyTooLong)) && <p className="field-hint">Longer passages stay available to read on screen.</p>}
    <div className="voice-playback-status" role="status" aria-live="polite">
      {playback.message && <p>{playback.message}</p>}
      {playback.status === 'loading' && <p className="field-hint">{playback.mode === 'streaming' ? 'Playback can begin as the audio arrives.' : 'This browser plays the clip after it finishes downloading.'}{playback.slow && ' Still preparing; you can stop audio and keep typing.'}</p>}
    </div>
    {(playback.status === 'blocked' || playback.status === 'finished') && <Button onClick={() => void playback.playPrepared()}><Volume2 size={16} aria-hidden="true" />{playback.status === 'blocked' ? 'Play audio' : 'Play again'}</Button>}
    {conversation.status !== 'off' && <p className="conversation-voice-status" role="status">{conversation.message}</p>}
    {open && <div className="voice-capture-panel" id={`${id}-capture`}>
      {!captureAllowed ? <p>Use the answer choices or fields for this question. You can still listen to its wording.</p> : <>
        {exactChoices ? <p>Say one of the displayed answer choices exactly, then say Yes or Confirm to save that choice. Say Retry to choose again. Each choice needs its own confirmation.</p> : <p>In voice conversation, completed utterances are saved automatically as draft answers. Review the summary before sending anything to your care team. You can also dictate one answer and check it before saving.</p>}
        <label className="voice-consent"><input type="checkbox" checked={consent} disabled={capture.active || conversation.active} onChange={event => setConsent(event.target.checked)} /><span>I agree to send microphone audio to the transcription service. Corvo Clinic does not store the raw recording. I’ll use only the fictional patient details.</span></label>
        <div className="voice-capture-actions">
          {!conversation.active && !capture.active && conversationAllowed && <Button variant="primary" disabled={!consent || disabled} onClick={() => conversation.controller.start()}><Mic size={17} aria-hidden="true" />{conversation.status === 'off' ? 'Start voice conversation' : 'Resume voice conversation'}</Button>}
          {!exactChoices && !capture.active && !conversation.active && <Button disabled={!consent || disabled} onClick={() => { conversation.controller.stop('Dictation: check this answer before saving.'); void capture.start(); }}><Mic size={17} aria-hidden="true" />Dictate one answer</Button>}
          {!conversation.active && capture.status === 'listening' && <Button variant="primary" onClick={capture.finish}><Square size={15} aria-hidden="true" />Finish recording</Button>}
          {capture.active && !conversation.active && <Button onClick={() => capture.stop()}><MicOff size={17} aria-hidden="true" />{capture.status === 'finishing' ? 'Stop waiting' : 'Stop microphone'}</Button>}
        </div>
        <p className={`microphone-state ${capture.status === 'listening' ? 'is-listening' : ''}`} role="status">{capture.status === 'listening' ? 'Microphone on' : capture.status === 'permission' ? 'Waiting for microphone permission' : capture.status === 'connecting' ? 'Microphone connected · waiting for transcription' : 'Microphone off'}</p>
        <div className="voice-capture-status" role="status" aria-live="polite"><p>{!conversation.active && capture.message}</p>{capture.slow && <p>Still connecting. You can stop the microphone and keep typing.</p>}</div>
        {capture.interim && <div className="voice-interim"><span>Still being transcribed · not yet final</span><p>{capture.interim}</p></div>}
        <p className="field-hint">Each speaking turn lasts up to one minute. Check medical names, amounts, units and words such as “not”.</p>
      </>}
    </div>}
  </section>;
}

