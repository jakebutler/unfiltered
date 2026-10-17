import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Native request cancellation and incremental response forwarding; never buffers a whole speech body. */
export function nodeHttpHandler(handler: (request: Request) => Promise<Response>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const abort = new AbortController();
    const disconnected = () => { if (!res.writableFinished) abort.abort(); };
    req.once('aborted', disconnected); res.once('close', disconnected); res.once('error', disconnected);
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const request = new Request(`http://127.0.0.1:8787${req.url}`, { method: req.method, headers, signal: abort.signal,
        ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' } : {}) } as RequestInit);
      const response = await handler(request);
      if (abort.signal.aborted) { await response.body?.cancel().catch(() => undefined); return; }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), res, { signal: abort.signal });
      else res.end();
    } catch {
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: { code: 'server-error', message: 'The request could not be completed.', retryable: true } }));
    } finally { req.off('aborted', disconnected); res.off('close', disconnected); res.off('error', disconnected); }
  };
}
