import { describe, expect, it, vi } from 'vitest';
import { createSpeechGrant, deepgramGrantUrl } from '../src/grant.js';
import type { SpeechLease } from '../src/server.js';
import { directCaptureMs, speechTokenTtlSeconds } from '../src/contracts.js';

const requestId = 'grant-1';
const accessToken = 'synthetic.access-token_value-123';
const grantJson = (body: unknown = { access_token: accessToken, expires_in: 3600 }) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
function setup(overrides: { fetcher?: ReturnType<typeof vi.fn>; settle?: ReturnType<typeof vi.fn>; reserve?: ReturnType<typeof vi.fn> } = {}) {
  const settle = overrides.settle ?? vi.fn();
  const reserve = overrides.reserve ?? vi.fn(async (): Promise<SpeechLease> => ({ settle }));
  const fetcher = overrides.fetcher ?? vi.fn(async () => grantJson());
  const grant = createSpeechGrant({ deepgramApiKey: 'k', admission: { reserve }, fetcher });
  return { settle, reserve, fetcher, grant };
}

describe('admitted, bounded Deepgram token grant', () => {
  it('reserves the full stream bound before the single provider POST', async () => {
    const { grant, reserve, fetcher, settle } = setup();
    await grant({ sessionId: 'session-a', requestId });
    expect(reserve).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-a', requestId, provider: 'deepgram', maxCharacters: 0, maxAudioSeconds: Math.ceil(directCaptureMs / 1000) });
    expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(fetcher.mock.invocationCallOrder[0]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledExactlyOnceWith('completed');
  });
  it('posts the exact grant URL, headers and ttl body without redirects', async () => {
    const { grant, fetcher } = setup();
    await grant({ sessionId: 'session-a', requestId });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe(deepgramGrantUrl);
    expect(url).toBe('https://api.deepgram.com/v1/auth/grant');
    expect(init.method).toBe('POST'); expect(init.redirect).toBe('error');
    expect(init.headers).toEqual({ Authorization: 'Token k', 'Content-Type': 'application/json', Accept: 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ ttl_seconds: speechTokenTtlSeconds });
    expect(speechTokenTtlSeconds).toBe(30);
  });
  it('returns the token and clamps the lifetime to the short token TTL', async () => {
    const { grant } = setup();
    expect(await grant({ sessionId: 'session-a', requestId })).toEqual({ accessToken, expiresIn: speechTokenTtlSeconds });
    const shorter = setup({ fetcher: vi.fn(async () => grantJson({ access_token: accessToken, expires_in: 12 })) });
    expect(await shorter.grant({ sessionId: 'session-a', requestId })).toEqual({ accessToken, expiresIn: 12 });
  });
  it('maps a non-2xx grant to unavailable, settles failed once, and never echoes the provider body', async () => {
    const { grant, settle } = setup({ fetcher: vi.fn(async () => new Response('synthetic provider secret body', { status: 401 })) });
    const error = await grant({ sessionId: 'session-a', requestId }).catch(e => e);
    expect(error).toMatchObject({ name: 'SpeechError', code: 'unavailable' });
    expect(String(error.message)).not.toContain('secret');
    expect(settle).toHaveBeenCalledExactlyOnceWith('failed');
  });
  it.each([
    ['invalid JSON', () => new Response('not json synthetic body')],
    ['token with spaces', () => grantJson({ access_token: 'bad token value with spaces', expires_in: 30 })],
    ['token shorter than 20 characters', () => grantJson({ access_token: 'short', expires_in: 30 })],
    ['zero lifetime', () => grantJson({ access_token: accessToken, expires_in: 0 })],
    ['lifetime above an hour', () => grantJson({ access_token: accessToken, expires_in: 3601 })],
    ['oversize body', () => new Response('x'.repeat(16_001))],
    ['declared oversize body', () => new Response('{}', { headers: { 'content-length': '16001' } })],
  ])('treats %s as invalid-provider-response and never echoes it', async (_name, respond) => {
    const { grant, settle } = setup({ fetcher: vi.fn(async () => respond()) });
    const error = await grant({ sessionId: 'session-a', requestId }).catch(e => e);
    expect(error).toMatchObject({ name: 'SpeechError', code: 'invalid-provider-response' });
    expect(String(error.message)).not.toContain('synthetic');
    expect(settle).toHaveBeenCalledExactlyOnceWith('unknown');
  });
  it('uses a short injected timeout, settles unknown exactly once, and never retries', async () => {
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const { settle, reserve } = setup({ fetcher });
    const grant = createSpeechGrant({ deepgramApiKey: 'k', admission: { reserve }, fetcher, timeoutMs: 5 });
    await expect(grant({ sessionId: 'session-a', requestId })).rejects.toMatchObject({ code: 'timeout' });
    expect(fetcher).toHaveBeenCalledOnce(); expect(settle).toHaveBeenCalledExactlyOnceWith('unknown');
  });
  it('caps an oversized injected timeout at ten seconds', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }));
      const { settle, reserve } = setup({ fetcher });
      const grant = createSpeechGrant({ deepgramApiKey: 'k', admission: { reserve }, fetcher, timeoutMs: 60_000 });
      const pending = grant({ sessionId: 'session-a', requestId }).catch(error => error);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toMatchObject({ code: 'timeout' });
      expect(settle).toHaveBeenCalledExactlyOnceWith('unknown');
    } finally { vi.useRealTimers(); }
  });
  it('settles interrupted when the caller cancels an in-flight grant', async () => {
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const { grant, settle } = setup({ fetcher }), caller = new AbortController();
    const pending = grant({ sessionId: 'session-a', requestId }, caller.signal);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    caller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'interrupted' });
    expect(settle).toHaveBeenCalledExactlyOnceWith('interrupted');
  });
  it('never calls the provider when admission denies the reservation', async () => {
    const reserve = vi.fn(async () => { throw new Error('provider-busy'); });
    const { grant, fetcher } = setup({ reserve });
    await expect(grant({ sessionId: 'session-a', requestId })).rejects.toThrow('provider-busy');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('keeps the grant result when bookkeeping throws or rejects', async () => {
    const throwing = setup({ settle: vi.fn(() => { throw new Error('ledger down'); }) });
    expect(await throwing.grant({ sessionId: 'session-a', requestId })).toEqual({ accessToken, expiresIn: speechTokenTtlSeconds });
    const rejecting = setup({ settle: vi.fn(async () => { throw new Error('ledger down'); }) });
    expect(await rejecting.grant({ sessionId: 'session-a', requestId })).toEqual({ accessToken, expiresIn: speechTokenTtlSeconds });
  });
  it('keeps a provider failure as unavailable when bookkeeping throws', async () => {
    const { grant } = setup({ fetcher: vi.fn(async () => new Response('', { status: 500 })), settle: vi.fn(() => { throw new Error('ledger down'); }) });
    await expect(grant({ sessionId: 'session-a', requestId })).rejects.toMatchObject({ code: 'unavailable' });
  });
  it.each([
    ['requestId', { requestId: 'bad id!' }],
    ['sessionId', { sessionId: '' }],
    ['long sessionId', { sessionId: 'x'.repeat(101) }],
  ])('rejects an invalid %s before admission', async (_name, override) => {
    const { grant, reserve, fetcher } = setup();
    await expect(grant({ sessionId: 'session-a', requestId, ...override })).rejects.toMatchObject({ code: 'invalid-request' });
    expect(reserve).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires an API key at construction', () => {
    expect(() => createSpeechGrant({ deepgramApiKey: '', admission: { reserve: vi.fn() } })).toThrow('unavailable');
  });
});
