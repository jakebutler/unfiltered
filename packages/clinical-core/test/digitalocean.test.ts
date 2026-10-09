import { describe, expect, it, vi } from 'vitest';
import { DO_ENDPOINT, digitalOcean, type DigitalOceanConfig } from '../src/digitalocean.js';
import { requestJson, type Fetch } from '../src/transport.js';
const config: DigitalOceanConfig = { endpoint: DO_ENDPOINT, apiKey: 'secret-test-token', model: 'glm-5.3-flash', maxOutputTokens: 128, timeoutMs: 100 };
const response = (model = config.model, finish = 'stop') => new Response(JSON.stringify({ id: 'request-1', model, choices: [{ finish_reason: finish, message: { content: 'Synthetic response' } }] }));
describe('DigitalOcean strict route', () => {
  it('pins the endpoint/model and bounds output with no implicit SDK/defaults', async () => {
    const fetcher = vi.fn<Fetch>().mockResolvedValue(response());
    expect(await digitalOcean(config, fetcher).generate([{ role: 'user', content: 'Synthetic question' }])).toMatchObject({ model: config.model, requestId: 'request-1' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://inference.do-ai.run/v1/chat/completions');
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: config.model, max_tokens: 128, stream: false });
  });
  it.each(['gpt-5', 'anthropic/claude', 'arcee-ai/trinity', 'glm-5.3', 'auto'])('rejects excluded or unapproved model %s before network access', model => {
    const fetcher = vi.fn<Fetch>();
    expect(() => digitalOcean({ ...config, model } as DigitalOceanConfig, fetcher)).toThrow('invalid-inference-configuration');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects wrong endpoints, missing config and fallback configuration', () => {
    expect(() => digitalOcean({ ...config, endpoint: 'https://api.openai.com' } as unknown as DigitalOceanConfig)).toThrow('invalid-inference-configuration');
    expect(() => digitalOcean({ ...config, apiKey: '' })).toThrow('invalid-inference-configuration');
    expect(() => digitalOcean({ ...config, fallback: 'gpt-5' } as DigitalOceanConfig)).toThrow('invalid-inference-configuration');
  });
  it('rejects a substituted response model or truncated generation', async () => {
    await expect(digitalOcean(config, async () => response('qwen3.8-max')).generate([{ role: 'user', content: 'x' }])).rejects.toThrow('inference-model-mismatch');
    await expect(digitalOcean(config, async () => response(config.model, 'length')).generate([{ role: 'user', content: 'x' }])).rejects.toThrow('inference-incomplete-output');
  });
  it('leaves failure explicit, does not retry or leak a provider body containing secrets', async () => {
    const fetcher = vi.fn<Fetch>().mockResolvedValue(new Response('secret-test-token echoed by upstream', { status: 429 }));
    await expect(digitalOcean(config, fetcher).generate([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'http', status: 429, message: 'http' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds image input and rejects arbitrary remote image URLs', async () => {
    const fetcher = vi.fn<Fetch>();
    await expect(digitalOcean(config, fetcher).generate([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://internal.example/private' } }] }])).rejects.toThrow('invalid-inference-input');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
describe('portable bounded transport', () => {
  it('aborts a stalled request and returns only a safe timeout code', async () => {
    const stalled: Fetch = (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('secret'))));
    await expect(requestJson(stalled, 'https://example.test', {}, 10)).rejects.toMatchObject({ code: 'timeout', message: 'timeout' });
  });
  it('rejects an oversized response before JSON parsing', async () => {
    await expect(requestJson(async () => new Response('x'.repeat(101)), 'https://example.test', {}, 100, 100)).rejects.toMatchObject({ code: 'response-too-large' });
  });
});
