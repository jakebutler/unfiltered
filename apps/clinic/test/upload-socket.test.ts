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
  const until = (check: () => boolean) => vi.waitFor(() => { if (!check()) throw new Error('still pending'); });
  return { socket, log, flush, messages, settle, until };
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

  it('reports a rejected transcription as retained and keeps the socket open, without retrying', async () => {
    const fetcher = vi.fn<Fetch>(async () => json({ error: { code: 'stale-session', message: 'The question changed.', retryable: false } }, 409));
    const { socket, log, flush, messages, until } = harness(fetcher);
    flush(); socket.send(JSON.stringify(scope)); socket.send(bytes(1, 2));
    socket.send(JSON.stringify({ type: 'finish' }));
    await until(() => messages().length === 2);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(messages().slice(1)).toEqual([{ type: 'error', code: 'stale-session', message: 'Voice is unavailable for this question.', retained: true }]);
    expect(socket.readyState).toBe(1);
    expect(log.some(event => event.type === 'close')).toBe(false);
  });

  it('retries a network failure once, then keeps the same recording for a manual retry', async () => {
    const fetcher = vi.fn<Fetch>(async () => { throw new TypeError('network down'); });
    const { socket, flush, messages, until } = harness(fetcher);
    flush(); socket.send(JSON.stringify(scope)); socket.send(bytes(1, 2));
    socket.send(JSON.stringify({ type: 'finish' }));
    await until(() => messages().length === 2);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][1].body).toEqual(fetcher.mock.calls[0][1].body);
    expect(messages().slice(1)).toEqual([{ type: 'error', code: 'transcription-unavailable', message: 'Voice is unavailable for this question.', retained: true }]);
    expect(socket.readyState).toBe(1);
  });

  it('completes on the automatic retry without reporting an error', async () => {
    const fetcher = vi.fn<Fetch>().mockRejectedValueOnce(new TypeError('blip')).mockResolvedValueOnce(json({ text: 'Recovered words' }));
    const { socket, flush, messages, until } = harness(fetcher);
    flush(); socket.send(JSON.stringify(scope)); socket.send(bytes(1, 2));
    socket.send(JSON.stringify({ type: 'finish' }));
    await until(() => messages().length === 3);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(messages().slice(1).map(event => event.type)).toEqual(['recognition', 'ended']);
    expect(socket.readyState).toBe(3);
  });

  it('transcribes a kept recording again when asked, and releases it after success', async () => {
    const fetcher = vi.fn<Fetch>()
      .mockRejectedValueOnce(new TypeError('down')).mockRejectedValueOnce(new TypeError('down'))
      .mockResolvedValueOnce(json({ text: 'Second try' }));
    const { socket, flush, messages, until } = harness(fetcher);
    flush(); socket.send(JSON.stringify(scope)); socket.send(bytes(1, 2));
    socket.send(JSON.stringify({ type: 'finish' }));
    await until(() => messages().length === 2);
    socket.retry();
    await until(() => messages().length === 4);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[2][1].body).toEqual(fetcher.mock.calls[0][1].body);
    expect(messages()[2]).toMatchObject({ type: 'recognition', segment: { text: 'Second try' } });
    expect(socket.readyState).toBe(3);
  });

  it('pause stops an in-flight transcription and keeps the recording for a later retry', async () => {
    let calls = 0;
    const fetcher: Fetch = (_, init) => {
      calls++;
      if (calls === 2) return Promise.resolve(json({ text: 'Late words' }));
      return new Promise((_, reject) => { init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); });
    };
    const { socket, flush, messages, until } = harness(fetcher);
    flush(); socket.send(JSON.stringify(scope)); socket.send(bytes(1, 2));
    socket.send(JSON.stringify({ type: 'finish' }));
    await until(() => calls === 1);
    expect(socket.pause()).toBe(true);
    await until(() => messages().length === 2);
    expect(messages().slice(1)).toEqual([{ type: 'error', code: 'transcription-paused', message: 'Voice is unavailable for this question.', retained: true }]);
    expect(calls).toBe(1);
    socket.retry();
    await until(() => messages().length === 4);
    expect(calls).toBe(2);
    expect(socket.pause()).toBe(false);
  });

  it('closing a kept recording drops it, so no later retry can send the audio', async () => {
    const fetcher = vi.fn<Fetch>(async () => json({ error: { code: 'speech-unavailable', message: 'x', retryable: false } }, 503));
    const { socket, flush, messages, until } = harness(fetcher);
    flush(); socket.send(JSON.stringify(scope)); socket.send(bytes(1, 2));
    socket.send(JSON.stringify({ type: 'finish' }));
    await until(() => messages().length === 2);
    expect(fetcher).toHaveBeenCalledTimes(2);
    socket.close();
    socket.retry();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(socket.readyState).toBe(3);
  });

  it('a discard while a failed response body is still being read never starts the automatic retry', async () => {
    const slowError = () => new Response(new ReadableStream({ start(controller) { setTimeout(() => { controller.enqueue(new TextEncoder().encode('{"error":{"code":"speech-unavailable"}}')); controller.close(); }, 10); } }), { status: 503 });
    const fetcher = vi.fn<Fetch>(async () => slowError());
    const { socket, flush, messages, until } = harness(fetcher);
    flush(); socket.send(JSON.stringify(scope)); socket.send(bytes(1, 2));
    socket.send(JSON.stringify({ type: 'finish' }));
    await until(() => fetcher.mock.calls.length === 1);
    socket.close(1000, 'capture-ended');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(messages().slice(1)).toEqual([]);
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
