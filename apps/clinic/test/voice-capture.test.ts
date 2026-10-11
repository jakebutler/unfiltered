import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { appendTranscript, CaptureEpoch, CaptureResources, LocalVoiceActivity, PcmTransport, StreamingPcm16, type CaptureScope } from '../src/voice-capture';
import { SpeechPlayback, createVoiceDraft, reduceVoiceDraft } from '../../../packages/speech/src/index';

// Exercise the exact JavaScript module shipped to the AudioWorklet.
const captureWorklet = readFileSync(new URL('../public/clinic-capture.worklet.js', import.meta.url), 'utf8');

const format = { sampleRate: 16000, channels: 1, maxCaptureMs: 60000 };
function socket() { return { readyState: 1, bufferedAmount: 0, sent: [] as (string | Uint8Array)[], send(data: string | Uint8Array) { this.sent.push(data); } }; }
const scope: CaptureScope = { sessionId: 'session', promptId: 'Q01', expectedRevision: 3, requestId: 'stable-answer-id' };

describe('actual-rate microphone conversion', () => {
  for (const sampleRate of [16000, 32000, 44100, 48000, 96000]) {
    it(`resamples ${sampleRate} Hz to exactly 16000 PCM samples each second`, () => {
      const input = Float32Array.from({ length: sampleRate }, (_, i) => Math.sin(i * 2 * Math.PI * 440 / sampleRate) * .5);
      const full = new StreamingPcm16(sampleRate).encode(input);
      const chunked = new StreamingPcm16(sampleRate), parts: number[] = [];
      for (let i = 0; i < input.length; i += 1024) parts.push(...chunked.encode(input.slice(i, i + 1024)));
      expect(full.length).toBe(32000);
      expect(new Uint8Array(parts)).toEqual(full);
      const view = new DataView(full.buffer);
      expect(Math.abs(view.getInt16(18, true))).toBeGreaterThan(15000);
    });
  }
  it('encodes signed little-endian PCM with saturation and finite values', () => {
    expect([...new StreamingPcm16(16000).encode(new Float32Array([-2, -1, 0, 1, 2, NaN, Infinity]))]).toEqual([0,128,0,128,0,0,255,127,255,127,0,0,0,0]);
  });
  it('fails closed for unsupported or fractional rates', () => {
    for (const rate of [0, 8000, 44100.1, Infinity, NaN, 192001]) expect(() => new StreamingPcm16(rate)).toThrow('unsupported-sample-rate');
  });
});

describe('browser transport bounds', () => {
  it('never sends PCM before ready; sends one finish and nothing after finish', () => {
    const ws = socket(), transport = new PcmTransport(ws, 48000, () => 0);
    transport.audio(new Float32Array(1024)); transport.finish(); expect(ws.sent).toEqual([]);
    transport.ready(format); transport.audio(new Float32Array(1024)); transport.finish(); transport.finish(); transport.audio(new Float32Array(1024));
    expect(ws.sent.length).toBe(2); expect(ws.sent[0]).toBeInstanceOf(Uint8Array); expect(ws.sent[1]).toBe('{"type":"finish"}');
  });
  it('enforces the shorter server capture lease and corresponding byte bound', () => {
    const ws = socket(); let time = 0;
    const transport = new PcmTransport(ws, 16000, () => time);
    transport.ready({ ...format, maxCaptureMs: 500 }); transport.audio(new Float32Array(8000));
    expect(() => transport.audio(new Float32Array(1))).toThrow('voice-limit');
    time = 501; expect(() => transport.audio(new Float32Array())).toThrow('voice-limit');
    expect((ws.sent[0] as Uint8Array).length).toBe(16000);
  });
  it('rejects invalid ready data and duplicate readiness', () => {
    for (const maxCaptureMs of [0, -1, 60001, 4.5, NaN]) expect(() => new PcmTransport(socket(), 48000).ready({ ...format, maxCaptureMs })).toThrow();
    expect(() => new PcmTransport(socket(), 48000).ready({ ...format, sampleRate: 48000 })).toThrow();
    expect(() => new PcmTransport(socket(), 48000).ready({ ...format, channels: 2 })).toThrow();
    const transport = new PcmTransport(socket(), 48000); transport.ready(format); expect(() => transport.ready(format)).toThrow();
  });
  it('bounds frame size, total duration and capture send rate', () => {
    const ws = socket(); let time = 0;
    const transport = new PcmTransport(ws, 16000, () => time); transport.ready(format);
    expect(() => transport.audio(new Float32Array(8193))).toThrow('voice-frame-too-large');
    transport.audio(new Float32Array(8192)); transport.audio(new Float32Array(8192)); transport.audio(new Float32Array(8192));
    expect(() => transport.audio(new Float32Array(8192))).toThrow('voice-limit');
    expect(ws.sent.every(value => value instanceof Uint8Array && value.length <= 16384 && value.length % 2 === 0)).toBe(true);
    time = 60001; expect(() => transport.audio(new Float32Array(1))).toThrow('voice-limit');
  });
  it('fails before sending on backpressure or a closed socket', () => {
    const ws = socket(), transport = new PcmTransport(ws, 16000, () => 0); transport.ready(format); ws.bufferedAmount = 63999;
    expect(() => transport.audio(new Float32Array(1))).toThrow('voice-connection-slow'); expect(ws.sent).toEqual([]);
    ws.bufferedAmount = 0; ws.readyState = 3; expect(() => transport.audio(new Float32Array(1))).toThrow('voice-connection-slow');
  });
});

describe('capture cancellation and unsent source preservation', () => {
  it('runs all cleanup once even if a browser cleanup fails; closes late permission results', () => {
    const resources = new CaptureResources(), calls: string[] = [];
    resources.own(() => calls.push('context')); resources.own(() => { calls.push('track'); throw new Error('browser'); }); resources.own(() => calls.push('listeners'));
    resources.close(); resources.close();
    expect(resources.own(() => calls.push('late-permission-track'))).toBe(false);
    expect(calls).toEqual(['listeners', 'track', 'context', 'late-permission-track']);
  });
  it('rejects late capture events after interrupt, reconnect, prompt, revision or answer identity changes', () => {
    const epoch = new CaptureEpoch(), first = epoch.begin(); expect(epoch.current(first, scope, { ...scope })).toBe(true);
    for (const changed of [{ ...scope, promptId: 'Q02' }, { ...scope, expectedRevision: 4 }, { ...scope, requestId: 'another-answer' }, { ...scope, sessionId: 'another-patient' }]) expect(epoch.current(first, scope, changed)).toBe(false);
    epoch.invalidate(); expect(epoch.current(first, scope, scope)).toBe(false);
    const second = epoch.begin(); expect(epoch.current(first, scope, scope)).toBe(false); expect(epoch.current(second, scope, scope)).toBe(true);
  });
  it('retains the exact typed prefix and promotes interim words only to unsent review', () => {
    const prefix = '  I take 5 mg.\n'; let draft = createVoiceDraft(scope);
    draft = reduceVoiceDraft(draft, { type: 'recognition', generation: draft.generation, segment: { text: 'not ten', start: 0, duration: 1, isFinal: false, speechFinal: false } });
    expect(draft.text).toBe(''); expect(appendTranscript(prefix, draft.text)).toBe(prefix);
    draft = reduceVoiceDraft(draft, { type: 'interrupt' }); expect(draft.phase).toBe('review'); expect(draft.scope.requestId).toBe(scope.requestId);
    expect(appendTranscript(prefix, draft.text)).toBe('  I take 5 mg.\nnot ten');
    const generation = draft.generation;
    expect(reduceVoiceDraft(draft, { type: 'recognition', generation: generation - 1, segment: { text: 'late', start: 1, duration: 1, isFinal: true, speechFinal: true } })).toBe(draft);
  });
});

describe('local barge-in and playback cancellation', () => {
  for (const rate of [32000, 44100, 48000]) it(`local ${rate} Hz frames interrupt playback synchronously well inside 500ms`, () => {
    const vad = new LocalVoiceActivity(), playback = new SpeechPlayback(); let stopped = false;
    const ticket = playback.begin(); ticket.attach(() => { stopped = true; });
    let frames = 0;
    while (!stopped && frames++ < 10) if (vad.feed(new Float32Array(1024).fill(.08), rate)) playback.interrupt();
    expect(stopped).toBe(true); expect(frames * 1024 / rate * 1000).toBeLessThan(100); expect(ticket.signal.aborted).toBe(true);
    expect(vad.feed(new Float32Array(1024).fill(.08), rate)).toBe(true); // Playback started during the same utterance is also interrupted.
  });
  it('does not treat silence or a single short spike as sustained voice', () => {
    const vad = new LocalVoiceActivity();
    expect(vad.feed(new Float32Array(1024).fill(.008), 48000)).toBe(false);
    expect(vad.feed(new Float32Array(1024).fill(.2), 48000)).toBe(false);
    expect(vad.feed(new Float32Array(1024), 48000)).toBe(false);
  });
  it('a late playback attach after stop immediately stops and cannot become current', () => {
    const playback = new SpeechPlayback(), old = playback.begin(); playback.interrupt();
    let stopped = 0; expect(old.attach(() => stopped++)).toBe(false); expect(stopped).toBe(1); expect(old.isCurrent()).toBe(false);
    const next = playback.begin(); expect(next.isCurrent()).toBe(true); expect(old.isCurrent()).toBe(false);
  });
});


describe('audio worklet tail and cancellation', () => {
  function worklet() {
    let Constructor: any;
    class Processor { port = { messages: [] as any[], onmessage: undefined as any, postMessage(value: any) { this.messages.push(value); } }; }
    runInNewContext(captureWorklet, { AudioWorkletProcessor: Processor, Float32Array, registerProcessor: (_name: string, implementation: any) => { Constructor = implementation; } });
    return new Constructor();
  }
  it('mixes to mono and flushes the last partial frame before the completion marker', () => {
    const processor = worklet();
    processor.process([[new Float32Array(128).fill(.4), new Float32Array(128).fill(.2)]]);
    expect(processor.port.messages).toEqual([]);
    processor.port.onmessage({ data: 'finish' });
    expect(processor.port.messages.length).toBe(2);
    expect(processor.port.messages[0].length).toBe(128);
    expect(processor.port.messages[0][0]).toBeCloseTo(.3);
    expect(processor.port.messages[1]).toEqual({ type: 'flushed' });
    expect(processor.process([[new Float32Array(128).fill(1)]])).toBe(false);
    processor.port.onmessage({ data: 'finish' }); expect(processor.port.messages.length).toBe(2);
  });
  it('posts bounded transferable frames and drops buffered raw audio on interruption', () => {
    const processor = worklet();
    for (let i = 0; i < 9; i++) processor.process([[new Float32Array(128).fill(.1)]]);
    expect(processor.port.messages.length).toBe(1); expect(processor.port.messages[0].length).toBe(1024);
    processor.port.onmessage({ data: 'stop' }); processor.port.onmessage({ data: 'finish' });
    expect(processor.port.messages.length).toBe(1);
    expect(processor.process([[new Float32Array(128)]])).toBe(false);
  });
});
