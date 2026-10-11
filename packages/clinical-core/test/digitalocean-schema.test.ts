import { describe, expect, it, vi } from 'vitest';
import { digitalOcean, DO_MODELS, prepareDigitalOceanRequest } from '../src/digitalocean.js';
import type { Fetch } from '../src/transport.js';
const schema = { type: 'object', properties: { answer: { type: 'string', enum: ['accepted'] } }, required: ['answer'], additionalProperties: false };
const config = { endpoint: 'https://inference.do-ai.run' as const, apiKey: 'schema-test-only', model: 'qwen3.8-max' as const, timeoutMs: 1000, maxOutputTokens: 128, responseFormat: { type: 'json-schema' as const, name: 'bounded_probe', schema } };

describe('explicit strict JSON Schema request option', () => {
  it.each(['glm-5.3-flash', 'qwen3.8-max'] as const)('preserves the exact existing %s wire and defaults', async model => {
    const messages = [{ role: 'user' as const, content: 'Return the schema value.' }];
    const prepared = await prepareDigitalOceanRequest({ ...config, model }, messages);
    expect(prepared.body).toBe(JSON.stringify({ model, messages, max_tokens: 128, stream: false,
      response_format: { type: 'json_schema', json_schema: { name: 'bounded_probe', strict: true, schema } } }));
  });
  it('requests bounded low-effort Kimi with native schema and no unsupported sampling controls', async () => {
    const messages = [{ role: 'user' as const, content: 'Return the schema value.' }];
    const prepared = await prepareDigitalOceanRequest({ ...config, model: 'kimi-k3', maxOutputTokens: 4096, maxRequestBytes: 60000 }, messages);
    expect(JSON.parse(prepared.body)).toEqual({ model: 'kimi-k3', messages, max_completion_tokens: 4096, reasoning_effort: 'low', stream: false,
      response_format: { type: 'json_schema', json_schema: { name: 'bounded_probe', strict: true, schema } } });
    expect(prepared.requestBytes).toBe(Buffer.byteLength(prepared.body));
    await expect(prepareDigitalOceanRequest({ ...config, model: 'kimi-k3', maxRequestBytes: prepared.requestBytes - 1, maxOutputTokens: 4096 }, messages)).rejects.toThrow('inference-input-too-large');
  });
  it('requests explicit bounded DeepSeek low effort without changing existing models', async () => {
    const messages = [{ role: 'user' as const, content: 'Return the schema value.' }];
    const prepared = await prepareDigitalOceanRequest({ ...config, model: 'deepseek-v4.1-flash', maxOutputTokens: 4096 }, messages);
    expect(JSON.parse(prepared.body)).toEqual({ model: 'deepseek-v4.1-flash', messages, max_tokens: 4096, reasoning_effort: 'low', stream: false,
      response_format: { type: 'json_schema', json_schema: { name: 'bounded_probe', strict: true, schema } } });
  });
  it('uses the documented GLM-5.3 low effort wire with one bounded combined output allowance', async () => {
    const messages = [{ role: 'user' as const, content: 'Return the schema value.' }];
    const prepared = await prepareDigitalOceanRequest({ ...config, model: 'glm-5.3', maxOutputTokens: 4096 }, messages);
    expect(JSON.parse(prepared.body)).toEqual({ model: 'glm-5.3', messages, max_tokens: 4096, reasoning_effort: 'low', stream: false,
      response_format: { type: 'json_schema', json_schema: { name: 'bounded_probe', strict: true, schema } } });
  });
  it.each(DO_MODELS)('rejects incomplete or substituted %s responses without retry', async model => {
    for (const response of [
      { model, finish_reason: 'length' },
      { model: 'unrequested-model', finish_reason: 'stop' },
    ]) {
      const fetcher = vi.fn<Fetch>().mockResolvedValue(new Response(JSON.stringify({ id: 'counterexample', model: response.model,
        choices: [{ finish_reason: response.finish_reason, message: { content: '{"answer":"accepted"}' } }] })));
      await expect(digitalOcean({ ...config, model }, fetcher).generate([{ role: 'user', content: 'x' }])).rejects.toThrow(
        response.model === model ? 'inference-incomplete-output' : 'inference-model-mismatch');
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it.each(DO_MODELS)('requests native strict schema for allowlisted %s, without asserting that HTTP success proves enforcement', async model => {
    const fetcher = vi.fn<Fetch>().mockResolvedValue(new Response(JSON.stringify({ id: 'schema-test', model, choices: [{ finish_reason: 'stop', message: { content: '{"answer":"accepted"}' } }] })));
    const input = { ...config, model }, messages = [{ role: 'user' as const, content: 'Return the schema value.' }];
    const before = structuredClone(input), prepared = await prepareDigitalOceanRequest(input, messages);
    const result = await digitalOcean(input, fetcher).generate(messages);
    expect(String(fetcher.mock.calls[0][1]?.body)).toBe(prepared.body);
    expect(result).toMatchObject({ requestBytes: Buffer.byteLength(prepared.body), responseSchema: { name: 'bounded_probe', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(JSON.parse(prepared.body).response_format).toEqual({ type: 'json_schema', json_schema: { name: 'bounded_probe', strict: true, schema } });
    expect(input).toEqual(before);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('leaves endpoint rejection explicit with no JSON-mode fallback or retry', async () => {
    const fetcher = vi.fn<Fetch>().mockResolvedValue(new Response('unsupported structured output format', { status: 400 }));
    await expect(digitalOcean(config, fetcher).generate([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'http', status: 400 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).response_format.type).toBe('json_schema');
  });
  it('bounds schema bytes before dispatch and never returns credentials in the request metadata', async () => {
    const fetcher = vi.fn<Fetch>();
    const oversized = { ...config, responseFormat: { ...config.responseFormat, schema: { ...schema, description: '界'.repeat(11000) } } };
    await expect(digitalOcean(oversized, fetcher).generate([{ role: 'user', content: 'x' }])).rejects.toThrow('invalid-inference-schema');
    expect(fetcher).not.toHaveBeenCalled();
    const prepared = await prepareDigitalOceanRequest(config, [{ role: 'user', content: '🙂' }]);
    expect(JSON.stringify(prepared)).not.toContain(config.apiKey);
    expect(prepared.requestBytes).toBe(Buffer.byteLength(prepared.body, 'utf8'));
    expect(prepared.requestBytes).toBeGreaterThan(prepared.body.length);
  });
});
