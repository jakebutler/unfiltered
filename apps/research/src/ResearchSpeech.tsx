import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { Participant } from './state';
import type { CaptureControls } from './ResearchCapture';
import { Notice } from './components';
import { useResearchSpeechCapture } from './useResearchSpeechCapture';
import { useResearchSpeechPlayback } from './useResearchSpeechPlayback';
import { useResearchBargeIn } from './useResearchBargeIn';
import type { CaptureScope } from '../../../packages/speech/src/browser-pcm';
import type { ResearchTranscriptReceipt, ResearchSpokenReceipt } from '../../../packages/research-core/src/speech-contract';

export type ResearchSpeechControls = { stop: () => void };
type Phase = 'off' | 'listening' | 'saving' | 'waiting' | 'speaking' | 'rearming' | 'interrupted';
export function ResearchSpeech({ token, session, draft, onDraft, onReceipt, onResetSpeech, blocked, controls, captureControls, onActivity, mediaSource, onCommitted, onMicrophoneConsent }: {
  token: string; session: Participant; draft: string; onDraft: (text: string, hasTranscript?: boolean) => void;
  onReceipt: (receipt: ResearchTranscriptReceipt) => void; blocked: boolean;
  onResetSpeech: () => void; onCommitted: (receipt: ResearchSpokenReceipt, scope: CaptureScope) => void;
  onMicrophoneConsent: (enabled: boolean) => Promise<void>;
  controls: MutableRefObject<ResearchSpeechControls | null>; captureControls: MutableRefObject<CaptureControls | null>;
  onActivity: (active: boolean) => void;
  mediaSource?: () => Promise<{ stream: MediaStream; owned: boolean }>;
}) {
  const [mode, setMode] = useState<'text' | 'voice'>('text'), [enabled, setEnabled] = useState(false), [continuous, setContinuous] = useState(false);
  const [message, setMessage] = useState('Voice availability is being checked. You can keep typing.');
  const [receipt, setReceipt] = useState<ResearchTranscriptReceipt | null>(null), [checking, setChecking] = useState(false), [missingReceipt, setMissingReceipt] = useState(false);
  const [phase, setPhase] = useState<Phase>('off');
  const intent = useRef(false), epoch = useRef(0), waitingRevision = useRef<number | null>(null), spokenPrompt = useRef('');
  const stream = useRef<{ stream: MediaStream; owned: boolean } | null>(null), outputScope = useRef<CaptureScope | null>(null);
  const pendingCommit = useRef<CaptureScope | null>(null), commitAbort = useRef<AbortController | null>(null), receiptByAttempt = useRef<ResearchTranscriptReceipt | null>(null);
  const attempt = useRef<CaptureScope | undefined>(undefined);
  const latest = useRef({ session, draft, blocked, onCommitted, onDraft, onReceipt, onResetSpeech }); latest.current = { session, draft, blocked, onCommitted, onDraft, onReceipt, onResetSpeech };
  const scopeKey = `${session.sessionId}:${session.question?.id}:${session.revision}:${session.state}:${session.consent?.microphone}`;
  const playback = useResearchSpeechPlayback(scopeKey, token);
  const barge = useResearchBargeIn(() => {
    if (!intent.current || !outputScope.current) return;
    playback.stop(); setPhase('rearming'); void rearmAfterOutput(outputScope.current);
  }, () => stopLoop('The speech microphone stopped. Your saved answers remain; continue typing or resume voice explicitly.'));
  const capture = useResearchSpeechCapture({ token, scopeKey,
    getScope: () => {
      const current = latest.current.session, scope = attempt.current;
      return !latest.current.blocked && current.state === 'active' && current.consent?.microphone && current.question && !current.pendingInterview && scope?.sessionId === current.sessionId && scope.promptId === current.question.id && scope.expectedRevision === current.revision ? scope : undefined;
    },
    getText: () => intent.current ? '' : latest.current.draft,
    onText: (text, hasTranscript) => latest.current.onDraft(text, hasTranscript), onInterruptPlayback: playback.stop,
    onReceipt: saved => { receiptByAttempt.current = saved; setReceipt(saved); latest.current.onReceipt(saved); },
    onEvent: event => {
      if (event.type === 'completed' && intent.current) {
        if (!event.clean || !receiptByAttempt.current || receiptByAttempt.current.attemptId !== event.scope.requestId) { stopLoop('The spoken result is not confirmed. Check its original transcript; no audio will be replayed.'); return; }
        pendingCommit.current = event.scope; setPhase('saving'); setMessage('Saving the spoken turn before continuing…'); void commitTurn(event.scope);
      } else if (event.type === 'interrupted' && intent.current) stopLoop(event.reason ?? 'Voice stopped. Your visible words remain available.');
    },
    mediaSource: async () => {
      if (stream.current?.stream.getAudioTracks().some(track => track.readyState === 'live')) return { stream: stream.current.stream, owned: false };
      return microphone();
    },
  });
  async function microphone() {
    const shared = captureControls.current?.microphoneStream();
    if (shared?.getAudioTracks().some(track => track.readyState === 'live')) return { stream: shared, owned: false };
    if (mediaSource) return mediaSource();
    return { stream: await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }), owned: true };
  }
  function stopLoop(reason = '') {
    intent.current = false; epoch.current++; commitAbort.current?.abort(); commitAbort.current = null;
    // Set intent first so capture interruption cannot recursively stop the loop.
    capture.stop(); playback.stop(); barge.stop();
    if (stream.current?.owned) stream.current.stream.getTracks().forEach(track => track.stop()); stream.current = null;
    waitingRevision.current = null; outputScope.current = null; setPhase(reason ? 'interrupted' : 'off'); if (reason) setMessage(reason);
  }
  async function post(path: string, body: unknown, signal: AbortSignal) {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Research-Participant': token }, body: JSON.stringify(body), signal, cache: 'no-store', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error('unconfirmed'); return response.json();
  }
  async function commitTurn(scope: CaptureScope) {
    if (checking || commitAbort.current) return; setChecking(true);
    const generation = epoch.current, abort = new AbortController(); commitAbort.current = abort; const timer = setTimeout(() => abort.abort(), 10_000);
    try {
      const saved = await post('/api/research/speech/commit', scope, abort.signal) as ResearchSpokenReceipt;
      if (saved.attemptId !== scope.requestId || typeof saved.rawSourceId !== 'string' || typeof saved.answerSourceId !== 'string' || (!Number.isSafeInteger(saved.acceptedRevision) || saved.acceptedRevision <= scope.expectedRevision)) throw new Error('invalid-receipt');
      pendingCommit.current = null;
      // A historic acknowledgement refreshes sources, never overwrites a newer composer.
      latest.current.onCommitted(saved, scope);
      if (generation !== epoch.current || !intent.current) { setMessage('The earlier spoken turn is saved. Its original remains in source history.'); return; }
      waitingRevision.current = saved.acceptedRevision; setPhase('waiting'); setMessage('Spoken answer saved. Preparing the next question; you will review these words before analysis.');
    } catch {
      if (generation === epoch.current) stopLoop('We could not confirm this spoken turn. Check the same saved turn before starting another; your audio will not be sent again.');
    } finally { clearTimeout(timer); if (commitAbort.current === abort) commitAbort.current = null; setChecking(false); }
  }
  function beginCapture(prelude = false) {
    const current = latest.current.session;
    if (!intent.current || latest.current.blocked || !current.question || current.pendingInterview || current.state !== 'active' || !current.consent?.microphone) return;
    attempt.current = { sessionId: current.sessionId, promptId: current.question.id, expectedRevision: current.revision, requestId: crypto.randomUUID() };
    receiptByAttempt.current = null; setReceipt(null); setMissingReceipt(false); setPhase('listening');
    void capture.start({ conversation: true, ...(prelude ? { prelude: () => { const frames = barge.take(); barge.stop(); return frames; } } : {}) });
  }
  async function startNatural() {
    if (!enabled || !continuous || blocked || !session.question || !session.consent?.microphone || capture.active || draft.trim() || pendingCommit.current) return;
    intent.current = true; const generation = ++epoch.current; setMode('voice'); setMessage('');
    try {
      const opened = await microphone();
      if (generation !== epoch.current || !intent.current) { if (opened.owned) opened.stream.getTracks().forEach(track => track.stop()); return; }
      stream.current = opened; spokenPrompt.current = ''; waitingRevision.current = latest.current.session.revision; setPhase('waiting'); setMessage('Preparing the current question audio before listening…');
    } catch { stopLoop('Microphone access was not available. Continue typing, or allow it and resume voice explicitly.'); }
  }
  async function rearmAfterOutput(scope: CaptureScope) {
    const generation = epoch.current, abort = new AbortController(), timer = setTimeout(() => abort.abort(), 10_000);
    try {
      const terminal = await post('/api/research/speech/settlement', { ...scope, provider: 'elevenlabs' }, abort.signal);
      if (terminal?.transportSettled !== true) throw new Error('unconfirmed-settlement');
      if (generation !== epoch.current || !intent.current || latest.current.session.question?.id !== scope.promptId || latest.current.session.revision !== scope.expectedRevision) return;
      outputScope.current = null; beginCapture(true);
    } catch { if (generation === epoch.current) stopLoop('Question audio could not settle safely. Continue with text; no speech request has been repeated.'); }
    finally { clearTimeout(timer); }
  }
  useEffect(() => { controls.current = { stop: () => stopLoop() }; return () => { controls.current = null; stopLoop(); }; }, []);
  useEffect(() => { onActivity(capture.active || ['saving', 'waiting', 'speaking', 'rearming'].includes(phase)); return () => onActivity(false); }, [capture.active, phase, onActivity]);
  useEffect(() => {
    attempt.current = undefined; receiptByAttempt.current = null; setReceipt(null); setMissingReceipt(false); latest.current.onResetSpeech();
    if (session.state !== 'active' || !session.consent?.microphone) stopLoop();
  }, [scopeKey]);
  useEffect(() => {
    if (!intent.current || phase !== 'waiting' || waitingRevision.current === null || session.revision < waitingRevision.current || session.pendingInterview || blocked) return;
    if (!session.question) { stopLoop('You have reached the end. Review your spoken answers before confirming the interview.'); return; }
    const key = `${session.question.id}:${session.revision}`; if (spokenPrompt.current === key) return; spokenPrompt.current = key;
    const scope = { sessionId: session.sessionId, promptId: session.question.id, expectedRevision: session.revision, requestId: crypto.randomUUID() }; outputScope.current = scope;
    setPhase('speaking'); setMessage('Preparing the complete question audio. You can pause or switch to typing.');
    void playback.start({ sessionId: scope.sessionId, sourceId: scope.promptId, expectedRevision: scope.expectedRevision, requestId: scope.requestId }, { buffered: true });
  }, [phase, session.question?.id, session.revision, session.pendingInterview?.scope.requestId, blocked]);
  useEffect(() => {
    if (!intent.current || phase !== 'speaking' || !outputScope.current) return;
    if (playback.status === 'playing' && stream.current) { setMessage('Question audio is playing. Speak to interrupt, or switch to typing.'); void barge.start(stream.current.stream); }
    else if (playback.status === 'finished') { setPhase('rearming'); void rearmAfterOutput(outputScope.current); }
    else if (playback.status === 'error') stopLoop('Question audio is unavailable. Your answers remain saved; continue with text.');
  }, [playback.status, phase]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) stopLoop('Voice paused while this tab was hidden. Resume explicitly when you return.'); };
    document.addEventListener('visibilitychange', hidden); return () => document.removeEventListener('visibilitychange', hidden);
  }, []);
  useEffect(() => {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 5000); let disposed = false;
    setEnabled(false);
    void fetch('/api/research/speech/status', { headers: { 'X-Research-Participant': token }, signal: abort.signal, cache: 'no-store', referrerPolicy: 'same-origin' }).then(async response => {
      if (!response.ok) throw new Error('unavailable'); const result = await response.json(); if (abort.signal.aborted || disposed) return;
      setEnabled(result.enabled === true); setContinuous(result.continuous === true); setMessage(result.enabled === true ? '' : 'Voice is not enabled for this study. Continue with text.');
    }).catch(() => { if (!disposed) setMessage('Voice is unavailable right now. Continue with text.'); }).finally(() => clearTimeout(timer));
    return () => { disposed = true; abort.abort(); clearTimeout(timer); };
  }, [token]);
  function startManual() {
    if (!enabled || blocked || !session.question || !session.consent?.microphone || capture.active) return;
    attempt.current = { sessionId: session.sessionId, promptId: session.question.id, expectedRevision: session.revision, requestId: crypto.randomUUID() };
    setReceipt(null); setMissingReceipt(false); void capture.start();
  }
  async function checkOriginal() {
    const scope = attempt.current; if (!scope || checking) return;
    setChecking(true); const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 5000);
    try {
      const saved = await post('/api/research/speech/transcript', scope, abort.signal) as ResearchTranscriptReceipt | null;
      if (!saved) { setMissingReceipt(true); setMessage('No original transcript receipt is available. Your visible words remain an unsaved draft.'); return; }
      if (saved.attemptId !== scope.requestId || saved.promptId !== scope.promptId || saved.expectedRevision !== scope.expectedRevision || typeof saved.text !== 'string' || saved.text.length > 8000 || typeof saved.rawSourceId !== 'string') throw new Error('unknown');
      const current = latest.current.session;
      if (attempt.current !== scope || current.sessionId !== scope.sessionId || current.question?.id !== scope.promptId || current.revision !== scope.expectedRevision || current.state !== 'active') { setMessage('The earlier original transcript remains in source history. Your current draft has been preserved.'); return; }
      setReceipt(saved); onReceipt(saved); setMessage('The original transcript is saved. Your edited draft has been preserved.');
    } catch { setMessage('The original voice result is still unconfirmed. No audio was sent again.'); }
    finally { clearTimeout(timer); setChecking(false); }
  }
  const questionStatus = playback.status === 'playing' ? 'Question audio is playing. Speak to interrupt, or switch to typing.' : playback.status === 'blocked' ? playback.message : playback.status === 'finished' ? 'Question audio finished. Checking its saved settlement before listening…' : 'Preparing the complete question audio. You can pause or switch to typing.';
  return <div className="research-speech" aria-label="Interview answer mode">
    <div className="answer-mode"><span>Answer mode: {mode === 'text' ? 'typing' : continuous ? 'conversation' : 'spoken draft'}</span><div className="actions">
      <button type="button" className="secondary" aria-pressed={mode === 'text'} onClick={() => { stopLoop(); setMode('text'); }}>Type answers</button>
      <button type="button" className="secondary" aria-pressed={mode === 'voice'} disabled={!enabled || blocked} onClick={() => setMode('voice')}>Speak instead</button>
    </div></div>
    {mode === 'voice' && <>
      <p>{continuous ? 'A brief pause completes your spoken answer and moves to the next question. Your transcript stays visible; review and correct it before final confirmation.' : 'Recognized words stay editable. Save each reviewed draft to continue.'} Study audio recording is separate.</p>
      <label className="check"><input type="checkbox" disabled={blocked || capture.active || intent.current} checked={!!session.consent?.microphone} onChange={event => void onMicrophoneConsent(event.target.checked)} /><span>Allow microphone use for spoken answers</span></label>
      <div className="actions">
        {continuous ? <>
          {!intent.current ? <button type="button" disabled={blocked || !session.question || !!draft.trim() || !session.consent?.microphone || !!pendingCommit.current} onClick={() => void startNatural()}>Talk through the interview</button> : <button type="button" className="secondary" onClick={() => stopLoop('Voice paused. Your saved answers remain; any unsent words stay in this tab.')}>Pause spoken answers</button>}
          {!intent.current && !!draft.trim() && <small>Save or clear your typed draft before starting a new spoken turn.</small>}
        </> : !capture.active ? <button type="button" disabled={blocked || !enabled || !session.question || !session.consent?.microphone} onClick={startManual}>Start spoken draft</button> : <><button type="button" disabled={capture.status !== 'listening'} onClick={capture.finish}>Finish spoken draft</button><button type="button" className="secondary" onClick={() => capture.stop()}>Pause spoken draft</button></>}
        {!intent.current && <button type="button" className="secondary" disabled={blocked || !session.question || ['loading', 'playing'].includes(playback.status)} onClick={() => session.question && void playback.start({ sessionId: session.sessionId, expectedRevision: session.revision, sourceId: session.question.id, requestId: crypto.randomUUID() })}>Hear current question</button>}
        {['loading', 'playing', 'blocked'].includes(playback.status) && <button type="button" className="secondary" onClick={() => { const audible = playback.status === 'playing'; playback.stop(); if (intent.current && outputScope.current && audible) { setPhase('rearming'); void rearmAfterOutput(outputScope.current); } else if (intent.current) stopLoop('Voice paused while question audio was preparing. Continue typing, or resume voice explicitly after the saved turn settles.'); }}>Stop question audio</button>}
        {['blocked', 'finished'].includes(playback.status) && <button type="button" className="secondary" onClick={() => void playback.playPrepared()}>Play prepared audio</button>}
      </div>
    </>}
    <p role="status" aria-live="polite">{capture.active ? `Speech microphone ${capture.status === 'listening' ? 'listening' : capture.status}. ` : phase === 'speaking' ? playback.status === 'playing' ? 'Listening locally for an interruption; question audio on. ' : playback.status === 'blocked' ? 'Question audio is ready; playback needs your permission. ' : playback.status === 'finished' ? 'Question audio finished; spoken answer capture off. ' : 'Preparing question audio; spoken answer capture off. ' : 'Spoken answer capture off. '}{phase === 'speaking' ? questionStatus : ['saving', 'waiting', 'rearming', 'interrupted'].includes(phase) ? message : capture.message || playback.message || message}</p>
    {capture.interim && <p className="muted">Provisional words: {capture.interim}</p>}
    {(capture.slow || playback.slow) && <p role="status">Still working. Your text answer is available; no voice request has been repeated.</p>}
    {pendingCommit.current && !intent.current && <button type="button" className="secondary" disabled={checking || blocked} onClick={() => { const scope = pendingCommit.current; if (scope) void commitTurn(scope); }}>Check saved spoken turn</button>}
    {attempt.current && !capture.active && !receipt && !pendingCommit.current && <button type="button" className="secondary" disabled={checking} onClick={() => void checkOriginal()}>{checking ? 'Checking original transcript…' : 'Check original voice transcript'}</button>}
    {missingReceipt && !capture.active && <button type="button" className="secondary" onClick={() => { onResetSpeech(); attempt.current = undefined; setMissingReceipt(false); setMessage('Your visible wording can be saved as a typed answer. Any original voice source remains separate.'); }}>Continue with typed wording</button>}
    {receipt && !continuous && <small>Original transcript retained with this draft. Saved originals remain in source history after the question changes.</small>}
  </div>;
}
