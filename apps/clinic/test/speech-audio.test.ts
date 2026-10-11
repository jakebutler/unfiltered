import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserSpeechAudioEnvironment, SpeechAudioStream, type SpeechAudioEnvironment, type SpeechMediaSource, type SpeechSourceBuffer } from '../src/speech-audio';
import { SpeechPlayback } from '../../../packages/speech/src/index';

class TrackedTarget extends EventTarget {
  listeners = new Set<EventListenerOrEventListenerObject>();
  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) { if (callback) this.listeners.add(callback); super.addEventListener(type, callback, options); }
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) { if (callback) this.listeners.delete(callback); super.removeEventListener(type, callback, options); }
}
class FakeBuffer extends TrackedTarget implements SpeechSourceBuffer {
  updating = false; chunks: Uint8Array<ArrayBuffer>[] = []; aborted = 0; throwAppend = false;
  appendBuffer(chunk: Uint8Array<ArrayBuffer>) { if (this.updating || this.throwAppend) throw new Error('append-failed'); this.updating = true; this.chunks.push(chunk); }
  complete() { this.updating = false; this.dispatchEvent(new Event('updateend')); }
  abort() { this.aborted++; this.updating = false; this.dispatchEvent(new Event('abort')); }
}
class FakeMedia extends TrackedTarget implements SpeechMediaSource {
  readyState = 'closed'; buffer = new FakeBuffer(); ended = 0; removed = 0; throwAdd = false;
  open() { this.readyState = 'open'; this.dispatchEvent(new Event('sourceopen')); }
  addSourceBuffer(type: string) { expect(type).toBe('audio/mpeg'); if (this.throwAdd) throw new Error('cannot-add'); return this.buffer; }
  removeSourceBuffer(buffer: SpeechSourceBuffer) { expect(buffer).toBe(this.buffer); this.removed++; }
  endOfStream() { if (this.buffer.updating) throw new Error('still-updating'); this.ended++; this.readyState = 'ended'; }
  close() { this.readyState = 'closed'; this.dispatchEvent(new Event('sourceclose')); }
}
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function harness(streaming = true) {
  const media = new FakeMedia(), audio = { src: '', paused: false }, playback = new SpeechPlayback();
  const ticket = playback.begin(), failures: string[] = [], created: (Blob | SpeechMediaSource)[] = [], revoked: string[] = [];
  let ready = 0, stream: SpeechAudioStream | undefined;
  const environment: SpeechAudioEnvironment = {
    ...(streaming ? { createMediaSource: () => media } : {}),
    createObjectURL(value) { created.push(value); return `blob:audio-${created.length}`; }, revokeObjectURL(value) { revoked.push(value); },
  };
  ticket.attach(() => { audio.paused = true; stream?.dispose(); audio.src = ''; });
  stream = new SpeechAudioStream({ audio, signal: ticket.signal, isCurrent: ticket.isCurrent, environment, onPlayable: () => ready++, onFailure: error => { failures.push(error.message); playback.interrupt(); } });
  let controller!: ReadableStreamDefaultController<Uint8Array>, canceled = 0;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel() { canceled++; } });
  return { stream, media, audio, ticket, playback, body, controller, created, revoked, failures, ready: () => ready, canceled: () => canceled };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('incremental MPEG playback lifecycle', () => {
  it('starts from the first appended chunk before response completion, serializes appends and ends only after the last update', async () => {
    const h = harness(), done = h.stream.consume(h.body); h.media.open();
    h.controller.enqueue(new Uint8Array([1, 2])); h.controller.enqueue(new Uint8Array([3, 4])); await tick();
    expect(h.media.buffer.chunks).toHaveLength(1); expect(h.ready()).toBe(0); expect(h.media.ended).toBe(0);
    h.media.buffer.complete(); await tick();
    expect(h.ready()).toBe(1); expect(h.media.buffer.chunks.map(chunk => [...chunk])).toEqual([[1, 2], [3, 4]]); expect(h.media.ended).toBe(0);
    h.controller.close(); await tick(); expect(h.media.ended).toBe(0);
    h.media.buffer.complete(); await done;
    expect(h.media.ended).toBe(1); expect(h.ready()).toBe(1); expect(h.created).toEqual([h.media]); expect(h.revoked).toEqual([]);
    // The same media and URL remain available for blocked autoplay retry and explicit replay.
    expect(h.audio.src).toBe('blob:audio-1'); await expect(h.stream.consume(h.body)).rejects.toThrow('already-used'); expect(h.created).toHaveLength(1);
    h.playback.interrupt(); expect(h.revoked).toEqual(['blob:audio-1']); expect(h.media.listeners.size + h.media.buffer.listeners.size).toBe(0);
  });
  it('abort during a pending append pauses synchronously, cancels the reader and rejects late update events', async () => {
    const h = harness(), result = h.stream.consume(h.body).catch(error => error); h.media.open(); h.controller.enqueue(new Uint8Array([1])); await tick();
    h.playback.interrupt(); expect(h.audio.paused).toBe(true); expect(h.ticket.signal.aborted).toBe(true); expect(h.media.buffer.aborted).toBe(1);
    h.media.buffer.complete(); await result;
    expect(h.ready()).toBe(0); expect(h.canceled()).toBe(1); expect(h.media.removed).toBe(1); expect(h.revoked).toEqual(['blob:audio-1']);
    expect(h.media.listeners.size + h.media.buffer.listeners.size).toBe(0); h.stream.dispose(); expect(h.revoked).toHaveLength(1);
  });
  it('abort while waiting for sourceopen prevents attachment or playback even if sourceopen arrives late', async () => {
    const h = harness(), result = h.stream.consume(h.body).catch(error => error);
    h.playback.interrupt(); h.media.open(); await result;
    expect(h.ready()).toBe(0); expect(h.media.buffer.chunks).toEqual([]); expect(h.canceled()).toBe(1); expect(h.media.listeners.size).toBe(0);
  });
  it('source closure during the response fails once and never falls back or restarts playback', async () => {
    const h = harness(), result = h.stream.consume(h.body).catch(error => error); h.media.open(); await tick(); h.media.close(); await result;
    expect(h.failures).toEqual(['audio-source-closed']); expect(h.audio.paused).toBe(true); expect(h.ready()).toBe(0); expect(h.created).toEqual([h.media]); expect(h.canceled()).toBe(1);
  });
  it.each(['error', 'abort'])('a SourceBuffer %s fails once and cleans all pending work', async type => {
    const h = harness(), result = h.stream.consume(h.body).catch(error => error); h.media.open(); h.controller.enqueue(new Uint8Array([1])); await tick();
    h.media.buffer.dispatchEvent(new Event(type)); await result;
    expect(h.failures).toHaveLength(1); expect(h.ticket.isCurrent()).toBe(false); expect(h.ready()).toBe(0); expect(h.media.listeners.size + h.media.buffer.listeners.size).toBe(0);
  });
  it.each(['add', 'append'])('a synchronous %s failure does not fetch or construct a fallback clip', async phase => {
    const h = harness(); h.media.throwAdd = phase === 'add'; h.media.buffer.throwAppend = phase === 'append';
    const result = h.stream.consume(h.body).catch(error => error); h.media.open(); h.controller.enqueue(new Uint8Array([1])); await result;
    expect(h.failures).toHaveLength(1); expect(h.created).toEqual([h.media]); expect(h.stream.mode).toBe('streaming'); expect(h.canceled()).toBe(1);
  });
  it('bounds a stalled response/append to 30 seconds, aborting playback and the in-flight reader', async () => {
    vi.useFakeTimers(); const h = harness(), result = h.stream.consume(h.body).catch(error => error); h.media.open(); h.controller.enqueue(new Uint8Array([1])); await tick();
    await vi.advanceTimersByTimeAsync(29999); expect(h.failures).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); await result;
    expect(h.failures).toEqual(['audio-timeout']); expect(h.audio.paused).toBe(true); expect(h.canceled()).toBe(1); expect(h.ready()).toBe(0);
  });
  it('starts the same 30-second deadline before any response is supplied', async () => {
    vi.useFakeTimers(); const h = harness(); await vi.advanceTimersByTimeAsync(30000);
    expect(h.failures).toEqual(['audio-timeout']); expect(h.ticket.signal.aborted).toBe(true); expect(h.revoked).toEqual(['blob:audio-1']);
    await expect(h.stream.consume(h.body)).rejects.toThrow(); expect(h.ready()).toBe(0);
  });
  it('never appends bytes above 600000, even when the first oversized response chunk arrives at once', async () => {
    const h = harness(), result = h.stream.consume(h.body).catch(error => error); h.media.open(); h.controller.enqueue(new Uint8Array(600001)); await result;
    expect(h.failures).toEqual(['audio-too-large']); expect(h.media.buffer.chunks).toEqual([]); expect(h.canceled()).toBe(1); expect(h.ready()).toBe(0);
  });
  it('rejects empty streaming output without starting playback', async () => {
    const h = harness(), result = h.stream.consume(h.body).catch(error => error); h.media.open(); h.controller.close(); await result;
    expect(h.failures).toEqual(['empty-audio']); expect(h.ready()).toBe(0); expect(h.media.ended).toBe(0);
  });
  it('enforces the cumulative bound after playback has begun and cancels the same generation', async () => {
    const h = harness(), result = h.stream.consume(h.body).catch(error => error); h.media.open(); h.controller.enqueue(new Uint8Array(400000)); await tick();
    h.media.buffer.complete(); await tick(); expect(h.ready()).toBe(1);
    h.controller.enqueue(new Uint8Array(200001)); await result;
    expect(h.failures).toEqual(['audio-too-large']); expect(h.media.buffer.chunks).toHaveLength(1); expect(h.audio.paused).toBe(true); expect(h.ticket.isCurrent()).toBe(false);
  });
  it('clears the response deadline after complete receipt, retaining the same media for later replay', async () => {
    vi.useFakeTimers(); const h = harness(), done = h.stream.consume(h.body); h.media.open(); h.controller.enqueue(new Uint8Array([1])); h.controller.close(); await tick();
    h.media.buffer.complete(); await done; await vi.advanceTimersByTimeAsync(60000);
    expect(h.failures).toEqual([]); expect(h.ticket.isCurrent()).toBe(true); expect(h.audio.src).toBe('blob:audio-1'); expect(h.created).toHaveLength(1);
    h.playback.interrupt();
  });
});

describe('unsupported-browser fallback', () => {
  it('chooses MPEG streaming only through the exact capability test', () => {
    const supported = vi.fn(() => true); vi.stubGlobal('MediaSource', class { static isTypeSupported = supported; });
    expect(browserSpeechAudioEnvironment().createMediaSource).toBeTypeOf('function'); expect(supported).toHaveBeenCalledWith('audio/mpeg');
    supported.mockReturnValue(false); expect(browserSpeechAudioEnvironment().createMediaSource).toBeUndefined();
    vi.stubGlobal('MediaSource', undefined); expect(browserSpeechAudioEnvironment().createMediaSource).toBeUndefined();
  });
  it('waits for the complete bounded blob, then retains one URL for playback retry without consuming again', async () => {
    const h = harness(false), done = h.stream.consume(h.body); h.controller.enqueue(new Uint8Array([1])); await tick();
    expect(h.stream.mode).toBe('buffered'); expect(h.ready()).toBe(0); expect(h.created).toEqual([]);
    h.controller.enqueue(new Uint8Array([2])); h.controller.close(); await done;
    expect(h.ready()).toBe(1); expect(h.created).toHaveLength(1); expect(h.created[0]).toBeInstanceOf(Blob); expect((h.created[0] as Blob).size).toBe(2);
    await expect(h.stream.consume(h.body)).rejects.toThrow('already-used'); expect(h.audio.src).toBe('blob:audio-1');
    h.playback.interrupt(); expect(h.revoked).toEqual(['blob:audio-1']);
  });
  it('rejects oversized fallback before creating a Blob URL', async () => {
    const h = harness(false), result = h.stream.consume(h.body).catch(error => error); h.controller.enqueue(new Uint8Array(600001)); await result;
    expect(h.failures).toEqual(['audio-too-large']); expect(h.created).toEqual([]); expect(h.ready()).toBe(0); expect(h.canceled()).toBe(1);
  });
  it('cancels fallback download without creating or replaying a clip', async () => {
    const h = harness(false), result = h.stream.consume(h.body).catch(error => error); h.controller.enqueue(new Uint8Array([1])); await tick(); h.playback.interrupt(); await result;
    expect(h.created).toEqual([]); expect(h.ready()).toBe(0); expect(h.canceled()).toBe(1);
  });
});
