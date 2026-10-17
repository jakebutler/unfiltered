import { afterEach, expect, test, vi } from 'vitest';
import { consumeCleanupResponse } from '../../../convex/researchGatewayLeases';
afterEach(() => vi.useRealTimers());
test('scheduler consumes terminal EOF without cancelling after the first chunk', async () => {
  let finish!: () => void; const cancel = vi.fn();
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"retired":9}')); finish = () => c.close(); }, cancel }));
  let settled = false; const pending = consumeCleanupResponse(response, Date.now() + 10000).then(() => { settled = true; });
  for (let n = 0; n < 20; n++) await Promise.resolve();
  expect(settled).toBe(false); expect(cancel).not.toHaveBeenCalled(); finish(); await pending; expect(cancel).not.toHaveBeenCalled();
});
test('response consumption has one absolute bound even when read and cancellation never settle', async () => {
  vi.useFakeTimers(); const cancel = vi.fn(() => new Promise<void>(() => {}));
  const pending = consumeCleanupResponse(new Response(new ReadableStream({ pull() { return new Promise<void>(() => {}); }, cancel })), Date.now() + 1000);
  const rejected = expect(pending).rejects.toThrow('unresolved'); await vi.advanceTimersByTimeAsync(1001); await rejected; expect(cancel).toHaveBeenCalledOnce();
});
test('oversize and rejected reads remain failed; response text is neither logged nor trusted', async () => {
  const log = vi.spyOn(console, 'info');
  await expect(consumeCleanupResponse(new Response('secret'.repeat(1000)), Date.now() + 1000)).rejects.toThrow('limit');
  await expect(consumeCleanupResponse(new Response(new ReadableStream({ pull(c) { c.error(new Error('private payload')); } })), Date.now() + 1000)).rejects.toThrow('private payload');
  expect(log).not.toHaveBeenCalled(); log.mockRestore();
});
