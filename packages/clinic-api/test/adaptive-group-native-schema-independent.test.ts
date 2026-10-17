import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import { normalizeAdaptiveGroupNativeSchema, draft7AdaptiveGroupNativeSchemaRevision } from '../src/adaptive-group-native-schema.js';
import { createAdaptiveGroupManifest, issuedAdaptiveGroupManifest } from '../src/adaptive-group-manifest.js';
import { validateAdaptiveGroupProposal } from '../src/adaptive-group-compile.js';
import { buildAdaptiveMessages, validateAdaptiveProposalResult } from '../src/adaptive.js';
import { context } from './fixtures/adaptive.js';

describe('independent V6 dialect equivalence controls, offline only', () => {
  it('preserves sibling constraints on singleton unions and excludes false schema branches', () => {
    const schema = { type: 'object', properties: {
      amount: { anyOf: [{ type: 'number' }], minimum: 2 },
      impossible: false,
      correction: { type: 'array', items: false, maxItems: 0 },
      literal: { const: { $ref: '#/$defs/A', anyOf: [false] } },
    }, required: ['amount', 'correction', 'literal'], additionalProperties: false };
    const normalized = normalizeAdaptiveGroupNativeSchema(schema);
    expect((normalized.properties as any).amount).toEqual(schema.properties.amount);
    expect((normalized.properties as any).literal).toEqual(schema.properties.literal);
    const ajv = new Ajv(), old = ajv.compile(schema), revised = ajv.compile(normalized);
    for (const value of [
      { amount: 3, correction: [], literal: schema.properties.literal.const },
      { amount: 1, correction: [], literal: schema.properties.literal.const },
      { amount: 3, correction: [0], literal: schema.properties.literal.const },
      { amount: 3, correction: [], literal: schema.properties.literal.const, impossible: null },
    ]) expect(revised(value)).toBe(old(value));
    expect(revised({ amount: 1, correction: [], literal: schema.properties.literal.const })).toBe(false);
  });

  it('keeps a role-state semantic rejection and independent safety question identical in V1/V2', () => {
    const ctx = context('No reason. Should I double my dose?', ['Q01']);
    const results = [undefined, draft7AdaptiveGroupNativeSchemaRevision].map(nativeSchemaRevision => {
      const manifest = createAdaptiveGroupManifest(ctx, { nativeSchemaRevision }), segments = issuedAdaptiveGroupManifest(manifest, ctx).segments;
      const address = (quote: string) => ({ segment: `s${segments.findIndex(segment => segment.text.includes(quote))}`, quote });
      const raw = { schema: 6, context: manifest.id, groups: [{ kind: 'Q01', key: 'goals', scope: 'patient', fields: [{ role: 'reason', answer: { state: 'negative', value: null, support: [address('No reason.')] } }], correct: [] }], completedLists: [], absentLists: [], sharedConcerns: [], acts: [{ kind: 'question', reply: 'COPY-05', support: [address('Should I double my dose?')] }], unmapped: [] };
      const native = new Ajv().compile(manifest.jsonSchema);
      expect(native(raw)).toBe(true); // Native grammar does not grant semantic acceptance.
      return validateAdaptiveGroupProposal(raw, ctx, manifest);
    });
    expect(results[1]).toEqual(results[0]);
    expect(results[1].rejectedCandidates).toMatchObject([{ role: 'reason', reason: 'unsupported-role-state' }]);
    expect(results[1].hasInterpretationGaps).toBe(true);
    expect(results[1].outcome.acts).toMatchObject([{ kind: 'question', replyId: 'COPY-05' }]);
    expect(results[1].outcome.updates).toEqual([]);
  });

  it('refuses native selection on every legacy protocol at message and trusted-validation entry', () => {
    const ctx = context('source');
    const empty = { proposal: { schema: 1, facts: [], newItems: [], completedLists: [], acts: [] } };
    for (const protocol of ['literal-disambiguation-v2', 'segment-quote-v3', 'contextual-handles-v4', 'contextual-values-v5'] as const) {
      expect(() => buildAdaptiveMessages(ctx, protocol, { nativeSchemaRevision: draft7AdaptiveGroupNativeSchemaRevision })).toThrow('native-schema-requires-group-protocol');
      expect(() => validateAdaptiveProposalResult(ctx, empty, { protocol, nativeSchemaRevision: draft7AdaptiveGroupNativeSchemaRevision })).toThrow('native-schema-requires-group-protocol');
    }
  });
});
