import { describe, expect, it, vi } from 'vitest';
import { DirectSpeechSocket, type ProviderEvent, type ProviderSocket } from '../src/direct-socket';
import { deepgramDirectListenUrl, directCaptureMs, speechTokenPath } from '../../../packages/speech/src/contracts';

type Fetch = (input: string, init: RequestInit) => Promise<Response>;
type Listener = (event: ProviderEvent) => void;
type LogEvent = { type: string; data?: string };
const token = 'tok_Abc-123.def_456';
const start = { type: 'start', requestId: 'req-1', sessionId: 'session-1', promptId: 'Q01', expectedRevision: 7 };
const unavailable = 'Voice is unavailable for this question.';
const fallbackMessage = 'Hands-free voice could not connect.';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const bytes = (...values: number[]) => new Uint8Array(values);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const okToken: Fetch = async () => json({ accessToken: token, expiresIn: 30 });
const results = (transcript: string, isFinal = true, speechFinal = false) => JSON.stringify({
  type: 'Results', start: 1.5, duration: 2, is_final: isFinal, speech_final: speechFinal, channel: { alternatives: [{ transcript }] },
});

/** EventTarget-like provider fake that the test drives explicitly. */
class FakeProvider implements ProviderSocket {
  readyState = 0;
  bufferedAmount = 0;
  binaryType = 'blob';
  readonly sent: (string | ArrayBuffer | ArrayBufferView)[] = [];
  readonly closes: { code?: number; reason?: string }[] = [];
  private listeners = new Map<string, Set<Listener>>();
  send(data: string | ArrayBuffer | ArrayBufferView) { this.sent.push(data); }
  close(code?: number, reason?: string) { this.closes.push({ code, reason }); this.readyState = 2; }
  addEventListener(type: string, listener: Listener) {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener); this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: Listener) { this.listeners.get(type)?.delete(listener); }
  listenerCount() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
  open() { this.readyState = 1; this.dispatch('open', {}); }
  message(data: unknown) { this.dispatch('message', { data }); }
  drop(code = 1006) { this.readyState = 3; this.dispatch('close', { code }); }
  fail() { this.dispatch('error', {}); }
  texts() { return this.sent.filter((data): data is string => typeof data === 'string'); }
  private dispatch(type: string, event: ProviderEvent) { for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event); }
}

/** Manual timer queue: deterministic timeouts and keepalives without faking globals. */
class ManualTimers {
  now = 0;
  private entries = new Map<number, { at: number; fn: () => void }>();
  private next = 1;
  readonly set = (fn: () => void, ms: number) => { const id = this.next++; this.entries.set(id, { at: this.now + ms, fn }); return id; };
  readonly clear = (handle: unknown) => { this.entries.delete(handle as number); };
  advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.entries) if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
      if (!due) break;
      this.entries.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
    }
    this.now = end;
  }
}

function harness(fetcher: Fetch = okToken, connectOverride?: () => ProviderSocket) {
  const tasks: (() => void)[] = [];
  const timers = new ManualTimers();
  const providers: FakeProvider[] = [];
  const connect = vi.fn((_url: string, _protocols: string[]) => {
    if (connectOverride) return connectOverride();
    const provider = new FakeProvider();
    providers.push(provider);
    return provider;
  });
  const fetcherSpy = vi.fn<Fetch>(fetcher);
  const socket = new DirectSpeechSocket('wss://clinic.example/api/clinic/speech/input', {
    fetcher: fetcherSpy, connect, schedule: fn => { tasks.push(fn); }, setTimer: timers.set, clearTimer: timers.clear,
  });
  const log: LogEvent[] = [];
  for (const type of ['open', 'message', 'close', 'error']) socket.addEventListener(type, event => { log.push({ type, data: event.data }); });
  const flush = () => tasks.splice(0).forEach(task => task());
  const types = () => log.map(event => event.type);
  const messages = () => log.filter(event => event.type === 'message').map(event => JSON.parse(event.data ?? 'null') as Record<string, unknown>);
  const until = (check: () => boolean) => vi.waitFor(() => { if (!check()) throw new Error('still pending'); });
  const provider = () => {
    const first = providers[0];
    if (!first) throw new Error('no provider');
    return first;
  };
  /** Opens the socket and sends start; the token request is now in flight. */
  const begin = () => { flush(); socket.send(JSON.stringify(start)); };
  /** Starts, waits for the provider to be created, and leaves it connecting. */
  const connecting = async () => { begin(); await until(() => providers.length === 1); };
  /** Starts and drives the provider open so the socket reports ready. */
  const ready = async () => {
    await connecting();
    provider().open();
    await until(() => messages().some(message => message.type === 'ready'));
  };
  return { socket, log, flush, types, messages, until, provider, providers, fetcherSpy, connect, timers, begin, connecting, ready };
}

describe('DirectSpeechSocket', () => {
  it('opens asynchronously and reports the open state only after the scheduled task runs', () => {
    const { socket, flush, types } = harness();
    expect(socket.readyState).toBe(0);
    flush();
    expect(socket.readyState).toBe(1);
    expect(types()).toEqual(['open']);
  });

  it('requests a token with the four scope fields, same-origin credentials, and no cache', async () => {
    const { fetcherSpy, begin, until } = harness();
    begin();
    await until(() => fetcherSpy.mock.calls.length === 1);
    const [path, init] = fetcherSpy.mock.calls[0];
    expect(path).toBe(speechTokenPath);
    expect(path).toBe('/api/clinic/speech/tokens');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(init.cache).toBe('no-store');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ requestId: 'req-1', sessionId: 'session-1', promptId: 'Q01', expectedRevision: 7 });
  });

  it('connects to the direct Deepgram URL with a bearer subprotocol and emits ready at the direct capture limit', async () => {
    const { connect, provider, messages, ready } = harness();
    await ready();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(deepgramDirectListenUrl, ['bearer', token]);
    expect(provider().binaryType).toBe('arraybuffer');
    expect(messages()).toEqual([{ type: 'ready', sampleRate: 16000, channels: 1, maxCaptureMs: 59000 }]);
    expect(directCaptureMs).toBe(59000);
  });

  it('the direct listen URL asks for nova-3-medical, an 800ms endpoint, and filler words so the endpoint grace can hear "um"', () => {
    const params = new URL(deepgramDirectListenUrl).searchParams;
    expect(params.get('model')).toBe('nova-3-medical');
    expect(params.get('endpointing')).toBe('800');
    expect(params.get('filler_words')).toBe('true');
  });

  it('drops audio before ready and forwards a copy after ready', async () => {
    const { provider, connecting, socket, until } = harness();
    await connecting();
    socket.send(bytes(1, 2));
    provider().open();
    await until(() => socket.readyState === 1);
    expect(provider().sent).toEqual([]);
    const frame = bytes(5, 6);
    socket.send(frame);
    frame.fill(9);
    expect(provider().sent).toHaveLength(1);
    expect(Array.from(provider().sent[0] as Uint8Array)).toEqual([5, 6]);
  });

  it('mirrors the provider bufferedAmount and reports zero before the provider exists', async () => {
    const { socket, provider, connecting } = harness();
    expect(socket.bufferedAmount).toBe(0);
    await connecting();
    expect(socket.bufferedAmount).toBe(0);
    provider().open();
    provider().bufferedAmount = 4096;
    expect(socket.bufferedAmount).toBe(4096);
  });

  it('drops binary audio sent before start without fetching a token', async () => {
    const { socket, flush, fetcherSpy, providers, log } = harness();
    flush();
    socket.send(bytes(1, 2));
    await sleep(5);
    expect(fetcherSpy).not.toHaveBeenCalled();
    expect(providers).toHaveLength(0);
    expect(socket.readyState).toBe(1);
    expect(log.map(event => event.type)).toEqual(['open']);
  });

  it('forwards recognition and speech-started events and ignores metadata and utterance end', async () => {
    const { provider, messages, ready } = harness();
    await ready();
    provider().message(JSON.stringify({ type: 'Metadata', request_id: 'provider-request' }));
    provider().message(JSON.stringify({ type: 'UtteranceEnd', last_word_end: 2 }));
    provider().message(JSON.stringify({ type: 'SpeechStarted' }));
    provider().message(results('Hello there', true, true));
    expect(messages().slice(1)).toEqual([
      { type: 'speech-started' },
      { type: 'recognition', segment: { start: 1.5, duration: 2, text: 'Hello there', isFinal: true, speechFinal: true } },
    ]);
  });

  it('turns a malformed provider message into an error and closes both sides without a fallback flag', async () => {
    const { provider, messages, types, ready } = harness();
    await ready();
    provider().message('not json');
    expect(messages().slice(1)).toEqual([{ type: 'error', code: 'invalid-provider-response', message: unavailable }]);
    expect(types().at(-1)).toBe('close');
    expect(provider().closes).toEqual([{ code: 1000, reason: 'speech-ended' }]);
  });

  it('treats a binary provider frame as malformed', async () => {
    const { provider, messages, ready } = harness();
    await ready();
    provider().message(new ArrayBuffer(4));
    expect(messages().slice(1)).toEqual([{ type: 'error', code: 'invalid-provider-response', message: unavailable }]);
  });

  it('reports a provider Error without forwarding its detail', async () => {
    const { provider, log, messages, ready } = harness();
    await ready();
    provider().message(JSON.stringify({ type: 'Error', err_code: 'INTERNAL', err_msg: 'secret provider detail' }));
    expect(messages().slice(1)).toEqual([{ type: 'error', code: 'unavailable', message: unavailable }]);
    expect(JSON.stringify(log)).not.toContain('secret provider detail');
    expect(JSON.stringify(log)).not.toContain('INTERNAL');
    expect(log.at(-1)?.type).toBe('close');
  });

  it('fails when the provider exceeds the 600-message limit', async () => {
    const { provider, messages, ready } = harness();
    await ready();
    for (let index = 0; index < 600; index++) provider().message(JSON.stringify({ type: 'Metadata' }));
    expect(messages()).toHaveLength(1);
    provider().message(JSON.stringify({ type: 'Metadata' }));
    expect(messages().slice(1)).toEqual([{ type: 'error', code: 'limit', message: unavailable }]);
  });

  it('fails when provider messages exceed the 2,000,000-byte total', async () => {
    const { provider, messages, ready } = harness();
    await ready();
    const large = JSON.stringify({ type: 'Metadata', pad: 'x'.repeat(60_000) });
    for (let index = 0; index < 33; index++) provider().message(large);
    expect(messages()).toHaveLength(1);
    provider().message(large);
    expect(messages().slice(1)).toEqual([{ type: 'error', code: 'limit', message: unavailable }]);
  });

  it('rejects an invalid start with an error and close, without fetching a token', () => {
    const { socket, fetcherSpy, messages, types, flush } = harness();
    flush();
    socket.send(JSON.stringify({ ...start, requestId: undefined }));
    expect(messages()).toEqual([{ type: 'error', code: 'invalid-control', message: unavailable }]);
    expect(types().at(-1)).toBe('close');
    expect(fetcherSpy).not.toHaveBeenCalled();
  });

  it('rejects a second start with an error and close', async () => {
    const { socket, messages, types, begin, until, fetcherSpy } = harness();
    begin();
    await until(() => fetcherSpy.mock.calls.length === 1);
    socket.send(JSON.stringify(start));
    expect(messages()).toEqual([{ type: 'error', code: 'invalid-control', message: unavailable }]);
    expect(types().at(-1)).toBe('close');
  });

  it('rejects a non-finish control before start', () => {
    const { socket, messages, flush } = harness();
    flush();
    socket.send('{"type":"KeepAlive"}');
    expect(messages()).toEqual([{ type: 'error', code: 'invalid-control', message: unavailable }]);
  });

  it('rejects finish before the provider is ready, and never opens the provider', async () => {
    const { socket, messages, types, begin, connect } = harness(async () => { await sleep(5); return json({ accessToken: token }); });
    begin();
    socket.send('{"type":"finish"}');
    expect(messages()).toEqual([{ type: 'error', code: 'not-ready', message: unavailable }]);
    expect(types().at(-1)).toBe('close');
    await sleep(15);
    expect(connect).not.toHaveBeenCalled();
  });

  it('emits a fallback error and closes when the token endpoint returns an HTTP error', async () => {
    const { socket, connect, messages, types, begin, until } = harness(async () => json({ error: { code: 'speech-unavailable', message: 'x', retryable: true } }, 503));
    begin();
    await until(() => types().at(-1) === 'close');
    expect(messages()).toEqual([{ type: 'error', code: 'speech-unavailable', message: fallbackMessage, fallback: true }]);
    expect(connect).not.toHaveBeenCalled();
    expect(socket.readyState).toBe(3);
  });

  it.each([[409, 'speech-buttons-only'], [429, 'speech-budget'], [403, 'session-scope-denied']])('treats a %i token refusal as a plain error, never a push-to-talk fallback', async (status, code) => {
    const { connect, messages, types, begin, until } = harness(async () => json({ error: { code, message: 'x', retryable: false } }, status));
    begin();
    await until(() => types().at(-1) === 'close');
    expect(messages()).toEqual([{ type: 'error', code, message: 'Voice is unavailable for this question.' }]);
    expect(connect).not.toHaveBeenCalled();
  });

  it('uses an HTTP status code when the token error body is not parseable', async () => {
    const { messages, types, begin, until } = harness(async () => new Response('<html>', { status: 502 }));
    begin();
    await until(() => types().at(-1) === 'close');
    expect(messages()).toEqual([{ type: 'error', code: 'http-502', message: fallbackMessage, fallback: true }]);
  });

  it('emits a fallback error when the token request fails at the network level', async () => {
    const { messages, types, begin, until, connect } = harness(async () => { throw new TypeError('network down'); });
    begin();
    await until(() => types().at(-1) === 'close');
    expect(messages()).toEqual([{ type: 'error', code: 'token-unavailable', message: fallbackMessage, fallback: true }]);
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', ''],
    ['too long', 'a'.repeat(4097)],
    ['with a space', 'bad token'],
    ['with a slash', 'tok/en'],
    ['not a string', 42],
    ['missing', undefined],
  ])('rejects a %s token without opening the provider', async (_label, accessToken) => {
    const { messages, types, begin, until, connect } = harness(async () => json({ accessToken }));
    begin();
    await until(() => types().at(-1) === 'close');
    expect(messages()).toEqual([{ type: 'error', code: 'invalid-token', message: fallbackMessage, fallback: true }]);
    expect(connect).not.toHaveBeenCalled();
  });

  it('falls back when the token request does not answer within 10 seconds', async () => {
    const { timers, messages, types, begin, connect } = harness((_input, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    begin();
    timers.advance(9_999);
    expect(messages()).toEqual([]);
    timers.advance(1);
    expect(messages()).toEqual([{ type: 'error', code: 'token-timeout', message: fallbackMessage, fallback: true }]);
    expect(types().at(-1)).toBe('close');
    expect(connect).not.toHaveBeenCalled();
  });

  it('falls back when the provider does not open within 10 seconds, and closes it', async () => {
    const { provider, timers, messages, types, connecting } = harness();
    await connecting();
    expect(provider().readyState).toBe(0);
    timers.advance(10_000);
    expect(messages()).toEqual([{ type: 'error', code: 'provider-timeout', message: fallbackMessage, fallback: true }]);
    expect(types().at(-1)).toBe('close');
    expect(provider().closes).toEqual([{ code: 1000, reason: 'speech-ended' }]);
    expect(provider().listenerCount()).toBe(0);
  });

  it('falls back when the provider cannot be constructed, without echoing the token', async () => {
    const { messages, types, begin, until } = harness(okToken, () => { throw new Error(`bad protocol ${token}`); });
    begin();
    await until(() => types().at(-1) === 'close');
    expect(messages()).toEqual([{ type: 'error', code: 'provider-unavailable', message: fallbackMessage, fallback: true }]);
    expect(JSON.stringify(messages())).not.toContain(token);
  });

  it('falls back when the provider closes before it is ready', async () => {
    const { provider, messages, types, connecting } = harness();
    await connecting();
    provider().drop(1006);
    expect(messages()).toEqual([{ type: 'error', code: 'provider-closed', message: fallbackMessage, fallback: true }]);
    expect(types().at(-1)).toBe('close');
  });

  it('sends CloseStream on finish and completes on a clean provider close', async () => {
    const { socket, provider, messages, types, ready } = harness();
    await ready();
    socket.send(bytes(1, 2, 3));
    socket.send('{"type":"finish"}');
    expect(provider().texts()).toEqual(['{"type":"CloseStream"}']);
    provider().message(results('Final words', true, true));
    provider().drop(1000);
    expect(messages().slice(1)).toEqual([
      { type: 'recognition', segment: { start: 1.5, duration: 2, text: 'Final words', isFinal: true, speechFinal: true } },
      { type: 'ended', outcome: 'completed' },
    ]);
    expect(types().at(-1)).toBe('close');
    expect(socket.readyState).toBe(3);
  });

  it('ends unknown when the provider closes uncleanly after finish', async () => {
    const { socket, provider, messages, ready } = harness();
    await ready();
    socket.send('{"type":"finish"}');
    provider().drop(1006);
    expect(messages().slice(1)).toEqual([{ type: 'ended', outcome: 'unknown' }]);
    expect(socket.readyState).toBe(3);
  });

  it('ends unknown after five seconds if the provider never confirms the finish', async () => {
    const { socket, provider, timers, messages, types, ready } = harness();
    await ready();
    socket.send('{"type":"finish"}');
    timers.advance(4_999);
    expect(messages()).toHaveLength(1);
    timers.advance(1);
    expect(messages().slice(1)).toEqual([{ type: 'ended', outcome: 'unknown' }]);
    expect(types().at(-1)).toBe('close');
    expect(provider().closes).toEqual([{ code: 1000, reason: 'speech-ended' }]);
  });

  it('ends interrupted when the provider drops mid-stream, with no fallback flag', async () => {
    const { provider, messages, types, ready } = harness();
    await ready();
    provider().drop(1006);
    expect(messages().slice(1)).toEqual([{ type: 'ended', outcome: 'interrupted' }]);
    expect(JSON.stringify(messages())).not.toContain('fallback');
    expect(types().at(-1)).toBe('close');
  });

  it('ends interrupted when the provider reports an error mid-stream', async () => {
    const { provider, messages, ready } = harness();
    await ready();
    provider().fail();
    expect(messages().slice(1)).toEqual([{ type: 'ended', outcome: 'interrupted' }]);
  });

  it('sends KeepAlive after five idle seconds and every five seconds while idle', async () => {
    const { provider, timers, ready } = harness();
    await ready();
    timers.advance(4_999);
    expect(provider().texts()).toEqual([]);
    timers.advance(1);
    expect(provider().texts()).toEqual(['{"type":"KeepAlive"}']);
    timers.advance(5_000);
    expect(provider().texts()).toEqual(['{"type":"KeepAlive"}', '{"type":"KeepAlive"}']);
  });

  it('sends no KeepAlive while audio keeps flowing, then resumes after idle', async () => {
    const { socket, provider, timers, ready } = harness();
    await ready();
    for (let index = 0; index < 12; index++) {
      socket.send(bytes(1, 2));
      timers.advance(1_000);
    }
    expect(provider().texts()).toEqual([]);
    timers.advance(5_000);
    expect(provider().texts()).toEqual(['{"type":"KeepAlive"}']);
  });

  it('stops KeepAlive once finishing', async () => {
    const { socket, provider, timers, ready } = harness();
    await ready();
    socket.send('{"type":"finish"}');
    timers.advance(4_999);
    expect(provider().texts()).toEqual(['{"type":"CloseStream"}']);
  });

  it('close aborts an in-flight token request and suppresses every later event', async () => {
    let signal: AbortSignal | undefined;
    const { socket, connect, log, types, begin, fetcherSpy } = harness((_input, init) => {
      signal = init.signal ?? undefined;
      return new Promise<Response>(resolve => { setTimeout(() => resolve(json({ accessToken: token })), 5); });
    });
    begin();
    expect(fetcherSpy).toHaveBeenCalledTimes(1);
    socket.close();
    expect(signal?.aborted).toBe(true);
    expect(socket.readyState).toBe(3);
    await sleep(20);
    expect(connect).not.toHaveBeenCalled();
    expect(log.filter(event => event.type === 'message')).toEqual([]);
    expect(types()).toEqual(['open', 'close']);
  });

  it('close is idempotent, closes the open provider once, and ignores later provider traffic', async () => {
    const { socket, provider, types, ready } = harness();
    await ready();
    socket.close();
    socket.close();
    expect(types().filter(type => type === 'close')).toHaveLength(1);
    expect(provider().closes).toEqual([{ code: 1000, reason: 'speech-ended' }]);
    expect(provider().listenerCount()).toBe(0);
    socket.send(bytes(1, 2));
    provider().message(results('late'));
    expect(types().filter(type => type === 'close')).toHaveLength(1);
    expect(provider().sent).toEqual([]);
  });

  it('never places the token in any emitted event across a full successful session', async () => {
    const { socket, log, provider, ready } = harness();
    await ready();
    socket.send(bytes(1, 2));
    provider().message(results('words'));
    socket.send('{"type":"finish"}');
    provider().drop(1000);
    expect(JSON.stringify(log)).not.toContain(token);
  });
});
