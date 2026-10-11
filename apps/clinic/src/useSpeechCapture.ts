import { useCallback, useEffect, useRef, useState } from 'react';
import { createVoiceDraft, reduceVoiceDraft, type VoiceDraft, type RecognitionSegment, type SpeechInputEvent } from '../../../packages/speech/src/index';
import type { CaptureEvent } from './voice-conversation';
import { appendTranscript, CaptureEpoch, CaptureResources, captureWorkletUrl, LocalVoiceActivity, PcmTransport, voiceCaptureLimits, type CaptureScope } from './voice-capture';

type CaptureStatus = 'idle' | 'permission' | 'connecting' | 'listening' | 'finishing' | 'review' | 'interrupted' | 'unavailable';
/** Explicit source seam for the isolated development fixture; normal callers use microphone capture. */
export type CaptureMediaSource = (context: AudioContext) => Promise<{ stream: MediaStream; dispose?: () => void }>;
interface CaptureRun { token: number; scope: CaptureScope; prefix: string; draft: VoiceDraft; resources: CaptureResources; hardware: CaptureResources; transport?: PcmTransport; finishTimer?: number; captureTimer?: number; setupTimer?: number; flushTimer?: number; stopTracks?: () => void; flush?: () => void; finishCapture?: () => void; finishRequested?: boolean; conversation?: boolean; }
function recognition(value: unknown): RecognitionSegment {
  if (!value || typeof value !== 'object') throw new Error('invalid-transcript');
  const v = value as RecognitionSegment;
  if (typeof v.text !== 'string' || v.text.length > 8000 || !Number.isFinite(v.start) || v.start < 0 || !Number.isFinite(v.duration) || v.duration < 0 || typeof v.isFinal !== 'boolean' || typeof v.speechFinal !== 'boolean') throw new Error('invalid-transcript');
  return { text: v.text, start: v.start, duration: v.duration, isFinal: v.isFinal, speechFinal: v.speechFinal };
}

export function useSpeechCapture({ getScope, getText, onText, onInterruptPlayback, onEvent, scopeKey, mediaSource }: {
  getScope: () => CaptureScope | undefined; getText: () => string; onText: (text: string, hasTranscript: boolean, conversation?: boolean) => void; onInterruptPlayback: () => void; onEvent?: (event: CaptureEvent) => void; scopeKey: string; mediaSource?: CaptureMediaSource;
}) {
  const callbacks = useRef({ getScope, getText, onText, onInterruptPlayback, onEvent, mediaSource }); callbacks.current = { getScope, getText, onText, onInterruptPlayback, onEvent, mediaSource };
  const epoch = useRef(new CaptureEpoch()), run = useRef<CaptureRun | undefined>(undefined);
  const [status, setStatus] = useState<CaptureStatus>('idle');
  const [interim, setInterim] = useState('');
  const [message, setMessage] = useState('');
  const [slow, setSlow] = useState(false);
  const active = ['permission', 'connecting', 'listening', 'finishing'].includes(status);
  const current = (capture: CaptureRun) => run.current === capture && epoch.current.current(capture.token, capture.scope, callbacks.current.getScope());
  const release = (capture: CaptureRun) => {
    window.clearTimeout(capture.finishTimer); window.clearTimeout(capture.captureTimer); window.clearTimeout(capture.setupTimer); window.clearTimeout(capture.flushTimer);
    capture.transport?.interrupt(); capture.hardware.close(); capture.resources.close();
  };
  const stop = useCallback((reason = 'Recording stopped. Check the words below before sending.', publish = true, preservePlayback = false) => {
    const capture = run.current;
    epoch.current.invalidate(); run.current = undefined;
    if (!preservePlayback) callbacks.current.onInterruptPlayback();
    if (capture) {
      if (publish) {
        capture.draft = reduceVoiceDraft(capture.draft, { type: 'interrupt' });
        callbacks.current.onText(appendTranscript(capture.prefix, capture.draft.text), Boolean(capture.draft.text), capture.conversation);
      }
      release(capture);
      if (publish && capture.conversation) callbacks.current.onEvent?.({ type: 'interrupted', scope: capture.scope, reason });
    }
    if (publish) { setInterim(''); setSlow(false); setStatus(capture ? 'interrupted' : 'idle'); setMessage(capture ? reason : ''); }
  }, []);
  useEffect(() => { stop('The question changed. Your transcript remains unsent; review it before continuing.'); }, [scopeKey, stop]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) stop('Recording stopped when this page was hidden. Check the words below before sending.'); };
    const pagehide = () => stop('Recording stopped when you left this page.');
    document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', pagehide);
    return () => { document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', pagehide); stop('', false); };
  }, [stop]);
  useEffect(() => {
    if (status !== 'connecting' && status !== 'finishing') { setSlow(false); return; }
    const timer = window.setTimeout(() => setSlow(true), 8000);
    return () => window.clearTimeout(timer);
  }, [status]);

  const finish = useCallback(() => {
    const capture = run.current;
    if (!capture || !capture.transport || !current(capture) || capture.finishRequested) return;
    capture.finishRequested = true;
    callbacks.current.onInterruptPlayback();
    capture.stopTracks?.(); window.clearTimeout(capture.captureTimer);
    setStatus('finishing'); setMessage('Microphone off. Finishing the last words…');
    try { capture.flush?.(); }
    catch { stop('The connection ended before transcription finished. Check the words below; the last words may be missing.'); return; }
    capture.finishTimer = window.setTimeout(() => stop('Transcription did not finish in time. Your draft is here; check for missing words before sending.'), voiceCaptureLimits.drainMs);
    capture.flushTimer = window.setTimeout(() => stop('Recording stopped before its last audio frame could finish. Check the transcript; the last words may be missing.'), 200);
  }, [stop]);

  const start = useCallback(async (options?: { conversation?: boolean }) => {
    const scope = callbacks.current.getScope();
    if (!scope || run.current) return;
    callbacks.current.onInterruptPlayback();
    if (!window.isSecureContext || (!callbacks.current.mediaSource && !navigator.mediaDevices?.getUserMedia) || !window.AudioContext || !window.AudioWorkletNode) {
      setStatus('unavailable'); setMessage('This browser cannot record here. You can continue by typing.'); if (options?.conversation) callbacks.current.onEvent?.({ type: 'interrupted', scope, reason: 'This browser cannot record here. Continue by typing.' }); return;
    }
    const capture: CaptureRun = { token: epoch.current.begin(), scope, prefix: callbacks.current.getText(), draft: createVoiceDraft(scope), resources: new CaptureResources(), hardware: new CaptureResources(), conversation: options?.conversation };
    run.current = capture; setStatus('permission'); setInterim(''); setMessage(options?.conversation ? 'Allow microphone access. Completed utterances become draft answers automatically; review the summary before sending to your care team.' : 'Allow microphone access to start. Nothing is sent as an answer until you review it.');
    if (capture.conversation) capture.setupTimer = window.setTimeout(() => stop('The microphone did not become ready. Resume explicitly or continue typing.'), 15000);
    try {
      // Resume is invoked in the initiating user gesture; permission is microphone-only.
      const context = new AudioContext();
      capture.hardware.own(() => { void context.close().catch(() => undefined); });
      const resumed = context.resume();
      void resumed.catch(() => undefined);
      const media = callbacks.current.mediaSource ? await callbacks.current.mediaSource(context) : { stream: await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }) };
      const { stream } = media;
      if (media.dispose) capture.hardware.own(media.dispose);
      capture.stopTracks = () => stream.getTracks().forEach(track => track.stop());
      if (!capture.hardware.own(capture.stopTracks) || !current(capture)) { release(capture); return; }
      await resumed;
      if (!current(capture)) { release(capture); return; }
      if (context.state !== 'running' || !context.audioWorklet) throw new Error('capture-unavailable');
      await context.audioWorklet.addModule(captureWorkletUrl);
      if (!current(capture)) { release(capture); return; }
      const source = context.createMediaStreamSource(stream), processor = new AudioWorkletNode(context, 'clinic-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' }), silent = context.createGain();
      silent.gain.value = 0;
      capture.hardware.own(() => { processor.port.onmessage = null; processor.port.postMessage('stop'); processor.port.close(); processor.disconnect(); source.disconnect(); silent.disconnect(); });
      const lost = () => { if (current(capture) && !capture.finishRequested) stop('Microphone access ended. Your words remain in the draft; you can continue typing.'); };
      for (const track of stream.getAudioTracks()) { track.addEventListener('ended', lost); capture.hardware.own(() => track.removeEventListener('ended', lost)); }
      const suspended = () => { if (current(capture) && context.state !== 'running') lost(); };
      context.addEventListener('statechange', suspended); capture.hardware.own(() => context.removeEventListener('statechange', suspended));
      const socketUrl = new URL('/api/clinic/speech/input', window.location.href); socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(socketUrl); socket.binaryType = 'arraybuffer';
      capture.resources.own(() => { if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(1000, 'capture-ended'); });
      capture.transport = new PcmTransport(socket, context.sampleRate);
      capture.flush = () => processor.port.postMessage('finish');
      capture.finishCapture = () => {
        if (!current(capture) || !capture.finishRequested) return;
        window.clearTimeout(capture.flushTimer); capture.hardware.close();
        try { capture.transport!.finish(); }
        catch { stop('The connection ended before transcription finished. Check for missing words before sending.'); }
      };
      const vad = new LocalVoiceActivity(); let messages = 0, messageBytes = 0, ready = false;
      processor.port.onmessage = event => {
        if (!current(capture) || !ready) return;
        if (event.data?.type === 'flushed') { capture.finishCapture?.(); return; }
        if (!(event.data instanceof Float32Array)) return;
        if (vad.feed(event.data, context.sampleRate)) { callbacks.current.onInterruptPlayback(); if (capture.conversation) callbacks.current.onEvent?.({ type: 'voice', scope }); }
        try { capture.transport!.audio(event.data); }
        catch { stop('The voice connection could not keep up. Your transcript remains here; continue by typing or start a new recording.'); }
      };
      const opened = () => {
        if (!current(capture)) return;
        socket.send(JSON.stringify({ type: 'start', requestId: crypto.randomUUID(), sessionId: scope.sessionId, promptId: scope.promptId, expectedRevision: scope.expectedRevision }));
      };
      const received = (event: MessageEvent) => {
        if (!current(capture)) return;
        try {
          if (typeof event.data !== 'string' || ++messages > 605 || (messageBytes += new TextEncoder().encode(event.data).byteLength) > 2000000 || event.data.length > 64000) throw new Error('invalid-voice-event');
          const value = JSON.parse(event.data) as SpeechInputEvent;
          if (value.type === 'ready') {
            capture.transport!.ready(value); ready = true;
            window.clearTimeout(capture.setupTimer); capture.captureTimer = window.setTimeout(() => capture.conversation ? stop('This recording reached its limit. Check the words before continuing.') : finish(), value.maxCaptureMs);
            setStatus('listening'); setMessage(capture.conversation ? 'Listening. A brief pause lets the conversation continue.' : 'Listening. Finish when you’re ready to check the transcript.');
            if (capture.conversation) callbacks.current.onEvent?.({ type: 'ready', scope });
          } else if (value.type === 'recognition' && ready) {
            const next = reduceVoiceDraft(capture.draft, { type: 'recognition', generation: capture.draft.generation, segment: recognition(value.segment) });
            const final = appendTranscript(capture.prefix, next.text);
            if (appendTranscript(final, next.interim).length > 8000) throw new Error('transcript-too-long');
            capture.draft = next;
            callbacks.current.onText(final, Boolean(capture.draft.text), capture.conversation); setInterim(capture.draft.interim);
            if (capture.conversation) callbacks.current.onEvent?.({ type: 'recognition', scope, segment: recognition(value.segment), interim: next.interim });
          } else if (value.type === 'speech-started' && ready) { callbacks.current.onInterruptPlayback(); if (capture.conversation) callbacks.current.onEvent?.({ type: 'voice', scope }); }
          else if (value.type === 'ended') {
            if (!ready || !['completed', 'interrupted', 'failed', 'unknown'].includes(value.outcome)) throw new Error('invalid-voice-event');
            callbacks.current.onInterruptPlayback();
            const clean = value.outcome === 'completed' && Boolean(capture.finishRequested) && !capture.draft.interim;
            capture.draft = reduceVoiceDraft(capture.draft, { type: 'finish' });
            callbacks.current.onText(appendTranscript(capture.prefix, capture.draft.text), Boolean(capture.draft.text), capture.conversation);
            run.current = undefined; epoch.current.invalidate(); release(capture); setInterim(''); setSlow(false);
            setStatus(value.outcome === 'completed' ? 'review' : 'interrupted');
            setMessage(value.outcome === 'completed' ? 'Check and edit the transcript below, especially names, amounts, units and “not”. Then send your reviewed answer.' : 'Recording ended. Check the transcript carefully; the last words may be missing. Nothing has been sent as an answer.');
            if (capture.conversation) callbacks.current.onEvent?.({ type: 'completed', scope, text: appendTranscript(capture.prefix, capture.draft.text), clean });
          } else if (value.type === 'error') stop('Voice is unavailable for this question. Your draft is still here, and you can continue typing.');
          else throw new Error('invalid-voice-event');
        } catch { stop('Transcription was interrupted. Your draft is still here; check it before sending.'); }
      };
      const closed = () => { if (current(capture)) stop('The voice connection ended. Check the transcript below; the last words may be missing. Start a new recording only if you want to continue.'); };
      socket.addEventListener('open', opened); socket.addEventListener('message', received); socket.addEventListener('close', closed); socket.addEventListener('error', closed);
      capture.resources.own(() => { socket.removeEventListener('open', opened); socket.removeEventListener('message', received); socket.removeEventListener('close', closed); socket.removeEventListener('error', closed); });
      source.connect(processor); processor.connect(silent); silent.connect(context.destination);
      setStatus('connecting'); setMessage('Connecting voice. You can cancel and keep typing.');
      window.clearTimeout(capture.setupTimer);
      capture.setupTimer = window.setTimeout(() => stop('The voice connection did not open. Your draft is here; you can continue typing or explicitly try a new recording.'), 15000);
    } catch (error) {
      if (!current(capture)) { release(capture); return; }
      const denied = error instanceof DOMException && ['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error.name);
      stop(denied ? 'Microphone access was not allowed. You can continue typing, or change your browser permission and start a new recording.' : 'The microphone could not start. Your draft is unchanged; you can continue typing.');
      setStatus('unavailable');
    }
  }, [finish, stop]);
  return { status, active, interim, message, slow, start, finish, stop };
}
