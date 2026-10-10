import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { acceptPrototypeMessage } from '../../../packages/research-capture/src/dom';
import type { DomEvent, Modality } from '../../../packages/research-capture/src/contracts';
import { BrowserCapture, CaptureBufferBudget, CaptureUploadQueue, type BrowserCaptureDevices, type CaptureSnapshot } from './capture-browser';
import { useRead } from './data';
import { Notice } from './components';
import { errorText, type Participant } from './state';

function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Result unconfirmed')), 65_000); })]).finally(() => clearTimeout(timer));
}

export type CaptureControls = { stop: (retain?: boolean) => Promise<void>; microphoneStream: () => MediaStream | null };
export function ResearchCapture({ token, session, controls, refresh, devices }: { token: string; session: Participant; controls: MutableRefObject<CaptureControls | null>; refresh: () => void; devices?: BrowserCaptureDevices }) {
  const convex = useConvex();
  const status = useRead(api.capture.status, { token });
  const modes = ['microphone', 'camera', 'screen'] as const;
  const [snapshots, setSnapshots] = useState<Record<Modality, CaptureSnapshot>>({ microphone: { phase: 'idle', mode: 'microphone', saved: 0, message: '', pending: 0 }, camera: { phase: 'idle', mode: 'camera', saved: 0, message: '', pending: 0 }, screen: { phase: 'idle', mode: 'screen', saved: 0, message: '', pending: 0 } });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [consentPending, setConsentPending] = useState(false);
  const [domState, setDomState] = useState('Page activity is off.');
  const domConnectionKey = `corvo.research.dom-connection.${session.sessionId}`;
  function retainedConnection(): { origin: string; challenge: string } | null {
    try { const saved = JSON.parse(sessionStorage.getItem(domConnectionKey) ?? 'null'); return saved && /^[a-f0-9]{64}$/.test(saved.challenge) && typeof saved.origin === 'string' ? saved : null; } catch { return null; }
  }
  function keepConnection(value: { origin: string; challenge: string } | null) { try { if (value) sessionStorage.setItem(domConnectionKey, JSON.stringify(value)); else sessionStorage.removeItem(domConnectionKey); } catch { /* A conversation pause remains the explicit server reset. */ } }
  const bridge = useRef<{ window: Window; origin: string; challenge: string; remove: () => void } | null>(null);
  const domWork = useRef(Promise.resolve());
  const uncertainConnect = useRef<{ origin: string; challenge: string } | null>(null);
  const domPending = useRef<{ challenge: string; origin: string; requestId: string; events: DomEvent[] } | null>(null);
  const current = useRef(session); current.current = session;
  const alive = useRef(true);
  const actionGeneration = useRef(0);
  const deviceGeneration = useRef<Record<Modality, number>>({ microphone: 0, camera: 0, screen: 0 });
  const uploadAdmission = useRef<Record<Modality, AbortController>>({ microphone: new AbortController(), camera: new AbortController(), screen: new AbortController() });
  const capture = useRef<Record<Modality, BrowserCapture> | null>(null);
  if (!capture.current) {
    const budget = new CaptureBufferBudget();
    const uploads = new CaptureUploadQueue();
    const create = (mode: Modality) => new BrowserCapture({
    reserve: item => bounded(convex.mutation(api.capture.reserve, { token, requestId: item.requestId, descriptor: item.descriptor })),
    transfer: async (id, body, onDispatch) => {
      const generation = deviceGeneration.current[mode];
      const signal = uploadAdmission.current[mode].signal;
      const dispatch = async () => {
        // Queuing consumes no network lease/timeout. The deadline starts here.
        onDispatch?.();
        const controller = new AbortController(); const timeout = window.setTimeout(() => controller.abort(), 65_000);
        try {
          const response = await fetch(`/capture/media/${encodeURIComponent(id)}`, { method: body ? 'PUT' : 'POST', headers: { 'X-Research-Participant': token }, ...(body ? { body } : {}), signal: controller.signal, cache: 'no-store', referrerPolicy: 'no-referrer' });
          if (!response.ok) throw new Error('Recording result is unconfirmed');
          return await response.json();
        } finally { window.clearTimeout(timeout); }
      };
      return body ? uploads.send(signal, () => alive.current && generation === deviceGeneration.current[mode] && !!current.current.consent?.[mode] && !!current.current.consent?.storage && !!current.current.consent?.analysis, dispatch) : dispatch();
    },
    gap: async (modality, reason, atMs) => { await convex.mutation(api.capture.gap, { token, requestId: crypto.randomUUID(), modality, reason, atMs }); },
    changed: next => { if (alive.current) setSnapshots(previous => ({ ...previous, [mode]: next })); },
    }, devices, Date.now, budget);
    capture.current = { microphone: create('microphone'), camera: create('camera'), screen: create('screen') };
  }
  function stopDom() {
    const old = bridge.current; bridge.current = null;
    if (old) { old.remove(); old.window.postMessage({ type: 'corvo-dom-stop', challenge: old.challenge }, old.origin); }
    if (alive.current) setDomState('Page activity is off.');
    return old;
  }
  async function stop(retain = true) {
    actionGeneration.current++;
    stopDom();
    if (!retain) modes.forEach(mode => uploadAdmission.current[mode].abort());
    await Promise.all(modes.map(mode => capture.current![mode].stop(retain)));
    await domWork.current;
  }
  useEffect(() => {
    alive.current = true; controls.current = { stop, microphoneStream: () => capture.current!.microphone.activeStream() };
    const leave = () => { void stop(false); };
    window.addEventListener('pagehide', leave);
    return () => { alive.current = false; controls.current = null; window.removeEventListener('pagehide', leave); void stop(false); };
  }, []);
  useEffect(() => {
    modes.forEach(mode => capture.current![mode].setQuestion(session.question?.id ?? ''));
    if (session.state !== 'active' || status.error || ['paused', 'stopped', 'purging', 'purged'].includes(status.data?.recording ?? '')) void stop(!status.error && !!session.consent?.storage && !!session.consent?.analysis && !['purging', 'purged'].includes(status.data?.recording ?? ''));
  }, [session.state, session.question?.id, status.data?.recording, status.error]);
  useEffect(() => {
    modes.forEach(mode => { if (!session.consent?.[mode]) { deviceGeneration.current[mode]++; uploadAdmission.current[mode].abort(); void capture.current![mode].stop(false); } });
    if (!session.consent?.dom) stopDom();
  }, [session.consent?.microphone, session.consent?.camera, session.consent?.screen, session.consent?.dom]);
  async function consent(track: Modality | 'dom', enabled: boolean) {
    if (!session.consent) return;
    // Selective withdrawal closes only its own source before the write.
    setBusy(true); setError('');
    if (!enabled) { if (track === 'dom') { stopDom(); domPending.current = null; uncertainConnect.current = null; keepConnection(null); } else { deviceGeneration.current[track]++; uploadAdmission.current[track].abort(); void capture.current![track].stop(false); } }
    const next = { ...session.consent, [track]: enabled };
    if (!enabled) { if (track === 'microphone') next.shareAudio = false; if (track === 'camera') next.shareCamera = false; if (track === 'screen') next.shareScreen = false; }
    try { await convex.mutation(api.capture.changeConsent, { token, expectedRevision: session.revision, consent: next }); refresh(); status.refresh(); }
    catch (err) { setError(errorText(err)); setConsentPending(true); refresh(); status.refresh(); }
    finally { setBusy(false); }
  }
  async function start(mode: Modality) {
    const state = status.data;
    if (!state || !session.question || !session.consent?.[mode]) return;
    setBusy(true); setError(''); const generation = actionGeneration.current; const device = ++deviceGeneration.current[mode];
    try {
      const receipt = await bounded(convex.mutation(api.capture.start, { token }));
      const liveStatus = await bounded(convex.query(api.capture.status, { token }));
      if (!alive.current || generation !== actionGeneration.current || device !== deviceGeneration.current[mode] || current.current.state !== 'active' || !current.current.consent?.[mode]) return;
      uploadAdmission.current[mode] = new AbortController();
      await capture.current![mode].start({ mode, startedAt: receipt.startedAt, deadline: receipt.deadline, sequence: liveStatus.nextSequence[mode], lastEnd: liveStatus.nextStartMs[mode], questionId: session.question.id });
      status.refresh();
    } catch (err) { setError(errorText(err)); status.refresh(); }
    finally { setBusy(false); }
  }
  async function endRecording() {
    setBusy(true); setError(''); await stop();
    try { await convex.mutation(api.capture.stop, { token }); status.refresh(); }
    catch (err) { setError(errorText(err)); status.refresh(); }
    finally { setBusy(false); }
  }
  async function openDom() {
    const state = status.data;
    if (!state?.domPolicy || !session.prototypeUrl || domPending.current || uncertainConnect.current) return;
    // The exact prototype is opened directly; invitation capability is never sent.
    const popup = window.open(session.prototypeUrl, 'corvo-controlled-prototype');
    if (!popup) { setError('Allow this study’s prototype tab to open, then connect again.'); return; }
    setBusy(true); setError(''); const generation = ++actionGeneration.current;
    try {
      const old = stopDom() ?? retainedConnection();
      if (old) { await bounded(convex.mutation(api.capture.disconnectDom, { token, challenge: old.challenge })); keepConnection(null); }
      const receipt = await convex.mutation(api.capture.start, { token });
      if (!alive.current || generation !== actionGeneration.current || current.current.state !== 'active' || !current.current.consent?.dom) return;
      const challenge = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
      uncertainConnect.current = { origin: state.domPolicy.origin, challenge }; keepConnection(uncertainConnect.current);
      const connected = await bounded(convex.mutation(api.capture.connectDom, { token, ...uncertainConnect.current }));
      uncertainConnect.current = null;
      if (!alive.current || generation !== actionGeneration.current || current.current.state !== 'active' || !current.current.consent?.dom) { popup.postMessage({ type: 'corvo-dom-stop', challenge }, state.domPolicy.origin); return; }
      let stopped = false, received = 0, handshaken = false;
      const send = () => popup.postMessage({ type: 'corvo-dom-connect', challenge, offsetMs: Math.max(0, Math.round(Date.now() - receipt.startedAt)), startSequence: connected.nextSequence }, state.domPolicy!.origin);
      const listener = (event: MessageEvent) => {
        if (stopped || bridge.current?.challenge !== challenge) return;
        const accepted = acceptPrototypeMessage(event, { window: popup, origin: state.domPolicy!.origin, challenge });
        if (!accepted || received >= 25) return;
        if (accepted.kind === 'connected') handshaken = true; // bounded queue, stop instead of silently dropping
        received++;
        domWork.current = domWork.current.then(async () => {
          received--;
          if (stopped || bridge.current?.challenge !== challenge || !current.current.consent?.dom || current.current.state !== 'active') return;
          const pending = { challenge, origin: state.domPolicy!.origin, requestId: crypto.randomUUID(), events: [accepted] };
          domPending.current = pending;
          await bounded(convex.mutation(api.capture.appendDom, { token, ...pending }));
          domPending.current = null;
          if (alive.current) setDomState('Controlled page activity is connected.');
        }).catch(() => { if (domPending.current?.challenge === challenge && current.current.consent?.dom) { if (bridge.current?.challenge === challenge) stopDom(); if (alive.current) setDomState('Page activity stopped with an unconfirmed source. Check the original result.'); } });
        if (received >= 25) stopDom();
      };
      window.addEventListener('message', listener);
      const handshake = window.setInterval(() => { if (popup.closed) { const old = stopDom(); if (old) void convex.mutation(api.capture.disconnectDom, { token, challenge: old.challenge }).catch(() => undefined); return; } if (!handshaken && received === 0 && !domPending.current) send(); }, 1000);
      const timeout = window.setTimeout(() => { if (!handshaken) { if (alive.current) setDomState('Waiting for the controlled prototype. Reconnect if its page was reloaded.'); } }, 10_000);
      const deadline = window.setTimeout(() => { stopDom(); }, Math.max(0, receipt.deadline - Date.now()));
      bridge.current = { window: popup, origin: state.domPolicy.origin, challenge, remove: () => { stopped = true; window.removeEventListener('message', listener); clearInterval(handshake); clearTimeout(timeout); clearTimeout(deadline); } };
      setDomState('Connecting the controlled prototype…'); send(); status.refresh();
    } catch (err) { stopDom(); setError(errorText(err)); }
    finally { setBusy(false); }
  }
  const activeModes = modes.filter(mode => ['requesting', 'recording'].includes(snapshots[mode].phase));
  const pending = modes.reduce((count, mode) => count + snapshots[mode].pending, 0);
  const disabled = busy || consentPending || session.state !== 'active';
  return <section className="research-capture" aria-label="Optional research recording">
    <div className="section-heading"><h2>Optional recording</h2><span className="capture-state" role="status">{activeModes.length ? `Recording: ${activeModes.join(', ')}` : 'Devices off'}</span></div>
    <p className="muted">You can answer every question in text. Choose each recording permission separately. Screen sharing can show any page you choose; page activity is available only on the study’s authorized prototype.</p>
    <fieldset disabled={busy || consentPending}><legend>Allow Corvo Labs to record for this study</legend>
      {(['microphone', 'camera', 'screen', 'dom'] as const).map(track => <label className="check" key={track}><input type="checkbox" checked={!!session.consent?.[track]} onChange={event => void consent(track, event.target.checked)} /><span>{track === 'dom' ? 'Masked activity on the controlled prototype' : track === 'microphone' ? 'Microphone audio' : track === 'camera' ? 'Camera video' : 'The screen or tab I choose'}</span></label>)}
    </fieldset>
    {consentPending && <Notice>A permission change may already be saved. The affected recording is stopped.<button className="secondary" onClick={() => { setBusy(true); void bounded(convex.query(api.participant.resume, { token })).then(() => { refresh(); status.refresh(); setConsentPending(false); }).catch(() => setError('Saved permissions are still unconfirmed. The affected recording remains stopped.')).finally(() => setBusy(false)); }}>Check saved permissions</button></Notice>}
    {session.state === 'active' && <div className="capture-tracks">{modes.map(mode => {
      const snapshot = snapshots[mode];
      const live = snapshot.phase === 'requesting' || snapshot.phase === 'recording';
      const label = mode === 'screen' ? 'Screen sharing' : mode === 'camera' ? 'Camera' : 'Microphone';
      return <div className="capture-track" key={mode}><div><strong>{label}</strong><p className="muted" role="status">{snapshot.phase === 'requesting' ? 'Awaiting browser permission' : snapshot.phase === 'recording' ? 'Recording' : snapshot.phase === 'saving' ? 'Saving sources' : snapshot.phase === 'unconfirmed' ? 'Stopped · result unconfirmed' : 'Off'}</p></div><div className="actions">
        <button className="secondary" disabled={disabled || live || !!snapshot.pending || !session.question || !session.consent?.[mode] || !status.data || ['stopped', 'purging', 'purged'].includes(status.data.recording)} onClick={() => void start(mode)}>Start {mode === 'screen' ? 'screen sharing' : mode}</button>
        {(live || snapshot.pending > 0) && <button className="text-button" onClick={() => { void capture.current![mode].stop(); }}>Stop {mode === 'screen' ? 'screen sharing' : mode}</button>}
        {snapshot.phase === 'unconfirmed' && <button className="secondary" disabled={busy} onClick={() => void capture.current![mode].recover()}>Check original {mode} recording</button>}
      </div>{snapshot.message && <p className="capture-message" role="status">{snapshot.message}</p>}</div>;
    })}{(activeModes.length > 0 || pending > 0 || status.data?.recording === 'active') && <button className="secondary" onClick={() => void endRecording()}>End all recording</button>}</div>}
    {pending > 0 && <p className="muted">Keep this tab open until recording sources are confirmed. Unconfirmed recording does not prevent text answers.</p>}
    {session.state !== 'active' && modes.filter(mode => snapshots[mode].phase === 'unconfirmed').map(mode => <button key={mode} className="secondary" disabled={busy} onClick={() => void capture.current![mode].recover()}>Check original {mode} recording</button>)}
    {session.consent?.dom && <div className="dom-controls"><p role="status">{domState}</p>{uncertainConnect.current && <button className="secondary" disabled={busy} onClick={async () => { const pending = uncertainConnect.current; if (!pending) return; setBusy(true); try { await convex.mutation(api.capture.connectDom, { token, ...pending }); await convex.mutation(api.capture.disconnectDom, { token, challenge: pending.challenge }); uncertainConnect.current = null; setDomState('Connection state confirmed. Reconnect to continue.'); } catch { setDomState('Connection state is still unconfirmed.'); } finally { setBusy(false); } }}>Check original connection</button>}{status.data?.domPolicy ? <button className="secondary" disabled={disabled || !!domPending.current || !!uncertainConnect.current} onClick={() => void openDom()}>Connect controlled prototype</button> : <p className="muted">The operator has not authorized page activity for this study.</p>}{bridge.current && <button className="text-button" onClick={() => { const old = stopDom(); if (old) void convex.mutation(api.capture.disconnectDom, { token, challenge: old.challenge }).catch(() => setError('Page activity stopped locally; reconnect state is unconfirmed.')); }}>Stop page activity</button>}{domPending.current && <button className="secondary" onClick={async () => { const pending = domPending.current; if (!pending) return; try { await bounded(convex.mutation(api.capture.appendDom, { token, ...pending })); domPending.current = null; setDomState('Original page activity source confirmed. Reconnect to continue.'); } catch { setDomState('Page activity source is still unconfirmed.'); } }}>Check original page activity</button>}</div>}
    {(error || status.error) && <Notice error>{error || status.error}</Notice>}
  </section>;
}
