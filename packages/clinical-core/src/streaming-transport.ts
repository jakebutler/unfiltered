import type { Fetch } from './transport.js';

export class StreamTransportError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(code); this.name = 'StreamTransportError'; }
}
export interface SseOptions {
  timeoutMs: number; maxBytes?: number; maxEventBytes?: number; maxEvents?: number;
  signal?: AbortSignal; onHeaders?: (response: Response) => void;
  onCleanup?: (state: { abortRequested: true; readerCancelRequested: boolean; lateHeadersCleanupRegistered: boolean; providerTermination: 'unconfirmed' }) => void;
  onProgress?: (state: { wireBytes: number; eventCount: number }) => void;
}
/** Bounded SSE only: no retry, redirect, error-body exposure or retained credentials. */
export async function* requestSse(fetcher: Fetch, url: string, init: RequestInit, options: SseOptions): AsyncGenerator<string> {
  const maximum = options.maxBytes ?? 256000, eventMaximum = options.maxEventBytes ?? 64000;
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60000 || !Number.isInteger(maximum) || maximum < 1 || maximum > 2621440 || !Number.isInteger(eventMaximum) || eventMaximum < 1 || eventMaximum > maximum || !Number.isInteger(options.maxEvents ?? 4096) || (options.maxEvents ?? 4096) < 1 || (options.maxEvents ?? 4096) > 4104)
    throw new StreamTransportError('invalid-stream-limits');
  const controller = new AbortController();
  let timedOut = false, lateHeadersCleanupRegistered = false, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs);
  let removeAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(new StreamTransportError(timedOut ? 'stream-timeout' : 'stream-cancelled'));
    controller.signal.addEventListener('abort', fail, { once: true });
    removeAbort = () => controller.signal.removeEventListener('abort', fail);
  });
  // The abort promise can reject during a callback; it is still observed at the next read.
  void aborted.catch(() => undefined);
  try {
    if (controller.signal.aborted) throw new StreamTransportError('stream-cancelled');
    const fetching = fetcher(url, { ...init, signal: controller.signal, redirect: 'error' });
    let response: Response;
    try { response = await Promise.race([fetching, aborted]); }
    catch (error) {
      lateHeadersCleanupRegistered = true;
      void fetching.then(late => { void late.body?.cancel().catch(() => undefined); }, () => undefined);
      throw error;
    }
    reader = response.body?.getReader();
    if (!response.ok) throw new StreamTransportError('stream-http', response.status);
    if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/event-stream' || !response.body)
      throw new StreamTransportError('stream-content-type');
    options.onHeaders?.(response);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0, line = '', data: string[] = [], eventBytes = 0, events = 0, afterCr = false;
    const queued: string[] = [];
    const endLine = () => {
      if (!line) {
        if (data.length) {
          ++events;
          options.onProgress?.({ wireBytes: bytes, eventCount: events });
          if (events > (options.maxEvents ?? 4096)) throw new StreamTransportError('stream-event-limit');
          queued.push(data.join('\n'));
        }
        data = []; eventBytes = 0;
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':'), field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') {
          eventBytes += new TextEncoder().encode(value).byteLength + 1;
          if (eventBytes > eventMaximum) throw new StreamTransportError('stream-event-too-large');
          data.push(value);
        }
      }
      line = '';
    };
    const consume = (text: string) => {
      for (const char of text) {
        if (afterCr) { afterCr = false; if (char === '\n') continue; }
        if (char === '\r') { endLine(); afterCr = true; }
        else if (char === '\n') endLine();
        else {
          line += char;
          if (line.length > eventMaximum) throw new StreamTransportError('stream-line-too-large');
        }
      }
    };
    for (;;) {
      const chunk = await Promise.race([reader!.read(), aborted]);
      if (chunk.done) { consume(decoder.decode()); break; }
      bytes += chunk.value.byteLength;
      options.onProgress?.({ wireBytes: bytes, eventCount: events });
      if (bytes > maximum) throw new StreamTransportError('stream-response-too-large');
      consume(decoder.decode(chunk.value, { stream: true }));
      while (queued.length) yield queued.shift()!;
    }
    while (queued.length) yield queued.shift()!;
    // SSE dispatch requires a blank line. An unterminated event is never a valid terminal packet.
    if (line || data.length) throw new StreamTransportError('stream-truncated-event');
  } catch (error) {
    if (error instanceof StreamTransportError) throw error;
    throw new StreamTransportError(controller.signal.aborted ? timedOut ? 'stream-timeout' : 'stream-cancelled' : error instanceof TypeError ? 'stream-invalid-utf8-or-network' : 'stream-network');
  } finally {
    clearTimeout(timer); removeAbort(); options.signal?.removeEventListener('abort', cancel);
    controller.abort();
    // Cancel acknowledgement can itself hang. Request it without blocking return or
    // claiming that upstream inference stopped; reservations remain charged.
    void reader?.cancel().catch(() => undefined);
    options.onCleanup?.({ abortRequested: true, readerCancelRequested: !!reader, lateHeadersCleanupRegistered, providerTermination: 'unconfirmed' });
  }
}
