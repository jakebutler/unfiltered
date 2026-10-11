import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAdaptiveMessages, resolveQuotedAdaptiveProposal } from '../src/adaptive.js';
import { adaptiveTargetCatalog, eligibleAdaptiveProbes, selectAdaptiveDialogue } from '../src/dialogue.js';
import { applyValidatedTurn, validateAdaptiveProposal, type AdaptiveContext, type AdaptiveProposal } from '../src/adaptive-validation.js';
import { context, evidence, fact, proposal, register, withPrior } from './fixtures/adaptive.js';
const retained = JSON.parse(readFileSync(new URL('../../../docs/implementation/evidence/DO-A3.json', import.meta.url), 'utf8')) as { results: { caseId: string; context: AdaptiveContext; rawProviderProposal: unknown; proposal?: AdaptiveProposal }[] };
const apply = (ctx: AdaptiveContext, input: AdaptiveProposal) => applyValidatedTurn(ctx, validateAdaptiveProposal(input, ctx));
const known = (value: string | number) => ({ state: 'known' as const, value, sourceIds: ['prior'] });

describe('scoped diet absence without broad collection negatives', () => {
  it.each(['Nothing else that day.', 'There was nothing else yesterday.', 'No other food or drink.', 'I did not eat or drink anything else that day.'])('accepts explicit complete recall absence: %s', text => {
    const ctx = context(text, ['Q11']);
    const result = apply(ctx, proposal([fact(ctx, 'Q11', 'otherIntake', text, 'scoped-response', 'negative')]));
    expect(result.responses.Q11?.answers.otherIntake).toMatchObject({ state: 'negative', note: text, sourceIds: [ctx.source.id] });
    expect(result.clarifications).toEqual([]);
  });
  it.each(['Nothing else that day?', 'Maybe nothing else that day.', 'Nothing else that day, except a snack.', 'Nothing else that day. Actually, I had tea.', 'Nothing else that day. I drank juice at night.', 'Nothing else caused the pain.', 'No snacks, but I drank juice.'])('defers questioned, uncertain, retracted or partial absence: %s', text => {
    const ctx = context(text, ['Q11']);
    const quote = text.startsWith('Nothing else that day') ? 'Nothing else that day' : text;
    const result = apply(ctx, proposal([fact(ctx, 'Q11', 'otherIntake', quote, 'scoped-response', 'negative')]));
    expect(result.responses.Q11?.answers.otherIntake).toBeUndefined();
    expect(result.clarifications).toHaveLength(1);
  });
  it('does not reuse nothing-else outside the recall topic or as an unrelated collection negative', () => {
    const ctx = context('Nothing else that day.', ['Q08', 'Q11']);
    const result = apply(ctx, proposal([fact(ctx, 'Q11', 'otherIntake', ctx.source.text, 'scoped-response', 'negative'), fact(ctx, 'Q08', 'medicines', ctx.source.text, 'scoped-response', 'negative')]));
    expect(result.updates).toEqual([]);
    expect(result.clarifications).toHaveLength(2);
  });
  it('accepts the retained A3 correct other-intake proposal and asks only the independent missing coffee amount', () => {
    const entry = retained.results.find(entry => entry.caseId === 'G3')!;
    const result = apply(entry.context, resolveQuotedAdaptiveProposal(entry.rawProviderProposal, entry.context));
    expect(result.responses.Q11?.answers.otherIntake).toMatchObject({ state: 'negative', note: 'Nothing else that day.' });
    expect(result.clarifications.some(item => item.path === 'otherIntake')).toBe(false);
    const next = selectAdaptiveDialogue(entry.context, result);
    expect(next.prompt?.targetPaths).toHaveLength(1);
    expect(next.prompt?.targetPaths[0]).toMatch(/\.drinkAmounts$/);
    expect(next.prompt?.text).toBe('At 8 am, about how much coffee did you have? A cup or glass is fine.');
    expect(next.prompt?.text).not.toMatch(/portion|add anything|anything else/);
  });
});

describe('collection catalog has no contradictory placeholder targets', () => {
  it('declares new child IDs separately and only real existing-item paths as writable targets', () => {
    const ctx = withPrior(context('Metformin.', ['Q08', 'Q10']), 'Q08', { medicines: { state: 'known', complete: false, sourceIds: ['prior'], items: [{ id: 'met', answers: { name: known('Metformin'), strength: known('500 mg') } }] } });
    const catalog = adaptiveTargetCatalog(ctx.topics, ctx.responses);
    expect(JSON.stringify(catalog)).not.toContain('@new');
    const medicines = catalog[0].collections[0];
    expect(catalog[0].fields).toEqual([]);
    expect(medicines.path).toBe('medicines');
    expect(medicines.fields.map(field => field[0])).toContain('labelDirections');
    expect(medicines.fields.every(field => !String(field[0]).includes('['))).toBe(true);
    expect(medicines.existingItems).toEqual([{ id: 'met', paths: ['name', 'strength', 'labelDirections', 'actualUse', 'reason', 'concerns'].map(path => `medicines[met].${path}`) }]);
    expect(catalog[1].collections[0]).toMatchObject({ path: 'familyHistory', existingItems: [] });
    const fullPrompt = buildAdaptiveMessages(ctx).map(message => message.content).join('\n');
    expect(fullPrompt).not.toContain('@new');
    expect(fullPrompt).toContain('Represent each supplied meaning once');
  });
  it('continues rejecting the malformed retained A3 placeholder paths', () => {
    const entry = retained.results.find(entry => entry.caseId === 'G5')!;
    const canonical = resolveQuotedAdaptiveProposal(entry.rawProviderProposal, entry.context);
    expect(() => validateAdaptiveProposal(canonical, entry.context)).toThrow('unknown-slot-path');
  });
  it('keeps all declared collections and scalar fields when projecting the complete first intake', () => {
    const ctx = context('A new detail', register.topics.map(topic => topic.id));
    const catalog = adaptiveTargetCatalog(ctx.topics, {});
    for (const topic of ctx.topics) {
      const projected = catalog.find(entry => entry.id === topic.id)!;
      for (const slot of topic.slots) {
        if (/^MH0[1-4]$/.test(slot.id) || slot.kind === 'configuration' || slot.id === 'currentWeightEstimate.statedAt') continue;
        if (slot.kind === 'collection') expect(projected.collections.map(entry => entry.path)).toContain(slot.id);
        else expect(projected.fields.map(entry => entry[0])).toContain(slot.id);
      }
    }
    expect(JSON.stringify(catalog)).not.toContain('@new');
  });
});

describe('independent structured and conversation coverage', () => {
  it('retains an uncertain condition, its recollection, family detail, and question as different supported records', () => {
    const ctx = context('My sister has sleep apnea. I was told I might have sleep apnea. Can you explain what you can do?', ['Q06', 'Q10', 'SLEEP']);
    const result = apply(ctx, proposal([
      fact(ctx, 'Q06', 'conditions.sleepApnea', 'I was told I might have sleep apnea', 'scoped-response', 'uncertain'),
      fact(ctx, 'Q06', 'uncertainDiagnosis', 'I was told I might have sleep apnea'),
    ], { newItems: [{ topicId: 'Q10', collection: 'familyHistory', key: 'family', fields: [
      { path: 'condition', state: 'known', transform: 'verbatim', evidence: evidence(ctx, 'sleep apnea') },
      { path: 'relationship', state: 'known', transform: 'verbatim', evidence: evidence(ctx, 'sister') },
    ] }], acts: [{ kind: 'question', replyId: 'COPY-02', evidence: evidence(ctx, 'Can you explain what you can do?') }] }));
    expect(result.responses.Q06?.answers).toMatchObject({ 'conditions.sleepApnea': { state: 'uncertain' }, uncertainDiagnosis: { state: 'known', value: 'I was told I might have sleep apnea' } });
    expect(result.responses.Q10?.answers.familyHistory).toMatchObject({ items: [{ answers: { condition: { value: 'sleep apnea' }, relationship: { value: 'sister' } } }] });
    expect(result.responses.SLEEP?.applicability).not.toBe('applicable');
    expect(selectAdaptiveDialogue(ctx, result).reply?.id).toBe('COPY-02');
  });
  it('records a help request alongside its boundary act without promising the requested action', () => {
    const ctx = context('Please renew my prescription. Can you tell me what dose to take?', ['W07'], 'refill');
    const result = apply(ctx, proposal([fact(ctx, 'W07', 'help', ctx.source.text)], { acts: [{ kind: 'question', replyId: 'COPY-05', evidence: evidence(ctx, 'Can you tell me what dose to take?') }] }));
    expect(result.responses.W07?.answers.help).toMatchObject({ state: 'known', value: ctx.source.text });
    expect(selectAdaptiveDialogue(ctx, result).reply?.id).toBe('COPY-05');
    expect(result.updates.map(update => update.path)).toEqual(['help']);
  });
  it('does not synthesize a help fact solely from an act, and asks for help without presuming an obstacle', () => {
    const ctx = withPrior(context('Can you explain your role?', ['W07'], 'refill'), 'W07', { medicine: known('Example medicine'), directions: known('Weekly'), actualUse: known('Sundays'), remaining: known('One pen'), pharmacy: known('Main Street Pharmacy'), symptomsChanges: { state: 'negative', sourceIds: ['prior'] } });
    const result = apply(ctx, proposal([], { acts: [{ kind: 'question', replyId: 'COPY-02', evidence: evidence(ctx, ctx.source.text) }] }));
    expect(result.responses.W07?.answers.help).toBeUndefined();
    expect(selectAdaptiveDialogue(ctx, result).prompt?.text).toBe('What would you like your medical care team to help with?');
  });
});

describe('natural missing-detail copy with exact target and wording provenance', () => {
  it.each([
    ['G1', 'Was August 12 the exact date, or is that approximate?'],
    ['G4', 'What do you take Vitamin D for, if you know?'],
    ['G7', "What directions are written on your Metformin label? Please don't guess if you aren't sure."],
  ])('asks the retained %s gap without exposing a schema label', (id, expected) => {
    const entry = retained.results.find(entry => entry.caseId === id)!;
    const result = apply(entry.context, resolveQuotedAdaptiveProposal(entry.rawProviderProposal, entry.context));
    const next = selectAdaptiveDialogue(entry.context, result);
    expect(next.prompt?.text).toBe(expected);
    expect(next.prompt?.wording).toMatchObject({ version: 'S2.scoped.2', status: 'proposed-detail', sourcePromptId: next.prompt!.promptId });
    expect(next.prompt?.text).not.toMatch(/What should I record|Reason for use|Label directions as reported|Whether the measurement/);
  });
  it('varies dates and medicine anchors from supported records rather than hardcoding gold values', () => {
    const ctx = withPrior(context('I have another detail.'), 'Q04', { 'height.value': known(168), 'height.unit': known('cm'), 'lastMeasuredWeight.value': known(81), 'lastMeasuredWeight.unit': known('kg'), 'lastMeasuredWeight.measuredWhen': known('September 3') });
    expect(eligibleAdaptiveProbes(ctx).find(probe => probe.targetPaths.includes('lastMeasuredWeight.datePrecision'))?.text).toBe('Was September 3 the exact date, or is that approximate?');
    const meds = withPrior(context('A detail.', ['Q08']), 'Q08', { medicines: { state: 'known', complete: false, sourceIds: ['prior'], items: [{ id: 'supp', answers: { name: known('Calcium'), strength: known('600 mg') } }] } });
    const direction = eligibleAdaptiveProbes(meds).find(probe => probe.promptId === 'B02')!;
    expect(direction.text).toBe("What directions are written on your Calcium label? Please don't guess if you aren't sure.");
    expect(direction.targetPaths).toEqual(['medicines[supp].labelDirections']);
  });
});
