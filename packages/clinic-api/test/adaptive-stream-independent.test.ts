import { describe, expect, it, vi } from 'vitest';
import { consumeReplyDraftStream, createReplyDraftManifest } from '../src/adaptive-reply.js';
import { context } from './fixtures/adaptive.js';
import type { Fetch } from '../../clinical-core/src/transport.js';

const config = { endpoint: 'https://inference.do-ai.run' as const, apiKey: 'offline-secret-never-recorded', model: 'qwen3.8-max' as const, timeoutMs: 100, maxOutputTokens: 2048, maxRequestBytes: 60000 };
function fixture() {
  const manifest = createReplyDraftManifest(context('I am five feet eight inches.', ['Q04', 'Q05']));
  const payload = JSON.parse(String(manifest.messages[1].content));
  const advance = { manifestId: manifest.id, actionId: payload.actions[0].id, controls: [], defer: [] };
  return { manifest, advance };
}
const event = (content: string | null, finish: string | null = null) => `data: ${JSON.stringify({ id: 'independent-one', model: config.model, choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`;
function fetchFixture(text: string, close: boolean, cancel: () => void | Promise<void> = () => {}) {
  return vi.fn<Fetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(text)); if (close) controller.close(); }, cancel,
  }), { headers: { 'Content-Type': 'text/event-stream' } }));
}
describe('independent one-call streaming boundary', () => {
  it('bounds a hanging validated advance callback even when reader cancellation never settles', async () => {
    const { manifest, advance } = fixture();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const fetcher = fetchFixture(event('{"advance":' + JSON.stringify(advance) + ','), false, cancel);
    const onAdvance = vi.fn(() => new Promise<void>(() => {}));
    const error = await consumeReplyDraftStream(config, manifest, { fetcher, onAdvance }).catch(error => error);
    expect(error).toMatchObject({ code: 'stream-consumer-timeout', receipt: { outcome: 'unknown', usage: 'unknown', providerExecution: 'unknown', cleanup: { readerCancelRequested: true, providerTermination: 'unconfirmed' } } });
    expect(onAdvance).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.receipt)).not.toContain(config.apiKey);
  });
  it('does not treat terminal-seen as a complete response when EOF stalls', async () => {
    const { manifest, advance } = fixture();
    const draft = { manifestId: manifest.id, claims: [], acts: [], residual: [], sourceDisposition: 'partially-represented' };
    const fetcher = fetchFixture(event(JSON.stringify({ advance, draft })) + event(null, 'stop') + 'data: [DONE]\n\n', false);
    const error = await consumeReplyDraftStream(config, manifest, { fetcher }).catch(error => error);
    expect(error).toMatchObject({ code: 'stream-timeout', receipt: { outcome: 'unknown', providerExecution: 'completed', finishReason: 'stop', usage: 'unknown' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects an escaped duplicate action identifier before any early action callback', async () => {
    const { manifest, advance } = fixture();
    const serialized = JSON.stringify(advance).replace('"actionId":', '"actionId":"invented","action\\u0049d":');
    const fetcher = fetchFixture(event('{"advance":' + serialized + ','), true), onAdvance = vi.fn();
    await expect(consumeReplyDraftStream(config, manifest, { fetcher, onAdvance })).rejects.toMatchObject({ code: 'duplicate-action-key', receipt: { outcome: 'rejected' } });
    expect(onAdvance).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not expose an invented action even if the provider marks its output complete', async () => {
    const { manifest, advance } = fixture();
    const fetcher = fetchFixture(event('{"advance":' + JSON.stringify({ ...advance, actionId: 'not-issued' }) + ',') + event(null, 'stop') + 'data: [DONE]\n\n', true), onAdvance = vi.fn();
    await expect(consumeReplyDraftStream(config, manifest, { fetcher, onAdvance })).rejects.toMatchObject({ code: 'invalid-reply-advance', receipt: { outcome: 'rejected', providerExecution: 'unknown' } });
    expect(onAdvance).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
