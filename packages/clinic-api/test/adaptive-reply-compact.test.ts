import { expect, it, vi } from 'vitest';
import { createCompactReplyManifest, consumeCompactReplyStream, decodeCompactDraft, encodeCompactDraft, createSyntheticPartialCapture } from '../src/adaptive-reply-compact.js';
import { createReplyDraftManifest, validateReplyDraft, type ReplyDraft } from '../src/adaptive-reply.js';
import { context } from './fixtures/adaptive.js';
import type { Fetch } from '../../clinical-core/src/transport.js';
const source = "I'm five feet eight inches. The scale read 230 pounds on August 12. I'm not sure whether that still reflects my weight; I estimate 235 pounds now.";
const config = { endpoint: 'https://inference.do-ai.run' as const, apiKey: 'offline-only', model: 'qwen3.8-max' as const, timeoutMs: 1000, maxOutputTokens: 2048, maxRequestBytes: 60000 };
function fixture() {
  const ctx = context(source, ['Q04', 'Q05']); ctx.sources = [{ ...ctx.source, id: 'earlier-source', text: 'Earlier synthetic weight report.' }, ...ctx.sources];
  const manifest = createCompactReplyManifest(ctx), original = createReplyDraftManifest(ctx), payload = JSON.parse(String(manifest.messages[1].content));
  const address = { statementId: payload.statements[0].id, quote: 'five feet eight inches' }, predicate = { ...address, quote: payload.statements[0].text };
  const advance = { manifestId: manifest.id, actionId: payload.actions[0].id, controls: [], defer: [] };
  const draft: ReplyDraft = { manifestId: manifest.id, claims: [{ targetId: payload.targets.find((t: { path: string }) => t.path === 'height.value').id, state: 'known', value: { feet: 5, inches: 8 }, valueEvidence: address, evidence: [address, predicate], scope: { subject: 'patient', entity: null, period: null, predicate }, correctsSourceIds: [] }],
    acts: [{ kind: 'answer', targetTopicId: 'Q04', replyId: null, evidence: [predicate] }], residual: [{ evidence: [{ statementId: payload.statements[1].id, quote: payload.statements[1].text }], reason: 'ambiguous' }], sourceDisposition: 'partially-represented' };
  return { ctx, manifest, original, advance, draft, weightTarget: payload.targets.find((t: { path: string }) => t.path === 'currentWeightEstimate.value').id, weightEvidence: { statementId: payload.statements[2].id, quote: payload.statements[2].text } }; 
}
function event(content: string | null, finish: string | null = null) { return `data: ${JSON.stringify({ id: 'compact', model: config.model, choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`; }
function response(text: string, finished = true) { return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(event(text) + (finished ? event(null, 'stop') + 'data: [DONE]\n\n' : ''))); c.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } }); }
it('roundtrips every scope/evidence/correction/act/residual field while reducing repeated wire bytes', () => {
  const { draft, original, weightTarget, weightEvidence } = fixture();
  const representative: ReplyDraft = { ...draft, claims: [draft.claims[0], { ...draft.claims[0], targetId: weightTarget, state: 'uncertain', value: null, valueEvidence: null, evidence: [weightEvidence], scope: { subject: 'patient', entity: 'the current weight', period: 'I estimate 235 pounds now', predicate: weightEvidence }, correctsSourceIds: ['earlier-source'] }] };
  expect(validateReplyDraft(representative, original).admission).toBe('unqualified-provisional');
  const compact = encodeCompactDraft(representative); expect(decodeCompactDraft(compact)).toEqual(representative);
  const oldBytes = Buffer.byteLength(JSON.stringify(representative)), newBytes = Buffer.byteLength(JSON.stringify(compact));
  expect(newBytes).toBeLessThan(oldBytes * .7);
  console.log(JSON.stringify({ offlineAuthoredRepresentative: true, observedAS1Tail: false, expandedBytes: oldBytes, compactBytes: newBytes, approximateTokensFourBytesEach: { expanded: Math.ceil(oldBytes / 4), compact: Math.ceil(newBytes / 4) }, actualTokenizerUsed: false }));
});
it('rejects duplicate/unused/out-of-range anchors rather than silently losing or inventing evidence', () => {
  const { draft } = fixture(), compact = encodeCompactDraft(draft);
  expect(() => decodeCompactDraft({ ...compact, a: [...compact.a, compact.a[0]] })).toThrow('duplicate-compact-anchor');
  expect(() => decodeCompactDraft({ ...compact, a: [...compact.a, { s: 'unused', q: 'unused' }] })).toThrow('unused-compact-anchor');
  expect(() => decodeCompactDraft({ ...compact, c: [{ ...compact.c[0], f: 95 }] })).toThrow('invalid-compact-reference');
});
it('retains the original address capacity beyond96 unique anchors within the unchanged128k byte bound', () => {
  const { draft } = fixture();
  const boundary: ReplyDraft = { ...draft, claims: Array.from({ length: 32 }, (_, i) => {
    const evidence = Array.from({ length: 6 }, (_, j) => ({ statementId: `synthetic-${i}`, quote: `unique synthetic evidence ${i}-${j}` }));
    return { ...draft.claims[0], targetId: `synthetic-target-${i}`, value: String(i), valueEvidence: evidence[4], evidence: evidence.slice(0, 4), scope: { ...draft.claims[0].scope, predicate: evidence[5] } };
  }), acts: Array.from({ length: 4 }, (_, i) => ({ kind: 'answer' as const, targetTopicId: null, replyId: null, evidence: Array.from({ length: 4 }, (_, j) => ({ statementId: `act-${i}`, quote: `act ${i}-${j}` })) })), residual: Array.from({ length: 8 }, (_, i) => ({ reason: 'ambiguous' as const, evidence: Array.from({ length: 4 }, (_, j) => ({ statementId: `gap-${i}`, quote: `gap ${i}-${j}` })) })) };
  const wire = encodeCompactDraft(boundary); expect(wire.a).toHaveLength(240);
  expect(decodeCompactDraft(wire)).toEqual(boundary); expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThan(128000);
});
it('keeps the advance prefix unchanged and admits only the same unqualified provisional shape', async () => {
  const { manifest, advance, draft } = fixture(), emitted = vi.fn();
  expect(manifest.jsonSchema).toMatchObject({ required: ['advance', 'draft'], additionalProperties: false });
  const fetcher = vi.fn<Fetch>().mockResolvedValue(response(JSON.stringify({ advance, draft: encodeCompactDraft(draft) })));
  const result = await consumeCompactReplyStream(config, manifest, { fetcher, onAdvance: emitted });
  expect(emitted).toHaveBeenCalledWith(advance); expect(result.draft).toEqual(draft);
  expect(result).toMatchObject({ admission: 'unqualified-provisional', compactValidationRevision: 'stream-compact-source-shape-v1', receipt: { outcome: 'complete', providerExecution: 'completed', usage: 'unknown' } });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('still rejects invented source quotations and context changes through original authority validation', async () => {
  const { ctx, manifest, advance, draft } = fixture(), wire = encodeCompactDraft(draft); wire.a[0].q = 'invented';
  const fetcher = vi.fn<Fetch>().mockResolvedValue(response(JSON.stringify({ advance, draft: wire })));
  await expect(consumeCompactReplyStream(config, manifest, { fetcher })).rejects.toMatchObject({ code: 'source-quote-not-found' });
  ctx.source.text += ' changed';
  await expect(consumeCompactReplyStream(config, manifest, { fetcher })).rejects.toMatchObject({ code: 'unissued-or-stale-reply-manifest' });
});
it('synthetic diagnostics retain incomplete text without admitting a failed tail or retracting advance', async () => {
  const { manifest, advance } = fixture(), emitted = vi.fn(), observed: string[] = [];
  const raw = '{"advance":' + JSON.stringify(advance) + ',"draft":{"m":';
  const fetcher = vi.fn<Fetch>().mockResolvedValue(response(raw));
  await expect(consumeCompactReplyStream(config, manifest, { fetcher, onAdvance: emitted, onSyntheticContent: text => { observed.push(text); } })).rejects.toMatchObject({ code: 'action-object-truncated', receipt: { providerExecution: 'completed' } });
  expect(observed.join('')).toBe(raw); expect(emitted).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('caps synthetic diagnostics at a UTF8 boundary and never appends later chunks after a dropped suffix', () => {
  const partial = createSyntheticPartialCapture(5); partial.append('a💡z'); partial.append('b');
  expect(partial.snapshot()).toEqual({ syntheticOnly: true, utf8: 'a💡', bytes: 5, capBytes: 5, truncated: true, admissible: false });
  expect(() => createSyntheticPartialCapture(8193)).toThrow('invalid-synthetic-evidence-cap');
});
