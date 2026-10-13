import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { useSpeechCapture, type CaptureMediaSource } from '../src/useSpeechCapture';
import type { CaptureScope } from '../src/voice-capture';

type Props = Parameters<typeof useSpeechCapture>[0];
const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
interface Slot { value?: unknown; set?: (next: unknown) => void; ref?: { current: unknown }; deps?: unknown[]; has?: boolean; effect?: () => void | (() => void); cleanup?: () => void }

/** Runs a hook with React's own dispatcher slot replaced by a small one: state, refs, memoized callbacks, and effects after each render. */
function mountHook<P, R>(hook: (props: P) => R, initial: P) {
  const slots: Slot[] = [];
  let props = initial, dirty = false, index = 0, queued: Slot[] = [], result!: R;
  const same = (a?: unknown[], b?: unknown[]) => Boolean(a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i])));
  const dispatcher = {
    useState(init: unknown) {
      const slot = (slots[index++] ??= {});
      if (!slot.set) {
        slot.value = typeof init === 'function' ? (init as () => unknown)() : init;
        slot.set = (next: unknown) => { slot.value = typeof next === 'function' ? (next as (value: unknown) => unknown)(slot.value) : next; dirty = true; };
      }
      return [slot.value, slot.set];
    },
    useRef(init: unknown) { const slot = (slots[index++] ??= { ref: { current: init } }); return slot.ref; },
    useCallback(fn: unknown, deps: unknown[]) {
      const slot = (slots[index++] ??= {});
      if (!slot.has || !same(slot.deps, deps)) { slot.value = fn; slot.deps = deps; slot.has = true; }
      return slot.value;
    },
    useEffect(effect: () => void | (() => void), deps: unknown[]) {
      const slot = (slots[index++] ??= {});
      if (!slot.has || !same(slot.deps, deps)) { slot.effect = effect; slot.deps = deps; slot.has = true; queued.push(slot); }
    },
  };
  const render = () => {
    for (let pass = 0; pass < 20; pass++) {
      dirty = false; index = 0; queued = [];
      const previous = internals.H; internals.H = dispatcher;
      try { result = hook(props); } finally { internals.H = previous; }
      for (const slot of queued) { slot.cleanup?.(); const cleanup = slot.effect!(); slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined; }
      if (!dirty) return;
    }
    throw new Error('render did not settle');
  };
  render();
  return {
    get value() { if (dirty) render(); return result; },
    setProps(next: P) { props = next; render(); },
    unmount() { for (const slot of slots) { slot.cleanup?.(); slot.cleanup = undefined; } },
  };
}

/** Fake browser audio: 16 kHz context, one worklet that answers finish with a flushed marker, and a stream with one track. */
class FakeAudioContext extends EventTarget {
  state = 'suspended'; sampleRate = 16000; destination = {};
  audioWorklet = { addModule: async () => undefined };
  resume() { this.state = 'running'; return Promise.resolve(); }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
  close() { this.state = 'closed'; return Promise.resolve(); }
}
let worklet: FakeWorklet | undefined;
class FakeWorklet {
  port: { onmessage: ((event: { data: unknown }) => void) | null; postMessage(value: unknown): void; close(): void };
  constructor() {
    worklet = this;
    this.port = {
      onmessage: null,
      postMessage: value => { if (value === 'finish') queueMicrotask(() => this.port.onmessage?.({ data: { type: 'flushed' } })); },
      close() {},
    };
  }
  connect() {}
  disconnect() {}
}

type Responder = (init: RequestInit) => Promise<Response>;
const ok = (text: string): Responder => () => Promise.resolve(new Response(JSON.stringify({ text }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
const failNetwork: Responder = () => Promise.reject(new TypeError('network down'));
const failServer: Responder = () => Promise.resolve(new Response(JSON.stringify({ error: { code: 'speech-unavailable', message: 'x', retryable: false } }), { status: 503 }));

const notices = {
  stopped: 'Recording stopped. We transcribed what you said so far; check it before sending.',
  hidden: 'Recording stopped when this page was hidden. We transcribed what you said so far; check it before sending.',
  changed: 'The question changed while you were recording. Nothing has been sent; check the words below before continuing.',
  limit: 'Recording stops after about a minute. We transcribed what you said.',
  kept: 'Transcription did not finish. Your recording is kept until you try again or discard it. Your typed words are unchanged.',
  discarded: 'Recording discarded. Nothing was transcribed.',
  noWords: 'No words were transcribed. Type your answer or dictate again.',
};

let now = 0;
let responders: Responder[] = [];
let posts: { url: string; body: Uint8Array }[] = [];
let scope: CaptureScope;
let text: string;
let track: EventTarget & { stop(): void };
const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
  posts.push({ url, body: init.body as Uint8Array });
  const next = responders.shift();
  if (!next) throw new Error('unexpected transcription request');
  return next(init);
});
const onText = vi.fn();
const onInterruptPlayback = vi.fn();
const mediaSource: CaptureMediaSource = async () => ({ stream: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream });
let doc = Object.assign(new EventTarget(), { hidden: false });

function props(overrides: Partial<Props> = {}): Props {
  return { getScope: () => scope, getText: () => text, onText, onInterruptPlayback, scopeKey: 'Q01', mediaSource, input: 'upload', ...overrides };
}
const drain = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
/** Advances fake time and feeds 16 kHz microphone frames as the worklet would. */
async function speak(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    now += 100;
    worklet!.port.onmessage?.({ data: new Float32Array(1600).fill(0.1) });
    await vi.advanceTimersByTimeAsync(100);
  }
}
async function recording(overrides?: Partial<Props>) {
  const view = mountHook(useSpeechCapture, props(overrides));
  await view.value.start();
  await vi.advanceTimersByTimeAsync(1);
  await drain();
  expect(view.value.status).toBe('listening');
  return view;
}
/** Recognition and the final ended event both report the same transcript, so compare distinct values. */
const transcribedTexts = () => [...new Set(onText.mock.calls.filter(call => call[1] === true).map(call => call[0]))];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  now = 0; responders = []; posts = []; text = ''; worklet = undefined;
  scope = { sessionId: 'session', promptId: 'Q01', expectedRevision: 7, requestId: 'answer-1' };
  track = Object.assign(new EventTarget(), { stop() {} });
  onText.mockClear(); onInterruptPlayback.mockClear(); fetchMock.mockClear(); doc = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    isSecureContext: true, AudioContext: FakeAudioContext, AudioWorkletNode: FakeWorklet, location: { href: 'https://clinic.example/patient' },
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms), clearTimeout: (id?: number) => clearTimeout(id),
  }));
  vi.stubGlobal('document', doc);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorklet);
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('useSpeechCapture in upload mode', () => {
  it('transcribes the audio captured before Stop into an unsent draft', async () => {
    responders = [ok('I have a headache')];
    const view = await recording();
    await speak(2000);
    view.value.stop();
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(posts[0].url).toContain('promptId=Q01');
    expect(posts[0].body.byteLength).toBe(64000);
    expect(onText).toHaveBeenLastCalledWith('I have a headache', true, undefined);
    expect(view.value.status).toBe('review');
    expect(view.value.message).toBe(notices.stopped);
  });

  it('transcribes the audio when the page is hidden', async () => {
    responders = [ok('Hidden words')];
    const view = await recording();
    await speak(1000);
    doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(transcribedTexts()).toEqual(['Hidden words']);
    expect(view.value.message).toBe(notices.hidden);
  });

  it('transcribes the audio when the microphone track ends', async () => {
    responders = [ok('Track words')];
    const view = await recording();
    await speak(1000);
    track.dispatchEvent(new Event('ended'));
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(transcribedTexts()).toEqual(['Track words']);
    expect(view.value.message).toBe('Microphone access ended. We transcribed what you said so far; check it before sending.');
  });

  it('keeps the transcript as an unsent draft when the question changes during recording', async () => {
    responders = [ok('Keep this')];
    const view = await recording();
    await speak(1000);
    scope = { ...scope, promptId: 'Q02', expectedRevision: 8 };
    view.setProps(props({ scopeKey: 'Q02' }));
    await drain();
    expect(posts[0].url).toContain('promptId=Q01');
    expect(onText).toHaveBeenLastCalledWith('Keep this', true, undefined);
    expect(view.value.status).toBe('review');
    expect(view.value.message).toBe(notices.changed);
  });

  it('transcribes at the 59 second cap and posts the clip once', async () => {
    responders = [ok('Long words')];
    const view = await recording();
    await speak(59_000);
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(posts[0].body.byteLength).toBe(59 * 32000);
    expect(transcribedTexts()).toEqual(['Long words']);
    expect(view.value.message).toBe(notices.limit);
  });

  it('posts nothing when Stop comes before any audio was captured', async () => {
    const view = await recording();
    view.value.stop();
    await drain();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(view.value.status).toBe('review');
    expect(view.value.message).toBe(notices.noWords);
  });

  it('retries a failed transcription once, then keeps the recording until the patient retries', async () => {
    responders = [failNetwork, failNetwork];
    const view = await recording();
    await speak(1000);
    view.value.stop();
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(view.value.retained).toBe(true);
    expect(view.value.status).toBe('retained');
    expect(view.value.message).toBe(notices.kept);
    expect(transcribedTexts()).toEqual([]);
    responders = [ok('Second time')];
    view.value.retry();
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(posts[2].body).toEqual(posts[0].body);
    expect(transcribedTexts()).toEqual(['Second time']);
    expect(view.value.retained).toBe(false);
  });

  it('a retry appends to what the patient typed while the recording was kept', async () => {
    responders = [failServer, failServer];
    const view = await recording();
    text = 'Before ';
    await speak(1000);
    view.value.stop();
    await drain();
    text = 'Before typed after';
    responders = [ok('retried words')];
    view.value.retry();
    await drain();
    expect(onText).toHaveBeenLastCalledWith('Before typed after retried words', true, undefined);
  });

  it('a retry never replaces or duplicates words typed while the recording was kept (app-like text updates)', async () => {
    responders = [failServer, failServer];
    const shown: string[] = [];
    const typing = vi.fn((value: string) => { text = value; shown.push(value); });
    text = 'Before';
    const view = await recording({ onText: typing });
    await speak(1000);
    view.value.stop();
    await drain();
    text = 'Before and I typed this while it was kept';
    responders = [ok('retried words')];
    view.value.retry();
    await drain();
    expect(text).toBe('Before and I typed this while it was kept retried words');
    expect(shown.filter(value => !value.includes('I typed this while it was kept'))).toEqual([]);
  });

  it('discard throws the audio away without transcribing it', async () => {
    const view = await recording();
    await speak(1000);
    view.value.discard();
    await drain();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(view.value.status).toBe('interrupted');
    expect(view.value.message).toBe(notices.discarded);
    expect(transcribedTexts()).toEqual([]);
  });

  it('discarding a kept recording means a later retry posts nothing', async () => {
    responders = [failServer, failServer];
    const view = await recording();
    await speak(1000);
    view.value.stop();
    await drain();
    expect(view.value.retained).toBe(true);
    view.value.discard();
    view.value.retry();
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(view.value.retained).toBe(false);
  });

  it('leaving the page drops the recording without transcribing it', async () => {
    const view = await recording();
    await speak(1000);
    window.dispatchEvent(new Event('pagehide'));
    await drain();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(view.value.status).toBe('interrupted');
    expect(view.value.message).toBe('Recording stopped when you left this page. Nothing was transcribed.');
    expect(transcribedTexts()).toEqual([]);
  });

  it('stop waiting pauses an in-flight transcription into the kept state', async () => {
    responders = [init => new Promise<Response>((_, reject) => { init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); })];
    const view = await recording();
    await speak(1000);
    view.value.stop();
    await drain();
    expect(view.value.status).toBe('finishing');
    view.value.pause();
    await drain();
    expect(view.value.retained).toBe(true);
    expect(view.value.message).toBe(notices.kept);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
