import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sourcedMeaningsGuidance } from '../src/adaptive-guidance.js';
import { contextualEvidenceProtocol, createAdaptiveManifest, resolveContextualAdaptiveProposal } from '../src/adaptive-manifest.js';
import { prepareAdaptiveRequest } from '../src/adaptive.js';
import { applyValidatedTurn, validateAdaptiveProposal } from '../src/adaptive-validation.js';
import { eligibleAdaptiveProbes, selectAdaptiveDialogue } from '../src/dialogue.js';
import { context, withPrior } from './fixtures/adaptive.js';

const config = { endpoint: 'https://inference.do-ai.run' as const, apiKey: 'offline-test-only', model: 'qwen3.8-max' as const, timeoutMs: 15000, maxOutputTokens: 4096 };
const options = { protocol: contextualEvidenceProtocol, guidanceRevision: sourcedMeaningsGuidance };

describe('independent sourced-meanings guidance checks', () => {
  it('hashes exact rendered system bytes and keeps multi-byte patient context intact', async () => {
    const ctx = context('I wrote “café ☕” in my diary; I do not have another detail.', ['Q01']);
    const historical = await prepareAdaptiveRequest(ctx, config, { protocol: contextualEvidenceProtocol });
    const revised = await prepareAdaptiveRequest(ctx, config, options);
    const oldBody = JSON.parse(historical.body), newBody = JSON.parse(revised.body);
    expect(revised.guidance?.instructionSha256).toBe(createHash('sha256').update(newBody.messages[0].content, 'utf8').digest('hex'));
    expect(revised.requestBytes).toBe(Buffer.byteLength(revised.body, 'utf8'));
    expect(revised.requestBytes).toBeGreaterThan(revised.body.length);
    expect(newBody.messages.slice(1)).toEqual(oldBody.messages.slice(1));
    expect(JSON.parse(newBody.messages[1].content).source).toBe(ctx.source.text);
    expect(revised.manifest).toEqual(historical.manifest);
    expect(revised.responseSchema).toEqual(historical.responseSchema);
    expect({ ...newBody, messages: undefined }).toEqual({ ...oldBody, messages: undefined });
  });

  it('retains concise medicine identity, scoped unavailability and a separate label detail without catalog filling', () => {
    const ctx = context("I take Loratadine 10 mg. I don't remember Loratadine label directions. I take Zinc 25 mg. Zinc label says once daily.", ['Q08', 'Q06']);
    const manifest = createAdaptiveManifest(ctx);
    const payload = Object.assign({}, ...manifest.payloads) as any;
    const collection = payload.topics.find((topic: any) => topic.topicId === 'Q08').collections.find((entry: any) => entry.path === 'medicines');
    const evidence = (quote: string, sentence: string) => {
      const segment = payload.sourceSegments.find((row: string[]) => row[1] === 'sentence' && row[2].trim() === sentence);
      if (!segment) throw new Error(`Missing independent source sentence: ${sentence}`);
      return [{ source: segment[0], quote }];
    };
    const field = (path: string, quote: string, sentence: string, state = 'known') => ({ field: collection.fields.find((row: string[]) => row[1] === path)[0], state, evidence: evidence(quote, sentence) });
    const raw = { schema: 4, context: manifest.id, facts: [], newItems: [
      { collection: collection.ref, fields: [
        field('name', 'Loratadine', 'I take Loratadine 10 mg.'), field('strength', '10 mg', 'I take Loratadine 10 mg.'),
        field('labelDirections', "I don't remember Loratadine label directions.", "I don't remember Loratadine label directions.", 'unknown'),
      ] },
      { collection: collection.ref, fields: [
        field('name', 'Zinc', 'I take Zinc 25 mg.'), field('strength', '25 mg', 'I take Zinc 25 mg.'),
        field('labelDirections', 'Zinc label says once daily.', 'Zinc label says once daily.'),
      ] },
    ], completedLists: [], interruptions: [], unmapped: [] };
    const canonical = resolveContextualAdaptiveProposal(raw, ctx, manifest);
    const outcome = applyValidatedTurn(ctx, validateAdaptiveProposal(canonical, ctx));
    expect(outcome.clarifications).toEqual([]);
    expect(outcome.hasUnresolvedInterpretation).toBe(false);
    const medicines = outcome.responses.Q08?.answers.medicines;
    if (medicines?.state !== 'known') throw new Error('Expected the two reported medicines');
    expect(medicines.items).toHaveLength(2);
    expect(medicines.items![0].answers).toEqual({
      name: { state: 'known', value: 'Loratadine', sourceIds: [ctx.source.id] },
      strength: { state: 'known', value: '10 mg', sourceIds: [ctx.source.id] },
      labelDirections: { state: 'unknown', note: "I don't remember Loratadine label directions.", sourceIds: [ctx.source.id] },
    });
    expect(medicines.items![1].answers.labelDirections).toMatchObject({ state: 'known', value: 'Zinc label says once daily.' });
    expect(medicines.complete).not.toBe(true);
    expect(outcome.responses.Q06).toBeUndefined();
    const unavailablePath = `medicines[${medicines.items![0].id}].labelDirections`;
    expect(eligibleAdaptiveProbes({ ...ctx, responses: outcome.responses }).flatMap(probe => probe.targetPaths)).not.toContain(unavailablePath);
    expect(selectAdaptiveDialogue(ctx, outcome).prompt?.targetPaths).not.toContain(unavailablePath);
  });

  it.each(['. ', ';\t  ', '\n  '])('anchors the following medicine heading after preceding evidence, preserving entity denial (delimiter=%j)', delimiter => {
    const unknown = `Loratadine: I don't remember the label directions${delimiter[0]}`;
    const ctx = withPrior(context(`${unknown}${delimiter.slice(1)}Zinc: 25 mg.`, ['Q08']), 'Q08', {
      medicines: { state: 'known', sourceIds: ['prior'], items: [
        { id: 'loratadine', answers: { name: { state: 'known', value: 'Loratadine', sourceIds: ['prior'] } } },
        { id: 'zinc', answers: { name: { state: 'known', value: 'Zinc', sourceIds: ['prior'] } } },
      ] },
    });
    const manifest = createAdaptiveManifest(ctx), payload = Object.assign({}, ...manifest.payloads) as any;
    const targets = payload.topics[0].targets;
    const evidence = (quote: string) => {
      const segment = payload.sourceSegments.find((row: string[]) => row[1] === 'sentence' && row[2].includes(quote));
      return [{ source: segment[0], quote }];
    };
    const fact = (path: string, quote: string, state = 'known') => ({ target: targets.find((row: string[]) => row[1] === path)[0], state, evidence: evidence(quote), operation: 'assert' });
    const wire = (facts: unknown[]) => ({ schema: 4, context: manifest.id, facts, newItems: [], completedLists: [], interruptions: [], unmapped: [] });
    const apply = (raw: unknown) => applyValidatedTurn(ctx, validateAdaptiveProposal(resolveContextualAdaptiveProposal(raw, ctx, manifest), ctx));
    const outcome = apply(wire([fact('medicines[loratadine].labelDirections', unknown, 'unknown'), fact('medicines[zinc].strength', '25 mg')]));
    expect(outcome.clarifications).toEqual([]);
    const medicines = outcome.responses.Q08?.answers.medicines;
    if (medicines?.state !== 'known') throw new Error('Expected retained medicine entities');
    expect(medicines.items![0].answers.labelDirections).toMatchObject({ state: 'unknown', note: unknown });
    expect(medicines.items![1].answers.strength).toMatchObject({ state: 'known', value: '25 mg' });
    const crossed = apply(wire([fact('medicines[loratadine].strength', '25 mg')]));
    expect(crossed.clarifications).toEqual([expect.objectContaining({ path: 'medicines[loratadine].strength', reason: 'ambiguous-value' })]);
  });
});
