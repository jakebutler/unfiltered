import { describe, expect, it, vi } from 'vitest';
import { UploadSpeechSocket, uploadPcmLimitBytes } from '../src/upload-socket';

type Fetch = (input: string, init: RequestInit) => Promise<Response>;
const scope = { type: 'start', requestId: 'answer-1', sessionId: 'session-1', promptId: 'Q01', expectedRevision: 7 };
const endpoint = '/api/clinic/speech/transcriptions?sessionId=session-1&promptId=Q01&expectedRevision=7&requestId=answer-1';

/** Schedules open manually so each test controls when the socket becomes OPEN. */
function harness(fetcher: Fetch) {
  const tasks: (() => void)[] = [];
  const socket = new UploadSpeechSocket('wss://clinic.example/api/clinic/speech/input', { fetcher, schedule: fn => { tasks.push(fn); } });
  const log: { type: string; data?: string }[] = [];
  for (const type of ['open', 'message', 'close', 'error']) socket.addEventListener(type, event => log.push({ type, data: event.data }));
  const flush = () => tasks.splice(0).forEach(task => task());
  const messages = () => log.filter(event => event.type === 'message').map(event => JSON.parse(event.data ?? 'null') as Record<string, unknown>);
  const settle = () => vi.waitFor(() => { if (!log.some(event => event.type === 'close')) throw new Error('upload still pending'); });
  return { socket, log, flush, messages, settle };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const bytes = (...values: number[]) => new Uint8Array(values);

describe('UploadSpeechSocket', () => {
  it('opens asynchronously and answers start with the ready format', () => {
    const { socket, log, flush, messages } = harness(async () => json({ text: '' }));
    expect(socket.readyState).toBe(0);
    flush();
    expect(socket.readyState).toBe(1);
    expect(log.map(event => event.type)).toEqual(['open']);
    socket.send(JSON.stringify(scope));
    expect(messages()).toEqual([{ type: 'ready', sampleRate: 16000, channels: 1, maxCaptureMs: 60000 }]);
    expect(socket.bufferedAmount).toBe(0);
  });

  it('buffers binary frames only after start and posts the exact concatenated bytes', async () => {
    const fetcher = vi.fn<Fetch>(async () => json({ text: 'ok' }));
    const { socket, flush, settle } = harness(fetcher);
    flush();
    socket.send(bytes(1, 2));
    socket.send(JSON.stringify(scope));
    const frame = bytes(3, 4, 5);
    socket.send(frame);
    frame.fill(9);
    socket.send(bytes(6));
    socket.send(JSON.stringify({ type: 'finish' }));
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(endpoint);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(init.cache).toBe('no-store');
    expect(init.headers).toEqual({ 'Content-Type': 'application/octet-stream' });
    expect(Array.from(init.body as Uint8Array)).toEqual([3, 4, 5, 6]);
  });

  it('emits recognition, then ended completed, then close on success', async () => {
    const { socket, log, flush, messages, settle } = harness(async () => json({ text: ' I have a headache. ' }));
    flush(); socket.send(JSON.stringify(scope));
    socket.send(new Uint8Array(64000));
    socket.send(JSON.stringify({ type: 'finish' }));
    await settle();
    expect(messages().slice(1)).toEqual([
      { type: 'recognition', segment: { start: 0, duration: 2, text: 'I have a headache.', isFinal: true, speechFinal: true } },
      { type: 'ended', outcome: 'completed' },
    ]);
    expect(log.map(event => event.type)).toEqual(['open', 'message', 'message', 'message', 'close']);
    expect(socket.readyState).toBe(3);
  });

  it('emits no recognition for an empty transcript but still completes', async () => {
    const { socket, flush, messages, settle } = harness(async () => json({ text: '   ' }));
    flush(); socket.send(JSON.stringify(scope)); socket.send(bytes(1, 2));
    socket.send(JSON.stringify({ type: 'finish' }));
    await settle();
    expect(messages().slice(1)).toEqual([{ type: 'ended', outcome: 'completed' }]);
  });

  it('finishes a recording with no audio cleanly, without sending an empty clip', async () => {
    const fetcher = vi.fn<Fetch>(async () => json({ text: 'unused' }));
    const { socket, flush, messages, settle } = harness(fetcher);
    flush(); socket.send(JSON.stringify(scope));
    socket.send(JSON.stringify({ type: 'finish' }));
    await settle();
    expect(fetcher).not.toHaveBeenCalled();
    expect(messages().slice(1)).toEqual([{ type: 'ended', outcome: 'completed' }]);
  });

  it('turns a 409 into an error event and then closes', async () => {
    const { socket, log, flush, messages, settle } = harness(async () => json({ error: { code: 'stale-revision', message: 'The question changed.', retryable: false } }, 409));
    flush(); socket.send(JSON.stringify(scope)); socket.send(bytes(1, 2));
    socket.send(JSON.stringify({ type: 'finish' }));
    await settle();
    expect(messages().slice(1)).toEqual([{ type: 'error', code: 'stale-revision', message: 'Voice is unavailable for this question.' }]);
    expect(log.at(-1)?.type).toBe('close');
  });

  it('turns a network failure into an error event and then closes', async () => {
    const { socket, flush, messages, settle } = harness(async () => { throw new TypeError('network down'); });
    flush(); socket.send(JSON.stringify(scope)); socket.send(bytes(1, 2));
    socket.send(JSON.stringify({ type: 'finish' }));
    await settle();
    expect(messages().slice(1)).toEqual([{ type: 'error', code: 'transcription-unavailable', message: 'Voice is unavailable for this question.' }]);
  });

  it('aborts an in-flight upload on close and suppresses every later event', async () => {
    let signal: AbortSignal | undefined;
    const { socket, log, flush, messages } = harness((_, init) => {
      signal = init.signal ?? undefined;
      return new Promise<Response>((resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')); });
        // A response that arrives after close must still be ignored.
        setTimeout(() => resolve(json({ text: 'late words' })), 5);
      });
    });
    flush(); socket.send(JSON.stringify(scope)); socket.send(bytes(1, 2));
    socket.send(JSON.stringify({ type: 'finish' }));
    socket.close(1000, 'capture-ended');
    expect(signal?.aborted).toBe(true);
    expect(socket.readyState).toBe(3);
    socket.close();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(log.filter(event => event.type === 'close')).toHaveLength(1);
    expect(messages().slice(1)).toEqual([]);
    expect(log.at(-1)?.type).toBe('close');
  });

  it('closes with an error when buffered audio would exceed the limit', async () => {
    const fetcher = vi.fn<Fetch>(async () => json({ text: 'never' }));
    const { socket, log, flush, messages } = harness(fetcher);
    flush(); socket.send(JSON.stringify(scope));
    socket.send(new Uint8Array(uploadPcmLimitBytes));
    socket.send(new Uint8Array(1));
    expect(messages().slice(1)).toEqual([{ type: 'error', code: 'audio-too-large', message: 'Voice is unavailable for this question.' }]);
    expect(log.at(-1)?.type).toBe('close');
    socket.send(JSON.stringify({ type: 'finish' }));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects malformed control messages with an error and close', () => {
    const { socket, flush, messages, log } = harness(async () => json({ text: '' }));
    flush();
    socket.send('{"type":"start"}');
    expect(messages()).toEqual([{ type: 'error', code: 'invalid-control', message: 'Voice is unavailable for this question.' }]);
    expect(log.at(-1)?.type).toBe('close');
  });
});
