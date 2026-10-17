import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createAdaptiveValueGuidanceExamples, renderAdaptiveValueGuidanceExamples } from '../src/adaptive-value-guidance.js';
import { adaptiveValueGuidance, adaptiveValueGuidanceRevision, createAdaptiveValueManifest, resolveAdaptiveValueProposal, restoredAdaptiveValueGuidanceRevision, valueEvidenceProtocol } from '../src/adaptive-value-manifest.js';
import { applyValidatedTurn, validateAdaptiveProposal } from '../src/adaptive-validation.js';
import { buildAdaptiveMessages, createDigitalOceanProposer, prepareAdaptiveRequest } from '../src/adaptive.js';
import { eligibleAdaptiveProbes, selectAdaptiveDialogue } from '../src/dialogue.js';
import { evaluateTopic, type SlotAnswer } from '../../clinic-content/src/index.js';
import { context, register, withPrior } from './fixtures/adaptive.js';

const config = { endpoint: 'https://inference.do-ai.run' as const, apiKey: 'offline-only', model: 'qwen3.8-max' as const, timeoutMs: 15000, maxOutputTokens: 4096, maxRequestBytes: 60000 };
const options = { protocol: valueEvidenceProtocol, guidanceRevision: restoredAdaptiveValueGuidanceRevision };
const example = (name: string) => createAdaptiveValueGuidanceExamples().find(example => example.name === name)!;
function execute(name: string) {
  const ex = example(name), canonical = resolveAdaptiveValueProposal(ex.output, ex.context, ex.manifest);
  const outcome = applyValidatedTurn(ex.context, validateAdaptiveProposal(canonical, ex.context));
  expect(outcome.clarifications).toEqual([]);
  expect(outcome.hasUnresolvedInterpretation).toBe(false);
  return { ex, canonical, outcome, dialogue: selectAdaptiveDialogue(ex.context, outcome) };
}
function items(answer: SlotAnswer | undefined) { if (answer?.state !== 'known' || !answer.items) throw new Error('expected-items'); return answer.items; }

describe('restored V5 executable illustrations', () => {
  it('preserves known estimates and readings, uncertain relevance and scoped unknown date without repeating them', () => {
    const { ex, outcome, dialogue } = execute('sparse-measurements'), answers = outcome.responses.Q04!.answers;
    expect(answers['height.value']).toMatchObject({ state: 'known', value: { feet: 6, inches: 1 } });
    expect(answers['height.unit']).toMatchObject({ value: 'ft-in' });
    expect(answers['lastMeasuredWeight.value']).toMatchObject({ value: 91.5 });
    expect(answers['lastMeasuredWeight.unit']).toMatchObject({ value: 'kg' });
    expect(answers['lastMeasuredWeight.measuredWhen']).toMatchObject({ state: 'unknown' });
    expect(answers['lastMeasuredWeight.representsCurrent']).toMatchObject({ state: 'uncertain' });
    expect(answers['currentWeightEstimate.value']).toMatchObject({ state: 'known', value: 93 });
    expect(answers['currentWeightEstimate.unit']).toMatchObject({ value: 'kg' });
    expect(answers['currentWeightEstimate.statedAt']).toMatchObject({ value: ex.context.source.at });
    expect(answers['lastMeasuredWeight.describedAsOld']).toBeUndefined();
    expect(outcome.responses.Q06).toBeUndefined();
    const probes = eligibleAdaptiveProbes({ ...ex.context, responses: outcome.responses }).flatMap(probe => probe.targetPaths);
    expect(probes).not.toContain('lastMeasuredWeight.representsCurrent');
    expect(probes).not.toContain('lastMeasuredWeight.measuredWhen');
    expect(dialogue.prompt?.targetPaths).not.toContain('height.value');
    expect(evaluateTopic(ex.context.topics[0], outcome.responses.Q04!, { validSourceIds: new Set([ex.context.source.id]) }).sufficient).toBe(false);
  });
  it('stores volunteered portions separately, unavailable details only on their occasion, and completion without filler', () => {
    const { ex, outcome, dialogue } = execute('two-occasions'), answers = outcome.responses.Q11!.answers, occasions = items(answers.occasions);
    expect(occasions).toHaveLength(2);
    expect(occasions[0].answers).toMatchObject({ time: { value: '7 pm' }, foods: { value: 'lentil stew' }, foodAmounts: { state: 'unknown' } });
    expect(occasions[0].answers.drinks).toBeUndefined();
    expect(occasions[0].answers.drinkAdditions).toBeUndefined();
    expect(occasions[1].answers).toMatchObject({ time: { value: '9 pm' }, foods: { value: 'one pear' }, foodAmounts: { value: 'one pear' }, drinks: { value: 'mint tea' }, drinkAmounts: { value: 'a mug' }, drinkAdditions: { state: 'unknown' } });
    expect(answers.otherIntake).toMatchObject({ state: 'negative' });
    expect(answers.occasions).toMatchObject({ complete: true });
    expect(dialogue.prompt?.text).toBe('At 7 pm, what did you drink with that, if anything?');
    const probes = eligibleAdaptiveProbes({ ...ex.context, responses: outcome.responses }).flatMap(probe => probe.targetPaths);
    expect(probes.filter(path => path.endsWith('.foodAmounts') || path.endsWith('.drinkAdditions'))).toEqual([]);
    expect(evaluateTopic(ex.context.topics[0], outcome.responses.Q11!, { validSourceIds: new Set([ex.context.source.id]) }).sufficient).toBe(false);
  });
  it('keeps full corrected units and lineage, scoped negative concerns, and both concurrent requests without false capacity', () => {
    const { ex, outcome, canonical, dialogue } = execute('correction-and-questions'), medicines = items(outcome.responses.Q08!.answers.medicines);
    expect(medicines.map(item => item.answers.strength)).toEqual([
      { state: 'known', value: '10 mg', sourceIds: ['illustration-current'] },
      { state: 'known', value: '18 mg', sourceIds: ['illustration-prior'] },
    ]);
    expect(medicines.every(item => item.answers.concerns?.state === 'negative')).toBe(true);
    expect(canonical.facts[0]).toMatchObject({ correctsSourceIds: ['illustration-prior'] });
    expect(outcome.provenance[0]).toMatchObject({ sourceText: ['10 mg'], supportSourceText: ['Correction: Cetirizine is 10 mg, not 5 mg;'], correctsSourceIds: ['illustration-prior'] });
    expect(canonical.acts).toHaveLength(2);
    expect(canonical.acts.map(act => act.replyId)).toEqual(['COPY-02', 'COPY-04']);
    expect(ex.output.unmapped).toEqual([]);
    expect(dialogue.reply?.id).toBe('COPY-04');
    expect(dialogue.prompt?.targetPaths).toEqual(['medicines[allergy].labelDirections']);
    expect(outcome.responses.Q04).toBeUndefined();
  });
  it('preserves full uncertain recollection and family/question scope without invented patient states', () => {
    const { outcome, dialogue } = execute('uncertain-status-and-family');
    expect(items(outcome.responses.Q06!.answers.reportedConditions)[0].answers.term).toMatchObject({ state: 'uncertain', note: 'I was told I might have kidney disease.' });
    expect(outcome.responses.Q06!.answers['conditions.kidney']).toMatchObject({ state: 'uncertain' });
    expect(outcome.responses.Q06!.answers.uncertainDiagnosis).toMatchObject({ state: 'known', value: 'I was told I might have kidney disease.' });
    expect(items(outcome.responses.Q10!.answers.familyHistory)[0].answers).toMatchObject({ condition: { value: 'asthma' }, relationship: { value: 'sister' } });
    expect(outcome.responses.Q06!.answers['conditions.diabetes']).toBeUndefined();
    expect(outcome.responses.Q06!.answers['conditions.lung']).toBeUndefined();
    expect(dialogue.reply?.id).toBe('COPY-02');
    expect(dialogue.prompt?.targetPaths).not.toContain('conditions.kidney');
    expect(dialogue.prompt?.targetPaths).not.toContain('uncertainDiagnosis');
  });
  it('renders all four complete output objects and sources; every known value has one containing support', () => {
    const examples = createAdaptiveValueGuidanceExamples(), rendered = renderAdaptiveValueGuidanceExamples(examples).split('\n').map(line => JSON.parse(line));
    expect(rendered).toHaveLength(4);
    for (const [index, ex] of examples.entries()) {
      expect(rendered[index].output).toEqual(ex.output);
      expect(rendered[index].input.source).toBe(ex.context.source.text);
      for (const field of [...ex.output.facts, ...ex.output.newItems.flatMap(item => item.fields)]) {
        if (field.state === 'known') expect(field.evidence.some(support => support.quote.includes(field.value!.quote))).toBe(true);
        else expect(field.value).toBeNull();
      }
    }
    expect(adaptiveValueGuidance(restoredAdaptiveValueGuidanceRevision).instruction).toContain(renderAdaptiveValueGuidanceExamples(examples));
  });
});

describe('V5 version identity and full request budget', () => {
  it('reproduces historical V1 instruction, manifest and schemas for all saved A11 contexts', () => {
    expect(adaptiveValueGuidance().receipt).toEqual({ revision: adaptiveValueGuidanceRevision, instructionSha256: '62ebcadc4b55054c3d3ae7716269503bbb44a427e1517615873b290458668c3d' });
    const receipt = JSON.parse(readFileSync(new URL('../../../docs/implementation/evidence/DO-A11.json', import.meta.url), 'utf8'));
    for (const record of receipt.results) {
      const manifest = createAdaptiveValueManifest(record.context);
      expect(manifest.id).toBe(record.preflight.manifest.id);
      expect(manifest.sha256).toBe(record.preflight.manifest.sha256);
    }
  });
  it('uses interpretable state profiles while preserving every destination, label, value shape, choice and condition', () => {
    const ctx = context('More energy.', register.topics.map(topic => topic.id));
    const old = Object.assign({}, ...createAdaptiveValueManifest(ctx).payloads) as any;
    const revised = Object.assign({}, ...createAdaptiveValueManifest(ctx, restoredAdaptiveValueGuidanceRevision).payloads) as any;
    const expand = (entry: any) => ({ ...revised.targetDefaults, ...entry, states: revised.stateProfiles[entry.states ?? revised.targetDefaults.states] });
    expect(revised.topics.map((topic: any) => ({ ...topic, targets: topic.targets.map(expand), collections: topic.collections.map((collection: any) => ({ ...collection, fields: collection.fields.map(expand) })) }))).toEqual(old.topics);
    expect(revised.source).toBe(old.source);
    expect(revised.sourceSegments).toEqual(old.sourceSegments);
    expect(revised.currentFacts).toEqual(old.currentFacts);
  });
  it('keeps the rich patient payload intact under unchanged full-body/native-schema/output/timeout bounds', async () => {
    const known = (value: string) => ({ state: 'known' as const, value, sourceIds: ['prior'] });
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
    const old = await prepareAdaptiveRequest(ctx, config, { protocol: valueEvidenceProtocol });
    const prepared = await prepareAdaptiveRequest(ctx, config, options), body = JSON.parse(prepared.body);
    const payload = Object.assign({}, ...createAdaptiveValueManifest(ctx, restoredAdaptiveValueGuidanceRevision).payloads) as any;
    expect(payload.source).toBe(ctx.source.text);
    expect(payload.currentFacts).toEqual((Object.assign({}, ...createAdaptiveValueManifest(ctx).payloads) as any).currentFacts);
    expect(payload.topics.map((topic: any) => topic.topicId)).toEqual(ctx.topics.map(topic => topic.id));
    const schemaBytes = Buffer.byteLength(JSON.stringify(body.response_format.json_schema.schema));
    console.info(JSON.stringify({ kind: 'v5-v2-rich-offline-preflight', requestBytes: prepared.requestBytes, baselineRequestBytes: old.requestBytes, schemaBytes, instructionBytes: Buffer.byteLength(body.messages[0].content), instructionSha256: prepared.guidance?.instructionSha256, topicCount: ctx.topics.length }));
    expect(prepared.requestBytes).toBeLessThanOrEqual(60000);
    expect(schemaBytes).toBeLessThanOrEqual(32000);
    expect(body.max_tokens).toBe(4096);
    expect(config.timeoutMs).toBe(15000);
    expect(prepared.guidance?.revision).toBe(restoredAdaptiveValueGuidanceRevision);
    expect(prepared.guidance?.instructionSha256).toBe(createHash('sha256').update(body.messages[0].content).digest('hex'));
  });
  it.each(Object.keys(register.scenarios))('retains all admitted scenario and branch catalogs under the request cap: %s', async scenarioId => {
    const scenario = register.scenarios[scenarioId as keyof typeof register.scenarios];
    const ctx = context('I have another detail to add.', ['Q01'], scenarioId as any);
    ctx.topics = [...register.topics.filter(topic => scenario.reusableTopicIds.includes(topic.id as any)), ...scenario.additionalTopics, ...Object.values(register.branches).map(branch => branch.topic)];
    const prepared = await prepareAdaptiveRequest(ctx, config, options);
    expect(prepared.requestBytes).toBeLessThanOrEqual(60000);
    const payload = Object.assign({}, ...createAdaptiveValueManifest(ctx, restoredAdaptiveValueGuidanceRevision).payloads) as any;
    expect(payload.topics.map((topic: any) => topic.topicId)).toEqual(ctx.topics.map(topic => topic.id));
    expect(payload.source).toBe(ctx.source.text);
  });
  it.each([false, true])('binds V2 preflight and mocked dispatch/rejection to identical instruction/schema/body (malformed=%s)', async malformed => {
    const ex = example('sparse-measurements'), raw = malformed ? { ...ex.output, next: 'invented' } : ex.output;
    const prepared = await prepareAdaptiveRequest(ex.context, config, options);
    const fetcher = vi.fn(async (_url, init) => {
      expect(init?.body).toBe(prepared.body);
      return new Response(JSON.stringify({ id: 'offline-v2-mock', model: config.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }] }));
    });
    const pending = createDigitalOceanProposer(config, fetcher, options).propose(ex.context);
    if (malformed) await expect(pending).rejects.toMatchObject({ code: 'invalid-contextual-value-proposal', rawProposal: raw, receipt: { guidance: prepared.guidance, manifest: prepared.manifest, responseSchema: prepared.responseSchema } });
    else expect(await pending).toMatchObject({ rawProposal: raw, receipt: { guidance: prepared.guidance, manifest: prepared.manifest, responseSchema: prepared.responseSchema } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects cross-protocol or unknown guide selections before dispatch', async () => {
    const fetcher = vi.fn(), ctx = context('More energy.', ['Q01']);
    await expect(createDigitalOceanProposer(config, fetcher, { protocol: valueEvidenceProtocol, guidanceRevision: 'v4-a7' }).propose(ctx)).rejects.toThrow('invalid-guidance-revision');
    await expect(createDigitalOceanProposer(config, fetcher, { protocol: 'contextual-handles-v4', guidanceRevision: restoredAdaptiveValueGuidanceRevision }).propose(ctx)).rejects.toThrow('invalid-guidance-revision');
    await expect(createDigitalOceanProposer(config, fetcher, { protocol: valueEvidenceProtocol, guidanceRevision: 'invented' as any }).propose(ctx)).rejects.toThrow('invalid-guidance-revision');
    expect(fetcher).not.toHaveBeenCalled();
    expect(buildAdaptiveMessages(ctx, valueEvidenceProtocol, { guidanceRevision: restoredAdaptiveValueGuidanceRevision })[0].content).toBe(adaptiveValueGuidance(restoredAdaptiveValueGuidanceRevision).instruction);
  });
});
