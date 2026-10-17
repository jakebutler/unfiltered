import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { adaptiveSourceSegments, resolveSegmentQuote, segmentedEvidenceProtocol } from '../src/adaptive-source.js';
import { adaptiveSegmentJsonSchema, adaptiveSegmentSchemaName, adaptiveSegmentWireSchema, resolveSegmentedAdaptiveProposal } from '../src/adaptive-wire.js';
import { AdaptiveProposalFailure, buildAdaptiveMessages, createDigitalOceanProposer, prepareAdaptiveRequest, resolveQuotedAdaptiveProposal } from '../src/adaptive.js';
import { applyValidatedTurn, validateAdaptiveProposal, type AdaptiveContext } from '../src/adaptive-validation.js';
import { context, source } from './fixtures/adaptive.js';
const config = { endpoint: 'https://inference.do-ai.run' as const, apiKey: 'test-only-secret', model: 'qwen3.8-max' as const, timeoutMs: 1000, maxOutputTokens: 4096 };
const options = { protocol: segmentedEvidenceProtocol };
const wire = (extra: Record<string, unknown> = {}) => ({ schema: 3, facts: [], newItems: [], completedLists: [], acts: [], next: null, ...extra });
function quote(ctx: AdaptiveContext, text: string, needle = text, kind: 'sentence' | 'literal' = 'sentence') {
  const segment = adaptiveSourceSegments(ctx).find(segment => segment.kind === kind && segment.text.includes(text))!;
  if (!segment) throw new Error('bad-test-segment');
  return [{ segmentId: segment.id, quote: needle }];
}
const field = (ctx: AdaptiveContext, path: string, text: string, state = 'known', transform = 'verbatim') => ({ path, state, transform, evidence: quote(ctx, text) });
const scalar = (ctx: AdaptiveContext, topicId: string, path: string, text: string, state = 'known', transform = 'verbatim') => ({ topicId, ...field(ctx, path, text, state, transform), correctsSourceIds: [] });
const apply = (ctx: AdaptiveContext, value: unknown) => applyValidatedTurn(ctx, validateAdaptiveProposal(resolveSegmentedAdaptiveProposal(value, ctx), ctx));

describe('immutable source-derived evidence addresses', () => {
  it('preserves all raw source bytes through decimal, abbreviation, Unicode and CRLF segmentation', () => {
    const text = 'Dr. Léa read 81.5 kg.\r\n🙂 我喝茶. I estimate 82.5 kg now.';
    const ctx = context(text), segments = adaptiveSourceSegments(ctx);
    expect(segments.filter(segment => segment.kind === 'sentence').map(segment => segment.text).join('')).toBe(text);
    expect(segments[0].text).toBe('Dr. Léa read 81.5 kg.');
    expect(segments.filter(segment => segment.kind === 'literal' && segment.text === 'kg')).toHaveLength(2);
    expect(segments.some(segment => segment.kind === 'literal' && segment.text === '81.5')).toBe(true);
    expect(Object.isFrozen(segments)).toBe(true);
    expect(segments.every(Object.isFrozen)).toBe(true);
    expect(adaptiveSourceSegments(ctx)).toEqual(segments);
  });
  it('issues separate IDs for repeated identical numeric and unit literals without assigning their clinical meaning', () => {
    const ctx = context('I measured 170 cm and later measured 170 cm.'), segments = adaptiveSourceSegments(ctx);
    const numbers = segments.filter(segment => segment.kind === 'literal' && segment.text === '170');
    expect(new Set(numbers.map(segment => segment.id)).size).toBe(2);
    expect(numbers.map(segment => resolveSegmentQuote(ctx, segments, { segmentId: segment.id, quote: '170' }).start)).toEqual([11, 37]);
  });
  it('rejects residual within-segment repetition rather than selecting the first occurrence', () => {
    const ctx = context('Tea and tea.', ['Q11']);
    const segment = adaptiveSourceSegments(ctx)[0];
    const raw = wire({ facts: [{ ...scalar(ctx, 'Q11', 'typicality', ctx.source.text), evidence: [{ segmentId: segment.id, quote: 'a' }] }] });
    expect(() => resolveSegmentedAdaptiveProposal(raw, ctx)).toThrow('ambiguous-source-quote');
  });
  it('does not borrow a matching quote from another segment', () => {
    const ctx = context('Coffee. Water.', ['Q11']);
    const raw = wire({ facts: [{ ...scalar(ctx, 'Q11', 'typicality', 'Coffee'), evidence: [{ segmentId: adaptiveSourceSegments(ctx)[0].id, quote: 'Water' }] }] });
    expect(() => resolveSegmentedAdaptiveProposal(raw, ctx)).toThrow('source-quote-not-found');
  });
  it('rejects IDs replayed across sources, source edits, invented maps and stale current-source snapshots', () => {
    const ctx = context('I prefer café.', ['Q01']), old = adaptiveSourceSegments(ctx), raw = wire({ facts: [scalar(ctx, 'Q01', 'priority', 'café')] });
    const other = context(ctx.source.text, ['Q01']); other.source = source(ctx.source.text, 'other-turn'); other.sources = [other.source];
    expect(() => resolveSegmentedAdaptiveProposal(raw, other)).toThrow('invalid-source-segment');
    const edited = context('I prefer café and tea.', ['Q01']);
    expect(() => resolveSegmentedAdaptiveProposal(raw, edited)).toThrow('invalid-source-segment');
    expect(() => resolveSegmentQuote(edited, old, { segmentId: old[0].id, quote: 'café' })).toThrow('invalid-source-segment');
    expect(() => resolveSegmentQuote(ctx, [...old], { segmentId: old[0].id, quote: 'café' })).toThrow('invalid-source-segment');
    expect(() => adaptiveSourceSegments({ ...ctx, sources: [] })).toThrow('invalid-adaptive-source');
  });
  it.each(['', ' ', '\ud83d', 'cafe\u0301', 'Café'])('rejects empty, split-surrogate or inexact quoted text %j', text => {
    const ctx = context('🙂 café.', ['Q01']);
    const raw = wire({ facts: [{ ...scalar(ctx, 'Q01', 'priority', 'café'), evidence: [{ segmentId: adaptiveSourceSegments(ctx)[0].id, quote: text }] }] });
    expect(() => resolveSegmentedAdaptiveProposal(raw, ctx)).toThrow();
  });
  it('bounds segmentation without truncating the full source', () => {
    const ctx = context('A detail. '.repeat(100), ['Q01']);
    const segments = adaptiveSourceSegments(ctx).filter(segment => segment.kind === 'sentence');
    expect(segments.length).toBeLessThanOrEqual(64);
    expect(segments.map(segment => segment.text).join('')).toBe(ctx.source.text);
    expect(() => adaptiveSourceSegments(context('1 '.repeat(193)))).toThrow('source-segment-limit');
  });
});

describe('one strict definition for native and local v3 shape', () => {
  it('generates closed objects with every key required, including neutral metadata', () => {
    const objects: Record<string, unknown>[] = [];
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      const object = value as Record<string, unknown>;
      if (object.type === 'object') objects.push(object);
      Object.values(object).forEach(visit);
    };
    visit(adaptiveSegmentJsonSchema);
    expect(objects.length).toBeGreaterThan(8);
    for (const object of objects) {
      expect(object.additionalProperties).toBe(false);
      expect(object.required).toEqual(Object.keys(object.properties as object));
    }
    expect(adaptiveSegmentWireSchema.safeParse(wire()).success).toBe(true);
  });
  it.each(['extra', 'null-correction', 'missing-correction', 'item-correction', 'offset', 'occurrence', 'answer-reply', 'missing-next'])('rejects undeclared or misplaced metadata: %s', variant => {
    const ctx = context('I prefer tea.', ['Q01']);
    const raw = wire({ facts: [scalar(ctx, 'Q01', 'priority', 'tea')] }) as any;
    if (variant === 'extra') raw.facts[0].newItemsNote = '';
    if (variant === 'null-correction') raw.facts[0].correctsSourceIds = null;
    if (variant === 'missing-correction') delete raw.facts[0].correctsSourceIds;
    if (variant === 'item-correction') raw.newItems = [{ topicId: 'Q11', collection: 'occasions', key: 'a', fields: [{ ...field(ctx, 'foods', 'tea'), correctsSourceIds: [] }] }];
    if (variant === 'offset') raw.facts[0].evidence[0].start = 0;
    if (variant === 'occurrence') raw.facts[0].evidence[0].occurrence = 0;
    if (variant === 'answer-reply') raw.acts = [{ kind: 'answer', evidence: quote(ctx, 'tea'), targetTopicId: null, replyId: 'COPY-02' }];
    if (variant === 'missing-next') delete raw.next;
    expect(() => resolveSegmentedAdaptiveProposal(raw, ctx)).toThrow('invalid-adaptive-segment-proposal');
  });
  it('maps declared empty/null metadata prospectively while retaining the raw object intact', () => {
    const ctx = context('I prefer tea. What can you do?', ['Q01']);
    const raw = wire({ facts: [scalar(ctx, 'Q01', 'priority', 'tea')], acts: [{ kind: 'question', evidence: quote(ctx, 'What can you do?'), targetTopicId: null, replyId: 'COPY-02' }] });
    const before = structuredClone(raw), canonical = resolveSegmentedAdaptiveProposal(raw, ctx);
    expect(canonical.facts[0]).not.toHaveProperty('correctsSourceIds');
    expect(canonical.acts[0]).not.toHaveProperty('targetTopicId');
    expect(canonical).not.toHaveProperty('next');
    expect(raw).toEqual(before);
  });
  it('uses separate segment addresses for repeated words and preserves an explicitly unknown item detail', () => {
    const ctx = context("At dawn I had toast. I don't remember the toast portion. At dusk I had toast again.", ['Q11']);
    const segments = adaptiveSourceSegments(ctx).filter(segment => segment.kind === 'sentence');
    const raw = wire({ newItems: [{ topicId: 'Q11', collection: 'occasions', key: 'morning', fields: [
      { path: 'foods', state: 'known', transform: 'verbatim', evidence: [{ segmentId: segments[0].id, quote: 'toast' }] },
      { path: 'foodAmounts', state: 'unknown', transform: 'scoped-response', evidence: [{ segmentId: segments[1].id, quote: "I don't remember the toast portion." }] },
    ] }] });
    const result = apply(ctx, raw);
    expect(result.responses.Q11?.answers.occasions).toMatchObject({ items: [{ answers: { foods: { state: 'known', value: 'toast' }, foodAmounts: { state: 'unknown', note: "I don't remember the toast portion." } } }] });
    expect(result.clarifications).toEqual([]);
  });
  it('retains full-source subject and measurement association beyond lexical segment boundaries', () => {
    const ctx = context('My mother has diabetes. My height is 169 cm and my weight is 78 kg.', ['Q06', 'Q04']);
    const segments = adaptiveSourceSegments(ctx), numeric = segments.find(segment => segment.kind === 'literal' && segment.text === '78')!;
    const result = apply(ctx, wire({ facts: [scalar(ctx, 'Q06', 'conditions.diabetes', 'diabetes', 'known', 'explicit-choice'), { ...scalar(ctx, 'Q04', 'height.value', '78', 'known', 'explicit-number'), evidence: [{ segmentId: numeric.id, quote: '78' }] }] }));
    expect(result.updates).toEqual([]);
    expect(result.clarifications).toHaveLength(2);
  });
  it('preserves the original A5 failures under v2 and rejects old wire shapes under v3', () => {
    const retained = JSON.parse(readFileSync(new URL('../../../docs/implementation/evidence/DO-A5.json', import.meta.url), 'utf8')) as { results: { caseId: string; context: AdaptiveContext; rawProviderProposal: unknown }[] };
    for (const entry of retained.results.filter(entry => ['G3', 'G5'].includes(entry.caseId))) {
      expect(() => resolveQuotedAdaptiveProposal(entry.rawProviderProposal, entry.context)).toThrow('ambiguous-source-quote');
      expect(() => resolveSegmentedAdaptiveProposal(entry.rawProviderProposal, entry.context)).toThrow('invalid-adaptive-segment-proposal');
    }
  });
});

describe('opt-in native strict schema request and exact accounting', () => {
  const response = (raw: unknown) => new Response(JSON.stringify({ id: 'schema-receipt', model: config.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }] }));
  it('sends the exact preflight request once and retains schema identity, raw proposal and canonical spans', async () => {
    const ctx = context('I prefer café 🙂.', ['Q01']), raw = wire({ facts: [scalar(ctx, 'Q01', 'priority', 'café 🙂')] });
    const prepared = await prepareAdaptiveRequest(ctx, config, options);
    const fetcher = vi.fn(async () => response(raw));
    const result = await createDigitalOceanProposer(config, fetcher, options).propose(ctx);
    const body = String(fetcher.mock.calls[0][1]?.body);
    expect(body).toBe(prepared.body);
    expect(prepared.requestBytes).toBe(Buffer.byteLength(body, 'utf8'));
    expect(prepared.requestBytes).toBeLessThanOrEqual(60000);
    expect(body).not.toContain(config.apiKey);
    expect(JSON.parse(body).response_format).toEqual({ type: 'json_schema', json_schema: { name: adaptiveSegmentSchemaName, strict: true, schema: adaptiveSegmentJsonSchema } });
    expect(result.receipt).toMatchObject({ evidenceProtocol: segmentedEvidenceProtocol, requestBytes: prepared.requestBytes, responseSchema: { name: adaptiveSegmentSchemaName, sha256: createHash('sha256').update(JSON.stringify(adaptiveSegmentJsonSchema)).digest('hex') } });
    expect(result.rawProposal).toEqual(raw);
    expect(result.proposal).toMatchObject({ schema: 1, facts: [{ evidence: [{ sourceId: ctx.source.id, start: 9, end: 16 }] }] });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects locally when a provider ignores the requested strict schema, retaining receipt/raw response with no retry', async () => {
    const ctx = context('I prefer tea.', ['Q01']), raw = { ...wire(), forbidden: true };
    const fetcher = vi.fn(async () => response(raw));
    const error = await createDigitalOceanProposer(config, fetcher, options).propose(ctx).catch(error => error);
    expect(error).toBeInstanceOf(AdaptiveProposalFailure);
    expect(error).toMatchObject({ code: 'invalid-adaptive-segment-proposal', rawProposal: raw, receipt: { evidenceProtocol: segmentedEvidenceProtocol, responseSchema: { name: adaptiveSegmentSchemaName } } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('includes schema and serialization overhead in the allocation, and rejects before network access', async () => {
    const ctx = context('I prefer tea.', ['Q01']), prepared = await prepareAdaptiveRequest(ctx, config, options), fetcher = vi.fn();
    const messageBytes = buildAdaptiveMessages(ctx, segmentedEvidenceProtocol).reduce((sum, message) => sum + Buffer.byteLength(String(message.content)), 0);
    expect(prepared.requestBytes).toBeGreaterThan(messageBytes + Buffer.byteLength(JSON.stringify(adaptiveSegmentJsonSchema)));
    await expect(createDigitalOceanProposer({ ...config, maxRequestBytes: prepared.requestBytes - 1 }, fetcher, options).propose(ctx)).rejects.toThrow('inference-input-too-large');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('keeps the existing default protocol and native JSON-object mode unchanged', async () => {
    const ctx = context('I prefer tea.', ['Q01']), fetcher = vi.fn(async () => response({ schema: 1, facts: [], newItems: [], completedLists: [], acts: [] }));
    const result = await createDigitalOceanProposer(config, fetcher).propose(ctx);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).response_format).toEqual({ type: 'json_object' });
    expect(result.receipt?.evidenceProtocol).toBe('literal-disambiguation-v2');
    expect(result.receipt?.responseSchema).toBeUndefined();
    expect(buildAdaptiveMessages(ctx, segmentedEvidenceProtocol)[0].content.length).toBeLessThan(4000);
  });
});
