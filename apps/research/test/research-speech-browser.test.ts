import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useResearchSpeechCapture } from '../src/useResearchSpeechCapture';

// Focused hook harness models refs, state and dependency cleanup; browser/audio
// ports are synthetic. It requires no DOM service, microphone or provider.
const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as any[], effects: [] as (() => void)[] }));
vi.mock('react', () => ({
  useRef(value: unknown) { const index = hooks.cursor++; return hooks.values[index] ??= { current: value }; },
  useState(value: unknown) { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = value; return [hooks.values[index], (next: any) => { hooks.values[index] = typeof next === 'function' ? next(hooks.values[index]) : next; }]; },
  useCallback(callback: unknown, dependencies: unknown[]) { const index = hooks.cursor++; const prior = hooks.values[index]; if (!prior || dependencies.some((value, n) => value !== prior.dependencies[n])) hooks.values[index] = { dependencies, callback }; return hooks.values[index].callback; },
  useEffect(callback: () => void | (() => void), dependencies: unknown[]) { const index = hooks.cursor++; const prior = hooks.values[index]; if (!prior || dependencies.some((value, n) => value !== prior.dependencies[n])) { hooks.effects.push(() => { prior?.cleanup?.(); hooks.values[index] = { dependencies, cleanup: callback() }; }); } },
}));
function render(args: Parameters<typeof useResearchSpeechCapture>[0]) { hooks.cursor = 0; hooks.effects = []; const value = useResearchSpeechCapture(args); for (const effect of hooks.effects) effect(); return value; }
beforeEach(() => { hooks.cursor = 0; hooks.values = []; hooks.effects = []; vi.useFakeTimers(); });
afterEach(() => { for (const value of hooks.values) value?.cleanup?.(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function fixture(owned = false) {
  const track = Object.assign(new EventTarget(), { readyState: 'live', stop: vi.fn() });
  track.stop.mockImplementation(() => { track.readyState = 'ended'; });
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const sockets: any[] = [], processors: any[] = [];
  class Socket extends EventTarget {
    static OPEN = 1; static CONNECTING = 0; readyState = 0; bufferedAmount = 0; sent: any[] = [];
    constructor(_url: unknown) { super(); sockets.push(this); }
    send(value: unknown) { this.sent.push(value); }
    close() { this.readyState = 3; }
  }
  class Context extends EventTarget {
    state = 'running'; sampleRate = 48000; destination = {}; audioWorklet = { addModule: vi.fn(async () => {}) };
    resume = vi.fn(async () => {}); close = vi.fn(async () => {});
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
  }
  class Worklet {
    port = { onmessage: null as any, postMessage: vi.fn(), close: vi.fn() };
    constructor(_context: unknown, _name: unknown, _options: unknown) { processors.push(this); }
    connect() {} disconnect() {}
  }
  const window = Object.assign(new EventTarget(), { location: { href: 'https://research.example/participate' }, isSecureContext: true, AudioContext: Context, AudioWorkletNode: Worklet, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
  vi.stubGlobal('window', window); vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
  vi.stubGlobal('AudioContext', Context); vi.stubGlobal('AudioWorkletNode', Worklet); vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
  let scope = { sessionId: 'session-001', promptId: 'q1', expectedRevision: 1, requestId: 'speech-attempt-001' }, text = '';
  const onText = vi.fn((value: string) => { text = value; }), bargeIn = vi.fn();
  const args = () => ({ token: 'a'.repeat(64), scopeKey: `${scope.promptId}:${scope.expectedRevision}`, getScope: () => scope, getText: () => text, onText, onInterruptPlayback: bargeIn, onReceipt: vi.fn(), mediaSource: async () => ({ stream, owned }) });
  const message = (value: unknown) => sockets[0].dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(value) }));
  async function ready() { const capture = render(args()); await capture.start(); const socket = sockets[0]; socket.readyState = 1; socket.dispatchEvent(new Event('open')); message({ type: 'ready', sampleRate: 16000, channels: 1, maxCaptureMs: 60_000 }); return capture; }
  const words = () => message({ type: 'recognition', segment: { text: 'original words', start: 0, duration: 1, isFinal: true, speechFinal: true } });
  return { track, processors, sockets, args, ready, words, message, onText, bargeIn, text: () => text, setText: (value: string) => { text = value; }, changeScope: () => { scope = { ...scope, promptId: 'q2', expectedRevision: 2 }; } };
}
test('finishing speech preserves borrowed recording microphone ownership', async () => {
  const f = fixture(false), capture = await f.ready(); f.words(); capture.finish();
  f.processors[0].port.onmessage({ data: { type: 'flushed' } });
  expect(f.track.stop).not.toHaveBeenCalled(); expect(f.sockets[0].sent.at(-1)).toBe('{"type":"finish"}');
  f.message({ type: 'ended', outcome: 'completed' }); expect(f.track.stop).not.toHaveBeenCalled(); expect(f.text()).toBe('original words');
});
test('owned speech microphone stops and local voice activity interrupts playback synchronously', async () => {
  const f = fixture(true), capture = await f.ready(); const before = f.bargeIn.mock.calls.length;
  f.processors[0].port.onmessage({ data: new Float32Array(2048).fill(0.1) });
  expect(f.bargeIn.mock.calls.length).toBe(before + 1); capture.stop(); expect(f.track.stop).toHaveBeenCalledOnce();
});
test('scope-change cleanup cannot publish old speech into a new question draft', async () => {
  const f = fixture(), capture = await f.ready(); f.words(); f.changeScope(); f.setText('typed answer for new question');
  f.onText.mockClear(); render(f.args());
  expect(f.onText).not.toHaveBeenCalled(); expect(f.text()).toBe('typed answer for new question');
  capture.stop(); expect(f.onText).not.toHaveBeenCalled();
});
test('parent stop-before-edit preserves typing and rejects late socket recognition', async () => {
  const f = fixture(), capture = await f.ready(); f.words(); capture.stop(); f.setText('my edited wording'); f.words();
  expect(f.text()).toBe('my edited wording');
});
test('conversation endpoint finishes automatically without stopping the shared recorder', async () => {
  const f = fixture(false), events = vi.fn(), args = { ...f.args(), onEvent: events };
  const capture = render(args); await capture.start({ conversation: true });
  f.sockets[0].readyState = 1; f.sockets[0].dispatchEvent(new Event('open'));
  f.message({ type: 'ready', sampleRate: 16000, channels: 1, maxCaptureMs: 60_000 }); f.words();
  expect(f.processors[0].port.postMessage).toHaveBeenCalledWith('finish');
  f.processors[0].port.onmessage({ data: { type: 'flushed' } });
  expect(f.sockets[0].sent.at(-1)).toBe('{"type":"finish"}');
  expect(f.track.stop).not.toHaveBeenCalled();
});
test('barge-in prelude sends only fresh bounded audio for the newly admitted turn', async () => {
  const f = fixture(false), capture = render(f.args());
  await capture.start({ conversation: true, prelude: () => [{ at: performance.now() - 1100, bytes: new Uint8Array([9, 9]) }, { at: performance.now(), bytes: new Uint8Array([1, 2]) }] });
  f.sockets[0].readyState = 1; f.sockets[0].dispatchEvent(new Event('open'));
  f.message({ type: 'ready', sampleRate: 16000, channels: 1, maxCaptureMs: 60_000 });
  const audio = f.sockets[0].sent.filter((value: unknown) => value instanceof Uint8Array);
  expect(audio).toEqual([new Uint8Array([1, 2])]); capture.stop(); expect(f.track.stop).not.toHaveBeenCalled();
});
