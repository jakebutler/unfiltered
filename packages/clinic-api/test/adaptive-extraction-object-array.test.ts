import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../clinical-core/src/domain.js';
import { getNativeQuestionnaireDefinition } from '../../clinic-content/src/native-questionnaire.js';
import { createFullReplyManifest } from '../src/adaptive-reply-full.js';
import { createDomainManifest, decodeDomainDraft } from '../src/adaptive-reply-domain.js';
import { createGroupedExtractionManifest, encodeGroupedExtraction, compileGroupedExtraction } from '../src/adaptive-extraction-grouped-v2.js';
import { createObjectArrayManifest, encodeObjectArrayExtraction, decodeObjectArrayExtraction } from '../../../scripts/qualification/extraction-object-array-manifest.js';
import { objectArrayCaseContext, objectArrayCaseReadback } from '../../../scripts/qualification/fixtures/adaptive-extraction-object-array-readback.js';
import { groupedRepresentativeDraft } from '../../../scripts/qualification/fixtures/adaptive-extraction-grouped-v2-cases.js';
import { assertClosedObjectArraySchema } from '../../../scripts/qualification/extraction-object-array-codec.mjs';
async function fixture(id = 'G3') {
  const context = objectArrayCaseContext(id), full = createFullReplyManifest(context), domain = createDomainManifest(full), authored = groupedRepresentativeDraft(id, full, domain), grouped = createGroupedExtractionManifest(context), m = await createObjectArrayManifest(context, grouped), g = encodeGroupedExtraction(authored, grouped), wire = encodeObjectArrayExtraction(g, m);
  return { context, full, authored, domain, grouped, m, g, wire };
}
const sorted = (entries: unknown[]) => entries.map(canonicalJson).sort();
describe('isolated closed object-array extraction with unchanged compiler', () => {
  it.each(['G3', 'P1', 'G7'])('%s preserves authored typed semantics, source accounting and current native binding', async (id) => {
    const f = await fixture(id), decoded = decodeObjectArrayExtraction(f.wire, f.m), original = decodeDomainDraft(f.authored, f.domain), same = compileGroupedExtraction(f.g, f.grouped);
    expect(decoded.groupedWire).toEqual(f.g);
    expect(decoded.capture).toEqual(same.capture);
    for (const key of ['claims', 'items', 'closures'] as const) expect(sorted(decoded.draft[key])).toEqual(sorted(original[key]));
    expect(decoded.draft.residual).toEqual(original.residual);
    expect(decoded.draft.accounting).toEqual(original.accounting);
    expect(f.m.nativeDefinition).toEqual((await getNativeQuestionnaireDefinition()).binding);
    expect(f.m.messages[1]).toEqual(f.grouped.messages[1]);
    assertClosedObjectArraySchema(f.m.jsonSchema);
    expect(Math.ceil(Buffer.byteLength(JSON.stringify(f.wire)) * .5)).toBeLessThanOrEqual(400);
    const read = await objectArrayCaseReadback(id, { raw: f.wire });
    const op = read.savedDraft.adaptive!.operations[read.savedDraft.adaptive!.activeOperationId!];
    expect(op.status).toBe('applied');
    expect(op.stream?.capture).toBe('saved');
    expect(read.projection.creditedSourceIds).toEqual([]);
    expect(read.policyQualified).toBe(false);
    expect(read.preview.confirmation.submission.questionnaireCapture?.definition).toEqual(f.m.nativeDefinition);
    const nativeTopics = read.preview.confirmation.submission.questionnaireCapture!.topics;
    expect(read.savedDraft.topics).toEqual({});
    expect(Object.keys(nativeTopics).sort()).toEqual(['DM', 'GI', 'SLEEP']);
    expect(Object.values(nativeTopics).every(topic => Object.keys(topic.answers).length === 0 && topic.applicability === 'unknown')).toBe(true);
    expect(read.nativeMappingQualified).toBe(false);
    if (id === 'P1') {
      expect(JSON.stringify(read.projection.responses.W02)).toContain('October 20, 2026 at 9 am Pacific');
      expect(read.projection.responses.W02?.answers.logistics?.state).not.toBe('negative');
      // Historical Q02 continuation has no trusted relevance in this fixture.
      // The current native scenario guard must withhold it, not invent relevance.
      expect(read.timings.nextQuestionSavedMs).toBeNull();
      expect(read.savedDraft.adaptive!.exchange!.status).toBe('interpretation-review');
      expect(read.savedDraft.adaptive!.exchange!.prompt).toBeUndefined();
      return;
    }
    expect(read.timings.nextQuestionSavedMs).not.toBeNull();
    const prompt = read.savedDraft.adaptive!.exchange!.prompt!;
    const supplied = read.projection.claims.filter(c => c.status === 'proposed');
    expect(prompt.targetPaths.some(path => supplied.some(c => c.topicId === prompt.topicId && c.path === path))).toBe(false);
    if (id === 'G3') {
      expect(decoded.draft.claims).toHaveLength(13);
      expect(decoded.draft.items).toHaveLength(2);
      expect(decoded.draft.closures).toHaveLength(1);
      expect(prompt.topicId).toBe('Q11');
      expect(prompt.targetPaths.join(' ')).not.toMatch(/foodAmounts|drinkAdditions/);
    }
    if (id === 'G7') {
      expect(JSON.stringify(read.projection.responses.Q08)).toContain('500 mg');
      expect(JSON.stringify(read.projection.responses.Q08)).toContain('1000 IU');
      expect(prompt.text).toContain('Metformin');
      expect(prompt.targetPaths.join(' ')).not.toContain('strength');
    }
  });
  it('rejects strict shape, duplicates, cardinality and missing identity rather than repairing', async () => {
    const f = await fixture(), mutations: Array<(raw: any) => void> = [
      r => { r.extra = true; }, r => { r.t[0].extra = true; }, r => { delete r.t[0].g; },
      r => { r.t.push(r.t[0]); }, r => { r.t[0].g[0].v.push('invented'); },
      r => { r.t[0].g[0].f.push('day'); r.t[0].g[0].v.push('invented'); },
      r => { r.t[0].l[0].i[0].n = null; }, r => { r.t[0].l[0].i[0].x = 'i0'; },
      r => { r.t[0].g[0].s = 's999'; }, r => { r.t[0].g[0].s = { s: 's0', a: 1, b: 1 }; },
      r => { r.t[0].g[0].s = { s: 's0', a: 0, b: 99999 }; }, r => { r.t[0].g[0].v = [27]; },
      r => { r.t[0].g[0].f = ['unsupportedField']; },
    ];
    for (const mutate of mutations) { const raw = structuredClone(f.wire); mutate(raw); expect(() => decodeObjectArrayExtraction(raw, f.m)).toThrow(); }
  });
  it('malformed and invalid source/field outputs cannot save a next question', async () => {
    const f = await fixture();
    for (const mutate of [(r: any) => { r.extra = true; }, (r: any) => { r.t[0].g[0].s = 's999'; }, (r: any) => { r.t[0].g[0].v = [27]; }]) {
      const raw = structuredClone(f.wire); mutate(raw);
      const read = await objectArrayCaseReadback('G3', { raw });
      expect(read.timings.nextQuestionSavedMs).toBeNull();
      expect(read.savedDraft.adaptive!.exchange?.prompt).toBeUndefined();
      expect(read.savedDraft.adaptive!.operations[read.savedDraft.adaptive!.activeOperationId!].status).not.toBe('applied');
    }
  });
  it('complete source accounting and effective conflicts remain navigation gates', async () => {
    const p = await fixture('P1'), omitted: any = structuredClone(p.wire);
    omitted.t[0].g = omitted.t[0].g.filter((g: any) => g.k !== 'k');
    const uncovered = await objectArrayCaseReadback('P1', { raw: omitted });
    expect(uncovered.timings.captureSavedMs).not.toBeNull();
    expect(uncovered.timings.nextQuestionSavedMs).toBeNull();
    expect(uncovered.savedDraft.adaptive!.exchange?.status).toBe('interpretation-review');
    const g = await fixture('G7'), conflict: any = structuredClone(g.wire), item = conflict.t[0].l[0].i[0];
    item.x = null; item.n = { s: 'patient', e: 'Metformin', r: 's0' };
    const rejected = await objectArrayCaseReadback('G7', { raw: conflict });
    expect(rejected.timings.nextQuestionSavedMs).toBeNull();
    expect(rejected.projection.gaps.some(g => g.reason === 'conflict')).toBe(true);
  });
  it('stale context and forged manifests fail before interpreting output', async () => {
    const f = await fixture();
    expect(() => decodeObjectArrayExtraction(f.wire, { ...f.m })).toThrow('unissued-or-stale-object-array-manifest');
    f.context.source.text += ' changed';
    expect(() => decodeObjectArrayExtraction(f.wire, f.m)).toThrow('unissued-or-stale-object-array-manifest');
  });
});
