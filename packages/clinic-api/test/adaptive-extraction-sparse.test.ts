import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../clinical-core/src/domain.js';
import { createFullReplyManifest } from '../src/adaptive-reply-full.js';
import { createDomainManifest, decodeDomainDraft } from '../src/adaptive-reply-domain.js';
import { createGroupedExtractionManifest, encodeGroupedExtraction } from '../src/adaptive-extraction-grouped-v2.js';
import { createSparseManifest, encodeSparseExtraction, decodeSparseExtraction, sparseOutputBudget } from '../../../scripts/qualification/extraction-sparse-manifest.js';
import { sparseCaseContext, sparseCaseReadback } from '../../../scripts/qualification/fixtures/adaptive-extraction-sparse-readback.js';
import { groupedRepresentativeDraft } from '../../../scripts/qualification/fixtures/adaptive-extraction-grouped-v2-cases.js';
import { assertClosedObjectArraySchema } from '../../../scripts/qualification/extraction-object-array-codec.mjs';
async function fixture(id = 'G3', context = sparseCaseContext(id)) {
  const full = createFullReplyManifest(context), domain = createDomainManifest(full), authored = groupedRepresentativeDraft(id, full, domain), grouped = createGroupedExtractionManifest(context), m = await createSparseManifest(context, grouped), g = encodeGroupedExtraction(authored, grouped), wire = encodeSparseExtraction(g, m);
  return { context, full, domain, authored, m, g, wire };
}
const sorted = (x: unknown[]) => x.map(canonicalJson).sort();
describe('sparse observed facts and unchanged native planning', () => {
  it.each(['G3', 'P1', 'G7'])('%s preserves authored facts, exact provenance, identities and useful-question boundary', async id => {
    const f = await fixture(id), decoded = decodeSparseExtraction(f.wire, f.m), original = decodeDomainDraft(f.authored, f.domain);
    for (const key of ['claims', 'items', 'closures'] as const) expect(sorted(decoded.draft[key])).toEqual(sorted(original[key]));
    expect(decoded.draft.residual).toEqual(original.residual); expect(decoded.draft.accounting).toEqual(original.accounting);
    assertClosedObjectArraySchema(f.m.jsonSchema);
    expect('topics' in f.wire).toBe(false); expect(f.wire.i.every(i => i.f.length > 0)).toBe(true);
    const payload = JSON.parse(String(f.m.messages[1].content));
    expect(payload.topics.flatMap((t: any) => t.fields).map((t: any) => t.slot).sort()).toEqual(f.full.targets.map(t => t.id).sort());
    const read = await sparseCaseReadback(id, { raw: f.wire });
    expect(read.savedDraft.adaptive!.operations[read.savedDraft.adaptive!.activeOperationId!].status).toBe('applied');
    expect(read.projection.creditedSourceIds).toEqual([]); expect(read.defaultEnabled).toBe(false); expect(read.nativeMappingQualified).toBe(false);
    expect(read.timings.nextQuestionSavedMs === null).toBe(id === 'P1');
    if (id === 'P1') expect(read.savedDraft.adaptive!.exchange!.prompt).toBeUndefined();
    else {
      const prompt = read.savedDraft.adaptive!.exchange!.prompt!;
      const supplied = read.projection.claims.filter(c => c.status === 'proposed');
      expect(prompt.targetPaths.some(path => supplied.some(c => c.topicId === prompt.topicId && c.path === path))).toBe(false);
      if (id === 'G3') { expect(decoded.draft.claims).toHaveLength(13); expect(decoded.draft.items).toHaveLength(2); expect(decoded.draft.closures).toHaveLength(1); expect(prompt.targetPaths.join(' ')).not.toMatch(/foodAmounts|drinkAdditions/); }
      if (id === 'G7') { expect(prompt.text).toContain('Metformin'); expect(prompt.targetPaths.join(' ')).not.toContain('strength'); }
    }
    const budget = sparseOutputBudget(f.wire);
    expect(budget.maxOutputTokens).toBeGreaterThan(budget.conservativeOutputTokens);
    if (id === 'G3') expect(budget.maxOutputTokens).toBeGreaterThan(512);
  });
  it('rejects scalar/list placement, cross-item slots, duplicate identities and empty scaffolds', async () => {
    const g = await fixture(), g7 = await fixture('G7');
    const mutations: Array<(r: any) => void> = [
      r => { r.topics = {}; }, r => { r.i[0].f = []; }, r => { r.f.push({ ...r.i[0].f[0], o: 'patient' }); },
      r => { r.i[0].f[0].f = r.f[0].f; }, r => { r.i[0].n = null; }, r => { r.i[0].x = 'i0'; },
      r => { r.i.push(structuredClone(r.i[0])); }, r => { r.i[0].f.push(structuredClone(r.i[0].f[0])); },
      r => { r.f.push(structuredClone(r.f[0])); }, r => { r.c.push(structuredClone(r.c[0])); },
      r => { r.f[0].f = 't99999'; }, r => { r.f[0].k = 'u'; }, r => { r.f[0].v = null; },
    ];
    for (const mutate of mutations) { const raw = structuredClone(g.wire); mutate(raw); expect(() => decodeSparseExtraction(raw, g.m)).toThrow(); }
    const wrong = structuredClone(g7.wire); wrong.i[0].f[0].f = wrong.i[1].f[0].f;
    expect(() => decodeSparseExtraction(wrong, g7.m)).toThrow('sparse-item-slot-mismatch');
  });
  it('derives exact spans without arithmetic, rejects quote drift and ambiguity inside the issued segment', async () => {
    const f = await fixture(), payload = JSON.parse(String(f.m.messages[1].content)), source = payload.bank[0];
    const raw = structuredClone(f.wire); raw.i[0].f[0].s = { s: source.id, q: source.quote };
    expect(decodeSparseExtraction(raw, f.m).capture.claims.some(c => c.evidence.some(e => f.context.source.text.slice(e.start, e.end) === source.quote))).toBe(true);
    for (const q of ['invented quote', source.quote + ' ', '']) {
      raw.i[0].f[0].s = { s: source.id, q }; expect(() => decodeSparseExtraction(raw, f.m)).toThrow();
    }
    const context = sparseCaseContext('G3');
    // Same words in different segments are valid addresses; repeated within one segment need context.
    context.source.text = 'Tea and tea and tea. Tea.'; context.sources = [context.source];
    const m = await createSparseManifest(context), bank = JSON.parse(String(m.messages[1].content)).bank;
    const slot = createFullReplyManifest(context).targets.find(t => t.topicId === 'Q11' && t.path === 'typicality')!.id;
    const wire: any = { m: m.id, f: [{ f: slot, o: 'patient', k: 'k', s: { s: bank[0].id, q: 'tea' }, v: 'Tea' }], i: [], c: [], e: [], r: [], d: 'partially-represented' };
    expect(() => decodeSparseExtraction(wire, m)).toThrow('ambiguous-sparse-quote');
    wire.f[0].s = { s: bank[1].id, q: 'Tea' };
    expect(() => decodeSparseExtraction(wire, m)).not.toThrow();
  });
  it('omission and wrong-source meaning cannot gain complete coverage or semantic credit', async () => {
    const f = await fixture(), omitted = structuredClone(f.wire); omitted.i[1].f = omitted.i[1].f.filter(x => x.k !== 'k');
    const read = await sparseCaseReadback('G3', { raw: omitted });
    expect(read.timings.nextQuestionSavedMs).toBeNull(); expect(read.savedDraft.adaptive!.exchange?.prompt).toBeUndefined();
    const wrong = structuredClone(f.wire); const amount = wrong.i[1].f.find(x => x.v === 'a glass')!; amount.s = 's0';
    // Exact valid quotes cannot establish semantic fidelity. The authored oracle detects this valid-address error.
    const decoded = decodeSparseExtraction(wrong, f.m);
    expect(sorted(decoded.draft.claims)).not.toEqual(sorted(decodeSparseExtraction(f.wire, f.m).draft.claims));
    expect(decoded.capture.claims.every(c => c.status === 'proposed')).toBe(true);
  });
  it('unknown is retained only on its fact; correction scope and ownership remain enforced', async () => {
    const f = await fixture();
    expect(f.wire.i[0].f.some(x => x.k === 'u')).toBe(true);
    const decoded = decodeSparseExtraction(f.wire, f.m);
    expect(decoded.draft.claims.filter(c => c.state === 'unknown')).toHaveLength(2);
    const g = await fixture('G7'), recreated = structuredClone(g.wire);
    recreated.i[0].n = { s: 'patient', e: 'Metformin', r: 's0' }; recreated.i[0].x = null;
    expect(() => decodeSparseExtraction(recreated, g.m)).toThrow('sparse-item-slot-mismatch');
    const other = structuredClone(f.wire); other.i[0].n!.s = 'other';
    expect(() => decodeSparseExtraction(other, f.m)).toThrow('sparse-nonpatient-list-closure');
    other.c = [];
    // Current domain admission rejects other-owned patient item identities before capture.
    expect(() => decodeSparseExtraction(other, f.m)).toThrow();
  });
  it('mixed scalar owners fail as a whole output and cannot save a next question', async () => {
    const f = await fixture(), mixed = structuredClone(f.wire);
    mixed.f[1].o = { s: 'other', e: 'father' };
    expect(() => decodeSparseExtraction(mixed, f.m)).toThrow('sparse-topic-owner-conflict');
    const read = await sparseCaseReadback('G3', { raw: mixed });
    expect(read.timings.captureSavedMs).toBeNull(); expect(read.timings.nextQuestionSavedMs).toBeNull();
    expect(read.savedDraft.adaptive!.operations[read.savedDraft.adaptive!.activeOperationId!].status).not.toBe('applied');
    expect(read.projection.creditedSourceIds).toEqual([]);
  });
  it('keeps volunteered cross-topic capture while the displayed topic stays Q11', async () => {
    const context = sparseCaseContext('G3'); context.source.text += ' I sleep six hours nightly.';
    const f = await fixture('G3', context), payload = JSON.parse(String(f.m.messages[1].content));
    const slot = f.full.targets.find(t => t.topicId === 'Q15' && t.path === 'schedule')!.id;
    const statement = payload.bank.find((s: any) => s.quote === 'I sleep six hours nightly.');
    const omitted = decodeSparseExtraction(f.wire, f.m); expect(omitted.capture.accounting.remaining.length).toBeGreaterThan(0);
    const wire = structuredClone(f.wire); wire.f.push({ f: slot, o: 'patient', k: 'k', s: statement.id, v: 'six hours nightly' });
    const complete = decodeSparseExtraction(wire, f.m);
    expect(complete.capture.accounting.remaining).toEqual([]);
    expect(complete.draft.claims.some(c => c.targetId === slot)).toBe(true);
    expect(context.displayed!.topicId).toBe('Q11');
  });
  it('forged manifests, changed source and offset-based quotes are rejected', async () => {
    const f = await fixture(); expect(() => decodeSparseExtraction(f.wire, { ...f.m })).toThrow('unissued-or-stale-sparse-manifest');
    const offsets = structuredClone(f.wire) as any; offsets.f[0].s = { s: 's0', a: 0, b: 44 }; expect(() => decodeSparseExtraction(offsets, f.m)).toThrow();
    f.context.source.text += ' changed'; expect(() => decodeSparseExtraction(f.wire, f.m)).toThrow('unissued-or-stale-sparse-manifest');
  });
});
