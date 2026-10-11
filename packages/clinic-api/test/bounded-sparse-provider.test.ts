import { expect, it, vi } from 'vitest';
import { boundedSparseExtractionProposer } from '../src/bounded-sparse-provider.js';
import { createGroupedExtractionManifest } from '../src/adaptive-extraction-grouped-v2.js';
import { context } from './fixtures/adaptive.js';
import { DO_ENDPOINT } from '../../clinical-core/src/digitalocean.js';
const config = { endpoint: DO_ENDPOINT, apiKey: 'synthetic-key', model: 'qwen3.8-max' as const, timeoutMs: 30000, maxOutputTokens: 4096 };
function args(signal = new AbortController().signal) { const ctx = { ...context('My height is 172 cm.'), nativeRouting: {} }; return [ctx, createGroupedExtractionManifest(ctx), { signal }] as const; }
function completedInvalidOutput() {
  const base = { id: 'synthetic-stream', model: config.model };
  const chunks = [
    { ...base, choices: [{ index: 0, delta: { content: '{}' }, finish_reason: 'stop' }] },
    { ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
  ];
  return new Response(chunks.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
}
it('reserves the exact transmitted schema and stream envelope before dispatch; semantic rejection still settles completed', async () => {
  const settle = vi.fn(async () => { throw Error('ack lost'); });
  const reserve = vi.fn(async (_request: import('../src/provider-admission.js').ProviderReservation) => ({ settle }));
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
    expect(reserve).toHaveBeenCalledOnce();
    const body = String(init?.body);
    expect(reserve.mock.calls[0]?.[0]).toMatchObject({ units: { inputBytes: Buffer.byteLength(body), outputTokens: 4096 } });
    expect(JSON.parse(body).response_format.type).toBe('json_schema');
    return completedInvalidOutput();
  });
  await expect(boundedSparseExtractionProposer(config, { reserve }, fetcher).extract(...args())).rejects.toMatchObject({ code: 'invalid-sparse-extraction' });
  expect(fetcher).toHaveBeenCalledOnce(); expect(settle).toHaveBeenCalledExactlyOnceWith('completed');
});
it('never dispatches when admission is ambiguous', async () => {
  const fetcher = vi.fn();
  await expect(boundedSparseExtractionProposer(config, { reserve: async () => { throw Error('unknown reservation'); } }, fetcher).extract(...args())).rejects.toThrow('unknown reservation');
  expect(fetcher).not.toHaveBeenCalled();
});
it('does not dispatch if the operation is cancelled during admission', async () => {
  const controller = new AbortController(), settle = vi.fn(async () => {}), fetcher = vi.fn();
  const reserve = async () => { controller.abort(); return { settle }; };
  await expect(boundedSparseExtractionProposer(config, { reserve }, fetcher).extract(...args(controller.signal))).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetcher).not.toHaveBeenCalled(); expect(settle).toHaveBeenCalledExactlyOnceWith('failed');
});
it('retains unknown provider cost without retry', async () => {
  const settle = vi.fn(async () => {}), fetcher = vi.fn(async () => { throw Error('lost connection'); });
  await expect(boundedSparseExtractionProposer(config, { reserve: async () => ({ settle }) }, fetcher).extract(...args())).rejects.toBeDefined();
  expect(fetcher).toHaveBeenCalledOnce(); expect(settle).toHaveBeenCalledExactlyOnceWith('unknown');
});
