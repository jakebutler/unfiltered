import { describe, expect, it } from 'vitest';
import { applyValidatedTurn, validateAdaptiveProposal, type AdaptiveContext, type AdaptiveProposal } from '../src/adaptive-validation.js';
import { eligibleAdaptiveProbes, selectAdaptiveDialogue } from '../src/dialogue.js';
import { context, evidence, fact, proposal, source, withPrior } from './fixtures/adaptive.js';

// Independent counterexamples are acceptance guards: none of the observed unsafe behavior may recur.
const apply = (ctx: AdaptiveContext, input: AdaptiveProposal) => applyValidatedTurn(ctx, validateAdaptiveProposal(input, ctx));
const known = (value: string | number | boolean) => ({ state: 'known' as const, value, sourceIds: ['prior'] });

describe('independent counterexample regression guards', () => {
  it.each(['Do I have diabetes?', 'If I have diabetes, can I join?', 'I was told my mother has diabetes.'])('defers diagnosis from nonassertion: %s', text => {
    const ctx = context(text, ['Q06', 'DM']);
    const result = apply(ctx, proposal([fact(ctx, 'Q06', 'conditions.diabetes', text, 'explicit-choice')]));
    expect(result.responses.Q06?.answers['conditions.diabetes']).toBeUndefined();
  });
  it('defers a cherry-picked positive quote inside explicit negation', () => {
    const ctx = context("I don't think I have diabetes.", ['Q06']);
    expect(apply(ctx, proposal([fact(ctx,'Q06','conditions.diabetes','I have diabetes','explicit-choice')])).responses.Q06?.answers['conditions.diabetes']).toBeUndefined();
  });
  it('does not use unrelated negation as negative condition evidence', () => {
    const ctx = context('I have diabetes, not prediabetes.', ['Q06']);
    expect(apply(ctx, proposal([fact(ctx,'Q06','conditions.diabetes',ctx.source.text,'scoped-response','negative')])).responses.Q06?.answers['conditions.diabetes']?.state).toBeUndefined();
  });
  it('does not map a medicine dose numeric span into height', () => {
    const ctx = context('I take metformin 500 mg every day.');
    expect(apply(ctx,proposal([fact(ctx,'Q04','height.value','500','explicit-number')])).responses.Q04?.answers['height.value']).toBeUndefined();
  });
  it('scopes childhood evidence to its one reported history window', () => {
    const ctx = context('I was heavy as a child.', ['Q03']);
    const result = apply(ctx, proposal(['childhood','teenage','afterSchool','lastFiveYears','past18Months'].map(path => fact(ctx,'Q03',path,ctx.source.text))));
    expect(result.updates.map(update => update.path)).toEqual(['childhood']);
    expect(result.clarifications).toHaveLength(4);
  });
  it('does not turn negated-old or uncertain-change into known flags', () => {
    const ctx = context("The reading is not old. I don't know if it changed.");
    const result = apply(ctx,proposal([fact(ctx,'Q04','lastMeasuredWeight.describedAsOld','not old','explicit-choice'),fact(ctx,'Q04','lastMeasuredWeight.representsCurrent',"I don't know if it changed",'explicit-choice')]));
    expect(result.responses.Q04?.answers['lastMeasuredWeight.describedAsOld']).toBeUndefined();
    expect(result.responses.Q04?.answers['lastMeasuredWeight.representsCurrent']).toBeUndefined();
  });
  it('activates DM from the accepted diagnosis anchor alone', () => {
    const ctx = context('I was told I have diabetes.', ['Q06','DM']);
    const result = apply(ctx,proposal([fact(ctx,'Q06','conditions.diabetes',ctx.source.text,'explicit-choice')]));
    expect(result.responses.DM?.applicability).toBe('applicable');
    expect(eligibleAdaptiveProbes({...ctx,responses:result.responses}).some(probe=>probe.topicId==='DM')).toBe(true);
  });
  it('stops DM prompts after negative correction while retaining historical details', () => {
    const ctx = withPrior(context('Actually, I do not have diabetes.', ['Q06','DM']), 'Q06', {'conditions.diabetes':known(true)});
    ctx.responses = {...ctx.responses,DM:{presented:true,applicability:'applicable',applicabilitySourceIds:['prior'],answers:{typeStatus:known('Type 2')}}};
    const result = apply(ctx,proposal([{...fact(ctx,'Q06','conditions.diabetes',ctx.source.text,'scoped-response','negative'),correctsSourceIds:['prior']}]));
    expect(result.responses.Q06?.answers['conditions.diabetes']?.state).toBe('negative');
    expect(result.responses.DM?.applicability).not.toBe('applicable');
    expect(result.responses.DM?.answers.typeStatus).toMatchObject({value:'Type 2'});
    expect(eligibleAdaptiveProbes({...ctx,responses:result.responses}).some(probe=>probe.topicId==='DM')).toBe(false);
  });
  it('does not reask supplied measurements or an explicitly unknown date', () => {
    const ctx = withPrior(context('I cannot recall the date.'),'Q04',{'height.value':known(172),'height.unit':known('cm'),'lastMeasuredWeight.value':known(230),'lastMeasuredWeight.unit':known('lb'),'lastMeasuredWeight.measuredWhen':{state:'unknown',sourceIds:['prior']}});
    const probe=eligibleAdaptiveProbes(ctx).find(probe=>probe.promptId==='Q04a')!;
    expect(probe).toBeUndefined();
  });
  it('offers the existing move-on choice after repeated ineffective answers', () => {
    let ctx=context('I eat normally',['Q11']);
    const first=selectAdaptiveDialogue(ctx,apply(ctx,proposal([fact(ctx,'Q11','typicality','I eat normally')])));
    ctx={...ctx,source:source('I eat normally','second'),sources:[ctx.source,source('I eat normally','second')],dialogue:first.state,displayed:first.prompt};
    const second=selectAdaptiveDialogue(ctx,apply(ctx,proposal([fact(ctx,'Q11','typicality','I eat normally')])));
    expect(second.prompt?.promptId).toBe('__engagement-choice');
    expect(second.prompt?.text).toBe('Would you rather move on or come back to this?');
  });
  it('keeps a medicine list open when completion is questioned and withdrawn', () => {
    const ctx = context("Metformin. That is all? No, there are others I cannot remember.",['Q08']);
    const result=apply(ctx,proposal([],{newItems:[{topicId:'Q08',collection:'medicines',key:'m',fields:[{path:'name',state:'known',transform:'verbatim',evidence:evidence(ctx,'Metformin')}]}],completedLists:[{topicId:'Q08',path:'medicines',evidence:evidence(ctx,ctx.source.text)}]}));
    expect(result.responses.Q08?.answers.medicines).toMatchObject({state:'known',complete:false});
  });
  it('rejects wrong medicine-item correction despite a nearby correction cue', () => {
    const ctx=withPrior(context('Actually, metformin is 500 mg; vitamin D is still 1000 IU.',['Q08']),'Q08',{medicines:{state:'known',complete:false,sourceIds:['prior'],items:[{id:'met',answers:{name:known('Metformin'),strength:known('850 mg')}},{id:'vit',answers:{name:known('Vitamin D'),strength:known('1000 IU')}}]}});
    const result=apply(ctx,proposal([{...fact(ctx,'Q08','medicines[vit].strength','500 mg'),correctsSourceIds:['prior']}]));
    const medicines=result.responses.Q08?.answers.medicines;
    expect(medicines?.state==='known' && medicines.items?.find(item=>item.id==='vit')?.answers.strength).toMatchObject({value:'1000 IU'});
  });
  it('retains an omitted patient question and returns the approved dose boundary', () => {
    const ctx=context("I'm 172 cm. Should I double my dose tonight?");
    const result=apply(ctx,proposal([fact(ctx,'Q04','height.value','172','explicit-number'),fact(ctx,'Q04','height.unit','cm','explicit-unit')]));
    expect(result.hasUnresolvedInterpretation).toBe(true);
    expect(result.unresolvedQuestions).toHaveLength(1);
    expect(selectAdaptiveDialogue(ctx,result).reply?.id).toBe('COPY-05');
  });
  it('prevents importing another medicine label and actual use', () => {
    const ctx=context('Metformin: label twice daily; I take once daily. Vitamin D: label once weekly; I take once monthly.',['Q08']);
    const result=apply(ctx,proposal([],{newItems:[{topicId:'Q08',collection:'medicines',key:'m',fields:[{path:'name',state:'known',transform:'verbatim',evidence:evidence(ctx,'Metformin')},{path:'labelDirections',state:'known',transform:'verbatim',evidence:evidence(ctx,'once weekly')},{path:'actualUse',state:'known',transform:'verbatim',evidence:evidence(ctx,'once monthly')}]}]}));
    const medicines=result.responses.Q08?.answers.medicines;
    expect(medicines?.state==='known'&&medicines.items?.[0].answers.labelDirections).toBeUndefined();
  });
});
