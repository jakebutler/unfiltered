import { describe, expect, it, vi } from 'vitest';
import { ActionFirstObjectDecoder } from '../src/action-first-object.js';
import { digitalOceanStream, prepareDigitalOceanStreamRequest } from '../src/digitalocean-stream.js';
import { prepareDigitalOceanRequest } from '../src/digitalocean.js';
import { requestSse } from '../src/streaming-transport.js';
import type { Fetch } from '../src/transport.js';
const config = { endpoint: 'https://inference.do-ai.run' as const, apiKey: 'offline-only', model: 'qwen3.8-max' as const, timeoutMs: 1000, maxOutputTokens: 128 };
const messages = [{ role: 'user' as const, content: 'synthetic' }];
const event = (content: string | null, finish: string | null = null, model: string = config.model, id = 'one') => `data: ${JSON.stringify({ id, model, choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\r\n\r\n`;
const usage = 'data: {"id":"one","model":"qwen3.8-max","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n';
const done = 'data: [DONE]\n\n';
function response(wire: string, fragment = 1) {
  const bytes = new TextEncoder().encode(wire);
  return new Response(new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < bytes.length; i += fragment) controller.enqueue(bytes.slice(i, i + fragment)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}
const read = async (wire: string, options = {}) => { const values: string[] = []; for await (const value of requestSse(async () => response(wire), 'https://example.test', {}, { timeoutMs: 1000, ...options })) values.push(value); return values; };
describe('bounded SSE transport', () => {
  it('preserves UTF-8 and CRLF across single-byte fragmentation and joins data lines', async () => {
    expect(await read(':comment\r\ndata: café 😀\r\ndata: second\r\n\r\n')).toEqual(['café 😀\nsecond']);
  });
  it.each(['data: partial', 'data: partial\n'])('does not dispatch unterminated event %s', async wire => { await expect(read(wire)).rejects.toThrow('stream-truncated-event'); });
  it('bounds bytes and events and rejects non-SSE without interpreting an error body', async () => {
    await expect(read('data: 123456789\n\n', { maxBytes: 10, maxEventBytes: 10 })).rejects.toThrow('stream-response-too-large');
    await expect(read('data: 1\n\ndata: 2\n\n', { maxEvents: 1 })).rejects.toThrow('stream-event-limit');
    const fetcher = vi.fn<Fetch>().mockResolvedValue(new Response('secret-body', { status: 403 }));
    await expect(async () => { for await (const _ of requestSse(fetcher, 'https://example.test', {}, { timeoutMs: 1000 })) {} }).rejects.toThrow('stream-http');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid UTF-8, oversized events and cancellation before fetch', async () => {
    const fetcher = vi.fn<Fetch>().mockResolvedValue(new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'Content-Type': 'text/event-stream' } }));
    await expect(async () => { for await (const _ of requestSse(fetcher, 'https://example.test', {}, { timeoutMs: 1000 })) {} }).rejects.toThrow('stream-invalid-utf8-or-network');
    await expect(read('data: abcdef\n\n', { maxEventBytes: 5 })).rejects.toThrow('stream-line-too-large');
    const controller = new AbortController(); controller.abort(); const unused = vi.fn<Fetch>();
    await expect(async () => { for await (const _ of requestSse(unused, 'https://example.test', {}, { timeoutMs: 1000, signal: controller.signal })) {} }).rejects.toThrow('stream-cancelled');
    expect(unused).not.toHaveBeenCalled();
  });
});
describe('closed action-first object decoder', () => {
  it('emits closed advance while draft remains absent, across escaped braces and Unicode', () => {
    const decoder = new ActionFirstObjectDecoder(), packets = [];
    for (const char of '{"advance":' + JSON.stringify({ text: 'brace } and " café 😀' }) + ',') packets.push(...decoder.feed(char));
    expect(packets).toEqual([{ kind: 'advance', value: { text: 'brace } and " café 😀' } }]);
    expect([...decoder.feed('"draft":{"claims":[]}}')].map(x => x.kind)).toEqual(['draft']); decoder.finish();
  });
  it('preserves an emitted advance when a duplicate or malformed tail arrives in the same delta', () => {
    const decoder = new ActionFirstObjectDecoder(), emitted: string[] = [];
    expect(() => { for (const packet of decoder.feed('{"advance":{},"draft":{"x":1,"x":2}}')) emitted.push(packet.kind); }).toThrow('duplicate-action-key');
    expect(emitted).toEqual(['advance']);
  });
  it.each(['{"draft":{},"advance":{}}', '{"advance":{},"advance":{}}', '{"advance":{"x":1,"x":2},"draft":{}}', '{"advance":{},"draft":{}} extra', '{"advance":{},"draft":{bad}}'])('rejects order/duplicate/malformed packet %s', text => {
    expect(() => [...new ActionFirstObjectDecoder().feed(text)]).toThrow();
  });
  it('rejects truncation and byte overflow rather than completing the draft', () => {
    const decoder = new ActionFirstObjectDecoder(); expect([...decoder.feed('{"advance":{},')]).toHaveLength(1); expect(() => decoder.finish()).toThrow('action-object-truncated');
    expect(() => [...new ActionFirstObjectDecoder(10).feed('{"advance":{}}')]).toThrow('action-object-too-large');
  });
});
describe('opt-in DigitalOcean stream adapter', () => {
  it('keeps the nonstream request unchanged and accounts the exact new stream request', async () => {
    const original = await prepareDigitalOceanRequest(config, messages), streaming = await prepareDigitalOceanStreamRequest(config, messages);
    expect(JSON.parse(original.body).stream).toBe(false); expect(JSON.parse(streaming.body)).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(streaming.requestBytes).toBe(Buffer.byteLength(streaming.body)); expect(streaming.body).not.toContain(config.apiKey);
  });
  it('accepts exact identity, stop, DONE and separately observed usage with one fetch', async () => {
    const fetcher = vi.fn<Fetch>().mockResolvedValue(response(event('café 😀') + event(null, 'stop') + usage + done)); const content: string[] = [];
    const result = await digitalOceanStream(config, fetcher).generate(messages, { onContent: text => { content.push(text); } });
    expect(content).toEqual(['café 😀']); expect(result.receipt).toMatchObject({ outcome: 'complete', requestId: 'one', usage: { total_tokens: 5 }, finishReason: 'stop' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('keeps successful semantic finish separate from missing usage', async () => {
    const result = await digitalOceanStream(config, async () => response(event('{}') + event(null, 'stop') + done)).generate(messages, { onContent: () => {} });
    expect(result.receipt).toMatchObject({ outcome: 'complete', usage: 'unknown' });
  });
  it.each([
    [event('{}') + done, 'stream-premature-done'],
    [event('{}') + event(null, 'length') + done, 'inference-incomplete-output'],
    [event('{}') + event(null, 'stop'), 'stream-missing-done'],
    [event('{}', null, 'other-model' as typeof config.model), 'inference-model-mismatch'],
    [event('{}') + event('x', null, config.model, 'two'), 'inference-request-id-mismatch'],
    [event('{}') + event(null, 'stop') + done + event('late'), 'stream-data-after-done'],
    ['data: {bad}\n\n', 'invalid-stream-json'],
  ])('rejects an invalid terminal/identity without retry (%s)', async (wire, code) => {
    const fetcher = vi.fn<Fetch>().mockResolvedValue(response(wire));
    await expect(digitalOceanStream(config, fetcher).generate(messages, { onContent: () => {} })).rejects.toMatchObject({ code }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds a stalled consumer and never waits for a stalled reader cancel acknowledgement', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const bytes = new TextEncoder().encode(event('{}'));
    const fetcher = vi.fn<Fetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); }, cancel }), { headers: { 'Content-Type': 'text/event-stream' } }));
    await expect(digitalOceanStream({ ...config, timeoutMs: 100 }, fetcher).generate(messages, { onContent: () => new Promise<void>(() => {}) })).rejects.toMatchObject({ receipt: { outcome: 'unknown', usage: 'unknown', cleanup: { readerCancelRequested: true, providerTermination: 'unconfirmed' } } });
    expect(cancel).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('registers cleanup for headers that arrive after timeout without observing their content', async () => {
    let resolve!: (value: Response) => void;
    const fetcher = vi.fn<Fetch>().mockImplementation(() => new Promise<Response>(ready => { resolve = ready; }));
    const content = vi.fn(), pending = digitalOceanStream({ ...config, timeoutMs: 100 }, fetcher).generate(messages, { onContent: content });
    await expect(pending).rejects.toMatchObject({ code: 'stream-timeout', receipt: { outcome: 'unknown', cleanup: { lateHeadersCleanupRegistered: true } } });
    const cancelled = vi.fn(); resolve(new Response(new ReadableStream({ cancel: cancelled }), { headers: { 'Content-Type': 'text/event-stream' } }));
    await Promise.resolve(); await Promise.resolve(); expect(cancelled).toHaveBeenCalledTimes(1); expect(content).not.toHaveBeenCalled();
  });
  it('allows documented null metadata but rejects unrequested tool calls', async () => {
    const chunk = { id: 'one', model: config.model, choices: [{ index: 0, delta: { content: '{}', reasoning_content: null, refusal: null, function_call: null, tool_calls: null }, finish_reason: null }] };
    const wire = `data: ${JSON.stringify(chunk)}\n\n` + event(null, 'stop') + done;
    await expect(digitalOceanStream(config, async () => response(wire)).generate(messages, { onContent: () => {} })).resolves.toMatchObject({ text: '{}' });
    chunk.choices[0].delta.tool_calls = [{ id: 'tool' }] as never;
    await expect(digitalOceanStream(config, async () => response(`data: ${JSON.stringify(chunk)}\n\n`)).generate(messages, { onContent: () => {} })).rejects.toMatchObject({ code: 'unrequested-stream-tool-or-refusal' });
  });
  it('cancels a pending reader and retains unknown usage/outcome after dispatch', async () => {
    const controller = new AbortController(), cancelled = vi.fn();
    const fetcher = vi.fn<Fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel: cancelled }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const pending = digitalOceanStream(config, fetcher).generate(messages, { signal: controller.signal, onContent: () => {}, onHeaders: () => controller.abort() });
    await expect(pending).rejects.toMatchObject({ code: 'stream-cancelled', receipt: { outcome: 'unknown', usage: 'unknown' } });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(cancelled).toHaveBeenCalledTimes(1);
  });
});
