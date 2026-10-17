import { describe, expect, it, vi } from 'vitest';
import { diagnosticFetch, rejectionDiagnosticBounds } from '../src/http-rejection-diagnostics.js';
import { digitalOceanStream, prepareDigitalOceanStreamRequest } from '../src/digitalocean-stream.js';
import type { Fetch } from '../src/transport.js';

const config = {
  endpoint: 'https://inference.do-ai.run' as const, apiKey: 'synthetic-private-key',
  model: 'qwen3.8-max' as const, timeoutMs: 1000, maxOutputTokens: 512,
};
const messages = [{ role: 'user' as const, content: 'synthetic' }];
const pending = () => new Promise<void>(() => {});

describe('isolated bounded HTTP rejection diagnostics', () => {
  it('passes successful Response and request init through by identity without a body read', async () => {
    const response = new Response('unread success');
    const getReader = vi.spyOn(response.body!, 'getReader');
    const underlying = vi.fn<Fetch>().mockResolvedValue(response);
    const wrapper = diagnosticFetch(underlying, Date.now() + 1000);
    const init = { method: 'POST', body: 'exact-body', redirect: 'error' as const };
    expect(await wrapper.fetcher('https://example.test', init)).toBe(response);
    expect(underlying).toHaveBeenCalledTimes(1);
    expect(underlying).toHaveBeenCalledWith('https://example.test', init);
    expect(getReader).not.toHaveBeenCalled();
    expect(wrapper.snapshot()).toBeUndefined();
  });

  it.each([400, 401, 403, 429, 500, 503])('retains status %i, finite tokens and no private data', async status => {
    const secret = 'synthetic-private-key';
    const underlying = vi.fn<Fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: 'forbidden', message: secret, request_id: secret,
      error: { code: 'invalid_json_schema', type: 'invalid_request_error',
        param: 'response_format.json_schema.schema', message: secret, request_id: secret },
    }), { status, headers: { 'authorization': secret, 'x-request-id': secret } }));
    const wrapper = diagnosticFetch(underlying, Date.now() + 1000);
    const response = await wrapper.fetcher('https://example.test');
    expect(response.status).toBe(status);
    expect(await response.text()).toBe('');
    expect([...response.headers]).toEqual([]);
    expect(wrapper.snapshot()).toMatchObject({ status, bodyRead: 'complete', parse: 'json',
      errorId: 'forbidden', errorCode: 'invalid_json_schema', errorType: 'invalid_request_error',
      errorParam: 'response_format.json_schema.schema' });
    expect(JSON.stringify(wrapper.snapshot())).not.toContain(secret);
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it('rejects arbitrary alphanumeric secret tokens in every otherwise permitted position', async () => {
    const secret = 'alphanumericSecret123';
    const wrapper = diagnosticFetch(async () => new Response(JSON.stringify({
      id: secret, error: { code: secret, type: secret, param: secret },
    }), { status: 400 }), Date.now() + 1000);
    await wrapper.fetcher('https://example.test');
    expect(wrapper.snapshot()).toEqual({ status: 400, bodyRead: 'complete',
      bytesCaptured: expect.any(Number), parse: 'json' });
  });

  it.each(['<html>private text</html>', '{broken', '"private text"', '[]'])('does not persist malformed/non-object bodies %s', async body => {
    const wrapper = diagnosticFetch(async () => new Response(body, { status: 502 }), Date.now() + 1000);
    await wrapper.fetcher('https://example.test');
    expect(wrapper.snapshot()?.status).toBe(502);
    expect(wrapper.snapshot()?.parse).not.toBe('json');
    expect(JSON.stringify(wrapper.snapshot())).not.toContain('private text');
  });

  it('does not decode or parse an oversized prefix, including multibyte input', async () => {
    const cancel = vi.fn();
    const bytes = new TextEncoder().encode('😀'.repeat(10000));
    const wrapper = diagnosticFetch(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(bytes); }, cancel,
    }), { status: 400 }), Date.now() + 1000);
    await wrapper.fetcher('https://example.test');
    expect(wrapper.snapshot()).toEqual({ status: 400, bodyRead: 'capped',
      bytesCaptured: rejectionDiagnosticBounds.maxBytes, parse: 'not-attempted' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('retains status after invalid UTF-8 or a failed body read', async () => {
    const invalid = diagnosticFetch(async () => new Response(new Uint8Array([255]),
      { status: 400 }), Date.now() + 1000);
    await invalid.fetcher('https://example.test');
    expect(invalid.snapshot()).toMatchObject({ status: 400, parse: 'invalid-utf8' });
    const broken = diagnosticFetch(async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error('private failure')); },
    }), { status: 500 }), Date.now() + 1000);
    expect((await broken.fetcher('https://example.test')).status).toBe(500);
    expect(broken.snapshot()).toMatchObject({ status: 500, bodyRead: 'unreadable' });
    expect(JSON.stringify(broken.snapshot())).not.toContain('private failure');
  });

  it('bounds stalled reads and cancel acknowledgements while retaining numeric status', async () => {
    const cancel = vi.fn(pending);
    const wrapper = diagnosticFetch(async () => new Response(new ReadableStream({ cancel }),
      { status: 429 }), Date.now() + 1000);
    const work = wrapper.fetcher('https://example.test');
    await Promise.resolve();
    expect(wrapper.snapshot()?.status).toBe(429);
    expect((await work).status).toBe(429);
    expect(wrapper.snapshot()?.bodyRead).toBe('timed-out');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels a diagnostic read on the original signal, without losing known status', async () => {
    const controller = new AbortController(), cancel = vi.fn(pending);
    const wrapper = diagnosticFetch(async () => new Response(new ReadableStream({ cancel }),
      { status: 400 }), Date.now() + 1000);
    const work = wrapper.fetcher('https://example.test', { signal: controller.signal });
    await Promise.resolve(); controller.abort();
    expect((await work).status).toBe(400);
    expect(wrapper.snapshot()).toMatchObject({ status: 400, bodyRead: 'cancelled' });
  });

  it('shortens diagnostic reads to the original deadline', async () => {
    const wrapper = diagnosticFetch(async () => new Response(new ReadableStream({}),
      { status: 500 }), Date.now() + 10);
    expect((await wrapper.fetcher('https://example.test')).status).toBe(500);
    expect(wrapper.snapshot()).toMatchObject({ status: 500, bodyRead: 'timed-out' });
  });

  it('does not invoke fetch for already cancelled or expired admission', async () => {
    const fetcher = vi.fn<Fetch>(), controller = new AbortController(); controller.abort();
    await expect(diagnosticFetch(fetcher, Date.now() + 1000).fetcher('https://example.test',
      { signal: controller.signal })).rejects.toThrow();
    await expect(diagnosticFetch(fetcher, Date.now() - 1).fetcher('https://example.test')).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps native SSE success, exact serialized body and receipt unchanged', async () => {
    const wire = 'data: {"id":"synthetic","model":"qwen3.8-max","choices":[{"index":0,"delta":{"content":"{}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const underlying = vi.fn<Fetch>().mockImplementation(async () =>
      new Response(wire, { headers: { 'Content-Type': 'text/event-stream' } }));
    const wrapper = diagnosticFetch(underlying, Date.now() + config.timeoutMs);
    const result = await digitalOceanStream(config, wrapper.fetcher, () => 0)
      .generate(messages, { onContent: () => {} });
    expect(underlying.mock.calls[0][1]?.body).toBe((await prepareDigitalOceanStreamRequest(config, messages)).body);
    expect(result.receipt).toMatchObject({ outcome: 'complete', providerExecution: 'completed',
      contentBytes: 2, eventCount: 2, usage: 'unknown' });
    expect(wrapper.snapshot()).toBeUndefined();
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it('uses the unchanged native stream-http path without claiming provider execution or retry', async () => {
    const underlying = vi.fn<Fetch>().mockResolvedValue(new Response('{bad', { status: 400 }));
    const wrapper = diagnosticFetch(underlying, Date.now() + 1000);
    await expect(digitalOceanStream(config, wrapper.fetcher).generate(messages, { onContent: () => {} }))
      .rejects.toMatchObject({ code: 'stream-http', receipt: { outcome: 'rejected',
        providerExecution: 'unknown', usage: 'unknown', contentBytes: 0, wireBytes: 0, eventCount: 0 } });
    expect(wrapper.snapshot()).toMatchObject({ status: 400, parse: 'invalid-json' });
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it('preserves the native deadline during a stalled diagnostic and keeps the already observed status', async () => {
    vi.useFakeTimers();
    try {
      const underlying = vi.fn<Fetch>().mockResolvedValue(new Response(new ReadableStream({
        cancel: pending,
      }), { status: 503 }));
      const wrapper = diagnosticFetch(underlying, Date.now() + 100);
      const work = digitalOceanStream({ ...config, timeoutMs: 100 }, wrapper.fetcher)
        .generate(messages, { onContent: () => {} }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(100);
      expect(await work).toMatchObject({ code: 'stream-timeout', receipt: {
        providerExecution: 'unknown', usage: 'unknown', contentBytes: 0,
      } });
      expect(wrapper.snapshot()).toMatchObject({ status: 503, bytesCaptured: 0 });
      expect(underlying).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(['abort', 'deadline'] as const)('cancels original late rejected headers exactly once after %s', async stop => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController(), cancel = vi.fn(pending);
      let release: ((response: Response) => void) | undefined;
      const underlying = vi.fn<Fetch>().mockImplementation(() => new Promise<Response>(resolve => {
        release = resolve;
      }));
      const wrapper = diagnosticFetch(underlying, Date.now() + 10);
      const work = wrapper.fetcher('https://example.test', { signal: controller.signal });
      if (stop === 'abort') controller.abort();
      else await vi.advanceTimersByTimeAsync(11);
      release!(new Response(new ReadableStream({ cancel }), { status: 400 }));
      expect((await work).status).toBe(400);
      expect(wrapper.snapshot()).toMatchObject({ status: 400, bytesCaptured: 0,
        bodyRead: stop === 'abort' ? 'cancelled' : 'timed-out' });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(underlying).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
