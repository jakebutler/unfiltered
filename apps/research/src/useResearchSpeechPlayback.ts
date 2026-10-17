import { useCallback, useEffect, useRef, useState } from 'react';
import { SpeechPlayback, type SpeechOutputRequest } from '../../../packages/speech/src/index';
import { SpeechAudioStream, browserSpeechAudioEnvironment } from '../../../packages/speech/src/browser-audio';

export function useResearchSpeechPlayback(scopeKey: string, token: string) {
  const guard = useRef(new SpeechPlayback());
  const displayedScope = useRef(scopeKey); displayedScope.current = scopeKey;
  const clip = useRef<{ audio: HTMLAudioElement; stream?: SpeechAudioStream; ticket: ReturnType<SpeechPlayback['begin']> } | undefined>(undefined);
  const [status, setStatus] = useState<'idle' | 'loading' | 'playing' | 'blocked' | 'finished' | 'error'>('idle');
  const [mode, setMode] = useState<'streaming' | 'buffered'>('buffered');
  const [message, setMessage] = useState('');
  const [slow, setSlow] = useState(false);
  const stop = useCallback(() => { guard.current.interrupt(); clip.current = undefined; setStatus('idle'); setMessage(''); setSlow(false); }, []);
  useEffect(() => { stop(); return () => { guard.current.interrupt(); clip.current = undefined; }; }, [scopeKey, stop]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', stop);
    return () => { document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', stop); };
  }, [stop]);
  const playPrepared = useCallback(async () => {
    const current = clip.current;
    if (!current || !current.ticket.isCurrent()) return;
    try {
      if (current.audio.ended) current.audio.currentTime = 0;
      await current.audio.play();
      if (!current.ticket.isCurrent()) { current.audio.pause(); return; }
      setStatus('playing'); setMessage('');
    } catch {
      if (!current.ticket.isCurrent()) return;
      setStatus('blocked'); setMessage('The audio is ready. Press Play audio to let your browser play it.');
    }
  }, []);
  const start = useCallback(async (input: SpeechOutputRequest, options?: { buffered?: boolean }) => {
    const begun = guard.current.begin(), scope = displayedScope.current;
    const ticket = { ...begun, isCurrent: () => begun.isCurrent() && scope === displayedScope.current }, audio = new Audio();
    const current: { audio: HTMLAudioElement; stream?: SpeechAudioStream; ticket: typeof ticket } = { audio, ticket }; clip.current = current;
    // Synchronous pause/detach is attached before constructing the media source or awaiting fetch/play.
    ticket.attach(() => {
      audio.pause(); audio.onended = null; audio.onerror = null; audio.onwaiting = null; audio.onplaying = null;
      current.stream?.dispose(); audio.removeAttribute('src'); audio.load();
    });
    const failed = (error: Error) => {
      if (!ticket.isCurrent()) return;
      guard.current.interrupt(); clip.current = undefined; setSlow(false); setStatus('error');
      setMessage(error.message === 'audio-timeout' ? 'Audio took too long to prepare. You can read the same words on screen.' : 'Audio could not continue. You can read the same words on screen or continue typing.');
    };
    audio.onended = () => { if (ticket.isCurrent()) { setStatus('finished'); setMessage('Audio finished.'); } };
    audio.onerror = () => failed(new Error('audio-playback-failed'));
    audio.onwaiting = () => { if (ticket.isCurrent() && !audio.paused) { setStatus('loading'); setMessage('Waiting for the next part of the audio…'); } };
    audio.onplaying = () => { if (ticket.isCurrent()) { setStatus('playing'); setMessage(''); setSlow(false); } };
    setStatus('loading'); setMessage('Preparing the audio…'); setSlow(false);
    const slowTimer = window.setTimeout(() => { if (ticket.isCurrent()) setSlow(true); }, 8000);
    try {
      current.stream = new SpeechAudioStream({ audio, signal: ticket.signal, isCurrent: ticket.isCurrent, onPlayable: () => { void playPrepared(); }, onFailure: failed, ...(options?.buffered ? { environment: { ...browserSpeechAudioEnvironment(), createMediaSource: undefined } } : {}) });
      setMode(current.stream.mode);
      const response = await fetch('/api/research/speech/output', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: ticket.signal, headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg', 'X-Research-Participant': token }, body: JSON.stringify(input) });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('audio/mpeg') || !response.body) throw new Error('audio-unavailable');
      await current.stream.consume(response.body);
    } catch (error) { failed(error instanceof Error ? error : new Error('audio-unavailable')); }
    finally { window.clearTimeout(slowTimer); if (ticket.isCurrent()) setSlow(false); }
  }, [playPrepared, token]);
  return { status, mode, message, slow, start, stop, playPrepared };
}
