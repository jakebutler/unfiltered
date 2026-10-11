import { describe, expect, it } from 'vitest';
import { applyValidatedTurn, validateAdaptiveProposal, type AdaptiveContext, type AdaptiveProposal } from '../src/adaptive-validation.js';
import { selectAdaptiveDialogue } from '../src/dialogue.js';
import { context, evidence, fact, proposal, withPrior } from './fixtures/adaptive.js';

// Independent follow-up counterexamples, inverted into intended acceptance guards.
const apply = (ctx: AdaptiveContext, input: AdaptiveProposal) => applyValidatedTurn(ctx, validateAdaptiveProposal(input, ctx));
const known = (value: string | number | boolean) => ({ state: 'known' as const, value, sourceIds: ['prior'] });

describe('independent repair recheck counterexamples', () => {
  it('rejects another measurement number as height', () => {
    const ctx = context('My height is 172 cm and my weight is 80 kg.');
    const result = apply(ctx, proposal([fact(ctx, 'Q04', 'height.value', '80', 'explicit-number')]));
    expect(result.responses.Q04?.answers['height.value']).toBeUndefined();
  });
  it('rejects a date number as measured weight', () => {
    const ctx = context('The scale read 230 pounds on August 12, 2026.');
    // A comma splits the old guard; use the day, which remains in the scale clause.
    const result = apply(ctx, proposal([fact(ctx, 'Q04', 'lastMeasuredWeight.value', '12', 'explicit-number')]));
    expect(result.responses.Q04?.answers['lastMeasuredWeight.value']).toBeUndefined();
  });
  it('does not turn one negated medicine into a negative entire collection', () => {
    const ctx = context("I don't take metformin anymore. I take Vitamin D.", ['Q08']);
    const result = apply(ctx, proposal([fact(ctx,'Q08','medicines',"I don't take metformin anymore",'scoped-response','negative')]));
    expect(result.responses.Q08?.answers.medicines?.state).toBeUndefined();
    expect(result.hasUnresolvedInterpretation).toBe(true);
  });
  it('applies label-versus-actual-use guards to scalar refill fields', () => {
    const ctx=context('Semaglutide: the label says weekly, but I take it daily.', ['W07'], 'refill');
    const result=apply(ctx,proposal([fact(ctx,'W07','directions','I take it daily'),fact(ctx,'W07','actualUse','weekly')]));
    expect(result.responses.W07?.answers.directions).toBeUndefined();
    expect(result.responses.W07?.answers.actualUse).toBeUndefined();
  });
  it('rejects the explicitly rejected dose as actual use', () => {
    const ctx=withPrior(context('Metformin: I take 500 mg, not 1000 mg.', ['Q08']), 'Q08', {medicines:{state:'known',complete:false,sourceIds:['prior'],items:[{id:'met',answers:{name:known('Metformin')}}]}});
    const result=apply(ctx,proposal([fact(ctx,'Q08','medicines[met].actualUse','1000 mg')]));
    const medicines=result.responses.Q08?.answers.medicines;
    expect(medicines?.state==='known'&&medicines.items?.[0].answers.actualUse).toBeUndefined();
  });
  it('prioritizes the dose boundary while preserving both questions', () => {
    const ctx=context('What can you do? Should I double my dose tonight?');
    const result=apply(ctx,proposal([],{acts:[{kind:'question',replyId:'COPY-02',evidence:evidence(ctx,'What can you do?')}]}));
    expect(result.unresolvedQuestions).toHaveLength(1);
    expect(result.acts.some(act=>act.replyId==='COPY-05')).toBe(true);
    expect(selectAdaptiveDialogue(ctx,result).reply?.id).toBe('COPY-05');
  });
});
