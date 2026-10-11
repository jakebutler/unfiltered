import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReactElement } from 'react';
import { ResearchSpeech } from '../src/ResearchSpeech';
const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as any[], effects: [] as (() => void)[] }));
const ports = vi.hoisted(() => ({ capture: { active: false, status: 'listening', message: '', interim: '', slow: false, start: vi.fn(async () => {}), stop: vi.fn(), finish: vi.fn() }, playback: { status: 'idle', message: '', slow: false, start: vi.fn(async () => {}), stop: vi.fn(), playPrepared: vi.fn() }, barge: { start: vi.fn(async () => {}), stop: vi.fn(), take: vi.fn(() => []) }, captureArgs: null as any }));
vi.mock('react', async importOriginal => ({ ...await importOriginal<any>(),
  useRef(value: unknown) { const index = hooks.cursor++; return hooks.values[index] ??= { current: value }; },
  useState(value: unknown) { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = value; return [hooks.values[index], (next: any) => { hooks.values[index] = typeof next === 'function' ? next(hooks.values[index]) : next; }]; },
  useEffect(callback: () => void | (() => void), dependencies: unknown[]) { const index = hooks.cursor++; const prior = hooks.values[index]; if (!prior || dependencies.some((value, n) => value !== prior.dependencies[n])) hooks.effects.push(() => { prior?.cleanup?.(); hooks.values[index] = { dependencies, cleanup: callback() }; }); },
}));
vi.mock('../src/useResearchSpeechCapture', () => ({ useResearchSpeechCapture: (args: unknown) => { ports.captureArgs = args; return ports.capture; } }));
vi.mock('../src/useResearchSpeechPlayback', () => ({ useResearchSpeechPlayback: () => ports.playback }));
vi.mock('../src/useResearchBargeIn', () => ({ useResearchBargeIn: () => ports.barge }));
function render(props: Parameters<typeof ResearchSpeech>[0]) { hooks.cursor = 0; hooks.effects = []; const tree = ResearchSpeech(props); for (const effect of hooks.effects) effect(); return tree; }
function button(tree: unknown, label: string): ReactElement<any> | undefined {
  if (Array.isArray(tree)) { for (const child of tree) { const found = button(child, label); if (found) return found; } return; }
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return;
  const node = tree as ReactElement<any>; if (node.type === 'button' && node.props.children === label) return node; return button(node.props.children, label);
}
function fixture() {
  const track = { readyState: 'live', stop: vi.fn() }, stream = { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  const props: Parameters<typeof ResearchSpeech>[0] = { token: 'a'.repeat(64), session: { sessionId: 'session-one', state: 'active', revision: 1, consent: { microphone: true }, question: { id: 'q1', question: 'First?' } } as any, draft: '', blocked: false, controls: { current: null }, captureControls: { current: { microphoneStream: () => stream } as any }, onDraft: vi.fn(), onReceipt: vi.fn(), onResetSpeech: vi.fn(), onActivity: vi.fn(), onCommitted: vi.fn(), onMicrophoneConsent: vi.fn() };
  return { props, track };
}
beforeEach(() => { hooks.cursor = 0; hooks.values = []; hooks.effects = []; vi.clearAllMocks(); ports.playback.status = 'idle'; vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false })); });
afterEach(() => { for (const value of hooks.values) value?.cleanup?.(); vi.unstubAllGlobals(); });
test('automatic spoken commit precedes next-prompt buffered playback and pending adaptive question keeps loop waiting', async () => {
  const f = fixture(), paths: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string) => { paths.push(path); return new Response(JSON.stringify(path.endsWith('status') ? { enabled: true, continuous: true } : path.endsWith('settlement') ? { transportSettled: true } : { attemptId: ports.captureArgs.getScope()?.requestId, rawSourceId: 'raw-1', answerSourceId: 'answer-2', acceptedRevision: 2 }), { headers: { 'Content-Type': 'application/json' } }); }));
  render(f.props); await new Promise(resolve => setTimeout(resolve, 0));
  let tree = render(f.props); button(tree, 'Speak instead')!.props.onClick(); tree = render(f.props);
  await button(tree, 'Talk through the interview')!.props.onClick(); render(f.props);
  expect(ports.capture.start).not.toHaveBeenCalled();
  expect(ports.playback.start).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'q1', expectedRevision: 1 }), { buffered: true });
  const preparing = render(f.props);
  expect(JSON.stringify(preparing)).toContain('Preparing question audio; spoken answer capture off.');
  expect(JSON.stringify(preparing)).not.toContain('question audio on.');
  expect(ports.barge.start).not.toHaveBeenCalled();
  ports.playback.status = 'finished'; render(f.props); await new Promise(resolve => setTimeout(resolve, 0)); render(f.props);
  expect(ports.capture.start).toHaveBeenCalledWith(expect.objectContaining({ conversation: true })); ports.playback.start.mockClear();
  const scope = ports.captureArgs.getScope(); ports.captureArgs.onReceipt({ ...scope, attemptId: scope.requestId, text: 'My original words', rawSourceId: 'raw-1' });
  ports.captureArgs.onEvent({ type: 'completed', clean: true, scope });
  await new Promise(resolve => setTimeout(resolve, 0)); render(f.props);
  expect(f.props.onCommitted).toHaveBeenCalledOnce(); expect(ports.playback.start).not.toHaveBeenCalled();
  f.props.session = { ...f.props.session, revision: 2, question: undefined, pendingInterview: { scope: { requestId: 'adaptive-1' } } } as any; render(f.props);
  expect(ports.playback.start).not.toHaveBeenCalled();
  f.props.session = { ...f.props.session, revision: 3, pendingInterview: undefined, question: { id: 'q2', question: 'Second?' } } as any; render(f.props);
  expect(ports.playback.start).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'q2', expectedRevision: 3 }), { buffered: true });
  expect(paths).toEqual(['/api/research/speech/status', '/api/research/speech/settlement', '/api/research/speech/commit']); expect(f.track.stop).not.toHaveBeenCalled();
});
test('type switch silences question audio and stops conversational capture without stopping borrowed recorder', async () => {
  const f = fixture(); vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ enabled: true, continuous: true }))));
  render(f.props); await new Promise(resolve => setTimeout(resolve, 0)); const tree = render(f.props);
  ports.capture.stop.mockClear(); ports.playback.stop.mockClear(); button(tree, 'Type answers')!.props.onClick();
  expect(ports.playback.stop).toHaveBeenCalledOnce(); expect(ports.capture.stop).toHaveBeenCalledOnce(); expect(ports.barge.stop).toHaveBeenCalled(); expect(f.track.stop).not.toHaveBeenCalled();
});
