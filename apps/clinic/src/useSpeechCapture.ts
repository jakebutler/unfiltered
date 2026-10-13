import { useCallback, useEffect, useRef, useState } from 'react';
import { createVoiceDraft, reduceVoiceDraft, type VoiceDraft, type RecognitionSegment, type SpeechInputEvent } from '../../../packages/speech/src/index';
import type { CaptureEvent } from './voice-conversation';
import { appendTranscript, CaptureEpoch, CaptureResources, captureWorkletUrl, LocalVoiceActivity, PcmTransport, voiceCaptureLimits, type CaptureScope } from './voice-capture';
import { UploadSpeechSocket } from './upload-socket';
import { DirectSpeechSocket } from './direct-socket';

/** Upload transcription starts only after Finish, so it gets the provider timeout plus margin. */
const uploadDrainMs = 35_000;
/** Upload recordings stop a little before the one-minute lease so the last frames never reach the limit. */
const uploadCaptureMs = 59_000;
type CaptureStatus = 'idle' | 'permission' | 'connecting' | 'listening' | 'finishing' | 'retained' | 'review' | 'interrupted' | 'unavailable';
/** Explicit source seam for the isolated development fixture; normal callers use microphone capture. */
export type CaptureMediaSource = (context: AudioContext) => Promise<{ stream: MediaStream; dispose?: () => void }>;
interface CaptureRun { token: number; scope: CaptureScope; prefix: string; draft: VoiceDraft; resources: CaptureResources; hardware: CaptureResources; transport?: PcmTransport; upload?: UploadSpeechSocket; finishTimer?: number; captureTimer?: number; setupTimer?: number; flushTimer?: number; stopTracks?: () => void; flush?: () => void; finishCapture?: () => void; ready?: boolean; finishRequested?: boolean; closing?: boolean; kept?: boolean; notice?: string; conversation?: boolean; }
const stoppedNotice = 'Recording stopped. We transcribed what you said so far; check it before sending.';
const questionChangedNotice = 'The question changed while you were recording. Nothing has been sent; check the words below before continuing.';
const limitNotice = 'Recording stops after about a minute. We transcribed what you said.';
const keptNotice = 'Transcription did not finish. Your recording is kept until you try again or discard it. Your typed words are unchanged.';
const noWordsNotice = 'No words were transcribed. Type your answer or dictate again.';
function recognition(value: unknown): RecognitionSegment {
  if (!value || typeof value !== 'object') throw new Error('invalid-transcript');
  const v = value as RecognitionSegment;
  if (typeof v.text !== 'string' || v.text.length > 8000 || !Number.isFinite(v.start) || v.start < 0 || !Number.isFinite(v.duration) || v.duration < 0 || typeof v.isFinal !== 'boolean' || typeof v.speechFinal !== 'boolean') throw new Error('invalid-transcript');
  return { text: v.text, start: v.start, duration: v.duration, isFinal: v.isFinal, speechFinal: v.speechFinal };
}

/** `upload` posts one recording on finish for hosted deployments without WebSocket support. Upload keeps captured audio when capture ends for any reason other than an explicit discard.
 * `direct` streams like `stream`, but to Deepgram with a server-minted token; `onFallback` reports that it could not connect. `getKeyterms` supplies the patient's own names for Deepgram keyterm prompting on direct connections, read when the socket connects. */
export function useSpeechCapture({ getScope, getText, onText, onInterruptPlayback, onEvent, onFallback, scopeKey, mediaSource, input, getKeyterms }: {
  getScope: () => CaptureScope | undefined; getText: () => string; onText: (text: string, hasTranscript: boolean, conversation?: boolean) => void; onInterruptPlayback: () => void; onEvent?: (event: CaptureEvent) => void; onFallback?: () => void; scopeKey: string; mediaSource?: CaptureMediaSource; input?: 'stream' | 'upload' | 'direct'; getKeyterms?: () => readonly string[];
}) {
  const callbacks = useRef({ getScope, getText, onText, onInterruptPlayback, onEvent, onFallback, mediaSource, input, getKeyterms }); callbacks.current = { getScope, getText, onText, onInterruptPlayback, onEvent, onFallback, mediaSource, input, getKeyterms };
  const epoch = useRef(new CaptureEpoch()), run = useRef<CaptureRun | undefined>(undefined), kept = useRef<CaptureRun | undefined>(undefined);
  const [status, setStatus] = useState<CaptureStatus>('idle');
  const [interim, setInterim] = useState('');
  const [message, setMessage] = useState('');
  const [slow, setSlow] = useState(false);
  const active = ['permission', 'connecting', 'listening', 'finishing'].includes(status);
  // A closing capture keeps its own scope: its audio belongs to the question it was recorded for.
  const current = (capture: CaptureRun) => (run.current === capture || kept.current === capture) && (capture.closing || epoch.current.current(capture.token, capture.scope, callbacks.current.getScope()));
  const release = (capture: CaptureRun) => {
    window.clearTimeout(capture.finishTimer); window.clearTimeout(capture.captureTimer); window.clearTimeout(capture.setupTimer); window.clearTimeout(capture.flushTimer);
    capture.transport?.interrupt(); capture.hardware.close(); capture.resources.close();
  };
  const settle = (capture: CaptureRun) => {
    if (run.current === capture) run.current = undefined;
    if (kept.current === capture) kept.current = undefined;
    epoch.current.invalidate(); release(capture);
  };
  /** Cancels immediately; audio captured so far is not transcribed. */
  const end = useCallback((reason: string, publish = true, preservePlayback = false) => {
    const wasKept = !run.current && Boolean(kept.current), capture = run.current ?? kept.current;
    epoch.current.invalidate(); run.current = undefined; kept.current = undefined;
    if (!preservePlayback) callbacks.current.onInterruptPlayback();
    if (capture) {
      if (publish && !wasKept) {
        capture.draft = reduceVoiceDraft(capture.draft, { type: 'interrupt' });
        callbacks.current.onText(appendTranscript(capture.prefix, capture.draft.text), Boolean(capture.draft.text), capture.conversation);
      }
      release(capture);
      if (publish && capture.conversation) callbacks.current.onEvent?.({ type: 'interrupted', scope: capture.scope, reason });
    }
    if (publish) { setInterim(''); setSlow(false); setStatus(capture ? 'interrupted' : 'idle'); setMessage(capture ? reason : ''); }
  }, []);
  const finish = useCallback(() => {
    const capture = run.current;
    if (!capture || !capture.transport || !current(capture) || capture.finishRequested) return;
    const upload = callbacks.current.input === 'upload';
    capture.finishRequested = true;
    callbacks.current.onInterruptPlayback();
    capture.stopTracks?.(); window.clearTimeout(capture.captureTimer);
    setStatus('finishing'); setMessage(capture.notice ? 'Microphone off. Transcribing what you said…' : 'Microphone off. Finishing the last words…');
    try { capture.flush?.(); }
    catch {
      if (upload) capture.finishCapture?.();
      else end('The connection ended before transcription finished. Check the words below; the last words may be missing.');
      return;
    }
    capture.finishTimer = window.setTimeout(() => upload ? capture.upload?.pause() : end('Transcription did not finish in time. Your draft is here; check for missing words before sending.'), upload ? uploadDrainMs : voiceCaptureLimits.drainMs);
    capture.flushTimer = window.setTimeout(() => upload ? capture.finishCapture?.() : end('Recording stopped before its last audio frame could finish. Check the transcript; the last words may be missing.'), 200);
  }, [end]);
  /** Ends a live recording. Upload transcribes the audio captured so far; stream ends as before. */
  const stop = useCallback((reason = stoppedNotice, publish = true, preservePlayback = false) => {
    const capture = run.current;
    if (callbacks.current.input !== 'upload' || !publish) return end(reason, publish, preservePlayback);
    if (!capture) { if (!kept.current) end(reason, publish, preservePlayback); return; }
    if (!capture.ready) return end(reason, publish, preservePlayback);
    capture.closing = true; capture.notice ??= reason;
    finish();
  }, [end, finish]);
  /** "Stop waiting": pauses an in-flight upload and keeps its recording for a retry. */
  const pause = useCallback(() => {
    const capture = run.current;
    if (capture?.upload && capture.finishRequested) capture.upload.pause(); else stop();
  }, [stop]);
  const retry = useCallback(() => {
    const capture = kept.current;
    if (!capture?.upload) return;
    kept.current = undefined; run.current = capture;
    setInterim(''); setSlow(false); setStatus('finishing'); setMessage('Trying the transcription again…');
    capture.finishTimer = window.setTimeout(() => capture.upload?.pause(), uploadDrainMs);
    capture.upload.retry();
  }, []);
  /** Throws the recording away without transcribing it. */
  const discard = useCallback(() => end(run.current || kept.current ? 'Recording discarded. Nothing was transcribed.' : ''), [end]);
  const keep = (capture: CaptureRun) => {
    window.clearTimeout(capture.finishTimer); window.clearTimeout(capture.flushTimer);
    if (run.current === capture) run.current = undefined;
    kept.current = capture; capture.kept = true; capture.closing = true;
    setInterim(''); setSlow(false); setStatus('retained'); setMessage(keptNotice);
  };
  useEffect(() => { stop(questionChangedNotice); }, [scopeKey, stop]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) stop('Recording stopped when this page was hidden. We transcribed what you said so far; check it before sending.'); };
    // Leaving the page drops the audio; a transcription cannot finish reliably after unload.
    const pagehide = () => { if (callbacks.current.input === 'upload') end('Recording stopped when you left this page. Nothing was transcribed.'); else stop('Recording stopped when you left this page.'); };
    document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', pagehide);
    return () => { document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', pagehide); end('', false); };
  }, [end, stop]);
  useEffect(() => {
    if (status !== 'connecting' && status !== 'finishing') { setSlow(false); return; }
    const timer = window.setTimeout(() => setSlow(true), 8000);
    return () => window.clearTimeout(timer);
  }, [status]);

  const start = useCallback(async (options?: { conversation?: boolean }) => {
    const scope = callbacks.current.getScope();
    if (!scope || run.current || kept.current) return;
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
      const lost = () => { if (current(capture) && !capture.finishRequested) stop('Microphone access ended. We transcribed what you said so far; check it before sending.'); };
      for (const track of stream.getAudioTracks()) { track.addEventListener('ended', lost); capture.hardware.own(() => track.removeEventListener('ended', lost)); }
      const suspended = () => { if (current(capture) && context.state !== 'running') lost(); };
      context.addEventListener('statechange', suspended); capture.hardware.own(() => context.removeEventListener('statechange', suspended));
      const socketUrl = new URL('/api/clinic/speech/input', window.location.href); socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      const upload = callbacks.current.input === 'upload';
      const uploadSocket = upload ? new UploadSpeechSocket(socketUrl) : undefined;
      capture.upload = uploadSocket;
      const socket = (uploadSocket ?? (callbacks.current.input === 'direct' ? new DirectSpeechSocket(socketUrl, { keyterms: () => callbacks.current.getKeyterms?.() ?? [] }) : new WebSocket(socketUrl))) as unknown as WebSocket; socket.binaryType = 'arraybuffer';
      capture.resources.own(() => { if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(1000, 'capture-ended'); });
      capture.transport = new PcmTransport(socket, context.sampleRate);
      capture.flush = () => processor.port.postMessage('finish');
      capture.finishCapture = () => {
        if (!current(capture) || !capture.finishRequested) return;
        window.clearTimeout(capture.flushTimer); capture.hardware.close();
        try { capture.transport!.finish(); }
        catch { end('The connection ended before transcription finished. Check for missing words before sending.'); }
      };
      const vad = new LocalVoiceActivity(); let messages = 0, messageBytes = 0;
      processor.port.onmessage = event => {
        if (!current(capture) || !capture.ready) return;
        if (event.data?.type === 'flushed') { capture.finishCapture?.(); return; }
        if (!(event.data instanceof Float32Array)) return;
        if (vad.feed(event.data, context.sampleRate)) { callbacks.current.onInterruptPlayback(); if (capture.conversation) callbacks.current.onEvent?.({ type: 'voice', scope }); }
        try { capture.transport!.audio(event.data); }
        catch { stop(upload ? limitNotice : 'The voice connection could not keep up. Your transcript remains here; continue by typing or start a new recording.'); }
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
            capture.transport!.ready(value); capture.ready = true;
            window.clearTimeout(capture.setupTimer);
            const limit = () => { if (upload) stop(limitNotice); else if (capture.conversation) stop('This recording reached its limit. Check the words before continuing.'); else finish(); };
            capture.captureTimer = window.setTimeout(limit, upload ? Math.min(value.maxCaptureMs, uploadCaptureMs) : value.maxCaptureMs);
            setStatus('listening'); setMessage(capture.conversation ? 'Listening. A brief pause lets the conversation continue.' : upload ? 'Recording. Press Finish recording when you are done, then check the words.' : 'Listening. Finish when you’re ready to check the transcript.');
            if (capture.conversation) callbacks.current.onEvent?.({ type: 'ready', scope });
          } else if (value.type === 'recognition' && capture.ready) {
            const next = reduceVoiceDraft(capture.draft, { type: 'recognition', generation: capture.draft.generation, segment: recognition(value.segment) });
            // A retried recording is added once, when it ends, to whatever the patient has typed since; it never replaces that text.
            const final = appendTranscript(capture.kept ? callbacks.current.getText() : capture.prefix, next.text);
            if (appendTranscript(final, next.interim).length > 8000) throw new Error('transcript-too-long');
            capture.draft = next;
            if (!capture.kept) callbacks.current.onText(final, Boolean(capture.draft.text), capture.conversation);
            setInterim(capture.draft.interim);
            if (capture.conversation) callbacks.current.onEvent?.({ type: 'recognition', scope, segment: recognition(value.segment), interim: next.interim });
          } else if (value.type === 'speech-started' && capture.ready) { callbacks.current.onInterruptPlayback(); if (capture.conversation) callbacks.current.onEvent?.({ type: 'voice', scope }); }
          else if (value.type === 'ended') {
            if (!capture.ready || !['completed', 'interrupted', 'failed', 'unknown'].includes(value.outcome)) throw new Error('invalid-voice-event');
            callbacks.current.onInterruptPlayback();
            const completed = value.outcome === 'completed', clean = completed && Boolean(capture.finishRequested) && !capture.draft.interim;
            capture.draft = reduceVoiceDraft(capture.draft, { type: 'finish' });
            const base = capture.kept ? callbacks.current.getText() : capture.prefix, text = appendTranscript(base, capture.draft.text);
            callbacks.current.onText(text, Boolean(capture.draft.text), capture.conversation);
            settle(capture); setInterim(''); setSlow(false);
            setStatus(completed ? 'review' : 'interrupted');
            setMessage(!capture.draft.text && completed ? noWordsNotice : capture.notice ?? (completed ? 'Check and edit the transcript below, especially names, amounts, units and “not”. Then send your reviewed answer.' : 'Recording ended. Check the transcript carefully; the last words may be missing. Nothing has been sent as an answer.'));
            if (capture.conversation) callbacks.current.onEvent?.({ type: 'completed', scope, text, clean, utterance: capture.draft.text, prefix: base });
          } else if (value.type === 'error') {
            if ('retained' in value && value.retained === true) keep(capture);
            else if ('fallback' in value && value.fallback === true) { callbacks.current.onFallback?.(); end('Hands-free voice could not connect. Nothing was lost: dictate one answer instead, or keep typing.'); }
            else end('Voice is unavailable for this question. Your draft is still here, and you can continue typing.');
          }
          else throw new Error('invalid-voice-event');
        } catch { end('Transcription was interrupted. Your draft is still here; check it before sending.'); }
      };
      const closed = () => { if (current(capture)) end('The voice connection ended. Check the transcript below; the last words may be missing. Start a new recording only if you want to continue.'); };
      socket.addEventListener('open', opened); socket.addEventListener('message', received); socket.addEventListener('close', closed); socket.addEventListener('error', closed);
      capture.resources.own(() => { socket.removeEventListener('open', opened); socket.removeEventListener('message', received); socket.removeEventListener('close', closed); socket.removeEventListener('error', closed); });
      source.connect(processor); processor.connect(silent); silent.connect(context.destination);
      setStatus('connecting'); setMessage('Connecting voice. You can cancel and keep typing.');
      window.clearTimeout(capture.setupTimer);
      capture.setupTimer = window.setTimeout(() => end('The voice connection did not open. Your draft is here; you can continue typing or explicitly try a new recording.'), 15000);
    } catch (error) {
      if (!current(capture)) { release(capture); return; }
      const denied = error instanceof DOMException && ['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error.name);
      end(denied ? 'Microphone access was not allowed. You can continue typing, or change your browser permission and start a new recording.' : 'The microphone could not start. Your draft is unchanged; you can continue typing.');
      setStatus('unavailable');
    }
  }, [end, finish, stop]);
  return { status, active, retained: status === 'retained', interim, message, slow, start, finish, stop, pause, retry, discard };
}
