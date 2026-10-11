import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAdaptiveValueGuidanceExamples } from '../src/adaptive-value-guidance.js';
import { adaptiveValueGuidance, createAdaptiveValueManifest, resolveAdaptiveValueProposal, restoredAdaptiveValueGuidanceRevision } from '../src/adaptive-value-manifest.js';
import { applyValidatedTurn, validateAdaptiveProposal, type AdaptiveContext } from '../src/adaptive-validation.js';
import { selectAdaptiveDialogue } from '../src/dialogue.js';
import { context } from './fixtures/adaptive.js';

const project = (manifest: ReturnType<typeof createAdaptiveValueManifest>) => Object.assign({}, ...manifest.payloads);
const example = (name: string) => createAdaptiveValueGuidanceExamples().find(entry => entry.name === name)!;

describe('independent restored V5 guidance boundaries', () => {
  it('expands profiles/defaults losslessly for every saved development context', () => {
    const receipt = JSON.parse(readFileSync(new URL('../../../docs/implementation/evidence/DO-A11.json', import.meta.url), 'utf8'));
    for (const record of receipt.results) {
      const old = project(createAdaptiveValueManifest(record.context));
      const revised = project(createAdaptiveValueManifest(record.context, restoredAdaptiveValueGuidanceRevision));
      const expand = (entry: Record<string, unknown>) => ({ ...revised.targetDefaults, ...entry, states: revised.stateProfiles[entry.states ?? revised.targetDefaults.states] });
      expect(revised.topics.map((topic: any) => ({ ...topic, targets: topic.targets.map(expand), collections: topic.collections.map((collection: any) => ({ ...collection, fields: collection.fields.map(expand) })) }))).toEqual(old.topics);
      for (const key of ['source', 'sourceSegments', 'currentFacts', 'replies', 'displayed']) expect(revised[key]).toEqual(old[key]);
    }
  });

  it('does not turn a rejected old correction value into the new strength', () => {
    const ex = example('correction-and-questions'), raw = structuredClone(ex.output);
    raw.facts[0].value!.quote = '5 mg';
    const outcome = applyValidatedTurn(ex.context, validateAdaptiveProposal(resolveAdaptiveValueProposal(raw, ex.context, ex.manifest), ex.context));
    expect(outcome.updates.some(update => update.path === 'medicines[allergy].strength')).toBe(false);
    const medicines = outcome.responses.Q08!.answers.medicines;
    expect(medicines?.state === 'known' && medicines.items?.find(item => item.id === 'allergy')?.answers.strength).toEqual({ state: 'known', value: '5 mg', sourceIds: ['illustration-prior'] });
    expect(outcome.hasUnresolvedInterpretation).toBe(true);
  });

  it('keeps broader uncertain support from authorizing a stripped positive condition value', () => {
    const ex = example('uncertain-status-and-family'), raw = structuredClone(ex.output);
    const field = raw.newItems[0].fields[0];
    field.state = 'known'; field.value = { source: field.evidence[0].source, quote: 'kidney disease' };
    const outcome = applyValidatedTurn(ex.context, validateAdaptiveProposal(resolveAdaptiveValueProposal(raw, ex.context, ex.manifest), ex.context));
    expect(outcome.responses.Q06?.answers['conditions.kidney']).toBeUndefined();
    expect(outcome.responses.Q06?.answers.uncertainDiagnosis).toBeUndefined();
    expect(outcome.clarifications).not.toEqual([]);
    expect(selectAdaptiveDialogue(ex.context, outcome).reply?.id).toBe('COPY-02');
  });

  it('rejects a missing selected known value before application', () => {
    const ex = example('sparse-measurements'), raw = structuredClone(ex.output) as any;
    delete raw.facts[0].value;
    expect(() => resolveAdaptiveValueProposal(raw, ex.context, ex.manifest)).toThrow('invalid-contextual-value-proposal');
    expect(ex.context.responses).toEqual({});
  });

  it('distinguishes prescribing from dose boundaries while retaining both questions', () => {
    const ctx: AdaptiveContext = context('Can you prescribe a medicine for me? Should I repeat my dose?', ['Q04']);
    const manifest = createAdaptiveValueManifest(ctx, restoredAdaptiveValueGuidanceRevision), payload = project(manifest);
    const question = (quote: string, replyId: string) => ({ kind: 'question', evidence: [{ source: payload.sourceSegments.find((row: string[]) => row[1] === 'sentence' && row[2].includes(quote))[0], quote }], topic: null, reply: payload.replies.find((reply: { id: string }) => reply.id === replyId).ref });
    const raw = { schema: 5, context: manifest.id, facts: [], newItems: [], completedLists: [], interruptions: [question('Can you prescribe a medicine for me?', 'COPY-04'), question('Should I repeat my dose?', 'COPY-05')], unmapped: [] };
    const canonical = resolveAdaptiveValueProposal(raw, ctx, manifest);
    const outcome = applyValidatedTurn(ctx, validateAdaptiveProposal(canonical, ctx));
    expect(outcome.acts.map(act => act.replyId)).toEqual(['COPY-04', 'COPY-05']);
    expect(outcome.hasUnresolvedInterpretation).toBe(false);
    expect(selectAdaptiveDialogue(ctx, outcome).reply?.id).toBe('COPY-05');
    const ex = example('correction-and-questions');
    expect(resolveAdaptiveValueProposal(ex.output, ex.context, ex.manifest).acts.map(act => act.replyId)).toEqual(['COPY-02', 'COPY-04']);
    expect(adaptiveValueGuidance(restoredAdaptiveValueGuidanceRevision).instruction).toContain('Treatment/prescribing/eligibility questions use COPY-04');
  });
});
