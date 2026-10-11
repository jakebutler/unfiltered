import { describe, expect, it } from 'vitest';
import { createAdaptiveManifest, resolveContextualAdaptiveProposal, type AdaptiveManifest } from '../src/adaptive-manifest.js';
import { applyValidatedTurn, validateAdaptiveProposal, type AdaptiveContext } from '../src/adaptive-validation.js';
import { eligibleAdaptiveProbes } from '../src/dialogue.js';
import { adaptiveSession, type AdaptiveDraftStore } from '../src/adaptive-session.js';
import { conversation } from '../src/conversation.js';
import { digest } from '../../clinical-core/src/domain.js';
import type { ClinicApiConfig, Draft, StoredDraft } from '../src/types.js';
import { context, withPrior } from './fixtures/adaptive.js';

type Projection = { topics: { ref: string; topicId: string; targets: unknown[][]; collections: { ref: string; path: string; fields: unknown[][] }[] }[]; sourceSegments: string[][] };
const projection = (m: AdaptiveManifest): Projection => Object.assign({}, ...m.payloads) as Projection;
const wire = (m: AdaptiveManifest, extras: Record<string, unknown> = {}) => ({ schema: 4, context: m.id, facts: [], newItems: [], completedLists: [], interruptions: [], unmapped: [], ...extras });
function span(m: AdaptiveManifest, quote: string, kind = 'sentence', index = 0) {
  const rows = projection(m).sourceSegments.filter(row => row[1] === kind && row[2].includes(quote));
  if (!rows[index]) throw new Error('Invalid reviewer evidence fixture');
  return [{ source: rows[index][0], quote }];
}
function fact(m: AdaptiveManifest, topic: string, path: string, quote: string, state = 'known', operation = 'assert') {
  const row = projection(m).topics.find(t => t.topicId === topic)!.targets.find(t => t[1] === path)!;
  return { target: row[0], state, operation, evidence: span(m, quote) };
}
function item(m: AdaptiveManifest, topic: string, path: string, fields: [string, string, string?][]) {
  const collection = projection(m).topics.find(t => t.topicId === topic)!.collections.find(c => c.path === path)!;
  return { collection: collection.ref, fields: fields.map(([field, quote, state = 'known']) => ({ field: collection.fields.find(row => row[1] === field)![0], state, evidence: span(m, quote) })) };
}
const apply = (ctx: AdaptiveContext, m: AdaptiveManifest, raw: unknown) => applyValidatedTurn(ctx, validateAdaptiveProposal(resolveContextualAdaptiveProposal(raw, ctx, m), ctx));

describe('independent v4 structural boundary controls', () => {
  it.each(['patient', 'scenario', 'contentVersion', 'sessionId'] as const)('rejects a captured manifest after %s changes even when source and ordinal handles agree', field => {
    const ctx = context('A personal priority.', ['Q01']), m = createAdaptiveManifest(ctx), raw = wire(m);
    (ctx.binding as Record<string, unknown>)[field] = field === 'scenario' ? 'refill' : 'different';
    expect(() => resolveContextualAdaptiveProposal(raw, ctx, m)).toThrow('stale-adaptive-manifest');
  });
  it('rejects a copied valid handle from another source segment rather than searching all source text', () => {
    const ctx = context('More energy. Easier walking.', ['Q01']), m = createAdaptiveManifest(ctx);
    const candidate = fact(m, 'Q01', 'priority', 'Easier walking');
    candidate.evidence[0].source = projection(m).sourceSegments[0][0];
    expect(() => apply(ctx, m, wire(m, { facts: [candidate] }))).toThrow('source-quote-not-found');
  });
  it('rejects splitting an emoji while preserving exact whitespace and composed Unicode spans', () => {
    const ctx = context('  🙂 Café is my café.\n', ['Q01']), m = createAdaptiveManifest(ctx);
    expect(() => apply(ctx, m, wire(m, { facts: [fact(m, 'Q01', 'reason', '\ud83d')] }))).toThrow('invalid-source-quote');
    const result = apply(ctx, m, wire(m, { unmapped: [{ evidence: span(m, ctx.source.text.trimEnd()), reason: 'ambiguous' }] }));
    expect(result.unmapped?.[0].evidence).toEqual([{ sourceId: ctx.source.id, start: 0, end: ctx.source.text.trimEnd().length }]);
    expect(result.hasUnresolvedInterpretation).toBe(true);
    expect(result.updates).toEqual([]);
  });
  it('rejects an entire valid-plus-foreign-unmapped envelope before applying its supported fact', () => {
    const ctx = context('I want easier walking.', ['Q01']), m = createAdaptiveManifest(ctx);
    expect(() => apply(ctx, m, wire(m, { facts: [fact(m, 'Q01', 'priority', 'easier walking')], unmapped: [{ evidence: [{ source: 's999', quote: 'walking' }], reason: 'unsupported-target' }] }))).toThrow('invalid-contextual-proposal');
    expect(ctx.responses).toEqual({});
  });
  it('rejects duplicate target handles and facts plus item fields beyond the combined cap', () => {
    const ctx = context('I want easier walking. I take aspirin.', ['Q01', 'Q08']), m = createAdaptiveManifest(ctx), candidate = fact(m, 'Q01', 'priority', 'easier walking');
    expect(() => apply(ctx, m, wire(m, { facts: [candidate, candidate] }))).toThrow('duplicate-target');
    expect(() => apply(ctx, m, wire(m, { facts: Array(32).fill(candidate), newItems: [item(m, 'Q08', 'medicines', [['name', 'aspirin']])] }))).toThrow('invalid-adaptive-proposal');
  });
  it('does not allow an unsupported correction cue to borrow trusted prior lineage', () => {
    const ctx = withPrior(context('My priority is easier walking.', ['Q01']), 'Q01', { priority: { state: 'known', value: 'better sleep', sourceIds: ['prior'] } }), m = createAdaptiveManifest(ctx);
    expect(() => apply(ctx, m, wire(m, { facts: [fact(m, 'Q01', 'priority', 'easier walking', 'known', 'correct')] }))).toThrow('invalid-correction-target');
    expect(ctx.responses.Q01!.answers.priority).toMatchObject({ value: 'better sleep', sourceIds: ['prior'] });
  });
});

describe('independent v4 semantic counterexamples', () => {
  it('does not put a relative-only diagnosis in the patient reported-condition collection', () => {
    const ctx = context('My mother has diabetes.', ['Q06', 'Q10']), m = createAdaptiveManifest(ctx);
    const result = apply(ctx, m, wire(m, { newItems: [item(m, 'Q06', 'reportedConditions', [['term', 'diabetes']])] }));
    expect(result.responses.Q06?.answers.reportedConditions).toBeUndefined();
    expect(result.hasUnresolvedInterpretation).toBe(true);
  });
  it('does not accept an unavailable history as known when the quote omits the trailing unavailable predicate', () => {
    const ctx = context('My weight trajectory during childhood is unknown.', ['Q03']), m = createAdaptiveManifest(ctx);
    const result = apply(ctx, m, wire(m, { facts: [fact(m, 'Q03', 'childhood', 'My weight trajectory during childhood')] }));
    expect(result.responses.Q03?.answers.childhood).toBeUndefined();
    expect(eligibleAdaptiveProbes({ ...ctx, responses: result.responses }).flatMap(p => p.targetPaths)).toContain('childhood');
    expect(result.hasUnresolvedInterpretation).toBe(true);
  });
  it('preserves an explicit known diagnostic-uncertainty narrative using do-not-know wording', () => {
    const text = 'I do not know whether I was diagnosed with sleep apnea.';
    const ctx = context(text, ['Q06']), m = createAdaptiveManifest(ctx);
    const result = apply(ctx, m, wire(m, { facts: [fact(m, 'Q06', 'uncertainDiagnosis', text)] }));
    expect(result.responses.Q06?.answers.uncertainDiagnosis).toMatchObject({ state: 'known', value: text });
    expect(result.responses.Q06?.answers['conditions.sleepApnea']?.state).not.toBe('known');
  });
  it('does not silently close a collection from an unmapped explicit completion', () => {
    const ctx = context('I take aspirin. That is all.', ['Q08']), m = createAdaptiveManifest(ctx);
    const result = apply(ctx, m, wire(m, { newItems: [item(m, 'Q08', 'medicines', [['name', 'aspirin']])], unmapped: [{ evidence: span(m, 'That is all.'), reason: 'ambiguous' }] }));
    expect(result.responses.Q08!.answers.medicines).toMatchObject({ complete: false });
    expect(result.unmapped).toHaveLength(1);
    expect(result.hasUnresolvedInterpretation).toBe(true);
  });
});

describe('independent durable unmapped result', () => {
  it('survives serialized draft readback and a new session service, with reason and spans covered by result digest', async () => {
    const content = conversation({ mentalHealth: 'phq4' } as ClinicApiConfig);
    let captured: ReturnType<typeof apply> | undefined;
    const proposer = { propose: async (ctx: AdaptiveContext) => {
      const m = createAdaptiveManifest(ctx), raw = wire(m, { facts: [fact(m, 'Q01', 'reason', 'More energy')], unmapped: [{ evidence: span(m, 'The other issue is hard to explain.'), reason: 'ambiguous' }] });
      const proposal = resolveContextualAdaptiveProposal(raw, ctx, m);
      captured = applyValidatedTurn(ctx, validateAdaptiveProposal(proposal, ctx));
      return { proposal, rawProposal: raw };
    } };
    const service = adaptiveSession(content, proposer);
    const draft: Draft = service.initialize({ schema: 1, id: 'review-session', patient: 'Patient/review', scenario: 'first-intake', revision: 0, savedAt: '2026-10-09T12:00:00Z', createdAt: '2026-10-09T12:00:00Z', phase: 'conversation', turns: [], topics: {}, requests: {}, version: 1 });
    let saved: StoredDraft = { resource: { resourceType: 'DocumentReference', id: 'draft', meta: { versionId: '0' } }, draft };
    const store: AdaptiveDraftStore = {
      async read() { return JSON.parse(JSON.stringify(saved)); },
      async save(previous, next) { expect(previous.draft.revision).toBe(saved.draft.revision); saved = JSON.parse(JSON.stringify({ resource: { ...saved.resource, meta: { versionId: String(next.revision) } }, draft: next })); return this.read(); },
    };
    const accepted = await service.accept(store, { requestId: 'independent-v4-operation', expectedRevision: 0, text: 'More energy. The other issue is hard to explain.', channel: 'text' });
    const result = await service.interpret(store, accepted.operation.id);
    expect(result.operation.status).toBe('applied');
    const restored = await adaptiveSession(content, proposer).reconcile(store, accepted.operation.id);
    expect(restored.operation.unmapped).toEqual(captured!.unmapped);
    expect(restored.operation.hasUnresolvedInterpretation).toBe(true);
    expect(restored.operation.resultDigest).toBe(await digest(captured!));
    expect(restored.operation.resultDigest).not.toBe(await digest({ ...captured!, unmapped: [] }));
    expect(restored.draft.topics.Q01.answers.reason).toMatchObject({ state: 'known', value: 'More energy' });
  });
});
