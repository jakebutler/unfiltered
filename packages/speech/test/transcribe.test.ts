import { describe, expect, it, vi } from 'vitest';
import { createSpeechTranscription, deepgramTranscribeUrl, speechUploadMaxBytes } from '../src/transcribe.js';
import type { SpeechLease } from '../src/server.js';
import { speechLimits } from '../src/contracts.js';

const requestId = 'audio-1';
const pcm = new Uint8Array(64_000).fill(7); // 2 seconds of 16 kHz mono 16-bit audio
const deepgramJson = (transcript: string) => new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript }] }] } }), { headers: { 'content-type': 'application/json' } });
function setup(fetcher = vi.fn(async () => deepgramJson('  I have a sore throat.  ')), admission?: { reserve: ReturnType<typeof vi.fn> }) {
  const settle = vi.fn(), reserve = admission?.reserve ?? vi.fn(async (): Promise<SpeechLease> => ({ settle }));
  const transcribe = createSpeechTranscription({ deepgramApiKey: 'k', admission: { reserve }, fetcher });
  return { settle, reserve, fetcher, transcribe };
}

describe('authorized bounded Deepgram transcription', () => {
  it('reserves first, makes one pinned POST with the raw PCM bytes, and returns trimmed text', async () => {
    const { transcribe, reserve, fetcher, settle } = setup();
    const result = await transcribe({ sessionId: 'session-a', requestId, pcm });
    expect(result).toEqual({ text: 'I have a sore throat.' });
    expect(reserve).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-a', requestId, provider: 'deepgram', maxCharacters: 0, maxAudioSeconds: 2 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe(deepgramTranscribeUrl);
    expect(init.method).toBe('POST'); expect(init.redirect).toBe('error');
    expect(init.headers.Authorization).toBe('Token k');
    expect(init.headers['Content-Type']).toBe('application/octet-stream');
    expect(new Uint8Array(init.body as Uint8Array)).toEqual(pcm);
    expect(settle).toHaveBeenCalledExactlyOnceWith('completed');
  });
  it('pins the nova-3-medical model and linear16 16 kHz mono query', () => {
    const query = new URL(deepgramTranscribeUrl).searchParams;
    expect(query.get('model')).toBe('nova-3-medical'); expect(query.get('encoding')).toBe('linear16');
    expect(query.get('sample_rate')).toBe('16000'); expect(query.get('channels')).toBe('1');
  });
  it('treats a response without channels as empty text with one provider call', async () => {
    const { transcribe, fetcher, settle } = setup(vi.fn(async () => new Response(JSON.stringify({ results: { channels: [] } }))));
    expect(await transcribe({ sessionId: 'session-a', requestId, pcm })).toEqual({ text: '' });
    expect(fetcher).toHaveBeenCalledOnce(); expect(settle).toHaveBeenCalledExactlyOnceWith('completed');
  });
  it('maps non-2xx to unavailable, settles failed once, and never echoes the provider body', async () => {
    const { transcribe, settle } = setup(vi.fn(async () => new Response('synthetic provider secret body', { status: 500 })));
    const error = await transcribe({ sessionId: 'session-a', requestId, pcm }).catch(e => e);
    expect(error).toMatchObject({ name: 'SpeechError', code: 'unavailable' });
    expect(String(error.message)).not.toContain('secret');
    expect(settle).toHaveBeenCalledExactlyOnceWith('failed');
  });
  it('uses a short injected timeout, settles unknown exactly once, and never retries', async () => {
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const settle = vi.fn(), reserve = vi.fn(async (): Promise<SpeechLease> => ({ settle }));
    const transcribe = createSpeechTranscription({ deepgramApiKey: 'k', admission: { reserve }, fetcher, timeoutMs: 5 });
    await expect(transcribe({ sessionId: 'session-a', requestId, pcm })).rejects.toMatchObject({ code: 'timeout' });
    expect(fetcher).toHaveBeenCalledOnce(); expect(settle).toHaveBeenCalledExactlyOnceWith('unknown');
  });
  it('settles interrupted when the caller cancels an in-flight attempt', async () => {
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const settle = vi.fn(), reserve = vi.fn(async (): Promise<SpeechLease> => ({ settle })), caller = new AbortController();
    const transcribe = createSpeechTranscription({ deepgramApiKey: 'k', admission: { reserve }, fetcher });
    const pending = transcribe({ sessionId: 'session-a', requestId, pcm }, caller.signal);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    caller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'interrupted' });
    expect(settle).toHaveBeenCalledExactlyOnceWith('interrupted');
  });
  it('rejects a provider body that is off-contract without echoing it', async () => {
    const { transcribe, settle } = setup(vi.fn(async () => new Response('not json synthetic body')));
    await expect(transcribe({ sessionId: 'session-a', requestId, pcm })).rejects.toMatchObject({ code: 'invalid-provider-response' });
    expect(settle).toHaveBeenCalledExactlyOnceWith('unknown');
  });
  it('caps the returned transcript at the shared character limit', async () => {
    const { transcribe } = setup(vi.fn(async () => deepgramJson('x'.repeat(speechLimits.transcriptCharacters + 1))));
    await expect(transcribe({ sessionId: 'session-a', requestId, pcm })).rejects.toMatchObject({ code: 'invalid-provider-response' });
  });
  it.each([
    ['empty', new Uint8Array(0), 'invalid-request'],
    ['odd-length', new Uint8Array(3), 'invalid-request'],
    ['oversize', new Uint8Array(speechUploadMaxBytes + 2), 'limit'],
  ] as const)('rejects %s audio before admission or any provider request', async (_name, bytes, code) => {
    const { transcribe, reserve, fetcher } = setup();
    await expect(transcribe({ sessionId: 'session-a', requestId, pcm: bytes })).rejects.toMatchObject({ code });
    expect(reserve).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    ['requestId', { requestId: 'bad id!' }],
    ['sessionId', { sessionId: '' }],
    ['long sessionId', { sessionId: 'x'.repeat(101) }],
  ])('rejects an invalid %s before admission', async (_name, override) => {
    const { transcribe, reserve, fetcher } = setup();
    await expect(transcribe({ sessionId: 'session-a', requestId, pcm, ...override })).rejects.toMatchObject({ code: 'invalid-request' });
    expect(reserve).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('never calls the provider when admission denies the reservation', async () => {
    const reserve = vi.fn(async () => { throw new Error('provider-budget-exhausted'); });
    const { transcribe, fetcher } = setup(undefined, { reserve });
    await expect(transcribe({ sessionId: 'session-a', requestId, pcm })).rejects.toThrow('provider-budget-exhausted');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires an API key before any admission', () => {
    expect(() => createSpeechTranscription({ deepgramApiKey: '', admission: { reserve: vi.fn() } })).toThrow('unavailable');
  });
});
