import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { evaluateTopic, type SlotAnswer } from '../../clinic-content/src/index.js';
import { adaptiveContextInstruction, contextualEvidenceProtocol, createAdaptiveManifest, resolveContextualAdaptiveProposal } from '../src/adaptive-manifest.js';
import { adaptiveGuidance, createAdaptiveGuidanceExamples, historicalAdaptiveGuidance, renderAdaptiveGuidanceExamples, sourcedMeaningsGuidance, type AdaptiveGuidanceExample } from '../src/adaptive-guidance.js';
import { adaptiveEvidenceProtocol, buildAdaptiveMessages, createDigitalOceanProposer, prepareAdaptiveRequest } from '../src/adaptive.js';
import { applyValidatedTurn, validateAdaptiveProposal } from '../src/adaptive-validation.js';
import { eligibleAdaptiveProbes, selectAdaptiveDialogue } from '../src/dialogue.js';
import { context, register, source } from './fixtures/adaptive.js';

const config = { endpoint: 'https://inference.do-ai.run' as const, apiKey: 'test-only-secret', model: 'qwen3.8-max' as const, timeoutMs: 15000, maxOutputTokens: 4096 };
const options = { protocol: contextualEvidenceProtocol, guidanceRevision: sourcedMeaningsGuidance };
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
function execute(example: AdaptiveGuidanceExample) {
  const canonical = resolveContextualAdaptiveProposal(example.output, example.context, example.manifest);
  const outcome = applyValidatedTurn(example.context, validateAdaptiveProposal(canonical, example.context));
  const dialogue = selectAdaptiveDialogue(example.context, outcome);
  const readiness = example.context.topics.map(topic => evaluateTopic(topic, outcome.responses[topic.id] ?? { presented: false, answers: {} }, { validSourceIds: new Set(example.context.sources.map(source => source.id)) }));
  return { canonical, outcome, dialogue, readiness };
}
const exampleNamed = (name: string) => createAdaptiveGuidanceExamples().find(example => example.name === name)!;
const items = (answer?: SlotAnswer) => answer?.state === 'known' ? answer.items ?? [] : [];

describe('executable v4 guidance demonstrations', () => {
  it.each(['sparse-measurements', 'two-occasions', 'correction-and-question', 'uncertain-status-and-family'])('runs the exact rendered %s output through resolve, validate, apply, dialogue and readiness', name => {
    const example = exampleNamed(name), rendered = JSON.parse(renderAdaptiveGuidanceExamples([example]));
    expect(rendered.output).toEqual(example.output);
    const { outcome, dialogue, readiness } = execute({ ...example, output: rendered.output });
    expect(outcome.clarifications).toEqual([]);
    expect(outcome.hasUnresolvedInterpretation).toBe(false);
    expect(outcome.unresolvedQuestions ?? []).toEqual([]);
    expect(dialogue.status).toBe('question');
    expect(dialogue.prompt?.topicId).toBe(example.context.displayed!.topicId);
    expect(readiness.find(topic => topic.topicId === example.context.displayed!.topicId)?.sufficient).toBe(false);
    for (const provenance of outcome.provenance) {
      expect(provenance.sourceText).toEqual(provenance.evidence.map(span => example.context.source.text.slice(span.start, span.end)));
    }
  });

  it('uses numeric/composite literals, stops an unavailable detail and leaves the unrelated condition catalog absent', () => {
    const example = exampleNamed('sparse-measurements'), { outcome, dialogue, readiness } = execute(example);
    expect(outcome.responses.Q04?.answers).toEqual({
      'height.value': { state: 'known', value: { feet: 6, inches: 1 }, sourceIds: ['illustration-current'] },
      'height.unit': { state: 'known', value: 'ft-in', sourceIds: ['illustration-current'] },
      'lastMeasuredWeight.value': { state: 'known', value: 91.5, sourceIds: ['illustration-current'] },
      'lastMeasuredWeight.unit': { state: 'known', value: 'kg', sourceIds: ['illustration-current'] },
      'lastMeasuredWeight.measuredWhen': { state: 'unknown', note: "I don't remember the measurement date.", sourceIds: ['illustration-current'] },
    });
    expect(outcome.responses.Q06).toBeUndefined();
    expect(dialogue.prompt?.targetPaths).toEqual(['lastMeasuredWeight.representsCurrent']);
    const eligible = eligibleAdaptiveProbes({ ...example.context, responses: outcome.responses }).flatMap(probe => probe.targetPaths);
    expect(eligible).not.toContain('lastMeasuredWeight.measuredWhen');
    expect(eligible).not.toContain('lastMeasuredWeight.datePrecision');
    expect(readiness[0].unresolvedSlotIds).toContain('lastMeasuredWeight.measuredWhen');
  });

  it('keeps concise occasion values, explicit unknown versus absent fields, and closed-list partial readiness', () => {
    const { outcome, dialogue, readiness } = execute(exampleNamed('two-occasions'));
    const answers = outcome.responses.Q11!.answers, occasions = items(answers.occasions);
    expect(answers.day).toMatchObject({ state: 'known', value: 'Tuesday' });
    expect(answers.otherIntake).toMatchObject({ state: 'negative' });
    expect(answers.occasions).toMatchObject({ state: 'known', complete: true });
    expect(occasions).toHaveLength(2);
    expect(occasions[0].answers).toEqual({
      time: { state: 'known', value: '7 pm', sourceIds: ['illustration-current'] },
      foods: { state: 'known', value: 'lentil stew', sourceIds: ['illustration-current'] },
      foodAmounts: { state: 'unknown', note: 'I cannot recall the stew portion.', sourceIds: ['illustration-current'] },
    });
    expect(occasions[1].answers).toEqual({
      time: { state: 'known', value: '9 pm', sourceIds: ['illustration-current'] },
      drinks: { state: 'known', value: 'mint tea', sourceIds: ['illustration-current'] },
      drinkAmounts: { state: 'known', value: 'a mug', sourceIds: ['illustration-current'] },
    });
    expect(dialogue.prompt?.text).toBe('At 7 pm, what did you drink with that, if anything?');
    expect(dialogue.prompt?.targetPaths).toEqual([`occasions[${occasions[0].id}].drinks`]);
    expect(readiness[0].sufficient).toBe(false);
    expect(readiness[0].unresolvedSlotIds).toContain(`occasions[${occasions[0].id}].foodAmounts`);
  });

  it('changes only the corrected existing strength, retains lineage and answers the concurrent question before a genuine gap', () => {
    const example = exampleNamed('correction-and-question'), { canonical, outcome, dialogue } = execute(example);
    expect(canonical.facts).toHaveLength(1);
    expect(canonical.facts[0]).toMatchObject({ path: 'medicines[allergy].strength', correctsSourceIds: ['illustration-prior'] });
    expect(outcome.updates).toHaveLength(1);
    expect(items(outcome.responses.Q08!.answers.medicines).map(item => item.answers.strength)).toEqual([
      { state: 'known', value: '10 mg', sourceIds: ['illustration-current'] },
      { state: 'known', value: '18 mg', sourceIds: ['illustration-prior'] },
    ]);
    expect(outcome.responses.Q04).toBeUndefined();
    expect(dialogue.reply?.id).toBe('COPY-02');
    expect(dialogue.prompt?.targetPaths).toEqual(['medicines[allergy].labelDirections']);
    expect(dialogue.prompt?.text).toBe("What directions are written on your Cetirizine label? Please don't guess if you aren't sure.");
    expect(outcome.provenance[0].correctsSourceIds).toEqual(['illustration-prior']);
  });

  it('retains uncertain recollection and family identity without a positive patient diagnosis or another diagnosis question', () => {
    const { outcome, dialogue } = execute(exampleNamed('uncertain-status-and-family'));
    expect(items(outcome.responses.Q06!.answers.reportedConditions)[0].answers.term).toMatchObject({ state: 'uncertain', note: 'I was told I might have kidney disease.' });
    expect(outcome.responses.Q06?.answers['conditions.kidney']).toMatchObject({ state: 'uncertain' });
    expect(outcome.responses.Q06?.answers.uncertainDiagnosis).toMatchObject({ state: 'known', value: 'I was told I might have kidney disease.' });
    expect(items(outcome.responses.Q10!.answers.familyHistory)[0].answers).toEqual({
      condition: { state: 'known', value: 'asthma', sourceIds: ['illustration-current'] },
      relationship: { state: 'known', value: 'sister', sourceIds: ['illustration-current'] },
    });
    expect(Object.entries(outcome.responses.Q06!.answers).filter(([path]) => path.startsWith('conditions.')).map(([path, answer]) => [path, answer?.state])).toEqual([['conditions.kidney', 'uncertain']]);
    expect(outcome.provenance.find(entry => entry.path === 'conditions.kidney')?.derivedFrom?.version).toBe('evidence-coverage-v1');
    expect(dialogue.prompt?.targetPaths).not.toContain('conditions.kidney');
    expect(dialogue.prompt?.targetPaths).not.toContain('uncertainDiagnosis');
  });
});

describe('versioned instruction identity without changed v4 mechanics', () => {
  it('preserves A7 bytes and the existing v2 default', () => {
    const ctx = context('I have a detail to share.', ['Q01']);
    expect(adaptiveGuidance().instruction).toBe(adaptiveContextInstruction);
    expect(adaptiveGuidance().receipt).toEqual({ revision: historicalAdaptiveGuidance, instructionSha256: '26a621cc8630a2047245193bcbbc897b0a279b2789997b5f52b28f4daf35fadf' });
    expect(buildAdaptiveMessages(ctx, contextualEvidenceProtocol)[0].content).toBe(adaptiveContextInstruction);
    expect(buildAdaptiveMessages(ctx)).toEqual(buildAdaptiveMessages(ctx, adaptiveEvidenceProtocol));
    expect(buildAdaptiveMessages(ctx, contextualEvidenceProtocol, { guidanceRevision: historicalAdaptiveGuidance })).toEqual(buildAdaptiveMessages(ctx, contextualEvidenceProtocol));
  });

  it('changes only system content, with exact hash/body accounting and identical schema, manifest and patient context', async () => {
    const ctx = context('I have a detail to share.', ['Q01']);
    const historical = await prepareAdaptiveRequest(ctx, config, { protocol: contextualEvidenceProtocol });
    const revised = await prepareAdaptiveRequest(ctx, config, options);
    const oldBody = JSON.parse(historical.body), newBody = JSON.parse(revised.body);
    expect(revised.guidance).toEqual({ revision: sourcedMeaningsGuidance, instructionSha256: hash(newBody.messages[0].content) });
    expect(revised.guidance!.instructionSha256).not.toBe(historical.guidance!.instructionSha256);
    expect(newBody.messages.slice(1)).toEqual(oldBody.messages.slice(1));
    expect({ ...newBody, messages: undefined }).toEqual({ ...oldBody, messages: undefined });
    expect(revised.manifest).toEqual(historical.manifest);
    expect(revised.responseSchema).toEqual(historical.responseSchema);
    expect(revised.requestBytes).toBe(Buffer.byteLength(revised.body));
    expect(newBody.messages[0].content).toContain(renderAdaptiveGuidanceExamples(createAdaptiveGuidanceExamples()));
  });

  it('rejects incompatible or unknown revisions before dispatch instead of silently selecting another instruction', async () => {
    const fetcher = vi.fn(), ctx = context('My height is 180 cm.');
    await expect(createDigitalOceanProposer(config, fetcher, { guidanceRevision: sourcedMeaningsGuidance }).propose(ctx)).rejects.toThrow('guidance-requires-contextual-protocol');
    await expect(createDigitalOceanProposer(config, fetcher, { protocol: contextualEvidenceProtocol, guidanceRevision: 'invented' as any }).propose(ctx)).rejects.toThrow('invalid-guidance-revision');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([false, true])('receipts the same exact instruction on provider success/rejection (malformed=%s), without repair calls', async malformed => {
    const example = exampleNamed('sparse-measurements');
    const raw = malformed ? { ...example.output, next: 'invented' } : example.output;
    const fetcher = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(JSON.stringify({ id: 'guidance-test', model: config.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }] })));
    const prepared = await prepareAdaptiveRequest(example.context, config, options);
    const proposed = createDigitalOceanProposer(config, fetcher, options).propose(example.context);
    if (malformed) await expect(proposed).rejects.toMatchObject({ code: 'invalid-contextual-proposal', rawProposal: raw, receipt: { guidance: prepared.guidance, manifest: prepared.manifest } });
    else expect(await proposed).toMatchObject({ rawProposal: raw, receipt: { guidance: prepared.guidance, manifest: prepared.manifest } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.body).toBe(prepared.body);
  });

  it.each(Object.keys(register.scenarios))('retains all admitted scenario and branch context within the unchanged request cap: %s', async scenarioId => {
    const scenario = register.scenarios[scenarioId as keyof typeof register.scenarios];
    const ctx = context('I have another detail to share.', ['Q01'], scenarioId as any);
    ctx.topics = [...register.topics.filter(topic => scenario.reusableTopicIds.includes(topic.id as any)), ...scenario.additionalTopics, ...Object.values(register.branches).map(branch => branch.topic)];
    const prepared = await prepareAdaptiveRequest(ctx, config, options), body = JSON.parse(prepared.body);
    expect(prepared.requestBytes).toBe(Buffer.byteLength(prepared.body));
    expect(prepared.requestBytes).toBeLessThanOrEqual(60000);
    expect(body.messages.every((message: { content: string }) => message.content.length <= 32000)).toBe(true);
    expect(body.messages.slice(1)).toEqual(buildAdaptiveMessages(ctx, contextualEvidenceProtocol).slice(1));
    expect((Object.assign({}, ...createAdaptiveManifest(ctx).payloads) as any).topics.map((topic: any) => topic.topicId)).toEqual(ctx.topics.map(topic => topic.id));
  });

  it.each([false, true])('preserves rich late-intake facts without truncation under the same request budget (include unknowns=%s)', async includeUnknowns => {
    const ctx = context('There is something else I want to add.');
    ctx.topics = [...register.topics, ...Object.values(register.branches).map(branch => branch.topic)];
    const answers: any = {};
    for (const topic of ctx.topics) answers[topic.id] = { presented: true, answers: Object.fromEntries(topic.slots.filter(slot => slot.kind === 'text').slice(0, 3).map((slot, index) => [slot.id, includeUnknowns && index === 1 ? { state: 'unknown', note: 'I do not remember this detail.', sourceIds: ['prior'] } : { state: 'known', value: 'I remember this part of my life. '.repeat(8), sourceIds: ['prior'] }])) };
    ctx.responses = answers; ctx.sources = [source('Earlier detailed answers', 'prior'), ctx.source];
    const prepared = await prepareAdaptiveRequest(ctx, config, options), body = JSON.parse(prepared.body);
    expect(prepared.requestBytes).toBeLessThanOrEqual(60000);
    expect(body.messages.slice(1)).toEqual(buildAdaptiveMessages(ctx, contextualEvidenceProtocol).slice(1));
    const facts = Object.assign({}, ...createAdaptiveManifest(ctx).payloads) as any;
    for (const [id, response] of Object.entries(answers) as any) for (const [path, answer] of Object.entries(response.answers) as any) {
      expect(facts.currentFacts[id].answers[path].slice(0, 3)).toEqual([answer.state, answer.value ?? null, answer.sourceIds]);
      if (answer.note) expect(facts.currentFacts[id].answers[path][3]).toBe(answer.note);
    }
  });
});
