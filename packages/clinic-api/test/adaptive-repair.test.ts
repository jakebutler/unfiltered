import { describe, expect, it } from 'vitest';
import { applyValidatedTurn, validateAdaptiveProposal, type AdaptiveContext, type AdaptiveProposal } from '../src/adaptive-validation.js';
import { buildAdaptiveMessages } from '../src/adaptive.js';
import { eligibleAdaptiveProbes, selectAdaptiveDialogue } from '../src/dialogue.js';
import { context, evidence, fact, proposal, register, source, withPrior } from './fixtures/adaptive.js';
const apply = (ctx: AdaptiveContext, input: AdaptiveProposal) => applyValidatedTurn(ctx, validateAdaptiveProposal(input, ctx));
const known = (value: string | number | boolean) => ({ state: 'known' as const, value, sourceIds: ['prior'] });

describe('finite scope repair positive and negative controls', () => {
  it.each(['My mother is 172 cm tall.', 'Am I 172 cm tall?', "I don't think my height is 172 cm.", 'If my height is 172 cm, can I join?'])('does not normalize nonasserted patient height: %s', text => {
    const ctx = context(text);
    const result = apply(ctx, proposal([fact(ctx, 'Q04', 'height.value', '172', 'explicit-number'), fact(ctx, 'Q04', 'height.unit', 'cm', 'explicit-unit')]));
    expect(result.updates).toEqual([]);
    expect(result.clarifications).toHaveLength(2);
  });
  it('keeps uncertain and conflicting diagnosis corrections from continuing old branch questions', () => {
    for (const explicit of [true, false]) {
      const ctx = withPrior(context('Actually, I might have diabetes.', ['Q06', 'DM']), 'Q06', { 'conditions.diabetes': known(true) });
      ctx.responses = { ...ctx.responses, DM: { presented: true, applicability: 'applicable', answers: { typeStatus: known('Type 2') } } };
      const candidate = fact(ctx, 'Q06', 'conditions.diabetes', ctx.source.text, 'scoped-response', 'uncertain');
      const result = apply(ctx, proposal([{ ...candidate, ...(explicit ? { correctsSourceIds: ['prior'] } : {}) }]));
      expect(result.responses.Q06?.answers['conditions.diabetes']?.state).toBe(explicit ? 'uncertain' : 'conflicting');
      expect(result.responses.DM?.applicability).toBe('unknown');
      expect(result.responses.DM?.answers.typeStatus).toEqual(known('Type 2'));
      expect(eligibleAdaptiveProbes({ ...ctx, responses: result.responses }).some(probe => probe.topicId === 'DM')).toBe(false);
    }
  });
  it('activates sleep and digestive branches from their accepted patient anchors alone', () => {
    const ctx = context('I was diagnosed with sleep apnea. I have a digestive condition.', ['Q06', 'SLEEP', 'GI']);
    const result = apply(ctx, proposal([fact(ctx, 'Q06', 'conditions.sleepApnea', 'I was diagnosed with sleep apnea', 'explicit-choice'), fact(ctx, 'Q06', 'conditions.digestive', 'I have a digestive condition', 'explicit-choice')]));
    expect(result.responses.SLEEP?.applicability).toBe('applicable');
    expect(result.responses.GI?.applicability).toBe('applicable');
  });
  it('does not use an after-high-school statement as evidence for the teenage window', () => {
    const ctx = context('After high school I gained weight.', ['Q03']);
    const result = apply(ctx, proposal([fact(ctx, 'Q03', 'teenage', ctx.source.text), fact(ctx, 'Q03', 'afterSchool', ctx.source.text)]));
    expect(result.updates.map(update => update.path)).toEqual(['afterSchool']);
  });
  it('accepts clear medicine headings, label versus actual use and explicitly shared concerns', () => {
    const ctx = context('Metformin 500 mg: the label says twice daily, but I take it once daily. Vitamin D 1000 IU: the label says once weekly, but I take it once monthly. No concerns with either. That is all of my medicines.', ['Q08']);
    const item = (key: string, name: string, strength: string, label: string, use: string) => ({ topicId: 'Q08', collection: 'medicines', key, fields: [
      { path: 'name', state: 'known' as const, transform: 'verbatim' as const, evidence: evidence(ctx, name) },
      { path: 'strength', state: 'known' as const, transform: 'verbatim' as const, evidence: evidence(ctx, strength) },
      { path: 'labelDirections', state: 'known' as const, transform: 'verbatim' as const, evidence: evidence(ctx, label) },
      { path: 'actualUse', state: 'known' as const, transform: 'verbatim' as const, evidence: evidence(ctx, use) },
      { path: 'concerns', state: 'negative' as const, transform: 'scoped-response' as const, evidence: evidence(ctx, 'No concerns with either') },
    ] });
    const result = apply(ctx, proposal([], { newItems: [item('m', 'Metformin', '500 mg', 'twice daily', 'I take it once daily'), item('v', 'Vitamin D', '1000 IU', 'once weekly', 'I take it once monthly')], completedLists: [{ topicId: 'Q08', path: 'medicines', evidence: evidence(ctx, 'That is all of my medicines') }] }));
    const list = result.responses.Q08?.answers.medicines;
    expect(list).toMatchObject({ state: 'known', complete: true });
    if (list?.state !== 'known' || !list.items) throw new Error('missing items');
    expect(list.items[0].answers).toMatchObject({ name: { value: 'Metformin' }, labelDirections: { value: 'twice daily' }, actualUse: { value: 'I take it once daily' }, concerns: { state: 'negative' } });
    expect(list.items[1].answers).toMatchObject({ name: { value: 'Vitamin D' }, labelDirections: { value: 'once weekly' }, actualUse: { value: 'I take it once monthly' }, concerns: { state: 'negative' } });
    expect(result.clarifications).toEqual([]);
  });
  it('accepts a scoped correction to one medicine and preserves the other item and old source', () => {
    const ctx = withPrior(context('Actually, I meant metformin 500 mg, not 850 mg; vitamin D is still 1000 IU.', ['Q08']), 'Q08', { medicines: { state: 'known', complete: false, sourceIds: ['prior'], items: [{ id: 'met', answers: { name: known('Metformin'), strength: known('850 mg') } }, { id: 'vit', answers: { name: known('Vitamin D'), strength: known('1000 IU') } }] } });
    const result = apply(ctx, proposal([{ ...fact(ctx, 'Q08', 'medicines[met].strength', '500 mg'), correctsSourceIds: ['prior'] }]));
    const list = result.responses.Q08?.answers.medicines;
    if (list?.state !== 'known' || !list.items) throw new Error('missing items');
    expect(list.items[0].answers.strength).toMatchObject({ value: '500 mg', sourceIds: [ctx.source.id] });
    expect(list.items[1].answers.strength).toEqual(known('1000 IU'));
    expect(result.provenance[0].correctsSourceIds).toEqual(['prior']);
    expect(ctx.sources.map(entry => entry.id)).toContain('prior');
  });
  it('does not install the explicitly rejected strength from a correction', () => {
    const ctx = withPrior(context('Actually, I meant metformin 500 mg, not 850 mg.', ['Q08']), 'Q08', { medicines: { state: 'known', complete: false, sourceIds: ['prior'], items: [{ id: 'met', answers: { name: known('Metformin'), strength: known('1000 mg') } }] } });
    const result = apply(ctx, proposal([{ ...fact(ctx, 'Q08', 'medicines[met].strength', '850 mg'), correctsSourceIds: ['prior'] }]));
    const list = result.responses.Q08?.answers.medicines;
    expect(list?.state === 'known' && list.items?.[0].answers.strength).toEqual(known('1000 mg'));
    expect(result.clarifications).toHaveLength(1);
  });
  it('does not accept a medicine item from a negated patient-use statement', () => {
    const ctx = context("I don't take Metformin.", ['Q08']);
    const result = apply(ctx, proposal([], { newItems: [{ topicId: 'Q08', collection: 'medicines', key: 'm', fields: [{ path: 'name', state: 'known', transform: 'verbatim', evidence: evidence(ctx, 'Metformin') }] }] }));
    expect(result.responses.Q08?.answers.medicines).toBeUndefined();
    expect(result.updates).toEqual([]);
    expect(selectAdaptiveDialogue(ctx, result).prompt).toBeDefined();
  });
  it('does not import label instructions into actual-use or actual use into label instructions', () => {
    const ctx = withPrior(context('Metformin: the label says twice daily, but I take once daily.', ['Q08']), 'Q08', { medicines: { state: 'known', complete: false, sourceIds: ['prior'], items: [{ id: 'met', answers: { name: known('Metformin') } }] } });
    const result = apply(ctx, proposal([fact(ctx, 'Q08', 'medicines[met].actualUse', 'twice daily'), fact(ctx, 'Q08', 'medicines[met].labelDirections', 'once daily')]));
    expect(result.updates).toEqual([]);
    expect(result.clarifications).toHaveLength(2);
  });
  it.each(['That is not all.', 'That is all? No, more medicines.', 'I am not sure that is all.'])('keeps a list open for retracted or uncertain completion: %s', text => {
    const ctx = withPrior(context(text, ['Q08']), 'Q08', { medicines: { state: 'known', complete: false, sourceIds: ['prior'], items: [{ id: 'met', answers: { name: known('Metformin') } }] } });
    ctx.displayed!.targetPaths = ['medicines'];
    expect(apply(ctx, proposal([], { completedLists: [{ topicId: 'Q08', path: 'medicines', evidence: evidence(ctx, text) }] })).responses.Q08?.answers.medicines).toMatchObject({ complete: false });
  });
  it('retains question-mark-free source questions omitted by the model', () => {
    const ctx = context("I'm 172 cm. Tell me what dose to take.");
    const result = apply(ctx, proposal([fact(ctx, 'Q04', 'height.value', '172', 'explicit-number'), fact(ctx, 'Q04', 'height.unit', 'cm', 'explicit-unit')]));
    expect(result.unresolvedQuestions?.map(span => ctx.source.text.slice(span.start, span.end).trim())).toEqual(['Tell me what dose to take.']);
    expect(selectAdaptiveDialogue(ctx, result).reply?.id).toBe('COPY-05');
    expect(result.hasUnresolvedInterpretation).toBe(true);
  });
  it('does not double-count an already represented full question', () => {
    const ctx = context('Should I double my dose tonight?');
    const result = apply(ctx, proposal([], { acts: [{ kind: 'question', evidence: evidence(ctx, ctx.source.text), replyId: 'COPY-05' }] }));
    expect(result.unresolvedQuestions).toBeUndefined();
    expect(result.acts).toHaveLength(1);
  });
});

describe('actual next-prompt body and complete provider context', () => {
  it('asks only prediabetes after diabetes is already answered', () => {
    const ctx = withPrior(context('No more detail.', ['Q06']), 'Q06', { 'conditions.diabetes': known(true) });
    const probe = eligibleAdaptiveProbes(ctx).find(entry => entry.promptId === 'Q06a')!;
    expect(probe.targetPaths).toEqual(['conditions.prediabetes']);
    expect(probe.text).toBe("Have you ever been told you have prediabetes?");
  });
  it('asks only additions to the already reported coffee for the correct occasion', () => {
    const ctx = withPrior(context('Coffee.', ['Q11']), 'Q11', { day: known('Yesterday'), occasions: { state: 'known', complete: false, sourceIds: ['prior'], items: [{ id: 'breakfast', answers: { time: known('8 am'), foods: known('Oatmeal'), drinks: known('Coffee') } }] } });
    const probe = eligibleAdaptiveProbes(ctx).find(entry => entry.promptId === 'Q11c')!;
    expect(probe.targetPaths).toEqual(['occasions[breakfast].drinkAdditions']);
    expect(probe.text).toBe('At 8 am, did you add anything to the Coffee?');
    expect(probe.text).not.toContain('What did you drink');
    expect(probe.text).toContain('8 am');
  });
  it('asks only label directions when medicine name and strength are supplied', () => {
    const ctx = withPrior(context('Metformin.', ['Q08']), 'Q08', { medicines: { state: 'known', complete: false, sourceIds: ['prior'], items: [{ id: 'met', answers: { name: known('Metformin'), strength: known('500 mg') } }] } });
    const probe = eligibleAdaptiveProbes(ctx).find(entry => entry.promptId === 'B02')!;
    expect(probe.targetPaths).toEqual(['medicines[met].labelDirections']);
    expect(probe.text).toBe("What directions are written on your Metformin label? Please don't guess if you aren't sure.");
  });
  it('keeps all fact metadata and opaque item identities without duplicating item schema', () => {
    const ctx = withPrior(context('My new detail'), 'Q04', { 'height.value': { state: 'uncertain', sourceIds: ['prior'], note: 'around 172 cm' } });
    ctx.topics = [...register.topics];
    const messages = buildAdaptiveMessages(ctx);
    const full = messages.map(message => message.content).join('\n');
    expect(full).toContain('around 172 cm');
    expect(full).toContain('uncertain');
    expect(full).toContain('prior');
    expect(full).toContain(ctx.source.text);
    expect(messages.every(message => String(message.content).length <= 32000)).toBe(true);
    expect(new TextEncoder().encode(messages.map(message => message.content).join('')).length).toBeLessThanOrEqual(60000);
    expect(full).not.toContain('Patient/secret');
  });
});
