import { describe, expect, it, vi } from 'vitest';
import { retainedFrame } from '../src/frames';
import { digest, type PrivateObjectStore } from '../../../packages/research-capture/src/contracts';
import type { AuthorizedMedia } from '../../../packages/research-capture/src/gateway';
describe('retained selected-frame input', () => {
  it('binds a checksum-verified private segment and exact offset to extraction', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]), sha256 = await digest(bytes), descriptor = { modality: 'screen' as const, sequence: 0, startMs: 1000, endMs: 2000, bytes: 4, sha256, mime: 'video/webm', questionId: 'q1', sourceId: null }, object = { id: 'media', key: 'research/session/media', descriptor } as AuthorizedMedia;
    const store = { head: vi.fn(async () => ({ bytes: 4, sha256, mime: 'video/webm' })), read: vi.fn(async () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } })) } as unknown as PrivateObjectStore;
    const extract = vi.fn(async () => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), mime: 'image/jpeg' as const })), signal = new AbortController().signal;
    await retainedFrame(store, object, 1250, { extract }, signal); expect(extract.mock.calls[0][1]).toBe(250); expect(extract.mock.calls[0][0]).toEqual(bytes);
    await expect(retainedFrame(store, object, 2000, { extract }, signal)).rejects.toThrow('source unavailable');
  });
  it('rejects altered bytes before the decoder sees them', async () => {
    const object = { id: 'media', key: 'research/session/media', descriptor: { modality: 'camera', startMs: 0, endMs: 1000, bytes: 4, sha256: 'a'.repeat(64), mime: 'video/webm' } } as AuthorizedMedia;
    const store = { head: async () => ({ bytes: 4, sha256: 'a'.repeat(64), mime: 'video/webm' }), read: async () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(4)); c.close(); } }) } as unknown as PrivateObjectStore, extract = vi.fn();
    await expect(retainedFrame(store, object, 0, { extract }, new AbortController().signal)).rejects.toThrow('checksum differs'); expect(extract).not.toHaveBeenCalled();
  });
});
