/** Explicit DEV entry, absent from the normal Vite build's index.html graph. */
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { ConvexReactClient, useConvex, useConvexAuth } from 'convex/react';
import { ConvexAuthProvider, useAuthActions } from '@convex-dev/auth/react';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import { ResearchCapture, type CaptureControls } from '../src/ResearchCapture';
import { CaptureSources } from '../src/CaptureSources';
import type { BrowserCaptureDevices } from '../src/capture-browser';
import { useRead } from '../src/data';
import '../src/styles.css';

const origin = 'http://127.0.0.1:5174';
const allowed = import.meta.env.DEV && location.origin === origin;
const consent = { version: 'research-consent-1' as const, storage: true, analysis: true, microphone: true, camera: true, screen: true, dom: true, shareTranscript: false, shareAudio: false, shareCamera: false, shareScreen: false, retainApprovedExcerpts: false };
type Fixture = { token: string; clientId: Id<'researchClients'>; projectId: Id<'researchProjects'>; sessionId: Id<'researchSessions'> };

function App() {
  const convex = useConvex();
  const { isAuthenticated } = useConvexAuth();
  const { signIn, signOut } = useAuthActions();
  const [message, setMessage] = useState('Import the existing private local operator file to sign in.');
  const [busy, setBusy] = useState(false);
  const [creationAttempted, setCreationAttempted] = useState(false);
  const [fixture, setFixture] = useState<Fixture | null>(null);
  const [devices, setDevices] = useState<BrowserCaptureDevices | null>(null);
  const controls = useRef<CaptureControls | null>(null);
  const releaseSynthetic = useRef<(() => void) | null>(null);
  const syntheticGeneration = useRef(0), enabling = useRef(false), alive = useRef(true);
  const session = useRead(api.participant.resume, fixture ? { token: fixture.token } : null);
  // Credentials exist only in this handler, never React state/DOM/log/storage.
  async function login(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget, file = input.files?.[0]; input.value = '';
    if (!file || file.size > 65_536) { setMessage('Private local operator file unavailable.'); return; }
    let contents = '', email = '', password = '', credentials: Record<string, unknown> | null = null;
    setBusy(true);
    try {
      contents = await file.text(); credentials = JSON.parse(contents); contents = '';
      if (!credentials || typeof credentials !== 'object' || Object.keys(credentials).some(key => !['email', 'password', 'name', 'privateKey', 'jwks'].includes(key)) || typeof credentials.email !== 'string' || credentials.email.length > 254 || typeof credentials.password !== 'string' || !credentials.password || credentials.password.length > 4096) throw new Error('Invalid local operator file');
      email = credentials.email; password = credentials.password; credentials = null;
      await signIn('password', { flow: 'signIn', email, password });
      setMessage('Existing local operator signed in; imported file discarded.');
    } catch { setMessage('Local sign-in failed or is unconfirmed. No automatic retry.'); }
    finally { contents = ''; email = ''; password = ''; credentials = null; input.value = ''; setBusy(false); }
  }
  async function create() {
    if (creationAttempted) return;
    setCreationAttempted(true);
    setBusy(true); setMessage('Creating one synthetic study through normal authenticated functions…');
    try {
      const id = crypto.randomUUID();
      const clientId = await convex.mutation(api.research.createClient, { name: `Browser capture ${id}` });
      const projectId = await convex.mutation(api.research.createProject, { clientId, name: 'Local synthetic browser qualification' });
      const study = await convex.mutation(api.research.saveStudy, { clientId, projectId, expectedRevision: 0, definition: { title: 'Synthetic browser capture', introduction: 'Generated canvas/audio only. No human device capture.', goals: ['Local capture boundaries'], script: [{ id: 'q1', question: 'Synthetic first question?' }], prototypeUrl: `${origin}/fixtures/prototype.html`, repository: null } });
      await convex.mutation(api.capture.authorizePrototype, { clientId, projectId, studyId: study.studyId, origin, componentIds: ['c1'] });
      const invitation = await convex.action(api.invitations.create, { clientId, projectId, studyVersion: 1, requestId: `browser-${id}` });
      if (!invitation.token) throw new Error('Invitation result unconfirmed');
      await convex.mutation(api.participant.agree, { token: invitation.token, expectedRevision: 0, consent });
      setFixture({ token: invitation.token, clientId, projectId, sessionId: invitation.sessionId });
      setMessage('Synthetic study ready; enable generated sources explicitly.');
    } catch { setMessage('Fixture creation failed or is unconfirmed. Do not resubmit; inspect the original state.'); }
    finally { setBusy(false); }
  }
  async function enable() {
    if (enabling.current || releaseSynthetic.current || !alive.current) return;
    enabling.current = true; const generation = ++syntheticGeneration.current; setBusy(true);
    let audio: AudioContext | null = null;
    try {
    audio = new AudioContext(); const contextAudio = audio;
    releaseSynthetic.current = () => { void contextAudio.close().catch(() => undefined); };
    await audio.resume();
    if (!alive.current || generation !== syntheticGeneration.current) { void audio.close().catch(() => undefined); return; }
    const disposers = new Set<() => void>(); let closed = false;
    const synthetic: BrowserCaptureDevices = {
      supports: mime => MediaRecorder.isTypeSupported(mime),
      recorder: (stream, options) => new MediaRecorder(stream, options),
      stream: async mode => {
        if (closed) throw new Error('Synthetic sources closed');
        let stream: MediaStream, dispose: () => void;
        if (mode === 'microphone') {
          const destination = contextAudio.createMediaStreamDestination(), oscillator = contextAudio.createOscillator();
          oscillator.frequency.value = 440; oscillator.connect(destination); oscillator.start(); stream = destination.stream;
          dispose = () => { oscillator.stop(); oscillator.disconnect(); destination.disconnect(); };
        } else {
          const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
          const context = canvas.getContext('2d')!; let frame = 0;
          const draw = () => { context.fillStyle = mode === 'camera' ? '#223c59' : '#5a293c'; context.fillRect(0, 0, 320, 180); context.fillStyle = 'white'; context.font = '22px sans-serif'; context.fillText(`Synthetic ${mode} ${frame++}`, 12, 90); };
          draw(); const timer = window.setInterval(draw, 100);
          try { stream = canvas.captureStream(10); } catch { window.clearInterval(timer); throw new Error('Synthetic canvas unavailable'); }
          dispose = () => window.clearInterval(timer);
        }
        let stopped = false;
        const tracks = stream.getTracks(), originalStops = tracks.map(track => track.stop.bind(track));
        const release = () => { if (stopped) return; stopped = true; originalStops.forEach(stop => stop()); dispose(); disposers.delete(release); };
        tracks.forEach(track => { track.stop = release; }); disposers.add(release);
        return stream;
      },
    };
    releaseSynthetic.current = () => { closed = true; disposers.forEach(dispose => dispose()); void contextAudio.close().catch(() => undefined); };
    setDevices(synthetic); setMessage('Generated canvas/video and oscillator/audio enabled. Human device APIs are not used.');
    } catch { if (audio) void audio.close().catch(() => undefined); releaseSynthetic.current = null; throw new Error('Synthetic sources unavailable'); }
    finally { enabling.current = false; if (alive.current) setBusy(false); }
  }
  useEffect(() => { alive.current = true; const release = () => { alive.current = false; syntheticGeneration.current++; void controls.current?.stop(false); releaseSynthetic.current?.(); releaseSynthetic.current = null; }; window.addEventListener('pagehide', release); return () => { window.removeEventListener('pagehide', release); release(); }; }, []);
  async function transition(state: 'active' | 'paused') {
    if (!fixture || !session.data) return;
    setBusy(true);
    try { if (state !== 'active') await controls.current?.stop(); await convex.mutation(api.participant.transition, { token: fixture.token, expectedRevision: session.data.revision, state }); session.refresh(); }
    catch { setMessage('Transition failed or is unconfirmed. Check the original session.'); }
    finally { setBusy(false); }
  }
  return <main id="main" style={{ maxWidth: 1100, margin: 'auto', padding: 24 }}>
    <h1>Local synthetic capture qualification</h1><p>DEV only · fixed research origin 5174/backend 3210 · generated tracks, real recorder/auth/transport. No human camera, microphone or screen APIs.</p>
    <p role="status">{message}</p>
    {!isAuthenticated && <label>Import existing private local operator file<input type="file" accept=".json" disabled={busy} onChange={event => void login(event)} /></label>}
    {isAuthenticated && <button disabled={busy} onClick={() => void signOut()}>Sign out local operator</button>}
    {isAuthenticated && !fixture && <button disabled={busy || creationAttempted} onClick={() => void create()}>Create one synthetic study</button>}
    {fixture && !devices && <button disabled={busy} onClick={() => void enable().catch(() => setMessage('Synthetic sources unavailable.'))}>Enable generated media sources</button>}
    {fixture && devices && session.data && <>
      <button disabled={busy} onClick={async () => { setBusy(true); try { await controls.current?.stop(); } finally { releaseSynthetic.current?.(); releaseSynthetic.current = null; setDevices(null); setBusy(false); } }}>Disable generated sources</button>
      <p>Participant state: {session.data.state}</p>
      <button disabled={busy} onClick={() => void transition(session.data!.state === 'paused' ? 'active' : 'paused')}>{session.data.state === 'paused' ? 'Resume synthetic interview' : 'Pause synthetic interview'}</button>
      <ResearchCapture token={fixture.token} session={session.data} controls={controls} refresh={session.refresh} devices={devices} />
      <CaptureSources scope={{ clientId: fixture.clientId, projectId: fixture.projectId, sessionId: fixture.sessionId }} />
    </>}
    {session.error && <p role="alert">Synthetic session unavailable.</p>}
  </main>;
}
const root = createRoot(document.getElementById('root')!);
if (!allowed) root.render(<p>Local DEV fixture unavailable.</p>);
else { const client = new ConvexReactClient('http://127.0.0.1:3210', { logger: false }); root.render(<ConvexAuthProvider client={client}><App /></ConvexAuthProvider>); }
