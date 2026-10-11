import { interpretDevelopmentSeed, createDevelopmentSeed, createMedicationCorrectionSeed } from '../../../scripts/qualification/fixtures/adaptive-canonical-development.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../clinical-core/src/domain.js';
import { nativeTopics } from '../../clinic-content/src/native-questionnaire.js';
import { projectProvisional } from '../src/provisional-projection.js';
import { createClinicContent } from '../../clinic-content/src/index.js';
import { expect, it } from 'vitest';
import { createFullReplyManifest } from '../src/adaptive-reply-full.js';
import { createDomainManifest, domainCollectionSubjects } from '../src/adaptive-reply-domain.js';
import { createGroupedExtractionManifest, encodeGroupedExtraction } from '../src/adaptive-extraction-grouped-v2.js';
import { createSparseManifest, decodeSparseExtraction, encodeSparseExtraction, type SparseWire, type SparseManifest } from '../src/adaptive-extraction-sparse.js';
import { assertClosedObjectArraySchema } from '../../../scripts/qualification/extraction-object-array-codec.mjs';
import { groupedCaseContext, groupedRepresentativeDraft } from '../../../scripts/qualification/fixtures/adaptive-extraction-grouped-v2-cases.js';
function report(attribute: string, value: any, sourceQuote: string) { return { sourceQuote, reported: [{ attribute, value }], exceptions: [], provenance: [] }; }
function empty(manifest: SparseManifest): SparseWire { return { manifestId: manifest.id, reports: [], items: [], finishedLists: [], questions: [], unmapped: [], sourceDisposition: 'represented' }; }
async function family() {
    const context = { ...groupedCaseContext('G5'), nativeRouting: {} }, full = createFullReplyManifest(context), grouped = createGroupedExtractionManifest(context);
    const manifest = await createSparseManifest(context, grouped), wire = encodeSparseExtraction(encodeGroupedExtraction(groupedRepresentativeDraft('G5', full, createDomainManifest(full)), grouped), manifest);
    return { context, full, manifest, wire, payload: JSON.parse(String(manifest.messages[1].content)) };
}
it('readable collection discriminator admits only issued family subjects and exact child attributes', async () => {
    const f = await family(), root = f.full.targets.find(t => t.topicId === 'Q10' && t.path === 'familyHistory')!;
    expect(f.payload.topics.find((t: any) => t.id === 'Q10').collections.find((c: any) => c.collection === 'Q10.familyHistory').allowedSubjects).toEqual(domainCollectionSubjects(root));
    expect(decodeSparseExtraction(f.wire, f.manifest).draft.claims.some(c => c.scope.subject === 'other')).toBe(true);
    for (const subject of ['patient', 'unclear'] as const) { const bad = structuredClone(f.wire); bad.items.find(i => i.collection === 'Q10.familyHistory')!.newItem!.subject = subject; expect(() => decodeSparseExtraction(bad, f.manifest)).toThrow(); }
    assertClosedObjectArraySchema(f.manifest.jsonSchema);
    expect(f.manifest.measurement.schemaBytes).toBeLessThanOrEqual(32000); expect(f.manifest.measurement.requestBodyBytes).toBeLessThanOrEqual(131072);
});
it('supplied values need no state enum; field exceptions stay scoped and missing stays absent', async () => {
    const base = groupedCaseContext('G5'), text = 'I want help managing my weight. I cannot recall my usual sleep duration.', source = { ...base.source, text }, context = { ...base, source, sources: [source], nativeRouting: {} }, manifest = await createSparseManifest(context), wire = empty(manifest);
    wire.reports.push({ ...report('Q01.reason', 'help managing my weight', 'I want help managing my weight.'), exceptions: [{ attribute: 'Q15.schedule', kind: 'not-recalled', sourceQuote: 'I cannot recall my usual sleep duration.' }] });
    const decoded = decodeSparseExtraction(wire, manifest);
    expect(decoded.capture.claims.map(c => [c.topicId, c.path, c.state])).toEqual([['Q01', 'reason', 'known'], ['Q15', 'schedule', 'unknown']]);
    expect(decoded.capture.claims.some(c => c.path === 'quality')).toBe(false);
    const mislabeled = structuredClone(wire); (mislabeled.reports[0].reported[0] as any).assertion = 'explicitly-unknown'; expect(() => decodeSparseExtraction(mislabeled, manifest)).toThrow();
    const duplicate = structuredClone(wire); duplicate.reports[0].exceptions.push({ attribute: 'Q01.reason', kind: 'not-recalled', sourceQuote: text }); expect(() => decodeSparseExtraction(duplicate, manifest)).toThrow('duplicate-sparse-slot');
});
it('explicit provenance can annotate only selected fields and cannot hide an invalid exception citation', async () => {
    const base = groupedCaseContext('G5'), text = 'I cannot recall my usual sleep schedule.', source = { ...base.source, text }, context = { ...base, source, sources: [source], nativeRouting: {} }, manifest = await createSparseManifest(context), wire = empty(manifest);
    wire.reports.push({ sourceQuote: text, reported: [], exceptions: [{ attribute: 'Q15.schedule', kind: 'not-recalled', sourceQuote: text }], provenance: [{ attributes: ['Q15.schedule'], evidenceQuotes: [text], predicateQuote: text, valueQuote: null, period: null, correctsSourceIds: [] }] });
    expect(decodeSparseExtraction(wire, manifest).capture.claims[0].state).toBe('unknown');
    for (const quote of ['I cannot  recall my usual sleep schedule.', 'A phrase from history']) { const bad = structuredClone(wire); bad.reports[0].exceptions[0].sourceQuote = quote; expect(() => decodeSparseExtraction(bad, manifest)).toThrow(); }
    const foreign = structuredClone(wire); foreign.reports[0].provenance[0].attributes = ['Q15.quality']; expect(() => decodeSparseExtraction(foreign, manifest)).toThrow('invalid-sparse-provenance-attribute');
    const duplicate = structuredClone(wire); duplicate.reports[0].provenance.push(structuredClone(duplicate.reports[0].provenance[0])); expect(() => decodeSparseExtraction(duplicate, manifest)).toThrow('invalid-sparse-provenance-attribute');
});
it('authored context and native when constraints are visible without a duplicated compact catalog', async () => {
    const f = await family(), text = String(f.manifest.messages[0].content);
    expect(text.startsWith('Return one readable sparse object:')).toBe(true); expect(text).not.toContain('compact grouped provisional interpretation');
    expect(text).toContain('not the speaker, diagnosing clinician or care-team addressee'); expect(text).toContain('Patient-only targets never authorize relabeling third-party');
    expect(f.payload).not.toHaveProperty('bank'); expect(f.payload).not.toHaveProperty('defaultAllowedStates');
    const support = f.payload.topics.find((t: any) => t.id === 'Q12').attributes.find((a: any) => a.attribute === 'Q12.support');
    expect(support.when).toEqual({ slotId: 'concern', condition: 'positive' }); expect(support.meaning).toContain('support');
    const presence = f.payload.topics.find((t: any) => t.id === 'Q06').attributes.find((a: any) => a.attribute === 'Q06.conditions.diabetes'); expect(presence.type).toBe('presence');
    for (const topic of f.payload.topics) { expect(topic.allowedSubjects).toEqual(['patient']); for (const attribute of [...topic.attributes, ...topic.collections.flatMap((c: any) => c.attributes)]) { expect(attribute).not.toHaveProperty('slot'); expect(attribute).not.toHaveProperty('allowedStates'); } }
});
it('named care owner remains a patient report value; a record cannot supply another clinical subject', async () => {
    const base = groupedCaseContext('G5'), text = 'My diabetes care owner is Dr Lane, and I have no current diabetes concern.', source = { ...base.source, text }, context = { ...base, responses: { ...base.responses, DM: { presented: false, applicability: 'applicable' as const, answers: {} } }, topics: [...base.topics, createClinicContent({ mentalHealth: 'phq4' }).branches.diabetes.topic], source, sources: [source], nativeRouting: {} }, manifest = await createSparseManifest(context), wire = empty(manifest);
    wire.reports.push({ ...report('DM.owner', 'Dr Lane', text), exceptions: [{ attribute: 'DM.concern', kind: 'explicit-none', sourceQuote: text }] });
    expect(decodeSparseExtraction(wire, manifest).capture.claims.find(c => c.path === 'owner')).toMatchObject({ value: 'Dr Lane', scope: { subject: 'patient' } });
    const bad = structuredClone(wire); (bad.reports[0] as any).subject = 'Dr Lane'; expect(() => decodeSparseExtraction(bad, manifest)).toThrow();
});
it('exact current-source quotes cross sentences but reject normalization, repetition, history and stale binding', async () => {
    const base = groupedCaseContext('G5'), text = 'I prefer written answers. Please use the portal.', source = { ...base.source, text }, context = { ...base, source, sources: [source], nativeRouting: {} }, manifest = await createSparseManifest(context), wire = empty(manifest);
    wire.reports.push(report('Q01.reason', text, text)); expect(decodeSparseExtraction(wire, manifest).capture.claims[0].evidence[0]).toEqual({ sourceId: source.id, start: 0, end: text.length });
    for (const quote of ['I prefer  written answers.', 'only from history']) { const bad = structuredClone(wire); bad.reports[0].sourceQuote = quote; expect(() => decodeSparseExtraction(bad, manifest)).toThrow(); }
    context.source.text += ' Changed'; expect(() => decodeSparseExtraction(wire, manifest)).toThrow('unissued-or-stale-sparse-manifest');
    const repeatedSource = { ...base.source, text: 'I want support. I want support.' }, repeated = { ...base, source: repeatedSource, sources: [repeatedSource], nativeRouting: {} }, repeatedManifest = await createSparseManifest(repeated), bad = empty(repeatedManifest); bad.reports.push(report('Q01.reason', 'support', 'I want support.')); expect(() => decodeSparseExtraction(bad, repeatedManifest)).toThrow('ambiguous-source-quote');
});
it('limited composite absence remains unresolved and cannot be encoded as explicit whole-field none', async () => {
    const context = { ...groupedCaseContext('P1'), nativeRouting: {} }, manifest = await createSparseManifest(context), payload = JSON.parse(String(manifest.messages[1].content)), wire = empty(manifest);
    const field = payload.topics.find((t: any) => t.id === 'W02').attributes.find((a: any) => a.attribute === 'W02.logistics'); expect(field.negativeScope).toBe('composite'); expect(field.allowsExplicitNone).toBeUndefined();
    wire.reports.push({ sourceQuote: context.source.text, reported: [], exceptions: [{ attribute: 'W02.logistics', kind: 'explicit-none', sourceQuote: context.source.text }], provenance: [] }); expect(() => decodeSparseExtraction(wire, manifest)).toThrow();
    wire.reports[0].exceptions[0] = { attribute: 'W02.logistics', kind: 'limited-report', sourceQuote: context.source.text, text: context.source.text };
    const decoded = decodeSparseExtraction(wire, manifest); expect(decoded.capture.claims).toEqual([]); expect(decoded.capture.gaps.some(g => g.reason === 'unsupported-target')).toBe(true);
});
it.each([87, 89, 91, 92, 93, 94])('retained AF%s output has only an explicit offline successor replay, never historical regrading', async id => {
    const publicReceipt = JSON.parse(readFileSync(`docs/implementation/evidence/DO-AF${id}.json`, 'utf8'));
    const prefixBytes = readFileSync(`infra/cloud/.private/DO-AF${id}-PREFIX.json`), retainedBytes = readFileSync(`infra/cloud/.private/DO-AF${id}-CANONICAL.json`);
    const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    expect(sha(prefixBytes)).toBe(publicReceipt.rawPrefixSha256); expect(sha(retainedBytes)).toBe(publicReceipt.privateReadbackSha256);
    const raw = JSON.parse(JSON.parse(prefixBytes.toString()).partial), retained = JSON.parse(retainedBytes.toString());
    const context = structuredClone(retained.actualContext), definitions = nativeTopics();
    // Reissue the successor's actual domain metadata; no expected patient facts are supplied.
    context.topics = context.topics.map((topic: any) => definitions.find(current => current.id === topic.id) ?? topic);
    const frozen = await import('../../../.extraction-canonical-development-v5-build/packages/clinic-api/src/adaptive-extraction-sparse.js');
    const frozenManifest = await frozen.createSparseManifest(context);
    const manifest = await createSparseManifest(context);
    if ([89, 91, 93].includes(id)) {
        expect(() => frozen.decodeSparseExtraction({ ...structuredClone(raw), m: frozenManifest.id }, frozenManifest)).toThrow();
        expect(() => decodeSparseExtraction({ ...structuredClone(raw), m: manifest.id }, manifest)).toThrow();
        expect(readFileSync(`infra/cloud/.private/DO-AF${id}-PREFIX.json`)).toEqual(prefixBytes); expect(readFileSync(`infra/cloud/.private/DO-AF${id}-CANONICAL.json`)).toEqual(retainedBytes); return;
    }
    const legacyGrouped = frozen.decodeSparseExtraction({ ...structuredClone(raw), m: frozenManifest.id }, frozenManifest).groupedWire;
    const migrate = (target: SparseManifest) => encodeSparseExtraction({ ...structuredClone(legacyGrouped), m: target.id }, target);
    // Frozen v5 decoding plus explicit representation migration is offline-only; v6 rejects raw v4/v5 shapes. Original bytes never change.
    expect(raw.m).not.toBe(manifest.id);
    expect(() => decodeSparseExtraction({ ...structuredClone(raw), m: manifest.id }, manifest)).toThrow();
    {
        const decoded = decodeSparseExtraction(migrate(manifest), manifest);
        const seedNames: Record<number, string> = { 87: 'canonical-development-d2', 92: 'canonical-development-d6a', 94: 'canonical-v4-development-d3-correction' };
        const frozenSeed = JSON.parse(readFileSync(`infra/cloud/.private/${seedNames[id]}-20261010.json`, 'utf8'));
        // Historical accepted operation authority is stale under v5. Accept the successor normally.
        const seed = id === 94
            ? await createMedicationCorrectionSeed(JSON.parse(readFileSync('infra/cloud/.private/canonical-development-d3-setup-20261010.json', 'utf8')), JSON.parse(readFileSync('infra/cloud/.private/DO-AF88-CANONICAL.json', 'utf8')).readback)
            : await createDevelopmentSeed(id === 87 ? 'D2' : 'D6A');
        expect(seed.operationId).not.toBe(frozenSeed.operationId);
        let extractError: unknown;
        const replay = await interpretDevelopmentSeed(seed, { async extract(actualContext, grouped) { try {
            expect(actualContext.source.text).toBe(context.source.text);
            const issued = await createSparseManifest(actualContext, grouped);
            return { raw: decodeSparseExtraction(migrate(issued), issued).groupedWire };
        } catch (error) { extractError = error; throw error; } } });
        expect(extractError).toBeUndefined();
        expect(replay.httpStatus).toBe(200); expect(replay.resumeHttpStatus).toBe(200); expect(replay.identityHttpStatus).toBe(200);
        expect(replay.savedDraft.adaptive?.operations[seed.operationId]?.errorCode).toBeUndefined();
        expect(replay.result.operation.status).toBe('applied');
        expect(replay.result.session.completeness).toBe('partial');
        if (id === 87) {
            expect(replay.savedDraft.adaptive!.exchange?.prompt?.text).toBe('At yesterday at 8 am, about how much coffee did you have? A cup or glass is fine.');
            expect(replay.result.session.currentPrompt?.text).toBe(replay.savedDraft.adaptive!.exchange?.prompt?.text);
            expect(replay.resumedView.currentPrompt?.text).toBe(replay.result.session.currentPrompt?.text);
        }
        if (id === 92) { expect(replay.result.session.currentPrompt?.topicId).toBe('Q02'); expect(replay.resumedView.currentPrompt?.topicId).toBe('Q02'); }
        if (id === 94) { expect(replay.result.session.currentPrompt?.id).toBe('Q08:B02'); expect(replay.resumedView.currentPrompt?.id).toBe('Q08:B02'); }

        if (id === 87) { expect(decoded.capture.claims).toHaveLength(13); expect(decoded.capture.items).toHaveLength(2); expect(decoded.capture.closures).toHaveLength(1); }
        if (id === 92) { expect(decoded.capture.claims).toHaveLength(2); expect(decoded.capture.accounting.remaining.length).toBeGreaterThan(0); expect(decoded.capture.gaps).toEqual([]); }
        if (id === 94) {
            expect(decoded.capture.claims).toHaveLength(2);
            const originalDraft = structuredClone(retained.readback.savedDraft), before = canonicalJson(originalDraft), projection = projectProvisional(originalDraft, context.topics);
            const vitamin = projection.claims.filter(claim => claim.path.endsWith('.strength') && claim.value === '1000 IU');
            expect(vitamin).toHaveLength(2); expect(vitamin.every(claim => claim.status === 'proposed')).toBe(true); expect(vitamin.flatMap(claim => claim.correctsSourceIds)).toEqual([]);
            expect(projection.claims.find(claim => claim.value === '850 mg')?.status).toBe('superseded'); expect(projection.claims.find(claim => claim.value === '500 mg')?.status).toBe('proposed');
            expect(projection.creditedSourceIds.size).toBe(0); expect(canonicalJson(originalDraft)).toBe(before);
        }
    }
    expect(readFileSync(`infra/cloud/.private/DO-AF${id}-PREFIX.json`)).toEqual(prefixBytes); expect(readFileSync(`infra/cloud/.private/DO-AF${id}-CANONICAL.json`)).toEqual(retainedBytes);
});


import { resolveAnchoredCurrentQuote } from '../src/adaptive-source.js';
import { createSourceReportsManifest, decodeSourceReports, createFocusedMappingManifest, retainFocusedResult, admitFocusedResult } from '../src/adaptive-extraction-focused.js';
it('anchored subquotes resolve exact spans only inside a unique immutable current record', async () => {
    const text = 'At breakfast I had oatmeal. At lunch I had a sandwich.';
    const old = { ...groupedCaseContext('G3'), nativeRouting: {}, sourceQuoteProtocol: 'unique-anchor-v1' as const };
    const source = { ...old.source, text }, context = { ...old, source, sources: [source] };
    const anchor = 'At breakfast I had oatmeal.';
    expect(resolveAnchoredCurrentQuote(context, anchor, 'had')).toEqual({ sourceId: source.id, start: text.indexOf('had'), end: text.indexOf('had') + 3 });
    expect(() => resolveAnchoredCurrentQuote(context, text, 'had')).toThrow('ambiguous-source-quote');
    expect(() => resolveAnchoredCurrentQuote(context, anchor, 'sandwich')).toThrow('source-quote-not-in-anchor');
    expect(() => resolveAnchoredCurrentQuote(context, anchor.toLowerCase(), 'had')).toThrow('source-quote-not-found');
    const repeated = { ...context, source: { ...source, text: `${anchor} ${anchor}` }, sources: [{ ...source, text: `${anchor} ${anchor}` }] };
    expect(() => resolveAnchoredCurrentQuote(repeated, anchor, 'had')).toThrow('ambiguous-source-quote');
});
it('unchanged AF122 raw can use explicitly versioned anchored provenance, without fixing its omitted closure or regrading history', async () => {
    const before = readFileSync('infra/cloud/.private/DO-AF122-PREFIX.json'), receipt = JSON.parse(readFileSync('infra/cloud/.private/DO-AF122-CANONICAL.json', 'utf8'));
    const context = { ...receipt.actualContext, sourceQuoteProtocol: 'unique-anchor-v1' as const };
    const raw = JSON.parse(JSON.parse(before.toString()).partial), manifest = await createSparseManifest(context, undefined, { anchoredQuotes: true, strictAnnotationAttributes: true, focusedTopicIds: ['Q11'] });
    expect(manifest.id).toBe(raw.manifestId);
    const decoded = decodeSparseExtraction(raw, manifest);
    expect(decoded.capture.claims).toHaveLength(13);
    expect(decoded.capture.closures).toHaveLength(0); // Historical whole-case failure remains.
    expect(readFileSync('infra/cloud/.private/DO-AF122-PREFIX.json')).toEqual(before);
});
it('focused annotation enums exclude root/global/foreign child addresses before the decoder guard', async () => {
    const context = { ...groupedCaseContext('G3'), nativeRouting: {}, sourceQuoteProtocol: 'unique-anchor-v1' as const }, manifest = await createSparseManifest(context, undefined, { anchoredQuotes: true, strictAnnotationAttributes: true, focusedTopicIds: ['Q08'] });
    const wire = empty(manifest);
    wire.items.push({ collection: 'Q08.medicines', newItem: { subject: 'patient', entity: 'medicine', sourceQuotes: [context.source.text] }, existingItem: null, sourceQuote: context.source.text, reported: [{ attribute: 'name', value: 'medicine' }], exceptions: [], provenance: [{ attributes: ['Q08.medicines.name'], evidenceQuotes: [context.source.text], predicateQuote: context.source.text, valueQuote: context.source.text, period: null, correctsSourceIds: [] }] });
    expect(() => decodeSparseExtraction(wire, manifest)).toThrow();
    wire.items[0].provenance[0].attributes = ['strength'];
    expect(() => decodeSparseExtraction(wire, manifest)).toThrow('invalid-sparse-provenance-attribute');
});
it('source report suggestions and dropped reports remain descriptive inventory with exact source quotes', () => {
    const context = { ...groupedCaseContext('G3'), nativeRouting: {} }, manifest = createSourceReportsManifest(context), payload = JSON.parse(String(manifest.messages[1].content));
    const raw = { reports: [{ quote: context.source.text, meaning: 'Unmapped supplied concept', suggestedTopics: [] }], unresolved: [] };
    expect(decodeSourceReports(raw, manifest).reports).toHaveLength(1);
    raw.reports[0].quote = 'invented history'; expect(() => decodeSourceReports(raw, manifest)).toThrow('source-quote-not-found');
    expect(payload.topics.every((topic: any) => Object.keys(topic).length === 1)).toBe(true);
    expect(JSON.stringify(manifest.jsonSchema)).not.toContain('assertion');
});


import { validateFocusedProviderSchema } from '../../../scripts/qualification/qualify-extraction-canonical-development.mjs';
it('zero-choice provider arrays are valid draft7 and admit only empty values', async () => {
    const base = { ...groupedCaseContext('G3'), nativeRouting: {} };
    const manifest = await createSparseManifest(base, undefined, { focusedTopicIds: ['Q01'], strictAnnotationAttributes: true });
    const validate = validateFocusedProviderSchema(manifest.jsonSchema);
    const wire = empty(manifest); expect(validate(wire)).toBe(true);
    expect(validate({ ...wire, items: ['invented item'] })).toBe(false);
    expect(validate({ ...wire, finishedLists: [{collection:'Q08.medicines',sourceQuotes:[base.source.text]}] })).toBe(false);
    const zero = { ...base, topics: [], responses: {}, displayed: undefined };
    const source = createSourceReportsManifest(zero), sourceValidate = validateFocusedProviderSchema(source.jsonSchema);
    expect(sourceValidate({reports:[{quote:zero.source.text,meaning:'Retained words',suggestedTopics:[]}],unresolved:[]})).toBe(true);
    expect(sourceValidate({reports:[{quote:zero.source.text,meaning:'Retained words',suggestedTopics:['Invented topic']}],unresolved:[]})).toBe(false);
    await expect(createSparseManifest(zero, undefined, { focusedTopicIds: [], strictAnnotationAttributes: true })).rejects.toThrow('full-reply-no-issued-action');
    const emptyManifest = await createSparseManifest(base, undefined, { focusedTopicIds: [], strictAnnotationAttributes: true });
    const emptyValidate = validateFocusedProviderSchema(emptyManifest.jsonSchema), emptyWire = empty(emptyManifest);
    expect(emptyValidate(emptyWire)).toBe(true);
    for(const key of ['reports','items','finishedLists'] as const) expect(emptyValidate({...emptyWire,[key]:['invented']})).toBe(false);
});
it('the immutable actual AF138 schema fails draft7 while actual AF130 mechanically derives a valid successor mapper', async () => {
    const actual = JSON.parse(readFileSync('infra/cloud/.private/DO-AF138-REQUEST.json','utf8'));
    expect(() => validateFocusedProviderSchema(JSON.parse(actual.body).response_format.json_schema.schema)).toThrow('invalid-draft7-provider-schema');
    const frozen = JSON.parse(readFileSync('infra/cloud/.private/canonical-focused-d1-source-request-20261010.json','utf8'));
    const rawBytes = readFileSync('infra/cloud/.private/DO-AF130-PREFIX.json'), raw = JSON.parse(JSON.parse(rawBytes.toString()).partial);
    const source = createSourceReportsManifest(frozen.context), mapping = await createFocusedMappingManifest(frozen.context, raw, source);
    expect(() => validateFocusedProviderSchema(mapping.sparse.jsonSchema)).not.toThrow();
    expect(JSON.parse(mapping.sparse.messages[1].content).sourceReports.reports).toEqual(raw.reports);
    expect(readFileSync('infra/cloud/.private/DO-AF130-PREFIX.json')).toEqual(rawBytes);
});
