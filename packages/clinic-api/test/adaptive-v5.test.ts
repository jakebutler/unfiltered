import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createAdaptiveValueManifest, resolveAdaptiveValueProposal, valueEvidenceProtocol, adaptiveValueGuidance, type AdaptiveValueManifest } from '../src/adaptive-value-manifest.js';
import { adaptiveProposalSchema, applyValidatedTurn, validateAdaptiveProposal, type AdaptiveContext } from '../src/adaptive-validation.js';
import { createAdaptiveManifest, resolveContextualAdaptiveProposal } from '../src/adaptive-manifest.js';
import { adaptiveGuidance } from '../src/adaptive-guidance.js';
import { buildAdaptiveMessages, createDigitalOceanProposer, prepareAdaptiveRequest } from '../src/adaptive.js';
import { eligibleAdaptiveProbes, selectAdaptiveDialogue } from '../src/dialogue.js';
import { evaluateTopic } from '../../clinic-content/src/index.js';
import { DO_ENDPOINT } from '../../clinical-core/src/digitalocean.js';
import { context, register, withPrior } from './fixtures/adaptive.js';

interface Descriptor { ref: string; path: string; label: string; valueShape: string; states: string[]; }
interface Projection { sourceSegments: string[][]; topics: { topicId: string; targets: Descriptor[]; collections: { ref: string; path: string; fields: Descriptor[] }[] }[]; replies: { id: string; ref: string }[]; }
const projection = (m: AdaptiveValueManifest) => Object.assign({}, ...m.payloads) as Projection;
const wire = (m: AdaptiveValueManifest, rest: Record<string, unknown> = {}) => ({ schema: 5, context: m.id, facts: [], newItems: [], completedLists: [], interruptions: [], unmapped: [], ...rest });
function address(m: AdaptiveValueManifest, quote: string, occurrence = 0, kind = 'sentence') {
  const rows = projection(m).sourceSegments.filter(row => row[1] === kind && row[2].includes(quote));
  if (!rows[occurrence]) throw new Error(`Missing V5 fixture quote: ${quote}`);
  return { source: rows[occurrence][0], quote };
}
function fact(m: AdaptiveValueManifest, topicId: string, path: string, quote: string, support = quote, state = 'known', operation = 'assert', occurrence = 0) {
  const ref = projection(m).topics.find(topic => topic.topicId === topicId)!.targets.find(target => target.path === path)!.ref;
  return { target: ref, state, value: state === 'known' ? address(m, quote, occurrence) : null, evidence: [address(m, support, occurrence)], operation };
}
type Child = [path: string, quote: string, support?: string, state?: string, occurrence?: number];
function item(m: AdaptiveValueManifest, topicId: string, path: string, fields: Child[]) {
  const collection = projection(m).topics.find(topic => topic.topicId === topicId)!.collections.find(collection => collection.path === path)!;
  return { collection: collection.ref, fields: fields.map(([path, quote, support = quote, state = 'known', occurrence = 0]) => ({ field: collection.fields.find(field => field.path === path)!.ref, state, value: state === 'known' ? address(m, quote, occurrence) : null, evidence: [address(m, support, occurrence)] })) };
}
const apply = (ctx: AdaptiveContext, m: AdaptiveValueManifest, raw: unknown) => applyValidatedTurn(ctx, validateAdaptiveProposal(resolveAdaptiveValueProposal(raw, ctx, m), ctx));
const known = (value: string) => ({ state: 'known' as const, value, sourceIds: ['prior'] });
function medicines(text: string) {
  return withPrior(context(text, ['Q08']), 'Q08', { medicines: { state: 'known', sourceIds: ['prior'], complete: true, items: [
    { id: 'allergy', answers: { name: known('Cetirizine'), strength: known('5 mg') } },
    { id: 'iron', answers: { name: known('Iron'), strength: known('18 mg') } },
  ] } });
}
const config = { endpoint: DO_ENDPOINT, apiKey: 'offline-only', model: 'qwen3.8-max' as const, timeoutMs: 15000, maxOutputTokens: 4096, maxRequestBytes: 60000 };

describe('V5 distinct value/support boundary', () => {
  it('rejects values unsupported by one complete support span, including union coverage', () => {
    const ctx = context('I take Cetirizine 10 mg.', ['Q08']), m = createAdaptiveValueManifest(ctx);
    const medicine = item(m, 'Q08', 'medicines', [['name', 'Cetirizine'], ['strength', '10 mg']]);
    medicine.fields[1].evidence = [address(m, '10'), address(m, 'mg')];
    expect(() => apply(ctx, m, wire(m, { newItems: [medicine] }))).toThrow('unsupported-value-span');
    expect(ctx.responses).toEqual({});
  });
  it('rejects multiple provider value spans and value/state mismatches without changing schema 1', () => {
    const ctx = context('I want more energy. I do not know my childhood weight.', ['Q01', 'Q03']), m = createAdaptiveValueManifest(ctx);
    const selected = fact(m, 'Q01', 'priority', 'more energy');
    expect(() => apply(ctx, m, wire(m, { facts: [{ ...selected, value: [selected.value, selected.value] }] }))).toThrow('invalid-contextual-value-proposal');
    expect(() => apply(ctx, m, wire(m, { facts: [{ ...selected, value: null }] }))).toThrow('invalid-contextual-value-proposal');
    const canonical = resolveAdaptiveValueProposal(wire(m, { facts: [selected] }), ctx, m);
    expect(adaptiveProposalSchema.safeParse({ ...canonical, schema: 1 }).success).toBe(false);
    expect(() => validateAdaptiveProposal({ ...canonical, facts: [{ ...canonical.facts[0], state: 'unknown' }] }, ctx)).toThrow('invalid-value-proposal');
  });
  it('rejects stale/copied manifests, foreign quote segments and whole-envelope invalid evidence', () => {
    const ctx = context('I want more energy. Easier walking.', ['Q01']), m = createAdaptiveValueManifest(ctx);
    expect(() => resolveAdaptiveValueProposal(wire(m), ctx, structuredClone(m))).toThrow('stale-adaptive-manifest');
    const changed = { ...ctx, binding: { ...ctx.binding, patient: 'Patient/other' } };
    expect(() => resolveAdaptiveValueProposal(wire(m), changed, m)).toThrow('stale-adaptive-manifest');
    const selected = fact(m, 'Q01', 'priority', 'Easier walking');
    selected.value!.source = projection(m).sourceSegments[0][0];
    expect(() => apply(ctx, m, wire(m, { facts: [selected] }))).toThrow('source-quote-not-found');
    expect(() => apply(ctx, m, wire(m, { facts: [fact(m, 'Q01', 'priority', 'more energy')], unmapped: [{ evidence: [{ source: 's999', quote: 'walking' }], reason: 'ambiguous' }] }))).toThrow('invalid-contextual-value-proposal');
    expect(ctx.responses).toEqual({});
  });
  it('preserves UTF-16 addressing and refuses split surrogate values without normalizing source text', () => {
    const ctx = context('  🙂 Café is my priority.\n', ['Q01']), m = createAdaptiveValueManifest(ctx);
    const support = '  🙂 Café is my priority.';
    const result = apply(ctx, m, wire(m, { facts: [fact(m, 'Q01', 'priority', '🙂 Café', support)] }));
    expect(result.provenance[0].valueEvidence).toEqual({ sourceId: ctx.source.id, start: 2, end: 9 });
    expect(result.provenance[0].supportSourceText).toEqual([support]);
    expect(ctx.source.text.slice(result.provenance[0].evidence[0].start, result.provenance[0].evidence[0].end)).toBe('🙂 Café');
    expect(() => apply(ctx, m, wire(m, { facts: [fact(m, 'Q01', 'priority', '\ud83d', support)] }))).toThrow('invalid-source-quote');
    expect(ctx.source.text).toBe('  🙂 Café is my priority.\n');
  });
  it('addresses repeated strengths in separate segments and rejects ambiguity within one segment', () => {
    const ctx = context('Cetirizine 10 mg. Iron 10 mg.', ['Q08']), m = createAdaptiveValueManifest(ctx);
    const result = apply(ctx, m, wire(m, { newItems: [
      item(m, 'Q08', 'medicines', [['name', 'Cetirizine'], ['strength', '10 mg', 'Cetirizine 10 mg.']]),
      item(m, 'Q08', 'medicines', [['name', 'Iron'], ['strength', '10 mg', '10 mg', 'known', 1]]),
    ] }));
    const saved = result.responses.Q08?.answers.medicines;
    expect(saved?.state === 'known' && saved.items?.map(entry => entry.answers.strength)).toMatchObject([{ value: '10 mg' }, { value: '10 mg' }]);
    const ambiguous = context('Cetirizine 10 mg and Iron 10 mg.', ['Q08']), am = createAdaptiveValueManifest(ambiguous);
    expect(() => apply(ambiguous, am, wire(am, { newItems: [item(am, 'Q08', 'medicines', [['name', 'Cetirizine'], ['strength', '10 mg', ambiguous.source.text]])] }))).toThrow('ambiguous-source-quote');
  });
  it('keeps numeric/composite height transforms and unit attachment on selected values', () => {
    const ctx = context('My height is six feet one inch. The scale read 91.5 kg.', ['Q04']), m = createAdaptiveValueManifest(ctx);
    const number = fact(m, 'Q04', 'lastMeasuredWeight.value', '91.5', 'The scale read 91.5 kg.');
    const unit = fact(m, 'Q04', 'lastMeasuredWeight.unit', 'kg', 'The scale read 91.5 kg.');
    const result = apply(ctx, m, wire(m, { facts: [fact(m, 'Q04', 'height.value', 'six feet one inch', 'My height is six feet one inch.'), number, unit] }));
    expect(result.responses.Q04?.answers).toMatchObject({ 'height.value': { value: { feet: 6, inches: 1 } }, 'height.unit': { value: 'ft-in' }, 'lastMeasuredWeight.value': { value: 91.5 }, 'lastMeasuredWeight.unit': { value: 'kg' } });
    expect(result.provenance.find(entry => entry.path === 'height.unit')?.transform).toBe('explicit-height-unit');
    const unrelated = context('My height is 168 cm. The scale read 91.5 kg.', ['Q04']), um = createAdaptiveValueManifest(unrelated);
    const failed = apply(unrelated, um, wire(um, { facts: [fact(um, 'Q04', 'height.value', '91.5', 'The scale read 91.5 kg.')] }));
    expect(failed.updates).toEqual([]);
  });
});

describe('V5 source-backed values and bounded semantic cases', () => {
  it('stores only the new complete strength with support/prior lineage and leaves unchanged medicine alone', () => {
    const text = 'Correction: Cetirizine is 10 mg, not 5 mg; Iron is still 18 mg.';
    const ctx = medicines(text), m = createAdaptiveValueManifest(ctx);
    const previous = structuredClone(ctx.responses);
    ctx.displayed = { topicId: 'Q08', promptId: 'Q08', targetPaths: ['medicines[allergy].strength'] };
    const bound = createAdaptiveValueManifest(ctx);
    const result = apply(ctx, bound, wire(bound, { facts: [fact(bound, 'Q08', 'medicines[allergy].strength', '10 mg', 'Correction: Cetirizine is 10 mg, not 5 mg;', 'known', 'correct')] }));
    expect(result.responses.Q08?.answers.medicines).toMatchObject({ items: [{ answers: { strength: { value: '10 mg', sourceIds: [ctx.source.id] } } }, { answers: { strength: { value: '18 mg', sourceIds: ['prior'] } } }] });
    expect(result.provenance).toHaveLength(1);
    expect(result.provenance[0]).toMatchObject({ sourceText: ['10 mg'], supportSourceText: ['Correction: Cetirizine is 10 mg, not 5 mg;'], correctsSourceIds: ['prior'], evidenceProtocol: valueEvidenceProtocol });
    expect(result.clarifications).toEqual([]);
    const dialogue = selectAdaptiveDialogue(ctx, result);
    expect(dialogue.prompt?.targetPaths).not.toContain('medicines[allergy].strength');
    expect(ctx.responses).toEqual(previous);
    expect(() => resolveAdaptiveValueProposal(wire(m), ctx, m)).toThrow('stale-adaptive-manifest');
  });
  it('rejects stripped units and broad correction values without borrowing units from support', () => {
    const ctx = context('Vitamin D 50000 IU: the label says weekly.', ['Q08']), m = createAdaptiveValueManifest(ctx);
    const correct = item(m, 'Q08', 'medicines', [['name', 'Vitamin D'], ['strength', '50000 IU', ctx.source.text]]);
    expect(apply(ctx, m, wire(m, { newItems: [correct] })).responses.Q08?.answers.medicines).toMatchObject({ items: [{ answers: { strength: { value: '50000 IU' } } }] });
    expect(() => apply(ctx, m, wire(m, { newItems: [item(m, 'Q08', 'medicines', [['name', 'Vitamin D'], ['strength', '50000', ctx.source.text]])] }))).toThrow('incomplete-strength-value');
    const changed = medicines('Correction: Cetirizine is 10 mg, not 5 mg.'), cm = createAdaptiveValueManifest(changed);
    expect(() => apply(changed, cm, wire(cm, { facts: [fact(cm, 'Q08', 'medicines[allergy].strength', changed.source.text, changed.source.text, 'known', 'correct')] }))).toThrow('invalid-strength-value');
  });
  it('keeps rejected-old, foreign entity and no-comma ambiguous correction values deferred', () => {
    for (const [text, quote, support, operation] of [
      ['Correction: Cetirizine is 10 mg, not 5 mg.', '5 mg', 'Correction: Cetirizine is 10 mg, not 5 mg.', 'correct'],
      ['Cetirizine is 10 mg. Iron is 20 mg.', '20 mg', 'Iron is 20 mg.', 'assert'],
      ['Correction: Cetirizine is 10 mg not 5 mg.', '10 mg', 'Correction: Cetirizine is 10 mg not 5 mg.', 'correct'],
    ]) {
      const ctx = medicines(text), m = createAdaptiveValueManifest(ctx);
      const result = apply(ctx, m, wire(m, { facts: [fact(m, 'Q08', 'medicines[allergy].strength', quote, support, 'known', operation)] }));
      expect(result.updates).toEqual([]);
      expect(result.hasUnresolvedInterpretation).toBe(true);
      expect(result.responses).toEqual(ctx.responses);
    }
  });
  it('requires correction support to cite the local cue rather than another entity or an uncited cue', () => {
    const ctx = medicines('Correction: Cetirizine is 10 mg. Iron is still 18 mg.'), m = createAdaptiveValueManifest(ctx);
    expect(() => apply(ctx, m, wire(m, { facts: [fact(m, 'Q08', 'medicines[allergy].strength', '10 mg', '10 mg', 'known', 'correct')] }))).toThrow('invalid-correction-support');
    expect(() => apply(ctx, m, wire(m, { facts: [fact(m, 'Q08', 'medicines[iron].strength', '18 mg', 'Iron is still 18 mg.', 'known', 'correct')] }))).toThrow('invalid-correction-support');
  });
  it('retains shared scoped negative concerns on each named medicine and completion without condition fillers', () => {
    const text = 'Cetirizine 10 mg. Iron 18 mg. No concerns with either. That is all of my medicines.';
    const ctx = context(text, ['Q08', 'Q06']), m = createAdaptiveValueManifest(ctx);
    const first = item(m, 'Q08', 'medicines', [['name', 'Cetirizine'], ['strength', '10 mg'], ['concerns', 'No concerns with either.', undefined, 'negative']]);
    const second = item(m, 'Q08', 'medicines', [['name', 'Iron'], ['strength', '18 mg'], ['concerns', 'No concerns with either.', undefined, 'negative']]);
    const complete = { collection: first.collection, evidence: [address(m, 'That is all of my medicines.')] };
    const result = apply(ctx, m, wire(m, { newItems: [first, second], completedLists: [complete] }));
    expect(result.responses.Q08?.answers.medicines).toMatchObject({ complete: true, items: [{ answers: { concerns: { state: 'negative' } } }, { answers: { concerns: { state: 'negative' } } }] });
    expect(result.responses.Q06).toBeUndefined();
    expect(result.clarifications).toEqual([]);
    expect(selectAdaptiveDialogue(ctx, result).prompt?.topicId).toBe('Q08');
    const wrong = apply(ctx, m, wire(m, { facts: [fact(m, 'Q06', 'conditions.digestive', 'No concerns with either.')], newItems: [first, second] }));
    expect(wrong.responses.Q06?.answers['conditions.digestive']).toBeUndefined();
    expect(wrong.hasUnresolvedInterpretation).toBe(true);
  });
  it('expresses separate volunteered food amounts and scoped unavailable drink additions', () => {
    const text = 'At 1 pm I ate two tacos with tea. I cannot recall what was added to the tea. At 7 pm I ate half a bowl of rice.';
    const ctx = context(text, ['Q11']), m = createAdaptiveValueManifest(ctx);
    const first = item(m, 'Q11', 'occasions', [['time', '1 pm'], ['foods', 'two tacos'], ['foodAmounts', 'two tacos'], ['drinks', 'tea', 'At 1 pm I ate two tacos with tea.'], ['drinkAdditions', 'I cannot recall what was added to the tea.', undefined, 'unknown']]);
    const second = item(m, 'Q11', 'occasions', [['time', '7 pm'], ['foods', 'rice'], ['foodAmounts', 'half a bowl of rice']]);
    const result = apply(ctx, m, wire(m, { newItems: [first, second] }));
    expect(result.responses.Q11?.answers.occasions).toMatchObject({ complete: false, items: [{ answers: { foodAmounts: { value: 'two tacos' }, drinkAdditions: { state: 'unknown' } } }, { answers: { foodAmounts: { value: 'half a bowl of rice' } } }] });
    const items = result.responses.Q11?.answers.occasions;
    expect(items?.state === 'known' && items.items?.[1].answers.drinkAdditions).toBeUndefined();
    const paths = eligibleAdaptiveProbes({ ...ctx, responses: result.responses }).flatMap(probe => probe.targetPaths);
    expect(paths.filter(path => path.endsWith('.foodAmounts') || path.endsWith('.drinkAdditions'))).toEqual([]);
    expect(evaluateTopic(ctx.topics[0], result.responses.Q11!, { validSourceIds: new Set([ctx.source.id]) }).sufficient).toBe(false);
    expect(selectAdaptiveDialogue(ctx, result).prompt?.text).not.toMatch(/how much.*(?:tacos|rice)/i);
  });
  it('keeps family history and a diagnostic question separate from patient states', () => {
    const text = 'My sister has asthma. Can you tell whether I have asthma?';
    const ctx = context(text, ['Q06', 'Q10']), m = createAdaptiveValueManifest(ctx);
    const family = item(m, 'Q10', 'familyHistory', [['condition', 'asthma', 'My sister has asthma.'], ['relationship', 'sister', 'My sister has asthma.']]);
    const question = { kind: 'question', evidence: [address(m, 'Can you tell whether I have asthma?')], topic: null, reply: projection(m).replies.find(reply => reply.id === 'COPY-02')!.ref };
    const result = apply(ctx, m, wire(m, { newItems: [family], interruptions: [question] }));
    expect(result.responses.Q10?.answers.familyHistory).toMatchObject({ items: [{ answers: { condition: { value: 'asthma' }, relationship: { value: 'sister' } } }] });
    expect(result.responses.Q06).toBeUndefined();
    expect(selectAdaptiveDialogue(ctx, result).reply?.id).toBe('COPY-02');
    const wrong = apply(ctx, m, wire(m, { facts: [fact(m, 'Q06', 'conditions.diabetes', 'Can you tell whether I have asthma?', undefined, 'unknown')], newItems: [family], interruptions: [question] }));
    expect(wrong.responses.Q06?.answers['conditions.diabetes']).toBeUndefined();
    expect(wrong.hasUnresolvedInterpretation).toBe(true);
  });
  it('does not let broad audit support become accepted condition coverage or suppress unsupported patient claims', () => {
    const text = 'I have kidney disease. My sister might have diabetes.';
    const ctx = context(text, ['Q06', 'Q10']), m = createAdaptiveValueManifest(ctx);
    const condition = item(m, 'Q06', 'reportedConditions', [['term', 'I have kidney disease.', 'I have kidney disease.']]);
    // A second exact support span is audit context only; it supplies no semantic patient state.
    condition.fields[0].evidence.push(address(m, 'My sister might have diabetes.'));
    const result = apply(ctx, m, wire(m, { newItems: [condition], facts: [fact(m, 'Q06', 'conditions.diabetes', 'My sister might have diabetes.', undefined, 'uncertain')] }));
    expect(result.responses.Q06?.answers['conditions.diabetes']).toBeUndefined();
    expect(result.responses.Q06?.answers.uncertainDiagnosis).toBeUndefined();
    expect(result.provenance.filter(entry => entry.derivedFrom)).toEqual([]);
    expect(result.clarifications).toHaveLength(1);
    expect(result.coveredCandidates ?? []).toEqual([]);
  });
  it('retains supported uncertain recollection and audited server-derived equivalent coverage', () => {
    const text = 'I was told I might have kidney disease.', ctx = context(text, ['Q06']), m = createAdaptiveValueManifest(ctx);
    const result = apply(ctx, m, wire(m, { newItems: [item(m, 'Q06', 'reportedConditions', [['term', text, undefined, 'uncertain']])] }));
    expect(result.responses.Q06?.answers['conditions.kidney']).toMatchObject({ state: 'uncertain' });
    expect(result.responses.Q06?.answers.uncertainDiagnosis).toMatchObject({ state: 'known', value: text });
    expect(result.provenance.filter(entry => entry.derivedFrom)).toHaveLength(2);
    expect(result.provenance.filter(entry => entry.derivedFrom).every(entry => !entry.supportEvidence)).toBe(true);
  });
});

describe('V5 explicit selection, preflight and legacy reproduction', () => {
  it('keeps historical v4 canonical results and guidance bytes executable', () => {
    const receipt = JSON.parse(readFileSync(new URL('../../../docs/implementation/evidence/DO-A10.json', import.meta.url), 'utf8'));
    const record = receipt.results.find((entry: { caseId: string }) => entry.caseId === 'G7');
    expect(resolveContextualAdaptiveProposal(record.rawProviderProposal, record.context, createAdaptiveManifest(record.context))).toEqual(record.proposal);
    expect(adaptiveGuidance('v4-sourced-meanings-v1').receipt.instructionSha256).toBe('efb66a742dc85dd1c3f02d44334e06b00de344328a46e5d2cff35344811c34f9');
    expect(buildAdaptiveMessages(context('More energy.', ['Q01']))[0]).not.toEqual({ role: 'system', content: adaptiveValueGuidance().instruction });
  });
  it('preflights one complete representative rich request under existing caps with no dispatch', async () => {
    const ctx = withPrior(context('Cetirizine 10 mg. Iron 18 mg. No concerns with either.', register.topics.map(topic => topic.id)), 'Q08', {
      medicines: { state: 'known', complete: true, sourceIds: ['prior'], items: [
        { id: 'allergy', answers: { name: known('Cetirizine'), strength: known('10 mg'), actualUse: known('I take it daily') } },
        { id: 'iron', answers: { name: known('Iron'), strength: known('18 mg'), actualUse: known('I take it twice weekly') } },
      ] },
    });
    ctx.responses = { ...ctx.responses, Q03: { presented: true, answers: { childhood: known('During childhood my weight stayed steady.'), teenage: known('My weight rose during my teens.'), afterSchool: known('After school it remained steady.') } }, Q11: { presented: true, answers: { occasions: { state: 'known', complete: false, sourceIds: ['prior'], items: [
      { id: 'lunch', answers: { time: known('1 pm'), foods: known('tacos'), foodAmounts: known('two tacos'), drinks: known('tea') } },
      { id: 'dinner', answers: { time: known('7 pm'), foods: known('rice'), foodAmounts: known('half a bowl of rice') } },
    ] } } } };
    const m = createAdaptiveValueManifest(ctx), payload = projection(m);
    const medicine = payload.topics.find(topic => topic.topicId === 'Q08')!.collections.find(collection => collection.path === 'medicines')!;
    expect(medicine.fields.find(field => field.path === 'strength')?.valueShape).toBe('strength-with-unit');
    expect(payload.topics.find(topic => topic.topicId === 'Q11')!.collections[0].fields.find(field => field.path === 'foodAmounts')?.valueShape).toBe('portion');
    const request = await prepareAdaptiveRequest(ctx, config, { protocol: valueEvidenceProtocol });
    expect(request.requestBytes).toBeLessThanOrEqual(60000);
    const body = JSON.parse(request.body);
    const schemaBytes = Buffer.byteLength(JSON.stringify(body.response_format.json_schema.schema));
    expect(schemaBytes).toBeLessThanOrEqual(32000);
    console.info(JSON.stringify({ kind: 'v5-rich-offline-preflight', requestBytes: request.requestBytes, schemaBytes, topicCount: ctx.topics.length, priorSourceCount: ctx.sources.length - 1 }));
    expect(body.max_tokens).toBe(4096);
    expect(request.guidance?.revision).toBe('v5-value-support-v1');
    expect(request.guidance?.instructionSha256).toBe(createHash('sha256').update(body.messages[0].content).digest('hex'));
    expect(body.messages.flatMap((message: { content: string }) => message.content).join('')).not.toMatch(/Patient\/secret|operation-secret|session-secret|snapshot-secret/);
  });
  it('keeps the exact preflight/native-schema identities on mocked dispatch and never repairs invalid output', async () => {
    const ctx = context('I want more energy.', ['Q01']), m = createAdaptiveValueManifest(ctx), raw = wire(m, { facts: [fact(m, 'Q01', 'priority', 'more energy', ctx.source.text)] });
    const prepared = await prepareAdaptiveRequest(ctx, config, { protocol: valueEvidenceProtocol });
    const fetcher = vi.fn(async (_url, init) => {
      expect(init?.body).toBe(prepared.body);
      return new Response(JSON.stringify({ id: 'offline-mock', model: config.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }] }), { headers: { 'Content-Type': 'application/json' } });
    });
    const result = await createDigitalOceanProposer(config, fetcher, { protocol: valueEvidenceProtocol }).propose(ctx);
    expect(result.receipt).toMatchObject({ evidenceProtocol: valueEvidenceProtocol, guidance: prepared.guidance, manifest: prepared.manifest, responseSchema: prepared.responseSchema });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.proposal).toMatchObject({ schema: 2 });
    const badRaw = wire(m, { facts: [{ ...fact(m, 'Q01', 'priority', 'more energy', ctx.source.text), value: null }] });
    const invalid = vi.fn(async () => new Response(JSON.stringify({ id: 'bad', model: config.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(badRaw) } }] })));
    await expect(createDigitalOceanProposer(config, invalid, { protocol: valueEvidenceProtocol }).propose(ctx)).rejects.toMatchObject({ code: 'invalid-contextual-value-proposal', rawProposal: { schema: 5 } });
    expect(invalid).toHaveBeenCalledTimes(1);
  });
});
