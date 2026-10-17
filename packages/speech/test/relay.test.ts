import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSpeechRelay, deepgramListenUrl } from '../src/relay.js';

afterEach(() => vi.useRealTimers());
function setup() {
  const provider = { bufferedAmount: 0, send: vi.fn(), close: vi.fn() }, settle = vi.fn(), emit = vi.fn();
  const relay = createSpeechRelay({ provider, lease: { settle }, emit });
  return { provider, settle, emit, relay };
}
describe('bounded server STT relay', () => {
  it('pins Nova-3 transcription, flushes once on explicit finish and never forwards metadata', () => {
    vi.useFakeTimers(); const { relay, provider, emit, settle } = setup();
    expect(new URL(deepgramListenUrl).pathname).toBe('/v1/listen');
    expect(new URL(deepgramListenUrl).searchParams.get('model')).toBe('nova-3');
    relay.audio(new Uint8Array(3200)); relay.finish(); relay.finish();
    expect(provider.send).toHaveBeenLastCalledWith('{"type":"CloseStream"}');
    expect(provider.send).toHaveBeenCalledTimes(2);
    relay.providerMessage('{"type":"Metadata","request_id":"private-id"}');
    expect(emit).not.toHaveBeenCalled(); relay.providerClosed(1000);
    expect(emit).toHaveBeenCalledWith({ type: 'ended', outcome: 'completed' });
    expect(settle).toHaveBeenCalledExactlyOnceWith('completed');
  });
  it('rejects excess audio rate and odd PCM frames with no further upstream send', () => {
    vi.useFakeTimers(); const { relay, provider, settle } = setup();
    for (let n = 0; n < 4; n++) relay.audio(new Uint8Array(16000));
    expect(() => relay.audio(new Uint8Array(2))).toThrow('limit');
    expect(provider.send).toHaveBeenCalledTimes(4); expect(settle).toHaveBeenCalledWith('interrupted');
    expect(() => relay.audio(new Uint8Array(2))).toThrow('interrupted');
    const other = setup(); expect(() => other.relay.audio(new Uint8Array(3))).toThrow('limit');
  });
  it('caps wall-clock duration even when audio is sent continuously', () => {
    vi.useFakeTimers(); const { relay, settle } = setup();
    for (let n = 0; n < 60; n++) { relay.audio(new Uint8Array(3200)); vi.advanceTimersByTime(1000); }
    vi.advanceTimersByTime(5000);
    expect(settle).toHaveBeenCalledExactlyOnceWith('interrupted');
  });
  it('marks connection loss/flush timeout unknown, closes and ignores late frames', () => {
    vi.useFakeTimers(); const { relay, provider, emit, settle } = setup();
    relay.finish(); vi.advanceTimersByTime(5000);
    expect(settle).toHaveBeenCalledExactlyOnceWith('unknown'); expect(provider.close).toHaveBeenCalledOnce();
    relay.providerMessage('{"type":"SpeechStarted"}'); relay.providerClosed(1000);
    expect(emit).toHaveBeenCalledOnce();
  });
  it('bounds individual and cumulative provider messages and outbound backpressure', () => {
    vi.useFakeTimers(); const { relay, settle } = setup();
    relay.providerMessage('x'.repeat(64001)); expect(settle).toHaveBeenCalledWith('unknown');
    const slow = setup(); slow.provider.bufferedAmount = 64001;
    expect(() => slow.relay.audio(new Uint8Array(2))).toThrow('limit'); expect(slow.provider.send).not.toHaveBeenCalled();
  });
});
