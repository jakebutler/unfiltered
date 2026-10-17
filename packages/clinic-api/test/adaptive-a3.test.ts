import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adaptiveWireExamples, buildAdaptiveMessages, resolveQuotedAdaptiveProposal } from '../src/adaptive.js';
import { applyValidatedTurn, validateAdaptiveProposal, type AdaptiveContext, type AdaptiveOutcome, type AdaptiveProposal } from '../src/adaptive-validation.js';
import { selectAdaptiveDialogue } from '../src/dialogue.js';
import { context, evidence, fact, proposal, source, withPrior } from './fixtures/adaptive.js';
const retained = JSON.parse(readFileSync(new URL('../../../docs/implementation/evidence/DO-A2.json', import.meta.url), 'utf8')) as { results: { caseId: string; context: AdaptiveContext; rawProviderProposal: unknown; proposal?: AdaptiveProposal; outcome?: AdaptiveOutcome }[] };
const known = (value: string, sourceId = 'earlier-turn') => ({ state: 'known' as const, value, sourceIds: [sourceId] });
const apply = (ctx: AdaptiveContext, wire: unknown) => applyValidatedTurn(ctx, validateAdaptiveProposal(resolveQuotedAdaptiveProposal(wire, ctx), ctx));

describe('A3 complete wire examples and strict historical counterexamples', () => {
  it.each(adaptiveWireExamples.map((example, index) => ({ example, index })))('validates and applies the actual complete prompt example $index', ({ example, index }) => {
    const ctx = context(example.source.text, [index === 0 ? 'Q04' : index === 1 ? 'Q10' : 'Q08']);
    ctx.source = source(example.source.text, example.source.id); ctx.sources = [ctx.source];
    if ('prior' in example) {
      ctx.sources = [source('Earlier medicine details', 'earlier-turn'), ctx.source];
      ctx.responses = { Q08: { presented: true, answers: { medicines: { state: 'known', complete: false, sourceIds: ['earlier-turn'], items: example.prior.items.map(item => ({ id: item.id, answers: { name: known(item.name), strength: known(item.strength) } })) } } } };
    }
    const result = apply(ctx, example.proposal);
    expect(result.clarifications).toEqual([]);
    if (index === 0) {
      expect(result.responses.Q04?.answers).toMatchObject({ 'lastMeasuredWeight.value': { value: 207 }, 'lastMeasuredWeight.unit': { value: 'lb' }, 'currentWeightEstimate.value': { value: 209 }, 'currentWeightEstimate.unit': { value: 'lb' } });
      expect(result.provenance.find(item => item.path === 'lastMeasuredWeight.unit')?.evidence[0].start).not.toBe(result.provenance.find(item => item.path === 'currentWeightEstimate.unit')?.evidence[0].start);
    } else if (index === 1) {
      expect(result.responses.Q06).toBeUndefined();
      expect(result.responses.Q10?.answers.familyHistory).toMatchObject({ state: 'known', items: [{ answers: { condition: { value: 'diabetes' }, relationship: { value: 'father' } } }] });
      expect(selectAdaptiveDialogue(ctx, result).reply?.id).toBe('COPY-02');
    } else {
      expect(result.updates.map(update => update.path)).toEqual(['medicines[m1].strength']);
      expect(result.responses.Q08?.answers.medicines).toMatchObject({ items: [{ answers: { strength: { value: '500 mg' } } }, { answers: { strength: { value: '800 IU', sourceIds: ['earlier-turn'] } } }] });
      expect(result.provenance[0].correctsSourceIds).toEqual(['earlier-turn']);
    }
  });
  it.each(['G1', 'G3', 'G5', 'G7'])('rejects the unchanged raw A2 $0 proposal instead of repairing its evidence or shape', id => {
    const entry = retained.results.find(entry => entry.caseId === id)!;
    expect(() => resolveQuotedAdaptiveProposal(entry.rawProviderProposal, entry.context, 'literal-occurrence-v1')).toThrow('invalid-source-quote');
  });
  it('retains historical v1 required occurrence on every evidence-bearing branch', () => {
    const ctx = context('Metformin. That is all. What can you do?', ['Q08']);
    const base = { schema: 1, facts: [], newItems: [], completedLists: [], acts: [] };
    const missing = [{ sourceId: ctx.source.id, quote: 'Metformin' }];
    const variants = [
      { ...base, facts: [{ topicId: 'Q08', path: 'medicines', state: 'negative', transform: 'scoped-response', evidence: missing }] },
      { ...base, newItems: [{ topicId: 'Q08', collection: 'medicines', key: 'm', fields: [{ path: 'name', state: 'known', transform: 'verbatim', evidence: missing }] }] },
      { ...base, completedLists: [{ topicId: 'Q08', path: 'medicines', evidence: missing }] },
      { ...base, acts: [{ kind: 'answer', evidence: missing }] },
    ];
    for (const variant of variants) expect(() => resolveQuotedAdaptiveProposal(variant, ctx, 'literal-occurrence-v1')).toThrow('invalid-source-quote');
  });
  it('rejects nested item objects in facts even with otherwise valid required evidence', () => {
    const ctx = context('My mother has diabetes.', ['Q10']);
    expect(() => resolveQuotedAdaptiveProposal({ schema: 1, facts: [{ topicId: 'Q10', path: 'familyHistory', state: 'known', transform: 'verbatim', evidence: [{ sourceId: ctx.source.id, quote: 'My mother has diabetes.', occurrence: 0 }], items: [] }], newItems: [], completedLists: [], acts: [] }, ctx)).toThrow('invalid-adaptive-proposal');
  });
  it('does not attach reply authority to an answer act', () => {
    const ctx = context('Can you diagnose me?', ['Q06']);
    const canonical = resolveQuotedAdaptiveProposal({ schema: 1, facts: [], newItems: [], completedLists: [], acts: [{ kind: 'answer', replyId: 'COPY-02', evidence: [{ sourceId: ctx.source.id, quote: ctx.source.text, occurrence: 0 }] }] }, ctx);
    expect(() => validateAdaptiveProposal(canonical, ctx)).toThrow('reply-not-allowed');
  });
  it('keeps the A2 wrong reaffirmation correction rejected at the canonical boundary', () => {
    const entry = retained.results.find(entry => entry.caseId === 'G7')!;
    expect(() => validateAdaptiveProposal(entry.proposal, entry.context)).toThrow('invalid-correction-target');
    expect(entry.context.responses.Q08?.answers.medicines).toMatchObject({ items: [{ answers: { strength: { value: '850 mg' } } }, { answers: { strength: { value: '1000 IU' } } }] });
  });
  it('includes complete examples without weakening the existing context budget', () => {
    const ctx = context('172 cm.');
    const messages = buildAdaptiveMessages(ctx), instruction = String(messages[0].content);
    for (const example of adaptiveWireExamples) expect(instruction).toContain(JSON.stringify(example));
    expect(instruction).toContain('literal-disambiguation-v2');
    expect(instruction).toContain('Omit facts whose known value is unchanged');
    expect(instruction).toContain('occurrence?');
    expect(messages.every(message => String(message.content).length <= 32000)).toBe(true);
    expect(messages.reduce((sum, message) => sum + new TextEncoder().encode(String(message.content)).length, 0)).toBeLessThanOrEqual(60000);
  });
});

describe('current-topic gaps before model nominations', () => {
  it('finishes the actual Vitamin D reason gap from A2 G4 before asking about conditions', () => {
    const entry = retained.results.find(entry => entry.caseId === 'G4')!;
    const next = selectAdaptiveDialogue(entry.context, entry.outcome);
    expect(next.prompt?.topicId).toBe('Q08');
    expect(next.prompt?.targetPaths).toHaveLength(1);
    expect(next.prompt?.targetPaths[0]).toMatch(/\.reason$/);
    expect(next.prompt?.text).toBe('What do you take Vitamin D for, if you know?');
  });
  it('still follows an explicit patient topic switch ahead of the unfinished current topic', () => {
    const ctx = context('I would rather talk about conditions first.', ['Q08', 'Q06']);
    const input = proposal([], { acts: [{ kind: 'topic-switch', targetTopicId: 'Q06', evidence: evidence(ctx, ctx.source.text) }], next: { topicId: 'Q08', promptId: 'Q08', targetPaths: ['medicines'] } });
    const result = applyValidatedTurn(ctx, validateAdaptiveProposal(input, ctx));
    expect(selectAdaptiveDialogue(ctx, result).prompt?.topicId).toBe('Q06');
  });
  it('honors a model nomination after the current topic has no remaining probes', () => {
    const ctx = withPrior(context('That covers it.', ['Q08', 'Q06']), 'Q08', { medicines: { state: 'negative', sourceIds: ['prior'] } });
    const result = applyValidatedTurn(ctx, validateAdaptiveProposal(proposal([], { next: { topicId: 'Q06', promptId: 'Q06a', targetPaths: ['conditions.diabetes', 'conditions.prediabetes'] } }), ctx));
    expect(selectAdaptiveDialogue(ctx, result).prompt?.topicId).toBe('Q06');
  });
});
