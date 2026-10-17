import { describe, expect, it, vi } from 'vitest';
import { createReplyDraftManifest, validateReplyAdvance, validateReplyDraft, consumeReplyDraftStream, type ReplyAdvance } from '../src/adaptive-reply.js';
import { context } from './fixtures/adaptive.js';
import type { Fetch } from '../../clinical-core/src/transport.js';
const source = "I'm five feet eight inches. The scale read 230 pounds on August 12. I'm not sure whether that still reflects my weight; I estimate 235 pounds now.";
const config = { endpoint: 'https://inference.do-ai.run' as const, apiKey: 'offline-only', model: 'qwen3.8-max' as const, timeoutMs: 1000, maxOutputTokens: 1536, maxRequestBytes: 60000 };
function fixture() {
  const ctx = context(source, ['Q04', 'Q05']), manifest = createReplyDraftManifest(ctx);
  const payload = JSON.parse(String(manifest.messages[1].content)), address = { statementId: payload.statements[0].id, quote: 'five feet eight inches' };
  const advance = { manifestId: manifest.id, actionId: payload.actions.find((action: { topicId: string }) => action.topicId === 'Q05').id, controls: [], defer: [] };
  const draft = { manifestId: manifest.id, claims: [{ targetId: payload.targets.find((target: { path: string }) => target.path === 'height.value').id, state: 'known', value: { feet: 5, inches: 8 }, valueEvidence: address, evidence: [address], scope: { subject: 'patient', entity: null, period: null, predicate: { ...address, quote: payload.statements[0].text } }, correctsSourceIds: [] }], acts: [], residual: [{ evidence: [{ statementId: payload.statements[1].id, quote: payload.statements[1].text }], reason: 'ambiguous' }], sourceDisposition: 'partially-represented' };
  return { ctx, manifest, address, advance, draft };
}
function event(content: string | null, finish: string | null = null) { return `data: ${JSON.stringify({ id: 'one', model: config.model, choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`; }
function response(chunks: string[]) { return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } }); }
describe('isolated action-first stream compatibility contract', () => {
  it('issues exact local actions and a native strict schema without identity or authority fields', () => {
    const { manifest, advance } = fixture();
    expect(manifest.jsonSchema).toMatchObject({ type: 'object', required: ['advance', 'draft'], additionalProperties: false });
    expect(validateReplyAdvance(advance, manifest)).toEqual(advance);
    expect(JSON.stringify(manifest.messages)).not.toMatch(/operation-secret|session-secret|Patient\/secret|snapshot-secret/);
  });
  it('validates source shape but explicitly grants no semantic admission or readiness', () => {
    const { manifest, draft } = fixture();
    expect(validateReplyDraft(draft, manifest)).toMatchObject({ admission: 'unqualified-provisional', policyRevision: 'stream-compatibility-source-shape-v1' });
  });
  it('rejects invented action/source/target, wrong context and value-state mismatch', () => {
    const { ctx, manifest, advance, draft } = fixture();
    expect(() => validateReplyAdvance({ ...advance, actionId: 'invented' }, manifest)).toThrow('invalid-reply-advance');
    const bad = structuredClone(draft); bad.claims[0].valueEvidence.quote = 'invented'; expect(() => validateReplyDraft(bad, manifest)).toThrow('source-quote-not-found');
    expect(() => validateReplyDraft({ ...draft, claims: [draft.claims[0], draft.claims[0]] }, manifest)).toThrow('invalid-reply-claim');
    expect(() => validateReplyDraft({ ...draft, claims: [{ ...draft.claims[0], state: 'uncertain' }] }, manifest)).toThrow('invalid-reply-claim');
    expect(() => validateReplyDraft({ ...draft, claims: [{ ...draft.claims[0], targetId: 'invented' }] }, manifest)).toThrow('invalid-reply-draft');
    ctx.source.text += ' changed'; expect(() => validateReplyAdvance(advance, manifest)).toThrow('unissued-or-stale-reply-manifest');
  });
  it('exposes the complete advance before any tail is parsed, with exactly one fetch', async () => {
    const { manifest, advance, draft } = fixture(), order: string[] = [];
    const first = '{"advance":' + JSON.stringify(advance) + ',', tail = '"draft":' + JSON.stringify(draft) + '}';
    let deliverTail!: () => void;
    const fetcher = vi.fn<Fetch>().mockResolvedValue(new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(event(first)));
      deliverTail = () => { controller.enqueue(new TextEncoder().encode(event(tail) + event(null, 'stop') + 'data: [DONE]\n\n')); controller.close(); };
    } }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const result = await consumeReplyDraftStream(config, manifest, { fetcher, onAdvance: packet => { order.push('advance'); expect(packet).toEqual(advance); deliverTail(); } });
    order.push('complete'); expect(order).toEqual(['advance', 'complete']); expect(result).toMatchObject({ admission: 'unqualified-provisional', receipt: { outcome: 'complete', usage: 'unknown' } }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('retains an already emitted advance when a same-delta duplicate tail rejects capture', async () => {
    const { manifest, advance } = fixture(), emitted: ReplyAdvance[] = [];
    const text = '{"advance":' + JSON.stringify(advance) + ',"draft":{"claims":[],"claims":[]}}';
    const fetcher = vi.fn<Fetch>().mockResolvedValue(response([event(text)]));
    await expect(consumeReplyDraftStream(config, manifest, { fetcher, onAdvance: packet => { emitted.push(packet); } })).rejects.toMatchObject({ code: 'duplicate-action-key', receipt: { outcome: 'rejected', usage: 'unknown' } });
    expect(emitted).toEqual([advance]); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('retains advance and known provider finish receipt when the full object is truncated', async () => {
    const { manifest, advance } = fixture(), emitted = vi.fn();
    const fetcher = vi.fn<Fetch>().mockResolvedValue(response([event('{"advance":' + JSON.stringify(advance) + ','), event(null, 'stop'), 'data: [DONE]\n\n']));
    await expect(consumeReplyDraftStream(config, manifest, { fetcher, onAdvance: emitted })).rejects.toMatchObject({ code: 'action-object-truncated', receipt: { finishReason: 'stop', usage: 'unknown' } });
    expect(emitted).toHaveBeenCalledTimes(1);
  });
});
