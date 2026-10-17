import { describe, expect, it, vi } from 'vitest';
import { createSpeechUploadHandler } from '../../../apps/clinic-server/src/speech-upload.js';
import { ApiFailure } from '../../../packages/clinic-api/src/types.js';
import { speechTranscriptionPath } from '../../../packages/clinic-api/src/speech-access.js';
import { speechUploadMaxBytes } from '../src/transcribe.js';

const origin = 'https://clinic.example';
const sessionId = '6f1f3d3e-2d4b-4c1e-9a53-3c1b2a4d5e6f';
const requestId = '0b8f6a4e-7c2d-4e91-8f3a-1d2c3b4a5e6f';
const query = `?sessionId=${sessionId}&promptId=prompt-a&expectedRevision=3&requestId=${requestId}`;
const pcm = new Uint8Array([1, 2, 3, 4]);
function setup() {
  const capture = vi.fn(async () => ({ sessionId, promptId: 'prompt-a', revision: 3 }));
  const transcribe = vi.fn(async () => ({ text: 'I have a sore throat.' }));
  const handler = createSpeechUploadHandler({ access: { upload: capture } as never, transcribe: transcribe as never });
  return { capture, transcribe, handler };
}
const upload = (search = query, init: { type?: string; length?: string; body?: Uint8Array } = {}) => new Request(`${origin}${speechTranscriptionPath}${search}`, {
  method: 'POST', headers: { origin, 'content-type': init.type ?? 'application/octet-stream', ...(init.length ? { 'content-length': init.length } : {}) }, body: init.body ?? pcm,
});

describe('push-to-talk transcription route', () => {
  it('leaves other paths and other API routes to the clinic handler', async () => {
    const { handler, capture, transcribe } = setup();
    expect(await handler.handle(new Request(`${origin}/api/clinic/config`))).toBeUndefined();
    expect(await handler.handle(new Request(`${origin}/api/clinic/speech/output`, { method: 'POST' }))).toBeUndefined();
    expect(capture).not.toHaveBeenCalled(); expect(transcribe).not.toHaveBeenCalled();
  });
  it('answers other methods on the transcription path with a JSON 405', async () => {
    const { handler, capture } = setup();
    const response = await handler.handle(new Request(`${origin}${speechTranscriptionPath}${query}`, { method: 'GET' }));
    expect(response?.status).toBe(405); expect(response?.headers.get('content-type')).toContain('json');
    expect(capture).not.toHaveBeenCalled();
  });
  it.each([
    ['missing requestId', '?sessionId=' + sessionId + '&promptId=prompt-a&expectedRevision=3'],
    ['non-uuid sessionId', `?sessionId=bad&promptId=prompt-a&expectedRevision=3&requestId=${requestId}`],
    ['negative revision', `?sessionId=${sessionId}&promptId=prompt-a&expectedRevision=-1&requestId=${requestId}`],
    ['unknown parameter', query + '&extra=1'],
  ])('rejects a malformed scope (%s) with 400 before authorization', async (_name, search) => {
    const { handler, capture, transcribe } = setup();
    const response = await handler.handle(upload(search));
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ error: { code: 'invalid-speech-request', retryable: false } });
    expect(capture).not.toHaveBeenCalled(); expect(transcribe).not.toHaveBeenCalled();
  });
  it('rejects a non-octet-stream body with 415 before authorization', async () => {
    const { handler, capture } = setup();
    const response = await handler.handle(upload(query, { type: 'audio/webm' }));
    expect(response?.status).toBe(415); expect(capture).not.toHaveBeenCalled();
  });
  it('refuses a declared oversize body with 413 without authorization or a body read', async () => {
    const { handler, capture, transcribe } = setup();
    const response = await handler.handle(upload(query, { length: String(speechUploadMaxBytes + 1) }));
    expect(response?.status).toBe(413);
    expect(capture).not.toHaveBeenCalled(); expect(transcribe).not.toHaveBeenCalled();
  });
  it('refuses an undeclared oversize body with 413 when the stream exceeds the cap', async () => {
    const { handler, transcribe } = setup();
    const chunked = new ReadableStream<Uint8Array>({ start(control) { control.enqueue(new Uint8Array(speechUploadMaxBytes)); control.enqueue(new Uint8Array(2)); control.close(); } });
    const request = new Request(`${origin}${speechTranscriptionPath}${query}`, { method: 'POST', headers: { origin, 'content-type': 'application/octet-stream' }, body: chunked, duplex: 'half' } as RequestInit);
    const response = await handler.handle(request);
    expect(response?.status).toBe(413); expect(transcribe).not.toHaveBeenCalled();
  });
  it('maps a closed or paused session from authorization to 409 and never reaches the transcriber', async () => {
    const { handler, capture, transcribe } = setup();
    capture.mockRejectedValueOnce(new ApiFailure('speech-conversation-required', 409));
    const response = await handler.handle(upload());
    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({ error: { code: 'speech-conversation-required', message: expect.any(String), retryable: false } });
    expect(transcribe).not.toHaveBeenCalled();
  });
  it('returns the transcript only as no-store JSON on success and scopes the transcriber to the verified session', async () => {
    const { handler, capture, transcribe } = setup();
    const response = await handler.handle(upload());
    expect(response?.status).toBe(200);
    expect(response?.headers.get('cache-control')).toBe('no-store');
    expect(await response?.json()).toEqual({ text: 'I have a sore throat.' });
    expect(capture).toHaveBeenCalledExactlyOnceWith(expect.any(Request), { sessionId, promptId: 'prompt-a', expectedRevision: 3, requestId });
    expect(transcribe).toHaveBeenCalledExactlyOnceWith({ sessionId, requestId, pcm: expect.any(Uint8Array) }, expect.anything());
  });
  it('maps a provider timeout to a 504 safe JSON error without transcript or provider detail', async () => {
    const { handler, transcribe } = setup();
    const { SpeechError } = await import('../src/contracts.js');
    transcribe.mockRejectedValueOnce(new SpeechError('timeout'));
    const response = await handler.handle(upload());
    expect(response?.status).toBe(504);
    const body = await response?.text();
    expect(body).toContain('"retryable":false'); expect(body).not.toContain('sore throat');
  });
});
