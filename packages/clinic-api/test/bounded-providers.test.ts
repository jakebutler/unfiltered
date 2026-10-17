import { expect, it, vi } from 'vitest';
import { boundedAdaptiveProposer } from '../src/bounded-providers.js';
import { DO_ENDPOINT } from '../../clinical-core/src/digitalocean.js';
import { context, proposal } from './fixtures/adaptive.js';
const config = { endpoint: DO_ENDPOINT, apiKey: 'synthetic-key', model: 'qwen3.8-max' as const, timeoutMs: 12000, maxOutputTokens: 4096 };
const response = () => new Response(JSON.stringify({ id: 'synthetic-receipt', model: config.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(proposal()) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }), { headers: { 'Content-Type': 'application/json' } });
it('requires a successful durable reservation before any inference request', async () => {
  const fetcher = vi.fn(async () => response()), reserve = vi.fn(async () => { throw Error('ambiguous'); });
  await expect(boundedAdaptiveProposer(config, { reserve }, fetcher).propose(context('My height is 172 cm.'))).rejects.toThrow('ambiguous');
  expect(fetcher).not.toHaveBeenCalled();
});
it('returns the successful provider result despite lost settlement acknowledgement; no repeated call', async () => {
  const fetcher = vi.fn(async () => response()), settle = vi.fn(async () => { throw Error('write-lost'); }), reserve = vi.fn(async () => ({ settle }));
  const ctx = context('My height is 172 cm.');
  const result = await boundedAdaptiveProposer(config, { reserve }, fetcher).propose(ctx);
  expect(result.receipt?.requestId).toBe('synthetic-receipt');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ provider: 'digitalocean', requestId: ctx.binding.operationId, sessionId: ctx.binding.sessionId, units: expect.objectContaining({ requests: 1, outputTokens: 4096 }) }));
  expect(settle).toHaveBeenCalledWith('completed');
});
it('does not call a provider after slow admission consumes the operation deadline', async () => {
  let time = 0;
  const fetcher = vi.fn(async () => response()), settle = vi.fn(async () => {});
  const reserve = async () => { time = 15000; return { settle }; };
  await expect(boundedAdaptiveProposer(config, { reserve }, fetcher, () => time).propose(context('My height is 172 cm.'))).rejects.toMatchObject({ code: 'provider-admission-timeout' });
  expect(fetcher).not.toHaveBeenCalled();
  expect(settle).toHaveBeenCalledWith('failed');
});
it('retains ambiguous provider cost without fallback or automatic retry', async () => {
  const fetcher = vi.fn(async () => { throw Error('network'); }), settle = vi.fn(async () => {});
  await expect(boundedAdaptiveProposer(config, { reserve: async () => ({ settle }) }, fetcher).propose(context('My height is 172 cm.'))).rejects.toBeDefined();
  expect(fetcher).toHaveBeenCalledTimes(1); expect(settle).toHaveBeenCalledWith('unknown');
});
