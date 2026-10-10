import { CAPTURE_LIMITS, byteRange, digest, type MediaDescriptor, type PrivateObjectStore } from './contracts';
export type AuthorizedMedia = { id: string; key: string; attempt: number; retryUntil: number; claimUntil: number; descriptor: MediaDescriptor; leaseUntil: number; state: string };
export interface CaptureAuthority {
  claim(token: string, id: string, attempt: number): Promise<AuthorizedMedia>;
  inspect(token: string, id: string): Promise<AuthorizedMedia>;
  beginRetry(token: string, id: string, attempt: number): Promise<AuthorizedMedia>;
  activateRetry(token: string, id: string, attempt: number, retiredKey: string): Promise<AuthorizedMedia>;
  finalize(id: string, attempt: number, stored: { bytes: number; sha256: string; mime: string }): Promise<boolean>;
  read(bearer: string, scope: { id: string; clientId: string; projectId: string; sessionId: string }): Promise<AuthorizedMedia>;
  cleanup(): Promise<AuthorizedMedia[]>;
  deleted(id: string, attempt: number): Promise<void>;
}
const headers = { 'Cache-Control': 'private, no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
export function mediaGateway(store: PrivateObjectStore, authority: CaptureAuthority, config: { origin: string; maxSegmentBytes?: number }) {
  const maximum = config.maxSegmentBytes ?? CAPTURE_LIMITS.segmentBytes;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > CAPTURE_LIMITS.segmentBytes || new URL(config.origin).origin !== config.origin) throw new Error('Invalid media gateway configuration');
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url), id = url.pathname.split('/').pop()!;
    if (url.origin !== config.origin || request.headers.get('Origin') !== config.origin) return new Response('Access unavailable', { status: 403, headers });
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || !url.pathname.startsWith('/api/research-media/')) return new Response('Not found', { status: 404, headers });
    try {
      if (request.method === 'POST' || request.method === 'PUT') {
        const token = request.headers.get('X-Research-Participant') ?? '';
        if (request.method === 'POST') {
          // Reconcile a successful write first. Never re-upload bytes just because
          // the final receipt was lost. An absent key is retryable only after a
          // persisted fence and confirmed retirement of that exact old attempt.
          const row = await authority.inspect(token, id), stored = await store.head(row.key);
          if (stored && row.state !== 'retry-fencing') {
            const available = await authority.finalize(id, row.attempt, stored);
            return Response.json({ state: available ? 'available' : 'unavailable' }, { headers, status: available ? 200 : 409 });
          }
          if (row.state === 'reserved' && row.claimUntil > Date.now()) return Response.json({ state: 'reserved', attempt: row.attempt }, { headers });
          if (row.state === 'available' || row.leaseUntil > Date.now() || row.retryUntil <= Date.now()) return Response.json({ state: row.state, object: 'unresolved' }, { headers, status: 409 });
          const fence = await authority.beginRetry(token, id, row.attempt);
          await store.retire(fence.key);
          if (await store.head(fence.key) !== null) throw new Error('Old attempt retirement is incomplete');
          const ready = await authority.activateRetry(token, id, fence.attempt, fence.key);
          return Response.json({ state: ready.state, attempt: ready.attempt }, { headers });
        }
        // Validate readily checked headers before consuming the single dispatch.
        const inspected = await authority.inspect(token, id);
        const size = Number(request.headers.get('Content-Length'));
        if (!Number.isSafeInteger(size) || size !== inspected.descriptor.bytes || size > maximum || !request.body) return new Response('Invalid segment size', { status: 413, headers });
        const row = await authority.claim(token, id, inspected.attempt);
        if (row.state === 'available') return Response.json({ state: 'available' }, { headers });
        const reader = request.body.getReader(), chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          while (true) {
            if (request.signal.aborted || Date.now() >= row.leaseUntil) throw new Error('Upload lease ended');
            let timeout: ReturnType<typeof setTimeout> | undefined;
            const next = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Upload lease ended')), Math.max(1, row.leaseUntil - Date.now())); })]).finally(() => clearTimeout(timeout));
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > size || bytes > maximum) throw new Error('Segment exceeded its reservation');
            chunks.push(next.value);
          }
        } finally { await reader.cancel().catch(() => undefined); }
        if (bytes !== size || Date.now() >= row.leaseUntil) throw new Error('Incomplete segment');
        const body = new Uint8Array(bytes); let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
        if (await digest(body) !== row.descriptor.sha256) throw new Error('Segment checksum mismatch');
        const stored = await store.putIfAbsent(row.key, body, { bytes, sha256: row.descriptor.sha256, mime: row.descriptor.mime });
        const available = await authority.finalize(id, row.attempt, stored);
        return Response.json({ state: available ? 'available' : 'unavailable' }, { status: available ? 200 : 409, headers });
      }
      if (request.method !== 'GET') return new Response('Method unavailable', { status: 405, headers });
      const bearer = /^Bearer (.+)$/.exec(request.headers.get('Authorization') ?? '')?.[1] ?? '';
      const scope = { id, clientId: url.searchParams.get('clientId') ?? '', projectId: url.searchParams.get('projectId') ?? '', sessionId: url.searchParams.get('sessionId') ?? '' };
      const row = await authority.read(bearer, scope), stored = await store.head(row.key);
      if (!stored || stored.bytes !== row.descriptor.bytes || stored.sha256 !== row.descriptor.sha256 || stored.mime !== row.descriptor.mime) throw new Error('Source unavailable');
      let range;
      try { range = byteRange(request.headers.get('Range'), stored.bytes); } catch { return new Response('Range unavailable', { status: 416, headers: { ...headers, 'Content-Range': `bytes */${stored.bytes}` } }); }
      const body = await store.read(row.key, range);
      // Reauthorize before the response and each bounded emitted chunk. Revocation cannot
      // recall bytes already sent; it prevents the next chunk/read. No CDN caching.
      await authority.read(bearer, scope);
      const reader = body.getReader(); let pending: Uint8Array | undefined;
      const protectedBody = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            await authority.read(bearer, scope);
            if (!pending?.byteLength) { const next = await reader.read(); if (next.done) { controller.close(); return; } pending = next.value; }
            // Object I/O may have stalled arbitrarily long since the first check.
            // Check again immediately before enqueue, including each split chunk.
            await authority.read(bearer, scope);
            const chunk = pending.subarray(0, 256_000); pending = pending.subarray(chunk.byteLength); controller.enqueue(chunk);
          } catch { await reader.cancel().catch(() => undefined); controller.error(new Error('Source access ended')); }
        }, async cancel() { await reader.cancel(); },
      }, { highWaterMark: 0 });
      return new Response(protectedBody, { status: range.partial ? 206 : 200, headers: { ...headers, 'Content-Type': stored.mime, 'Content-Length': String(range.end - range.start + 1), 'Accept-Ranges': 'bytes', ...(range.partial ? { 'Content-Range': `bytes ${range.start}-${range.end}/${stored.bytes}` } : {}) } });
    } catch { return new Response('Source unavailable; reconcile before retrying', { status: 409, headers }); }
  };
}
export async function cleanupObjects(store: PrivateObjectStore, authority: CaptureAuthority): Promise<number> {
  const rows = await authority.cleanup();
  for (const row of rows) { await store.retire(row.key); if (await store.head(row.key) !== null) throw new Error('Object retirement is incomplete'); await authority.deleted(row.id, row.attempt); }
  return rows.length;
}
