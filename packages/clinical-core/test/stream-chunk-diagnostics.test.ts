import { describe, expect, it, vi } from 'vitest';
// The staged adapter imports archived AF52 dependencies, never current Medplum WIP.
import { digitalOceanStream } from '../../../.stream-chunk-diagnostic-stage/packages/clinical-core/src/digitalocean-stream.js';
import { describeRejectedStreamChunk } from '../src/stream-chunk-diagnostics.js';
import { syntheticDiagnosticPrefix } from '../src/synthetic-diagnostic-prefix.js';
const config = { endpoint: 'https://inference.do-ai.run' as const, apiKey: 'mock-only',
  model: 'qwen3.8-max' as const, timeoutMs: 1000, maxOutputTokens: 4096 };
const messages = [{ role: 'user' as const, content: 'synthetic offline control' }];
const chunk = (content: string | null, finish: string | null = null) => ({ id: 'synthetic-id', model: config.model,
  choices: [{ index: 0, delta: { content }, finish_reason: finish }] });
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const done = 'data: [DONE]\n\n';
const response = (wire: string) => new Response(wire, { headers: { 'Content-Type': 'text/event-stream' } });
const state = { consumedEvent: 3, schemaValidChunksBefore: 2, stopSeen: false };
function run(wire: string, observer?: Parameters<ReturnType<typeof digitalOceanStream>['generate']>[1]['onInvalidChunk']) {
  const fetcher = vi.fn(async () => response(wire));
  return { fetcher, pending: digitalOceanStream(config, fetcher, () => 0).generate(messages,
    { onContent: () => {}, ...(observer ? { onInvalidChunk: observer } : {}) }) };
}

describe('finite structural rejection evidence', () => {
  it('redacts all values, unknown key names, issue messages and unknown issue paths', () => {
    const secret = 'hostile-private-secret';
    const packet = { id: secret, model: secret, choices: [{ index: secret,
      delta: { content: secret, [secret]: secret }, finish_reason: secret }],
      error: { code: secret, type: secret, param: secret, message: secret, request_id: secret, [secret]: secret } };
    const diagnostic = describeRejectedStreamChunk(packet, [
      { code: 'unrecognized_keys', path: ['choices', 0, 'delta', secret], message: secret, keys: [secret] },
      { code: secret, path: [secret, 9000] },
    ], state);
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
    expect(diagnostic).toMatchObject({ consumedEvent: 3, schemaValidChunksBefore: 2,
      error: { fields: { code: 'string', type: 'string', param: 'string', message: 'string', request_id: 'string' }, unknownKeys: 1 },
      choices: { entries: [{ indexIsZero: false, delta: { unknownKeys: 1 }, finish: 'other' }] },
      issues: [{ code: 'unrecognized_keys', path: ['choices', 'choice-0', 'delta', 'other-field'] },
        { code: 'other', path: ['other-field', 'other-index'] }] });
  });
  it.each([null, [], 'private', 123, false])('retains only packet type for %j', value => {
    const diagnostic = describeRejectedStreamChunk(value, [], state);
    expect(Object.keys(diagnostic.packet)).toEqual(['kind']);
    expect(JSON.stringify(diagnostic)).not.toContain('private');
  });
  it('bounds choices, issue paths, counters and total serialized UTF-8 bytes', () => {
    const diagnostic = describeRejectedStreamChunk({ id: 'secret', model: 'secret',
      choices: Array.from({ length: 40 }, () => ({ index: 0, delta: {
        role: 'assistant', content: 'secret', reasoning_content: 'secret', refusal: 'secret',
        tool_calls: [], function_call: {} }, finish_reason: 'stop' })),
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, secret: true },
      error: { code: 'secret', message: 'secret' } },
    Array.from({ length: 100 }, () => ({ code: 'invalid_type', path: Array(100).fill('content') })),
    { consumedEvent: 999999, schemaValidChunksBefore: -1, stopSeen: true });
    expect(Buffer.byteLength(JSON.stringify(diagnostic))).toBeLessThanOrEqual(2048);
    expect(diagnostic.issues.length).toBeLessThanOrEqual(16);
    expect(diagnostic.issues.every(issue => issue.path.length <= 6)).toBe(true);
    expect(diagnostic.choices?.entries?.length ?? 0).toBeLessThanOrEqual(2);
    expect(diagnostic).toMatchObject({ consumedEvent: 4104, schemaValidChunksBefore: 0, stopSeen: true, truncated: true });
  });
  it('never coerces a hostile finish object to a string', () => {
    const diagnostic = describeRejectedStreamChunk({ choices: [{ finish_reason: { toString: 'secret' } }] }, [], state);
    expect(diagnostic.choices?.entries?.[0].finish).toBe('other');
  });
});

describe('opt-in observer preserves parser behavior', () => {
  it('matches the archived pre-edit adapter on success and rejection with the exact AF52 request', async () => {
    const historical = await import('../../../docs/implementation/evidence/SCOPED-EXTRACTION-CANDIDATE-31a116f0d09ebb4a4061b7c803d59c4b179ac36ca8656522f7aeb7ab5927f2b0/files/.extraction-settlement-build/packages/clinical-core/src/digitalocean-stream.js');
    const { readFileSync } = await import('node:fs');
    const { createHash } = await import('node:crypto');
    const packet = JSON.parse(readFileSync('docs/implementation/evidence/S3-EXTRACTION-SETTLEMENT-AUTHORED-PACKET.json', 'utf8'));
    const original = packet.cases.find((entry: { id: string }) => entry.id === 'DO-AF52');
    const exactConfig = { ...config, timeoutMs: 30000, maxRequestBytes: 131072,
      responseFormat: { type: 'json-schema' as const, name: 'adaptive_extraction_scoped_v1', schema: original.manifest.jsonSchema } };
    for (const wire of [event(chunk('{}')) + event(chunk(null, 'stop')) + done,
      event(chunk('synthetic prefix')) + event({ error: { message: 'private' } })]) {
      const before = vi.fn(async () => response(wire)), after = vi.fn(async () => response(wire));
      const legacy = await historical.digitalOceanStream(exactConfig, before, () => 0).generate(original.manifest.messages,
        { onContent: () => {} }).catch((error: { code: string; receipt: unknown }) => ({ code: error.code, receipt: error.receipt }));
      const observer = vi.fn();
      const current = await digitalOceanStream(exactConfig, after, () => 0).generate(original.manifest.messages,
        { onContent: () => {}, onInvalidChunk: observer }).catch(error => ({ code: error.code, receipt: error.receipt }));
      expect(current).toEqual(legacy);
      expect(after.mock.calls).toEqual(before.mock.calls);
      const requestBody = (after.mock.calls as unknown as [string, RequestInit][])[0][1].body as string;
      expect(createHash('sha256').update(requestBody).digest('hex')).toBe('44c4e286cf6484fbf243f74aaeeb23ae21a36433f9cb81019fda99d652038a86');
      expect(after).toHaveBeenCalledTimes(1);
    }
  });
  it.each([
    { error: { message: 'private-error', code: 'private-code' } },
    { ...chunk('{}'), choices: [{ index: 0, delta: null, finish_reason: 'stop' }] },
    { ...chunk('{}'), choices: [{ index: 0, delta: { content: '{}', unexpectedSecret: 'private' }, finish_reason: null }] },
    { ...chunk('{}'), usage: { prompt_tokens: 1, completion_tokens: null, total_tokens: 1 } },
  ])('reports one sanitized invalid chunk and retains the original failure', async rejected => {
    const observer = vi.fn(), wire = event(chunk('synthetic prefix')) + event(rejected);
    const baseline = run(wire), observed = run(wire, observer);
    const before = await baseline.pending.catch(error => error);
    const after = await observed.pending.catch(error => error);
    expect(after).toMatchObject({ code: 'invalid-stream-chunk', receipt: { providerExecution: 'unknown', usage: 'unknown' } });
    expect(after.receipt).toEqual(before.receipt);
    expect(observed.fetcher.mock.calls).toEqual(baseline.fetcher.mock.calls);
    expect(observed.fetcher).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer.mock.calls[0][0]).toMatchObject({ consumedEvent: 2, schemaValidChunksBefore: 1, stopSeen: false });
    expect(JSON.stringify(observer.mock.calls)).not.toContain('private');
  });
  it.each(['throw', 'reject', 'pending'])('does not await or expose a hostile %s observer', async behavior => {
    const observer = vi.fn(() => {
      if (behavior === 'throw') throw new Error('private-observer-error');
      if (behavior === 'reject') return Promise.reject(new Error('private-observer-error'));
      return new Promise<void>(() => {});
    });
    const test = run(event({ error: { message: 'private' } }), observer);
    await expect(test.pending).rejects.toMatchObject({ code: 'invalid-stream-chunk' });
    await Promise.resolve();
    expect(observer).toHaveBeenCalledTimes(1);
    expect(test.fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not reinterpret malformed JSON or empty null usage as a schema rejection', async () => {
    const observer = vi.fn();
    await expect(run('data: {malformed}\n\n', observer).pending).rejects.toMatchObject({ code: 'invalid-stream-json' });
    await expect(run(event({ id: 'synthetic-id', model: config.model, choices: [], usage: null }), observer).pending)
      .rejects.toMatchObject({ code: 'empty-stream-chunk' });
    expect(observer).not.toHaveBeenCalled();
  });
  it('preserves successful null metadata and usage extensions byte-for-byte', async () => {
    const observer = vi.fn();
    const wire = event({ ...chunk('{}'), usage: null }) + event(chunk(null, 'stop')) + event({
      id: 'synthetic-id', model: config.model, choices: [], usage: {
        prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, completion_tokens_details: { reasoning_tokens: 0 },
      },
    }) + done;
    const baseline = run(wire), observed = run(wire, observer);
    expect(await observed.pending).toEqual(await baseline.pending);
    expect(observed.fetcher.mock.calls).toEqual(baseline.fetcher.mock.calls);
    expect(observer).not.toHaveBeenCalled();
  });
  it('retains stop observation when invalid usage follows it, without inventing completion', async () => {
    const observer = vi.fn();
    await expect(run(event(chunk('{}')) + event(chunk(null, 'stop')) + event({
      id: 'synthetic-id', model: config.model, choices: [], usage: { total_tokens: 5 },
    }), observer).pending).rejects.toMatchObject({ code: 'invalid-stream-chunk', receipt: { finishReason: 'stop', providerExecution: 'unknown' } });
    expect(observer.mock.calls[0][0]).toMatchObject({ consumedEvent: 3, schemaValidChunksBefore: 2, stopSeen: true });
  });
  it('keeps valid-schema stop/usage sequencing failures outside the structural observer', async () => {
    const observer = vi.fn();
    const usage = { id: 'synthetic-id', model: config.model, choices: [], usage: {
      prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } };
    await expect(run(event(usage), observer).pending).rejects.toMatchObject({ code: 'invalid-stream-usage' });
    await expect(run(event(chunk('{}')) + event(chunk(null, 'length')) + done, observer).pending)
      .rejects.toMatchObject({ code: 'inference-incomplete-output' });
    expect(observer).not.toHaveBeenCalled();
  });
  it('preserves pre-dispatch cancellation without invoking fetch or the observer', async () => {
    const signal = new AbortController(); signal.abort();
    const observer = vi.fn(), fetcher = vi.fn();
    await expect(digitalOceanStream(config, fetcher).generate(messages,
      { signal: signal.signal, onContent: () => {}, onInvalidChunk: observer })).rejects.toMatchObject({ code: 'stream-cancelled' });
    expect(fetcher).not.toHaveBeenCalled(); expect(observer).not.toHaveBeenCalled();
  });
});

describe('private synthetic rejected prefix', () => {
  it('bounds Unicode content without retaining later deltas', () => {
    const prefix = syntheticDiagnosticPrefix();
    prefix.append('😀'.repeat(2047)); prefix.append('é😀'); prefix.append('private-later');
    const result = prefix.snapshot();
    expect(result).toMatchObject({ syntheticOnly: true, acceptedOutput: false, bytes: 8190, truncated: true, maxBytes: 8192 });
    expect(Buffer.byteLength(result.contentPrefix)).toBe(result.bytes);
    expect(result.contentPrefix).not.toContain('private-later');
    expect(result.contentPrefix).not.toContain('\uFFFD');
  });
  it('saves validated content deltas as unaccepted evidence even if a later chunk fails', async () => {
    const prefix = syntheticDiagnosticPrefix(), observer = vi.fn();
    const adapter = digitalOceanStream(config, async () => response(event(chunk('synthetic partial')) + event({ error: { message: 'private' } })));
    await expect(adapter.generate(messages, { onContent: text => prefix.append(text), onInvalidChunk: observer }))
      .rejects.toMatchObject({ code: 'invalid-stream-chunk' });
    expect(prefix.snapshot()).toMatchObject({ contentPrefix: 'synthetic partial', acceptedOutput: false });
    expect(JSON.stringify(observer.mock.calls)).not.toContain('synthetic partial');
  });
});
