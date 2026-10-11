import { byteRange, type PrivateObjectStore } from './contracts';
import type { AuthorizedMedia } from './gateway';
export const PRIVATE_HEADERS = { 'Cache-Control': 'private, no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
export async function protectedObjectResponse(store: PrivateObjectStore, authorize: () => Promise<AuthorizedMedia>, rangeHeader: string | null, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const row = await authorize(), stored = await store.head(row.key);
  if (!stored || stored.bytes !== row.descriptor.bytes || stored.sha256 !== row.descriptor.sha256 || stored.mime !== row.descriptor.mime) throw new Error('Source unavailable');
  let range;
  try { range = byteRange(rangeHeader, stored.bytes); } catch { return new Response('Range unavailable', { status: 416, headers: { ...PRIVATE_HEADERS, 'Content-Range': `bytes */${stored.bytes}` } }); }
  const body = await store.read(row.key, range); await authorize();
  const reader = body.getReader(); let pending: Uint8Array | undefined;
  const protectedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const current = await authorize(); if (current.key !== row.key || current.descriptor.sha256 !== stored.sha256) throw new Error('Source changed');
        if (!pending?.byteLength) { const next = await reader.read(); if (next.done) { controller.close(); return; } pending = next.value; }
        const latest = await authorize(); if (latest.key !== row.key || latest.descriptor.sha256 !== stored.sha256) throw new Error('Source changed');
        const chunk = pending.subarray(0, 256_000); pending = pending.subarray(chunk.byteLength); controller.enqueue(chunk);
      } catch { await reader.cancel().catch(() => undefined); controller.error(new Error('Source access ended')); }
    }, async cancel() { await reader.cancel(); },
  }, { highWaterMark: 0 });
  return new Response(protectedBody, { status: range.partial ? 206 : 200, headers: { ...PRIVATE_HEADERS, ...extraHeaders, 'Content-Type': stored.mime, 'Content-Length': String(range.end - range.start + 1), 'Accept-Ranges': 'bytes', ...(range.partial ? { 'Content-Range': `bytes ${range.start}-${range.end}/${stored.bytes}` } : {}) } });
}
