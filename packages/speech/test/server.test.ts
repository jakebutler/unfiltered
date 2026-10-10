import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSpeechOutput, type SpeechLease } from '../src/server.js';
import { speechLimits } from '../src/contracts.js';

const input = { sessionId: 'session-a', sourceId: 'prompt-a', expectedRevision: 3, requestId: 'audio-1' };
const source = { sessionId: 'session-a', sourceId: 'prompt-a', revision: 3, text: 'What would help you prepare for this visit?' };
afterEach(() => vi.useRealTimers());
function setup(fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } }))) {
  const settle = vi.fn(), reserve = vi.fn(async (): Promise<SpeechLease> => ({ settle }));
  const authorize = vi.fn(async () => source);
  const speak = createSpeechOutput({ elevenlabsApiKey: 'test-only', admission: { reserve }, authorize, fetcher });
  return { settle, reserve, authorize, fetcher, speak };
}
describe('authorized bounded TTS', () => {
  it('resolves text on the server, reserves first, pins provider/model and streams only audio', async () => {
    const { speak, fetcher, reserve, settle } = setup();
    const response = await speak(input); expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(reserve).toHaveBeenCalledExactlyOnceWith({ sessionId: input.sessionId, requestId: input.requestId, provider: 'elevenlabs', maxCharacters: source.text.length, maxAudioSeconds: 0 });
    const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream?output_format=mp3_22050_32');
    expect(JSON.parse(call[1].body as string)).toEqual({ text: source.text, model_id: 'eleven_flash_v2_5' });
    expect(call[1].redirect).toBe('error'); expect(settle).toHaveBeenCalledExactlyOnceWith('completed');
  });
  it('denies cross-session, stale source and oversized text before provider work', async () => {
    const { speak, authorize, fetcher, reserve } = setup();
    authorize.mockResolvedValueOnce({ ...source, sessionId: 'other' });
    await expect(speak(input)).rejects.toThrow('not-authorized');
    authorize.mockResolvedValueOnce({ ...source, revision: 4 });
    await expect(speak(input)).rejects.toThrow('not-authorized');
    authorize.mockResolvedValueOnce({ ...source, text: 'x'.repeat(speechLimits.ttsCharacters + 1) });
    await expect(speak(input)).rejects.toThrow('limit');
    expect(reserve).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('cannot generate if quota/concurrency admission rejects', async () => {
    const { speak, reserve, fetcher } = setup(); reserve.mockRejectedValueOnce(new Error('admission-denied'));
    await expect(speak(input)).rejects.toThrow('admission-denied'); expect(fetcher).not.toHaveBeenCalled();
  });
  it('aborts provider reads on browser cancellation and settles once without retry', async () => {
    const canceled = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel: canceled }), { headers: { 'content-type': 'audio/mpeg' } }));
    const { speak, settle } = setup(fetcher); const abort = new AbortController();
    const response = await speak(input, abort.signal); const reading = response.arrayBuffer();
    abort.abort(); await expect(reading).rejects.toThrow('interrupted');
    expect(canceled).toHaveBeenCalledOnce(); expect(settle).toHaveBeenCalledExactlyOnceWith('interrupted'); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('caps chunked response bytes without trusting Content-Length', async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array(speechLimits.ttsBytes + 1), { headers: { 'content-type': 'audio/mpeg' } }));
    const { speak, settle } = setup(fetcher); const response = await speak(input);
    await expect(response.arrayBuffer()).rejects.toThrow('limit'); expect(settle).toHaveBeenCalledExactlyOnceWith('unknown');
  });
  it('bounds a stalled response body, including when the consumer never reads', async () => {
    vi.useFakeTimers(); const canceled = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel: canceled }), { headers: { 'content-type': 'audio/mpeg' } }));
    const { speak, settle } = setup(fetcher); const response = await speak(input);
    await vi.advanceTimersByTimeAsync(speechLimits.providerTimeoutMs);
    await expect(response.arrayBuffer()).rejects.toThrow('timeout');
    expect(canceled).toHaveBeenCalledOnce(); expect(settle).toHaveBeenCalledExactlyOnceWith('unknown');
  });
  it('redacts provider error bodies and does not retry an uncertain failure', async () => {
    const fetcher = vi.fn(async () => new Response('private provider details', { status: 429 }));
    const { speak, settle } = setup(fetcher); await expect(speak(input)).rejects.toThrow('unavailable');
    expect(fetcher).toHaveBeenCalledOnce(); expect(settle).toHaveBeenCalledExactlyOnceWith('unknown');
  });
});
