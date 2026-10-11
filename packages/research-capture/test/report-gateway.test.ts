import { describe, expect, it, vi } from 'vitest';
import { reportReadGateway, type ViewerAuthority } from '../src/report-gateway';
import type { PrivateObjectStore } from '../src/contracts';
import type { AuthorizedMedia } from '../src/gateway';
const slug = 'a'.repeat(32), token = 'b'.repeat(64), key = 'research/session/media', object = { id: 'media', key, attempt: 0, retryUntil: 0, claimUntil: 0, leaseUntil: 0, state: 'available', descriptor: { modality: 'screen', sequence: 0, startMs: 0, endMs: 1000, bytes: 600_000, sha256: 'c'.repeat(64), mime: 'video/webm', questionId: 'q1', sourceId: null } } as AuthorizedMedia;
describe('client protected source gateway', () => {
  it('reauthorizes after slow object I/O and before each emitted bounded chunk', async () => {
    let allowed = true;
    const source = vi.fn(async () => { if (!allowed) throw new Error('revoked'); return { type: 'media' as const, object }; });
    const store = { head: async () => ({ bytes: 600_000, sha256: object.descriptor.sha256, mime: object.descriptor.mime }), read: async () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(600_000)); controller.close(); } }) } as unknown as PrivateObjectStore;
    const gateway = reportReadGateway(store, { source } as unknown as ViewerAuthority), response = await gateway(new Request(`http://127.0.0.1:5174/api/research/portal/source/e1?intent=view&slug=${slug}`, { headers: { Range: 'bytes=0-599999' } }), token), reader = response.body!.getReader();
    expect(response.status).toBe(206); expect(response.headers.get('Cache-Control')).toContain('no-store'); expect((await reader.read()).value?.byteLength).toBe(256_000);
    allowed = false; await expect(reader.read()).rejects.toThrow('Source access ended'); expect(source.mock.calls.length).toBeGreaterThan(4);
  });
  it('download denial reaches authority and exposes neither object keys nor bytes', async () => {
    const source = vi.fn<ViewerAuthority['source']>(async () => { throw new Error('ungranted'); }), store = { head: vi.fn(), read: vi.fn() } as unknown as PrivateObjectStore;
    await expect(reportReadGateway(store, { source } as unknown as ViewerAuthority)(new Request(`http://127.0.0.1:5174/api/research/portal/source/e1?intent=download&slug=${slug}`), token)).rejects.toThrow('ungranted');
    expect(source.mock.calls[0][0]).toMatchObject({ intent: 'download', slug }); expect(store.read).not.toHaveBeenCalled();
  });
});
