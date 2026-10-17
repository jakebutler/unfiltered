import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPrivateRecording } from '../src/private-recording';
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function response(stream: ReadableStream<Uint8Array>, bytes = 3) { return new Response(stream, { headers: { 'Content-Length': String(bytes) } }); }
describe('private recording body completion', () => {
  it('returns only a complete body with exact receipt length', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1,2,3])); c.close(); } })));
    vi.stubGlobal('fetch', fetcher);
    expect(await readPrivateRecording('/media', 'test', 3, new AbortController())).toEqual([new Uint8Array([1,2,3])]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('times out a body even when cancellation acknowledgment never arrives, without retry', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const fetcher = vi.fn().mockResolvedValue(response(new ReadableStream({ cancel })));
    vi.stubGlobal('fetch', fetcher);
    const result = readPrivateRecording('/media', 'test', 3, new AbortController(), 100);
    const assertion = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(100); await assertion;
    expect(cancel).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('cancels a stalled body on explicit user abort', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(new ReadableStream())));
    const controller = new AbortController();
    const result = readPrivateRecording('/media', 'test', 3, controller);
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve(); controller.abort(); await assertion;
  });
  it.each([2,4])('rejects an actual %s-byte body against a 3-byte receipt', async actual => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(actual)); c.close(); } }))));
    await expect(readPrivateRecording('/media', 'test', 3, new AbortController())).rejects.toThrow(/Source (incomplete|exceeds)/);
  });
  it('cancels a rejected header body without waiting for its cancellation acknowledgment', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(new ReadableStream({ cancel }), 4)));
    await expect(readPrivateRecording('/media', 'test', 3, new AbortController())).rejects.toThrow('Source unavailable');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('cancels late response bytes if transport ignores an already completed abort', async () => {
    let deliver!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { deliver = resolve; })));
    const controller = new AbortController();
    const result = readPrivateRecording('/media', 'test', 3, controller);
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await assertion;
    const cancel = vi.fn();
    deliver(response(new ReadableStream({ cancel })));
    await Promise.resolve(); await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
  });

});
