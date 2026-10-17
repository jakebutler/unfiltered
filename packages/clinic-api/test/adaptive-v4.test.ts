import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { evaluateTopic } from '../../clinic-content/src/index.js';
import { createAdaptiveManifest, resolveContextualAdaptiveProposal, contextualEvidenceProtocol, type AdaptiveManifest } from '../src/adaptive-manifest.js';
import { applyValidatedTurn, validateAdaptiveProposal, type AdaptiveContext } from '../src/adaptive-validation.js';
import { createDigitalOceanProposer, prepareAdaptiveRequest, buildAdaptiveMessages } from '../src/adaptive.js';
import { selectAdaptiveDialogue, eligibleAdaptiveProbes } from '../src/dialogue.js';
import { context, source, register, withPrior } from './fixtures/adaptive.js';
const config = { endpoint: 'https://inference.do-ai.run' as const, apiKey: 'test-only-secret', model: 'qwen3.8-max' as const, timeoutMs: 1000, maxOutputTokens: 4096 };
const options = { protocol: contextualEvidenceProtocol };
function data(manifest: AdaptiveManifest): any { return Object.assign({}, ...manifest.payloads); }
const wire = (manifest: AdaptiveManifest, extra: Record<string, unknown> = {}) => ({ schema: 4, context: manifest.id, facts: [], newItems: [], completedLists: [], interruptions: [], unmapped: [], ...extra });
function evidence(manifest: AdaptiveManifest, quote: string, occurrence = 0, literal = false) {
  const row = data(manifest).sourceSegments.filter((row: any[]) => row[1] === (literal ? 'literal' : 'sentence') && row[2].includes(quote))[occurrence];
  if (!row) throw new Error('bad-evidence-fixture');
  return [{ source: row[0], quote }];
}
function target(manifest: AdaptiveManifest, topicId: string, path: string) { return data(manifest).topics.find((topic: any) => topic.topicId === topicId).targets.find((row: any[]) => row[1] === path)[0]; }
function fact(manifest: AdaptiveManifest, topicId: string, path: string, quote: string, state = 'known', operation = 'assert', literal = false) { return { target: target(manifest, topicId, path), state, evidence: evidence(manifest, quote, 0, literal), operation }; }
function item(manifest: AdaptiveManifest, topicId: string, path: string, fields: [string, string, string?][]) {
  const collection = data(manifest).topics.find((topic: any) => topic.topicId === topicId).collections.find((collection: any) => collection.path === path);
  return { collection: collection.ref, fields: fields.map(([path, quote, state = 'known']) => ({ field: collection.fields.find((row: any[]) => row[1] === path)[0], state, evidence: evidence(manifest, quote) })) };
}
function apply(ctx: AdaptiveContext, manifest: AdaptiveManifest, raw: unknown) { return applyValidatedTurn(ctx, validateAdaptiveProposal(resolveContextualAdaptiveProposal(raw, ctx, manifest), ctx)); }
const readiness = (ctx: AdaptiveContext, outcome: ReturnType<typeof apply>, id: string) => evaluateTopic(ctx.topics.find(topic => topic.id === id)!, outcome.responses[id] ?? { presented: false, answers: {} }, { validSourceIds: new Set(ctx.sources.map(source => source.id)) });

describe('operation-bound contextual protocol', () => {
  it('issues deterministic immutable manifests and schema identities without provider-bound patient identifiers', () => {
    const ctx = context('I want better sleep.', ['Q01', 'Q16']), manifest = createAdaptiveManifest(ctx);
    expect(createAdaptiveManifest(ctx)).toEqual(manifest);
    expect(Object.isFrozen(manifest)).toBe(true);
    const messages = JSON.stringify(buildAdaptiveMessages(ctx, contextualEvidenceProtocol));
    for (const hidden of ['Patient/secret', 'session-secret', 'operation-secret', 'snapshot-secret', 'eligibleProbes', 'probeTexts']) expect(messages).not.toContain(hidden);
    expect(JSON.stringify(manifest.jsonSchema)).not.toContain('MH01');
    expect(data(manifest).topics[1].targets.every((row: any[]) => !/^MH0/.test(row[1]))).toBe(true);
    expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(['revision', 'binding', 'source', 'answers', 'displayed', 'reconstructed'])('rejects a stale/reconstructed manifest: %s', change => {
    const ctx = context('I want better sleep.', ['Q01']), manifest = createAdaptiveManifest(ctx), raw = wire(manifest);
    if (change === 'revision') ctx.binding.revision++;
    if (change === 'binding') ctx.binding.operationId = 'other';
    if (change === 'source') { ctx.source = source('Different words'); ctx.sources = [ctx.source]; }
    if (change === 'answers') ctx.responses = { Q01: { presented: true, answers: {} } };
    if (change === 'displayed') ctx.displayed = undefined;
    expect(() => resolveContextualAdaptiveProposal(raw, ctx, change === 'reconstructed' ? structuredClone(manifest) : manifest)).toThrow('stale-adaptive-manifest');
  });
  it('rejects cross-operation raw replay even when field and segment ordinal handles coincide', () => {
    const ctx = context('I want better sleep.', ['Q01']), old = createAdaptiveManifest(ctx), raw = wire(old);
    ctx.binding.operationId = 'other-operation';
    expect(() => resolveContextualAdaptiveProposal(raw, ctx, createAdaptiveManifest(ctx))).toThrow('invalid-contextual-proposal');
  });
  it.each(['target', 'source', 'agenda', 'reply', 'next', 'transform', 'item-key', 'prior-lineage', 'unknown-field', 'forbidden-negative', 'offset', 'redundant-answer'])('rejects invalid reference/authority %s without repair', change => {
    const ctx = context('I want better sleep. Can you help? Let us discuss medicines first.', ['Q01', 'Q08']), manifest = createAdaptiveManifest(ctx);
    const raw: any = wire(manifest, { facts: [fact(manifest, 'Q01', 'priority', 'better sleep')] });
    if (change === 'target') raw.facts[0].target = 'Q01.priority';
    if (change === 'source') raw.facts[0].evidence[0].source = 's999';
    if (change === 'agenda') raw.interruptions = [{ kind: 'topic-switch', topic: 't999', reply: null, evidence: evidence(manifest, 'discuss medicines first') }];
    if (change === 'reply') raw.interruptions = [{ kind: 'question', topic: null, reply: 'r999', evidence: evidence(manifest, 'Can you help?') }];
    if (change === 'next') raw.next = null;
    if (change === 'transform') raw.facts[0].transform = 'verbatim';
    if (change === 'item-key') raw.newItems = [{ ...item(manifest, 'Q08', 'medicines', [['name', 'medicines']]), key: 'mine' }];
    if (change === 'prior-lineage') raw.facts[0].correctsSourceIds = ['forged'];
    if (change === 'unknown-field') raw.facts[0].value = 'sleep';
    if (change === 'forbidden-negative') raw.facts[0].state = 'negative';
    if (change === 'offset') raw.facts[0].evidence[0].start = 0;
    if (change === 'redundant-answer') raw.interruptions = [{ kind: 'answer', topic: null, reply: null, evidence: evidence(manifest, 'better sleep') }];
    expect(() => resolveContextualAdaptiveProposal(raw, ctx, manifest)).toThrow('invalid-contextual-proposal');
  });
  it('constrains collection-child compatibility in both the native schema and local parser', () => {
    const ctx = context('My father has diabetes. I take aspirin.', ['Q08', 'Q10']), manifest = createAdaptiveManifest(ctx);
    const med = item(manifest, 'Q08', 'medicines', [['name', 'aspirin']]);
    med.fields = item(manifest, 'Q10', 'familyHistory', [['condition', 'diabetes']]).fields;
    expect(() => resolveContextualAdaptiveProposal(wire(manifest, { newItems: [med] }), ctx, manifest)).toThrow('invalid-contextual-proposal');
    expect(JSON.stringify(manifest.jsonSchema)).toContain('cf');
  });
  it('addresses repeated numeric literals separately and rejects residual ambiguity', () => {
    const ctx = context('I am 170 cm tall and measured 170 pounds.', ['Q04']), manifest = createAdaptiveManifest(ctx);
    const raw = wire(manifest, { facts: [{ ...fact(manifest, 'Q04', 'lastMeasuredWeight.value', '170', 'known', 'assert', true), evidence: evidence(manifest, '170', 1, true) }] });
    const canonical = resolveContextualAdaptiveProposal(raw, ctx, manifest);
    expect(canonical.facts[0].evidence[0].start).toBe(ctx.source.text.lastIndexOf('170'));
    expect(() => resolveContextualAdaptiveProposal(wire(manifest, { facts: [fact(manifest, 'Q04', 'lastMeasuredWeight.value', '170')] }), ctx, manifest)).toThrow('ambiguous-source-quote');
  });
  it('derives height, number, unit, choice and unavailable transforms, never guesses between alternatives', () => {
    const ctx = context("My height is five feet nine inches. The scale read 212 pounds. I don't remember when.", ['Q04']), manifest = createAdaptiveManifest(ctx);
    const raw = wire(manifest, { facts: [fact(manifest, 'Q04', 'height.value', 'five feet nine inches'), fact(manifest, 'Q04', 'lastMeasuredWeight.value', '212', 'known', 'assert', true), fact(manifest, 'Q04', 'lastMeasuredWeight.unit', 'pounds', 'known', 'assert', true), fact(manifest, 'Q04', 'lastMeasuredWeight.measuredWhen', "I don't remember when", 'unknown')] });
    const result = apply(ctx, manifest, raw);
    expect(result.responses.Q04?.answers).toMatchObject({ 'height.value': { value: { feet: 5, inches: 9 } }, 'height.unit': { value: 'ft-in' }, 'lastMeasuredWeight.value': { value: 212 }, 'lastMeasuredWeight.unit': { value: 'lb' }, 'lastMeasuredWeight.measuredWhen': { state: 'unknown' } });
    expect(readiness(ctx, result, 'Q04').sufficient).toBe(false);
    expect(eligibleAdaptiveProbes({ ...ctx, responses: result.responses }).flatMap(probe => probe.targetPaths)).not.toContain('lastMeasuredWeight.measuredWhen');
    const bad = fact(manifest, 'Q04', 'lastMeasuredWeight.value', '212', 'known', 'assert', true); bad.evidence.push(...evidence(manifest, 'pounds', 0, true));
    expect(() => resolveContextualAdaptiveProposal(wire(manifest, { facts: [bad] }), ctx, manifest)).toThrow('invalid-value-evidence');
  });
  it('resolves exact prior lineage while keeping explicit scoped correction guards and conflicts', () => {
    const ctx = withPrior(context('Actually, Metformin is 500 mg.', ['Q08']), 'Q08', { medicines: { state: 'known', sourceIds: ['prior'], complete: false, items: [{ id: 'm1', answers: { name: { state: 'known', value: 'Metformin', sourceIds: ['prior'] }, strength: { state: 'known', value: '1000 mg', sourceIds: ['prior'] } } }] } });
    const manifest = createAdaptiveManifest(ctx), raw = wire(manifest, { facts: [fact(manifest, 'Q08', 'medicines[m1].strength', '500 mg', 'known', 'correct')] });
    expect(resolveContextualAdaptiveProposal(raw, ctx, manifest).facts[0].correctsSourceIds).toEqual(['prior']);
    expect(apply(ctx, manifest, raw).provenance[0].correctsSourceIds).toEqual(['prior']);
    const conflict = apply(ctx, manifest, wire(manifest, { facts: [fact(manifest, 'Q08', 'medicines[m1].strength', '500 mg')] }));
    expect(conflict.clarifications[0].reason).toBe('conflict');
    const absent = context('Actually, I prefer walking.', ['Q01']), absentManifest = createAdaptiveManifest(absent);
    expect(() => resolveContextualAdaptiveProposal(wire(absentManifest, { facts: [fact(absentManifest, 'Q01', 'priority', 'walking', 'known', 'correct')] }), absent, absentManifest)).toThrow('invalid-correction-target');
  });
  it('retains raw proposal, unmapped meaning and exact evidence without turning machine uncertainty into a patient answer', () => {
    const ctx = context('I want better sleep. The second thing is hard to explain.', ['Q01']), manifest = createAdaptiveManifest(ctx);
    const raw = wire(manifest, { facts: [fact(manifest, 'Q01', 'priority', 'better sleep')], unmapped: [{ evidence: evidence(manifest, 'The second thing is hard to explain.'), reason: 'ambiguous' }] }), before = structuredClone(raw);
    const result = apply(ctx, manifest, raw);
    expect(raw).toEqual(before);
    expect(result.unmapped).toEqual([{ evidence: [{ sourceId: ctx.source.id, start: 21, end: ctx.source.text.length }], reason: 'ambiguous' }]);
    expect(result.hasUnresolvedInterpretation).toBe(true);
    expect(result.responses.Q01?.answers.priority).toMatchObject({ state: 'known', value: 'better sleep' });
  });
});

describe('target-scoped availability, readiness and dialogue', () => {
  it.each(["I don't remember what happened over the past 18 months.", "I cannot recall my weight during childhood.", "I do not know what my weight did in the last five years."])('does not make unavailable history sufficient: %s', text => {
    const path = text.includes('childhood') ? 'childhood' : text.includes('five') ? 'lastFiveYears' : 'past18Months';
    const ctx = context(text, ['Q03']); ctx.displayed!.targetPaths = [path];
    const manifest = createAdaptiveManifest(ctx);
    const rejected = apply(ctx, manifest, wire(manifest, { facts: [fact(manifest, 'Q03', path, text)] }));
    expect(rejected.updates).toEqual([]);
    expect(readiness(ctx, rejected, 'Q03').sufficient).toBe(false);
    expect(selectAdaptiveDialogue(ctx, rejected).status).toBe('clarification');
    const accepted = apply(ctx, manifest, wire(manifest, { facts: [fact(manifest, 'Q03', path, text, 'unknown')] }));
    expect(accepted.responses.Q03?.answers[path]?.state).toBe('unknown');
    expect(eligibleAdaptiveProbes({ ...ctx, responses: accepted.responses }).flatMap(probe => probe.targetPaths)).not.toContain(path);
  });
  it('records known food alongside an explicit unavailable portion without re-asking the portion', () => {
    const ctx = context("At noon I ate rice and I don't remember the portion.", ['Q11']), manifest = createAdaptiveManifest(ctx);
    const result = apply(ctx, manifest, wire(manifest, { newItems: [item(manifest, 'Q11', 'occasions', [['time', 'At noon'], ['foods', 'rice'], ['foodAmounts', "I don't remember the portion", 'unknown']])] }));
    const saved = result.responses.Q11?.answers.occasions;
    expect(saved).toMatchObject({ items: [{ answers: { foods: { state: 'known', value: 'rice' }, foodAmounts: { state: 'unknown' } } }] });
    expect(eligibleAdaptiveProbes({ ...ctx, responses: result.responses }).flatMap(probe => probe.targetPaths).some(path => path.endsWith('.foodAmounts'))).toBe(false);
    const bad = apply(ctx, manifest, wire(manifest, { newItems: [item(manifest, 'Q11', 'occasions', [['foods', 'rice'], ['foodAmounts', "I don't remember the portion"]])] }));
    expect(bad.clarifications.some(clarification => clarification.path.endsWith('.foodAmounts'))).toBe(true);
  });
  it.each(['who to call', 'mask settings'])('does not turn established sleep apnea into diagnostic uncertainty about %s', detail => {
    const text = `I have sleep apnea but I am unsure about ${detail}.`, ctx = context(text, ['Q06']), manifest = createAdaptiveManifest(ctx);
    const result = apply(ctx, manifest, wire(manifest, { newItems: [item(manifest, 'Q06', 'reportedConditions', [['term', text]])] }));
    expect(result.responses.Q06?.answers.reportedConditions).toMatchObject({ items: [{ answers: { term: { state: 'known', value: text } } }] });
    expect(result.responses.Q06?.answers['conditions.sleepApnea']).toBeUndefined();
    expect(result.responses.Q06?.answers.uncertainDiagnosis).toBeUndefined();
  });
  it('preserves the known narrative of explicitly reported diagnostic uncertainty and does not activate a diagnosis branch', () => {
    const text = 'My doctor told me I might have sleep apnea.', ctx = context(text, ['Q06', 'SLEEP']), manifest = createAdaptiveManifest(ctx);
    const result = apply(ctx, manifest, wire(manifest, { facts: [fact(manifest, 'Q06', 'uncertainDiagnosis', text)] }));
    expect(result.responses.Q06?.answers.uncertainDiagnosis).toMatchObject({ state: 'known', value: text });
    expect(result.responses.Q06?.answers['conditions.sleepApnea']?.state).toBe('uncertain');
    expect(result.responses.SLEEP?.applicability).not.toBe('applicable');
    expect(selectAdaptiveDialogue(ctx, result).prompt?.topicId).not.toBe('SLEEP');
  });
  it('separates a known reading from its unavailable date within one clause', () => {
    const ctx = context("The scale read 213 pounds and I don't remember the date.", ['Q04']), manifest = createAdaptiveManifest(ctx);
    const result = apply(ctx, manifest, wire(manifest, { facts: [fact(manifest, 'Q04', 'lastMeasuredWeight.value', '213', 'known', 'assert', true), fact(manifest, 'Q04', 'lastMeasuredWeight.unit', 'pounds', 'known', 'assert', true), fact(manifest, 'Q04', 'lastMeasuredWeight.measuredWhen', "I don't remember the date", 'unknown')] }));
    expect(result.responses.Q04?.answers).toMatchObject({ 'lastMeasuredWeight.value': { state: 'known', value: 213 }, 'lastMeasuredWeight.unit': { value: 'lb' }, 'lastMeasuredWeight.measuredWhen': { state: 'unknown' } });
    expect(result.clarifications).toEqual([]);
    expect(readiness(ctx, result, 'Q04').sufficient).toBe(false);
    const bad = apply(ctx, manifest, wire(manifest, { facts: [fact(manifest, 'Q04', 'lastMeasuredWeight.measuredWhen', "I don't remember the date")] }));
    expect(bad.responses.Q04?.answers['lastMeasuredWeight.measuredWhen']).toBeUndefined();
    expect(bad.hasUnresolvedInterpretation).toBe(true);
  });
  it('does not borrow evidence across entity, diagnosis or measurement roles after handle resolution', () => {
    const ctx = context('My mother has diabetes. My height is 169 cm and my weight is 78 kg.', ['Q06', 'Q04']), manifest = createAdaptiveManifest(ctx);
    const result = apply(ctx, manifest, wire(manifest, { facts: [fact(manifest, 'Q06', 'conditions.diabetes', 'diabetes'), fact(manifest, 'Q04', 'height.value', '78', 'known', 'assert', true)] }));
    expect(result.updates).toEqual([]); expect(result.clarifications).toHaveLength(2);
    expect(result.responses.DM).toBeUndefined();
  });
  it('allows explicit topic preference and move-on only with supported patient evidence', () => {
    const ctx = context('I would rather discuss medicines first.', ['Q01', 'Q08']), manifest = createAdaptiveManifest(ctx);
    const raw = wire(manifest, { interruptions: [{ kind: 'topic-switch', topic: 't1', reply: null, evidence: evidence(manifest, ctx.source.text) }] });
    expect(selectAdaptiveDialogue(ctx, apply(ctx, manifest, raw)).prompt?.topicId).toBe('Q08');
    const noCue = context('I take medicines.', ['Q01', 'Q08']), other = createAdaptiveManifest(noCue);
    expect(() => apply(noCue, other, wire(other, { interruptions: [{ kind: 'topic-switch', topic: 't1', reply: null, evidence: evidence(other, noCue.source.text) }] }))).toThrow('unscoped-topic-switch');
    const skip = context('I would rather move on.', ['Q01', 'Q08']), skipped = createAdaptiveManifest(skip);
    const stopped = apply(skip, skipped, wire(skipped, { interruptions: [{ kind: 'move-on', topic: 't0', reply: null, evidence: evidence(skipped, skip.source.text) }] }));
    expect(stopped.responses.Q01?.stopped).toBe('patient-moves-on');
    expect(selectAdaptiveDialogue(skip, stopped).prompt?.topicId).toBe('Q08');
  });
  it('keeps supported question interruptions with concurrent facts and a deterministic remaining current-topic gap', () => {
    const ctx = context('I take Vitamin D. What can you do?', ['Q08', 'Q06']), manifest = createAdaptiveManifest(ctx);
    const result = apply(ctx, manifest, wire(manifest, { newItems: [item(manifest, 'Q08', 'medicines', [['name', 'Vitamin D']])], interruptions: [{ kind: 'question', topic: null, reply: 'r0', evidence: evidence(manifest, 'What can you do?') }] }));
    const next = selectAdaptiveDialogue(ctx, result);
    expect(next.reply?.id).toBe('COPY-02'); expect(next.prompt?.topicId).toBe('Q08');
    expect(result.nomination).toBeUndefined(); expect(next.prompt?.targetPaths.some(path => path.endsWith('.name'))).toBe(false);
  });
});

describe('generated schema, full-context accounting and one call', () => {
  it.each(Object.keys(register.scenarios))('keeps every admitted scenario topic/conditional candidate addressable: %s', scenarioId => {
    const scenario = register.scenarios[scenarioId as keyof typeof register.scenarios];
    const ctx = context('I have something to share.', ['Q01'], scenarioId as any);
    ctx.topics = [...register.topics.filter(topic => scenario.reusableTopicIds.includes(topic.id as any)), ...scenario.additionalTopics, ...Object.values(register.branches).map(branch => branch.topic)];
    const manifest = createAdaptiveManifest(ctx), payload = data(manifest);
    expect(payload.topics.map((topic: any) => topic.topicId)).toEqual(ctx.topics.map(topic => topic.id));
    expect(payload.topics.flatMap((topic: any) => topic.targets).every((row: any[]) => row[1] !== 'currentWeightEstimate.statedAt' && !/^MH0/.test(row[1]))).toBe(true);
  });
  it('generates closed objects with all keys required and enum addresses in small and full manifests', () => {
    for (const ctx of [context('A detail.', ['Q01']), { ...context('A detail.'), topics: register.topics }]) {
      const manifest = createAdaptiveManifest(ctx), objects: any[] = [], enums: unknown[][] = [];
      const visit = (value: any): void => { if (!value || typeof value !== 'object') return; if (value.type === 'object') objects.push(value); if (value.enum) enums.push(value.enum); Object.values(value).forEach(visit); };
      visit(manifest.jsonSchema);
      expect(objects.length).toBeGreaterThan(5);
      for (const object of objects) { expect(object.additionalProperties).toBe(false); expect(object.required).toEqual(Object.keys(object.properties)); }
      expect(enums.some(values => values.includes('f0'))).toBe(true);
      expect(enums.some(values => values.includes('s0'))).toBe(true);
      expect(() => resolveContextualAdaptiveProposal(wire(manifest), ctx, manifest)).not.toThrow();
    }
  });
  it('fails a malformed provider result once and retains both raw data and bound receipts', async () => {
    const ctx = context('I want better sleep.', ['Q01']), manifest = createAdaptiveManifest(ctx), raw = { ...wire(manifest), next: { target: 'invented' } };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'bad-v4', model: config.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }] })));
    await expect(createDigitalOceanProposer(config, fetcher, options).propose(ctx)).rejects.toMatchObject({ code: 'invalid-contextual-proposal', rawProposal: raw, receipt: { manifest: { id: manifest.id, sha256: manifest.sha256 }, evidenceProtocol: contextualEvidenceProtocol } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('accounts for the generated schema plus complete rich context and preserves every prior value/state/source', async () => {
    const ctx = context('I measured 219 pounds today.');
    ctx.topics = [...register.topics, ...Object.values(register.branches).map(branch => branch.topic)];
    const answers: any = {};
    for (const topic of ctx.topics) answers[topic.id] = { presented: true, answers: Object.fromEntries(topic.slots.filter(slot => slot.kind === 'text').slice(0, 3).map(slot => [slot.id, { state: 'known', value: 'I remember this part of my life. '.repeat(8), sourceIds: ['prior'] }])) };
    ctx.responses = answers; ctx.sources = [source('Earlier detailed answers', 'prior'), ctx.source];
    const prepared = await prepareAdaptiveRequest(ctx, config, options), payload = data(createAdaptiveManifest(ctx));
    expect(prepared.requestBytes).toBe(Buffer.byteLength(prepared.body)); expect(prepared.requestBytes).toBeLessThanOrEqual(60000);
    for (const [id, response] of Object.entries(answers) as any) for (const [path, answer] of Object.entries(response.answers) as any) expect(payload.currentFacts[id].answers[path].slice(0, 3)).toEqual([answer.state, answer.value, answer.sourceIds]);
    expect(prepared.responseSchema?.sha256).toBe(createHash('sha256').update(JSON.stringify(JSON.parse(prepared.body).response_format.json_schema.schema)).digest('hex'));
    expect(prepared.manifest).toEqual({ id: createAdaptiveManifest(ctx).id, sha256: createAdaptiveManifest(ctx).sha256 });
  });
  it('sends exact preflight bytes once, preserves raw output, and receipts schema and manifest', async () => {
    const ctx = context('I want easier walking.', ['Q01']), manifest = createAdaptiveManifest(ctx), raw = wire(manifest, { facts: [fact(manifest, 'Q01', 'priority', 'easier walking')] });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'v4-receipt', model: config.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }] })));
    const prepared = await prepareAdaptiveRequest(ctx, config, options), result = await createDigitalOceanProposer(config, fetcher, options).propose(ctx);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(String(fetcher.mock.calls[0][1]?.body)).toBe(prepared.body);
    expect(result.rawProposal).toEqual(raw); expect(result.receipt).toMatchObject({ evidenceProtocol: contextualEvidenceProtocol, manifest: prepared.manifest, responseSchema: prepared.responseSchema, requestBytes: prepared.requestBytes });
  });
  it('makes no calls for frozen PHQ or safety interruption or over-budget full request', async () => {
    const fetcher = vi.fn(), proposer = createDigitalOceanProposer(config, fetcher, options);
    const phq = context('Nearly every day.', ['Q16']); phq.displayed = { topicId: 'Q16', promptId: 'MH01', targetPaths: ['MH01'] };
    await expect(proposer.propose(phq)).rejects.toThrow('instrument-guided-required');
    const safety = context('I want to die.', ['Q01']); safety.safetyPaused = true;
    await expect(proposer.propose(safety)).rejects.toThrow('safety-interruption');
    await expect(createDigitalOceanProposer({ ...config, maxRequestBytes: 1000 }, fetcher, options).propose(context('I want better sleep.', ['Q01']))).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});


describe('v4 independent semantic repairs', () => {
  it.each([
    ['My mother has diabetes.', 'diabetes'],
    ['If I had diabetes, I would need care.', 'diabetes'],
    ['Do I have diabetes?', 'diabetes'],
    ["I don't have diabetes.", 'diabetes'],
    ['I might have sleep apnea.', 'sleep apnea'],
    ['I have sleep apnea but my mother has diabetes.', 'diabetes'],
  ])('rejects a stripped non-patient or uncertain condition identity: %s', (text, quote) => {
    const ctx = context(text, ['Q06', 'Q10']), manifest = createAdaptiveManifest(ctx);
    const result = apply(ctx, manifest, wire(manifest, { newItems: [item(manifest, 'Q06', 'reportedConditions', [['term', quote]])] }));
    expect(result.responses.Q06?.answers.reportedConditions).toBeUndefined();
    expect(result.hasUnresolvedInterpretation).toBe(true);
  });
  it('keeps legitimate family history while rejecting the same diagnosis as patient history', () => {
    const ctx = context('My father has diabetes.', ['Q06', 'Q10']), manifest = createAdaptiveManifest(ctx);
    const result = apply(ctx, manifest, wire(manifest, { newItems: [item(manifest, 'Q06', 'reportedConditions', [['term', 'diabetes']]), item(manifest, 'Q10', 'familyHistory', [['condition', 'diabetes'], ['relationship', 'father']])] }));
    expect(result.responses.Q06?.answers.reportedConditions).toBeUndefined();
    expect(result.responses.Q10?.answers.familyHistory).toMatchObject({ items: [{ answers: { condition: { state: 'known', value: 'diabetes' }, relationship: { value: 'father' } } }] });
  });
  it('does not keep orphan care details when the same proposed condition identity was rejected', () => {
    const ctx = context('My mother has diabetes. I see Dr Lee.', ['Q06']), manifest = createAdaptiveManifest(ctx);
    const result = apply(ctx, manifest, wire(manifest, { newItems: [item(manifest, 'Q06', 'reportedConditions', [['owner', 'Dr Lee'], ['term', 'diabetes']])] }));
    expect(result.responses.Q06?.answers.reportedConditions).toBeUndefined();
    expect(result.updates).toEqual([]);
    expect(result.clarifications).toHaveLength(2);
  });
  it('orders a supported condition identity before its dependent care without inventing a diagnosis anchor', () => {
    const ctx = context('I have diabetes. I see Dr Lee.', ['Q06']), manifest = createAdaptiveManifest(ctx);
    const result = apply(ctx, manifest, wire(manifest, { newItems: [item(manifest, 'Q06', 'reportedConditions', [['owner', 'Dr Lee'], ['term', 'diabetes']])] }));
    expect(result.responses.Q06?.answers.reportedConditions).toMatchObject({ items: [{ answers: { term: { value: 'diabetes' }, owner: { value: 'Dr Lee' } } }] });
    expect(result.responses.Q06?.answers['conditions.diabetes']).toBeUndefined();
  });
  it.each(["I don't have diabetes.", 'I was told I might have sleep apnea.'])('preserves a fully quoted patient status without converting it into a positive anchor: %s', text => {
    const ctx = context(text, ['Q06', 'SLEEP']), manifest = createAdaptiveManifest(ctx);
    const result = apply(ctx, manifest, wire(manifest, { newItems: [item(manifest, 'Q06', 'reportedConditions', [['term', text]])] }));
    expect(result.responses.Q06?.answers.reportedConditions).toMatchObject({ items: [{ answers: { term: { state: 'known', value: text } } }] });
    expect(result.responses.Q06?.answers['conditions.diabetes']?.state).not.toBe('known');
    expect(result.responses.Q06?.answers['conditions.sleepApnea']?.state).not.toBe('known');
    expect(result.responses.SLEEP?.applicability).not.toBe('applicable');
  });
  it.each([
    ['My weight trajectory during childhood is unknown.', 'childhood', 'My weight trajectory during childhood'],
    ['My weight over the last five years remains unknown.', 'lastFiveYears', 'My weight over the last five years'],
  ])('checks the unavailable predicate after a selected history quote: %s', (text, path, quote) => {
    const ctx = context(text, ['Q03']), manifest = createAdaptiveManifest(ctx);
    const result = apply(ctx, manifest, wire(manifest, { facts: [fact(manifest, 'Q03', path, quote)] }));
    expect(result.responses.Q03?.answers[path]).toBeUndefined();
    expect(readiness(ctx, result, 'Q03').sufficient).toBe(false);
    expect(eligibleAdaptiveProbes({ ...ctx, responses: result.responses }).flatMap(probe => probe.targetPaths)).toContain(path);
  });
  it('keeps known food independent of a trailing unavailable portion', () => {
    const ctx = context('I ate rice and the portion is unknown.', ['Q11']), manifest = createAdaptiveManifest(ctx);
    const result = apply(ctx, manifest, wire(manifest, { newItems: [item(manifest, 'Q11', 'occasions', [['foods', 'rice'], ['foodAmounts', 'the portion']])] }));
    expect(result.responses.Q11?.answers.occasions).toMatchObject({ items: [{ answers: { foods: { value: 'rice' } } }] });
    expect(result.clarifications.some(entry => entry.path.endsWith('.foodAmounts'))).toBe(true);
  });
  it.each([
    'I do not know whether I was diagnosed with sleep apnea.',
    "I don't know if I have diabetes.",
    'I cannot remember whether I was diagnosed with diabetes.',
    'I am not sure about whether I have sleep apnea.',
  ])('preserves the complete patient report of diagnostic uncertainty: %s', text => {
    const ctx = context(text, ['Q06', 'DM', 'SLEEP']), manifest = createAdaptiveManifest(ctx);
    const result = apply(ctx, manifest, wire(manifest, { facts: [fact(manifest, 'Q06', 'uncertainDiagnosis', text)] }));
    expect(result.responses.Q06?.answers.uncertainDiagnosis).toMatchObject({ state: 'known', value: text });
    expect(result.responses.Q06?.answers['conditions.sleepApnea']?.state).not.toBe('known');
    expect(result.responses.Q06?.answers['conditions.diabetes']?.state).not.toBe('known');
    expect(result.responses.DM?.applicability).not.toBe('applicable');
    expect(result.responses.SLEEP?.applicability).not.toBe('applicable');
  });
  it('does not reclassify a relative diagnostic question as the patient uncertainty narrative', () => {
    const text = 'I do not know whether my mother was diagnosed with sleep apnea.', ctx = context(text, ['Q06']), manifest = createAdaptiveManifest(ctx);
    const result = apply(ctx, manifest, wire(manifest, { facts: [fact(manifest, 'Q06', 'uncertainDiagnosis', text)] }));
    expect(result.responses.Q06?.answers.uncertainDiagnosis).toBeUndefined();
    expect(result.hasUnresolvedInterpretation).toBe(true);
  });
});
