import { expect, it, vi } from 'vitest';
import { boundedAdaptiveProposer } from '../src/bounded-providers.js';
import { DO_ENDPOINT } from '../../clinical-core/src/digitalocean.js';
import { context, proposal } from './fixtures/adaptive.js';

it('returns a completed model result even when bookkeeping acknowledgement never settles', async () => {
  vi.useFakeTimers();
  try {
    const config = { endpoint: DO_ENDPOINT, apiKey: 'synthetic-key', model: 'qwen3.8-max' as const, timeoutMs: 12000, maxOutputTokens: 4096 };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'synthetic-hanging-settlement', model: config.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(proposal()) } }] }), { headers: { 'Content-Type': 'application/json' } }));
    const settle = vi.fn(() => new Promise<void>(() => undefined));
    let settled = false;
    const pending = boundedAdaptiveProposer(config, { reserve: async () => ({ settle }) }, fetcher).propose(context('I am 170 cm tall.'));
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(15001);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledOnce();
    expect(settled).toBe(true);
    await expect(pending).resolves.toMatchObject({ receipt: { requestId: 'synthetic-hanging-settlement' } });
  } finally { vi.useRealTimers(); }
});
