import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PatientApp } from '../PatientApp';
import type { CaptureMediaSource } from '../useSpeechCapture';
import '../styles.css';

if (!import.meta.env.DEV || location.origin !== 'http://localhost:5190') throw new Error('Development fixture unavailable');
let pulse: (() => void) | undefined;
const mediaSource: CaptureMediaSource = async context => {
  const oscillator = context.createOscillator(), gain = context.createGain(), destination = context.createMediaStreamDestination();
  oscillator.frequency.value = 440; gain.gain.value = 0;
  oscillator.connect(gain); gain.connect(destination); oscillator.start();
  const send = () => { gain.gain.cancelScheduledValues(context.currentTime); gain.gain.setValueAtTime(.08, context.currentTime); gain.gain.setValueAtTime(0, context.currentTime + .45); };
  pulse = send;
  return { stream: destination.stream, dispose() { if (pulse === send) pulse = undefined; oscillator.stop(); oscillator.disconnect(); gain.disconnect(); destination.disconnect(); } };
};
const originalPhrases = [
  'I want more energy for walks with my family.',
  'My priority is playing outside with my children.',
  'I do not have any specific symptoms to discuss today.',
];
function Fixture() {
  const [phrase, setPhrase] = useState('0'), [message, setMessage] = useState('Ready. Start the fictional patient flow, then enable voice.'), [report, setReport] = useState('');
  const [fixture, setFixture] = useState<{ id: string; mode: string; phrases: string[] }>();
  const phrases = fixture?.phrases ?? originalPhrases;
  useEffect(() => { let current = true; void fetch('/api/fixture/config').then(async response => { if (!response.ok) throw new Error('Fixture configuration unavailable'); const config = await response.json(); if (current) setFixture(config); }).catch(() => { if (current) setMessage('Fixture server unavailable; start the matching local fixture before validation.'); }); return () => { current = false; }; }, []);
  const control = async (action: string) => {
    try {
      if (action === 'pulse' && !pulse) throw new Error('Start or resume voice capture first.');
      const response = await fetch('/api/fixture/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, phrase: Number(phrase) }) });
      if (!response.ok) throw new Error('Fixture control denied; confirm the fictional patient first.');
      if (action === 'pulse') pulse?.();
      if (action === 'prepare-phq' || action === 'prepare-height') { location.reload(); return; }
      setMessage(action === 'pulse' ? `Synthetic pulse sent. Expected recognized words: ${phrases[Number(phrase)]}` : action === 'release-tail' ? 'The synthetic full draft tail was released. Inspect durable evidence after settlement.' : 'The local fake transcription connection was interrupted. No automatic reconnect should occur.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Fixture control failed.'); }
  };
  const inspect = async () => {
    const response = await fetch('/api/fixture/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    setReport(JSON.stringify(await response.json(), null, 2));
  };
  return <><aside style={{ borderBottom: '3px solid #c28254', padding: '16px 24px', background: '#fff6e8' }} aria-label="Development fixture controls"><strong>DEV ONLY · Synthetic voice integration</strong><p>Local generated signal replaces the microphone. Local fake STT, deterministic interpretation, and a tone replace providers. Real signed session, durable Medplum storage, authorization and admission remain active. The tone does not represent spoken answer quality or human latency.</p>{fixture?.mode === 'choice-tail' && <p>Fixture {fixture.id}: only the listed exact synthetic words are injected. PHQ controls select the approved item through the real server contract. The authored full source emits a synthetic advance and holds its draft tail for at most 12 seconds. Stop voice before selecting a fixture topic; selecting reloads the app and requires persona confirmation again. This is rendered mechanics evidence only.</p>}<label>Synthetic utterance <select value={phrase} onChange={event => setPhrase(event.target.value)}>{phrases.map((text, index) => <option key={text} value={index}>{text}</option>)}</select></label><div className="button-row"><button onClick={() => void control('pulse')}>Send synthetic utterance</button><button onClick={() => void control('disconnect')}>Disconnect fake transcription</button><button onClick={() => void inspect()}>Inspect fixture evidence</button>{fixture?.mode === 'choice-tail' && <><button onClick={() => void control('prepare-height')}>Select height topic and reload</button><button onClick={() => void control('prepare-phq')}>Select PHQ item and reload</button><button onClick={() => void control('release-tail')}>Release synthetic draft tail</button></>}</div><p role="status">{message}</p>{report && <pre style={{ maxHeight: 240, overflow: 'auto', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{report}</pre>}</aside><PatientApp captureMediaSource={mediaSource} /></>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
