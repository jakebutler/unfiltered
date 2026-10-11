import { expect, test, vi } from 'vitest';
import { digitalOcean, DO_ENDPOINT } from '../src/digitalocean';
const config = { endpoint: DO_ENDPOINT, apiKey: 'SENSITIVE', model: 'qwen3.8-max' as const, timeoutMs: 1000, maxOutputTokens: 1024 };
test('incomplete response observer receives exact bounded metadata without sensitive provider content', async () => {
  const observed = vi.fn(), fetcher = vi.fn(async () => Response.json({ id: 'AlphanumericSecretToken123', model: config.model, choices: [{ finish_reason: 'length', message: { content: 'SENSITIVE' } }], usage: { prompt_tokens: 10, completion_tokens: 1024, total_tokens: 1034 }, secret: 'SENSITIVE' }));
  await expect(digitalOcean(config, fetcher, observed).generate([{ role: 'user', content: 'synthetic' }])).rejects.toThrow('inference-incomplete-output');
  expect(fetcher).toHaveBeenCalledOnce(); expect(observed).toHaveBeenCalledOnce();
  expect(observed.mock.calls[0][0]).toEqual({ finishReason: 'length', choiceCount: 1, contentCharacters: 9, usage: { promptTokens: 10, completionTokens: 1024, totalTokens: 1034 } });
  expect(JSON.stringify(observed.mock.calls)).not.toContain('SENSITIVE'); expect(JSON.stringify(observed.mock.calls)).not.toContain('AlphanumericSecretToken123');
});
test('unsafe finish/usage values are omitted or classified, and observer rejection cannot replace the original failure', async () => {
  const observed = vi.fn(() => { throw Error('SENSITIVE'); });
  const fetcher = vi.fn(async () => Response.json({ id: 'https://secret.example/key', model: config.model, choices: [{ finish_reason: 'SENSITIVE', message: { content: 'SENSITIVE' } }], usage: { prompt_tokens: 1.5, completion_tokens: 1e20, total_tokens: 1e20 } }));
  await expect(digitalOcean(config, fetcher, observed).generate([{ role: 'user', content: 'synthetic' }])).rejects.toThrow('inference-incomplete-output');
  expect(observed.mock.calls[0][0]).toEqual({ finishReason: 'other', choiceCount: 1, contentCharacters: 9 }); expect(fetcher).toHaveBeenCalledOnce();
});
test('successful and malformed responses do not invoke the failed-response observer', async () => {
  const observed = vi.fn();
  for (const response of [Response.json({ id: 'ok', model: config.model, choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }), Response.json({ secret: 'SENSITIVE' })]) {
    await digitalOcean(config, async () => response, observed).generate([{ role: 'user', content: 'synthetic' }]).catch(() => undefined);
  }
  expect(observed).not.toHaveBeenCalled();
});
