import { describe, expect, it, vi } from 'vitest';
import { createSpeechTokenHandler } from '../../../apps/clinic-server/src/speech-token.js';
import { ApiFailure } from '../../../packages/clinic-api/src/types.js';
import { AdmissionError } from '../../../packages/clinic-api/src/provider-admission.js';
import { speechTokenPath, SpeechError } from '../src/contracts.js';

const origin = 'https://clinic.example';
const sessionId = '6f1f3d3e-2d4b-4c1e-9a53-3c1b2a4d5e6f';
const requestId = '0b8f6a4e-7c2d-4e91-8f3a-1d2c3b4a5e6f';
const body = { requestId, sessionId, promptId: 'prompt-a', expectedRevision: 3 };
const accessToken = 'synthetic.access-token_value-123';
function setup() {
  const authenticate = vi.fn(async () => ({ sessionId }));
  const token = vi.fn(async () => ({ sessionId, promptId: 'prompt-a', revision: 3 }));
  const grant = vi.fn(async () => ({ accessToken, expiresIn: 30 }));
  const handler = createSpeechTokenHandler({ access: { authenticate, token } as never, grant: grant as never });
  return { authenticate, token, grant, handler };
}
const mint = (init: { method?: string; search?: string; type?: string; body?: string } = {}) => {
  const method = init.method ?? 'POST';
  return new Request(`${origin}${speechTokenPath}${init.search ?? ''}`, {
    method, headers: { origin, 'content-type': init.type ?? 'application/json' },
    body: method === 'POST' ? init.body ?? JSON.stringify(body) : undefined,
  });
};

describe('hosted speech token route', () => {
  it('leaves other paths to the rest of the clinic server', async () => {
    const { handler, token, grant } = setup();
    expect(await handler.handle(new Request(`${origin}/api/clinic/speech/output`, { method: 'POST' }))).toBeUndefined();
    expect(await handler.handle(new Request(`${origin}/api/clinic/speech/transcriptions`, { method: 'POST' }))).toBeUndefined();
    expect(token).not.toHaveBeenCalled(); expect(grant).not.toHaveBeenCalled();
  });
  it('answers other methods on the token path with a JSON 405', async () => {
    const { handler, token, grant } = setup();
    const response = await handler.handle(mint({ method: 'GET' }));
    expect(response?.status).toBe(405); expect(response?.headers.get('content-type')).toContain('json');
    expect(token).not.toHaveBeenCalled(); expect(grant).not.toHaveBeenCalled();
  });
  it('refuses a query string with 400', async () => {
    const { handler, token } = setup();
    const response = await handler.handle(mint({ search: '?debug=1' }));
    expect(response?.status).toBe(400); expect(token).not.toHaveBeenCalled();
  });
  it('refuses a non-JSON body with 415 before reading or authorizing', async () => {
    const { handler, authenticate, token, grant } = setup();
    const response = await handler.handle(mint({ type: 'text/plain' }));
    expect(response?.status).toBe(415); expect(authenticate).not.toHaveBeenCalled(); expect(token).not.toHaveBeenCalled(); expect(grant).not.toHaveBeenCalled();
  });
  it('refuses an oversize body with 413 without authorization or a grant', async () => {
    const { handler, token, grant } = setup();
    const response = await handler.handle(mint({ body: JSON.stringify({ ...body, promptId: 'x'.repeat(2100) }) }));
    expect(response?.status).toBe(413); expect(token).not.toHaveBeenCalled(); expect(grant).not.toHaveBeenCalled();
  });
  it('refuses an undeclared oversize stream with 413', async () => {
    const { handler, grant } = setup();
    const chunked = new ReadableStream<Uint8Array>({ start(control) { control.enqueue(new Uint8Array(2048)); control.enqueue(new Uint8Array(2)); control.close(); } });
    const request = new Request(`${origin}${speechTokenPath}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: chunked, duplex: 'half' } as RequestInit);
    expect((await handler.handle(request))?.status).toBe(413); expect(grant).not.toHaveBeenCalled();
  });
  it.each([
    ['malformed JSON', '{not json'],
    ['missing requestId', JSON.stringify({ sessionId, promptId: 'prompt-a', expectedRevision: 3 })],
    ['non-uuid sessionId', JSON.stringify({ ...body, sessionId: 'bad' })],
    ['negative revision', JSON.stringify({ ...body, expectedRevision: -1 })],
    ['fractional revision', JSON.stringify({ ...body, expectedRevision: 1.5 })],
    ['empty promptId', JSON.stringify({ ...body, promptId: '' })],
    ['unknown field', JSON.stringify({ ...body, text: 'Say this' })],
  ])('rejects a schema failure (%s) with 400 before authorization', async (_name, text) => {
    const { handler, token, grant } = setup();
    const response = await handler.handle(mint({ body: text }));
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ error: { code: 'invalid-speech-request', retryable: false } });
    expect(token).not.toHaveBeenCalled(); expect(grant).not.toHaveBeenCalled();
  });
  it('returns only the short-lived token as no-store JSON after the same scope check as capture', async () => {
    const { handler, token, grant } = setup();
    const response = await handler.handle(mint());
    expect(response?.status).toBe(200);
    expect(response?.headers.get('cache-control')).toBe('no-store');
    expect(await response?.json()).toEqual({ accessToken, expiresIn: 30 });
    expect(token).toHaveBeenCalledExactlyOnceWith(expect.any(Request), { sessionId, promptId: 'prompt-a', expectedRevision: 3, requestId });
    expect(grant).toHaveBeenCalledExactlyOnceWith({ sessionId, requestId }, expect.anything());
  });
  it('refuses an unauthenticated caller before any body read or scope check', async () => {
    const { handler, authenticate, token, grant } = setup();
    authenticate.mockRejectedValueOnce(new ApiFailure('session-required', 401));
    const response = await handler.handle(mint());
    expect(response?.status).toBe(401); expect(token).not.toHaveBeenCalled(); expect(grant).not.toHaveBeenCalled();
  });
  it('propagates an access refusal status and never calls the grant', async () => {
    const { handler, token, grant } = setup();
    token.mockRejectedValueOnce(new ApiFailure('stale-prompt', 409));
    const response = await handler.handle(mint());
    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({ error: { code: 'stale-prompt', message: expect.any(String), retryable: false } });
    expect(grant).not.toHaveBeenCalled();
  });
  it('maps a busy or exhausted provider budget to 429 speech-budget', async () => {
    const { handler, grant } = setup();
    grant.mockRejectedValueOnce(new AdmissionError('provider-busy'));
    const response = await handler.handle(mint());
    expect(response?.status).toBe(429);
    expect(await response?.json()).toEqual({ error: { code: 'speech-budget', message: expect.any(String), retryable: false } });
  });
  it('maps an unresolvable budget ledger to 503 without a budget code', async () => {
    const { handler, grant } = setup();
    grant.mockRejectedValueOnce(new AdmissionError('budget-outcome-unknown'));
    const response = await handler.handle(mint());
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({ error: { code: 'speech-unavailable', retryable: false } });
  });
  it('marks provider unavailability and timeouts retryable without echoing provider detail', async () => {
    const { handler, grant } = setup();
    grant.mockRejectedValueOnce(new SpeechError('unavailable'));
    const unavailable = await handler.handle(mint());
    expect(unavailable?.status).toBe(503);
    expect(await unavailable?.json()).toEqual({ error: { code: 'unavailable', message: expect.any(String), retryable: true } });
    grant.mockRejectedValueOnce(new SpeechError('timeout'));
    const timeout = await handler.handle(mint());
    expect(timeout?.status).toBe(504);
    const text = await timeout?.text();
    expect(text).toContain('"retryable":true'); expect(text).not.toContain(accessToken);
  });
  it('does not mark an invalid provider response retryable', async () => {
    const { handler, grant } = setup();
    grant.mockRejectedValueOnce(new SpeechError('invalid-provider-response'));
    const response = await handler.handle(mint());
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({ error: { code: 'invalid-provider-response', retryable: false } });
  });
});
