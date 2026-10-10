import { describe, expect, it } from 'vitest';
import {
  addCollectionItem, aggregateTargets, applyGuidedAnswer, conditionBranches, createClinicContent,
  diabetesBranchApplicability, evaluateRequiredMeasurements, evaluateTopic, finishCollection,
  guidedFieldForPath, nextGuidedField, parseGuidedValue, promptsById, scenarioOpeningPrompt,
  scenarioTopics, scenarios, scorePhq4, toContentContractDefinition,
  type SlotAnswer, type SlotAnswers, type SlotDefinition, type TopicResponse,
} from '../src/index.js';

const register = createClinicContent();
const evidence = { validSourceIds:new Set(['source-1','source-2','source-3']) };
const known = (value: string | number | boolean | {feet:number;inches:number}, sourceId='source-1'): SlotAnswer => ({state:'known',value,sourceIds:[sourceId]});
const negative: SlotAnswer = {state:'negative',sourceIds:['source-1']};
const unknown: SlotAnswer = {state:'unknown',sourceIds:['source-1']};
const response = (answers: SlotAnswers = {}): TopicResponse => ({presented:true,answers});
const topic = (id:string) => register.topics.find(t=>t.id===id)!;
const measured = (extra:SlotAnswers = {}): TopicResponse => response({
  'height.value':known({feet:5,inches:6}), 'height.unit':known('ft-in'),
  'lastMeasuredWeight.value':known(220), 'lastMeasuredWeight.unit':known('lb'),
  'lastMeasuredWeight.measuredWhen':known('February 2026'), 'lastMeasuredWeight.datePrecision':known('approximate'),
  'lastMeasuredWeight.representsCurrent':known(true), ...extra,
});
const estimate:SlotAnswers = {'currentWeightEstimate.value':known(230,'source-2'),'currentWeightEstimate.unit':known('lb','source-2'),'currentWeightEstimate.statedAt':known('2026-10-09T18:00:00Z','source-2')};

function allSlots(slots:readonly SlotDefinition[]):readonly SlotDefinition[] {
  return slots.flatMap(slot=>[slot,...allSlots(slot.fields??[])]);
}

describe('versioned content and authority',()=>{
  it('defaults to the recorded PHQ-4 selection, while keeping other detailed wording proposed',()=>{
    expect(register.mentalHealth).toBe('phq4');
    expect(register.provenance.detailApproval).toBe('proposed');
    expect(promptsById.Q02.wordingStatus).toBe('proposed-detail');
    expect(promptsById.MH01.wordingStatus).toBe('accepted-targeted-choice');
    expect(register.provenance.clinicalProtocolApproval).toBe(false);
    expect(toContentContractDefinition(register)).not.toHaveProperty('approval');
    expect(()=>createClinicContent({mentalHealth:'invalid' as 'phq4'})).toThrow('mental-health-selection-required');
  });
  it('resolves every opening and granular prompt across all 22 topics, branches and seven scenarios',()=>{
    expect(register.topics).toHaveLength(22);
    expect(Object.values(scenarios)).toHaveLength(7);
    const definitions=[...register.topics,...Object.values(scenarios).flatMap(s=>s.additionalTopics),...Object.values(conditionBranches).map(b=>b.topic)];
    for(const definition of definitions){
      expect(promptsById[definition.openingPromptId],definition.id).toBeDefined();
      expect(definition.visibility).toBe('assigned-clinical-full');
      expect(definition.stopWhen).toEqual(expect.arrayContaining(['patient-declines','patient-moves-on','safety-interruption']));
      for(const slot of allSlots(definition.slots)) for(const id of slot.promptIds) expect(promptsById[id],`${definition.id}:${slot.id}:${id}`).toBeDefined();
    }
    expect(promptsById['Q04.followup.3']).toBeUndefined();
    expect(promptsById['Q16.followup.3']).toBeUndefined();
  });
  it('keeps explicit pending/unscored configurations unscored without claiming completion',()=>{
    const pending=createClinicContent({mentalHealth:'pending'});
    expect(pending.mentalHealthOption.scoring).toBe('disabled');
    expect(pending.topics.find(t=>t.id==='Q16')!.slots.some(s=>s.kind==='configuration')).toBe(true);
    expect(createClinicContent({mentalHealth:'unscored'}).mentalHealthOption.scoring).toBe('disabled');
  });
});

describe('required measured and estimated weight',()=>{
  it('preserves historical measured weight and separate current estimate without a recency cutoff',()=>{
    const r=measured({'lastMeasuredWeight.representsCurrent':known(false),...estimate});
    const result=evaluateRequiredMeasurements(r,evidence);
    expect(result.sufficient).toBe(true);
    expect(result.hasClinicalRecencyCutoff).toBe(false);
    expect(result.clinicalClearance).toBe(false);
    expect(r.answers['lastMeasuredWeight.value']).toEqual(known(220));
    expect(r.answers['currentWeightEstimate.value']).toEqual(known(230,'source-2'));
  });
  it.each(['height.value','height.unit','lastMeasuredWeight.value','lastMeasuredWeight.unit','lastMeasuredWeight.measuredWhen','lastMeasuredWeight.datePrecision'])('missing %s prevents a complete intake and allows partial handoff',id=>{
    const r=measured({[id]:unknown});
    expect(evaluateRequiredMeasurements(r,evidence)).toMatchObject({sufficient:false,partialHandoffAllowed:true});
  });
  it('does not demand an estimate for a representative reading solely because its date is old',()=>{
    expect(evaluateRequiredMeasurements(measured({'lastMeasuredWeight.measuredWhen':known('2017')}),evidence).sufficient).toBe(true);
  });
  it('does demand a separate estimate when patient explicitly calls the reading old, even if described representative',()=>{
    const r=measured({'lastMeasuredWeight.describedAsOld':known(true)});
    expect(evaluateRequiredMeasurements(r,evidence).unresolvedSlotIds).toContain('currentWeightEstimate.value');
    expect(nextGuidedField(topic('Q04'),r,evidence)?.path).toBe('currentWeightEstimate.value');
    expect(evaluateRequiredMeasurements(measured({...r.answers,...estimate}),evidence).sufficient).toBe(true);
  });
  it('retains uncertain representativeness and requests an estimate; missing estimate never passes',()=>{
    const r=measured({'lastMeasuredWeight.representsCurrent':{state:'uncertain',sourceIds:['source-1']}});
    expect(evaluateRequiredMeasurements(r,evidence).sufficient).toBe(false);
    expect(nextGuidedField(topic('Q04'),r,evidence)?.path).toBe('currentWeightEstimate.value');
    expect(evaluateRequiredMeasurements(response({...r.answers,...estimate}),evidence).sufficient).toBe(true);
  });
  it('does not replace unknown actual reading with a current estimate',()=>{
    const r=measured({'lastMeasuredWeight.value':unknown,'lastMeasuredWeight.representsCurrent':known(false),...estimate});
    expect(evaluateRequiredMeasurements(r,evidence).unresolvedSlotIds).toContain('lastMeasuredWeight.value');
  });
  it('rejects mismatched units, zero or nonfinite measurements, and untrusted sources',()=>{
    for(const overrides of [ {'height.unit':known('cm')}, {'height.value':known(0)}, {'lastMeasuredWeight.value':known(Infinity)}, {'lastMeasuredWeight.value':known(220,'foreign-source')} ]){
      expect(evaluateRequiredMeasurements(measured(overrides),evidence).sufficient).toBe(false);
    }
  });
});

describe('focused detail collection and honest missingness',()=>{
  it('a scoped negative satisfies symptoms without manufacturing onset/impact answers',()=>{
    const r=response({concern:negative});
    const readiness=evaluateTopic(topic('Q02'),r,evidence);
    expect(readiness.sufficient).toBe(true);
    expect(aggregateTargets(topic('Q02'),readiness).every(t=>t.sourceIds.includes('source-1'))).toBe(true);
    expect(r.answers.onset).toBeUndefined();
  });
  it('unknown, declined, negative and not-asked stay distinct; unknown closes only its detail',()=>{
    for(const [state,sufficient] of [['negative',true],['unknown',false],['declined',false]] as const){
      const readiness=evaluateTopic(topic('Q02'),response({concern:{state,sourceIds:['source-1']}}),evidence);
      expect(readiness.slots[0].answerState).toBe(state);
      expect(readiness.sufficient).toBe(sufficient);
    }
    const r=response({childhood:unknown});
    expect(nextGuidedField(topic('Q03'),r,evidence)?.path).toBe('teenage');
    expect(evaluateTopic(topic('Q03'),r,evidence).slots.find(s=>s.id==='childhood')).toMatchObject({answerState:'unknown',state:'unresolved',promptIds:[]});
    expect(evaluateTopic(topic('Q03'),response(),evidence).slots[0].answerState).toBe('not-asked');
  });
  it('uses five history windows and skips a supplied overlapping window',()=>{
    const r=response({childhood:known('Heavy as a child'),teenage:known('Steady'),afterSchool:known('Steady'),lastFiveYears:known('Gained after shift change')});
    expect(nextGuidedField(topic('Q03'),r,evidence)).toMatchObject({path:'past18Months',promptIds:['Q03e']});
  });
  it('honors explicit topic resistance even when other slots remain missing',()=>{
    const r={...response({day:known('Yesterday')}),stopped:'resistance-after-purpose' as const};
    expect(nextGuidedField(topic('Q11'),r,evidence)).toBeUndefined();
    expect(evaluateTopic(topic('Q11'),r,evidence)).toMatchObject({sufficient:false,collection:'stopped',nextPromptIds:[],partialHandoffAllowed:true});
  });
  it('requires source evidence for conditional inapplicability and does not ask when trigger is unknown',()=>{
    expect(nextGuidedField(topic('Q18'),response(),evidence)).toBeUndefined();
    expect(evaluateTopic(topic('Q18'),{...response(),applicability:'not-applicable'},evidence).sufficient).toBe(false);
    const readiness=evaluateTopic(topic('Q18'),{...response(),applicability:'not-applicable',applicabilitySourceIds:['source-1']},evidence);
    expect(readiness.sufficient).toBe(true);
    expect(aggregateTargets(topic('Q18'),readiness).every(t=>t.state==='sufficient'&&t.sourceIds[0]==='source-1')).toBe(true);
  });
  it('collects food contents, drinks, amounts, timing and typicality instead of accepting meal names as sufficient',()=>{
    let r=response({day:known('Yesterday')});
    r=addCollectionItem(topic('Q11'),r,{path:'occasions',itemId:'breakfast',sourceIds:['source-1']},evidence);
    r=applyGuidedAnswer(topic('Q11'),r,{path:'occasions[breakfast].time',answer:known('8 am')},evidence);
    r=applyGuidedAnswer(topic('Q11'),r,{path:'occasions[breakfast].foods',answer:known('Toast')},evidence);
    expect(nextGuidedField(topic('Q11'),r,evidence)).toMatchObject({path:'occasions[breakfast].drinks',promptIds:['Q11c']});
    r=finishCollection(topic('Q11'),r,{path:'occasions',sourceIds:['source-2']},evidence);
    expect(evaluateTopic(topic('Q11'),r,evidence).sufficient).toBe(false);
    expect(evaluateTopic(topic('Q11'),r,evidence).unresolvedSlotIds).toEqual(expect.arrayContaining(['occasions[breakfast].drinks','occasions[breakfast].foodAmounts','typicality']));
  });
  it('does not ask for invented amounts when a reported occasion contained no food or drink',()=>{
    const r=response({day:known('Yesterday'),occasions:{state:'known',sourceIds:['source-1'],complete:true,items:[{id:'omitted',answers:{time:known('Morning'),foods:negative,drinks:negative}}]},otherIntake:negative,typicality:known('It was a usual day')});
    expect(evaluateTopic(topic('Q11'),r,evidence).sufficient).toBe(true);
    const coffee=response({day:known('Yesterday'),occasions:{state:'known',sourceIds:['source-1'],complete:true,items:[{id:'coffee',answers:{time:known('Morning'),foods:negative,drinks:known('Coffee')}}]},otherIntake:negative,typicality:known('Usual')});
    expect(evaluateTopic(topic('Q11'),coffee,evidence).unresolvedSlotIds).toEqual(expect.arrayContaining(['occasions[coffee].drinkAdditions','occasions[coffee].drinkAmounts']));
  });
  it('makes precise immutable corrections and rejects direct unstructured collection answers',()=>{
    let r=addCollectionItem(topic('Q08'),response(),{path:'medicines',itemId:'one',sourceIds:['source-1']},evidence);
    r=applyGuidedAnswer(topic('Q08'),r,{path:'medicines[one].name',answer:known('Patient product name')},evidence);
    const corrected=applyGuidedAnswer(topic('Q08'),r,{path:'medicines[one].name',answer:known('Corrected patient name','source-2')},evidence);
    expect(guidedFieldForPath(topic('Q08'),r,'medicines[one].name').kind).toBe('text');
    expect(JSON.stringify(r)).toContain('Patient product name');
    expect(JSON.stringify(corrected)).toContain('Corrected patient name');
    expect(()=>applyGuidedAnswer(topic('Q08'),r,{path:'medicines',answer:known('Some medicines')},evidence)).toThrow('structured-collection');
    expect(()=>applyGuidedAnswer(topic('Q08'),r,{path:'medicines[one].name',answer:known('Forged','foreign-source')},evidence)).toThrow('invalid-evidence');
    expect(()=>addCollectionItem(topic('Q08'),r,{path:'medicines',itemId:'one',sourceIds:['source-1']},evidence)).toThrow('duplicate-collection-item');
  });
  it('parses explicit structured answers without extracting numbers or units from prose',()=>{
    expect(parseGuidedValue({kind:'height-value'},{feet:'5',inches:'6'})).toEqual({feet:5,inches:6});
    expect(()=>parseGuidedValue({kind:'positive-number'},'220 pounds')).toThrow('invalid-value');
    expect(()=>parseGuidedValue({kind:'positive-number'},'0')).toThrow('invalid-value');
    expect(()=>parseGuidedValue({kind:'height-value'},{feet:'5',inches:'12'})).toThrow('invalid-value');
    expect(()=>parseGuidedValue({kind:'presence'},'false')).toThrow('explicit-presence-required');
  });
});

describe('condition and scenario branches',()=>{
  it('explicitly checks diabetes and prediabetes without treating vague recollection or medicines as diagnoses',()=>{
    expect(diabetesBranchApplicability({},evidence)).toBe('unknown');
    expect(diabetesBranchApplicability({'conditions.diabetes':negative},evidence)).toBe('unknown');
    expect(diabetesBranchApplicability({'conditions.diabetes':negative,'conditions.prediabetes':negative},evidence)).toBe('not-applicable');
    expect(diabetesBranchApplicability({'conditions.diabetes':known(true)},evidence)).toBe('applicable');
    expect(diabetesBranchApplicability({'conditions.diabetes':known(true,'foreign-source')},evidence)).toBe('unknown');
    expect(conditionBranches.diabetes.topic.slots.map(s=>s.id)).toEqual(expect.arrayContaining(['latestGlucose.value','latestGlucose.unit','latestGlucose.measuredWhen','lowEvents.description','lowEvents.mostRecent','lowEvents.help']));
    expect(conditionBranches.diabetes.optionalFacts[0].separateFrom).toBe('latestGlucose');
  });
  it('does not let an explicit condition coexist with a complete claim of no reported conditions',()=>{
    const answers:Record<string,SlotAnswer>=Object.fromEntries(topic('Q06').slots.map(slot=>[slot.id,negative]));
    answers['conditions.diabetes']=known(true);
    expect(evaluateTopic(topic('Q06'),response(answers),evidence).sufficient).toBe(false);
  });
  it('offers one sourced clarification for uncertain diabetes without activating confirmed diabetes',()=>{
    const initial=response({'conditions.diabetes':{state:'uncertain',sourceIds:['source-1']}});
    expect(nextGuidedField(topic('Q06'),initial,evidence)).toMatchObject({path:'uncertainDiagnosis',promptIds:['Q06.uncertain']});
    expect(promptsById['Q06.uncertain'].text).toBe('What were you told, as best you remember?');
    const clarified=applyGuidedAnswer(topic('Q06'),initial,{path:'uncertainDiagnosis',answer:known('I was told my blood sugar was high, but I do not recall a diagnosis','source-2')},evidence);
    expect(clarified.answers['conditions.diabetes']).toEqual(initial.answers['conditions.diabetes']);
    expect(diabetesBranchApplicability(clarified.answers,evidence)).toBe('unknown');
    expect(scenarioTopics(register,'first-intake',{responses:{Q06:clarified},evidence}).map(t=>t.id)).not.toContain('DM');
    expect(nextGuidedField(topic('Q06'),clarified,evidence)?.path).toBe('conditions.prediabetes');
    const declined=applyGuidedAnswer(topic('Q06'),initial,{path:'uncertainDiagnosis',answer:{state:'declined',sourceIds:['source-2']}},evidence);
    expect(nextGuidedField(topic('Q06'),declined,evidence)?.path).toBe('conditions.prediabetes');
    const forged=response({'conditions.diabetes':{state:'uncertain',sourceIds:['foreign-source']}});
    expect(nextGuidedField(topic('Q06'),forged,evidence)?.path).not.toBe('uncertainDiagnosis');
  });
  it('makes optional A1C capture reachable without substituting it for glucose or requiring disclosure',()=>{
    const dm=conditionBranches.diabetes.topic;
    let r:TopicResponse={...response({typeStatus:known('Type 2'),when:known('2019'),treatment:negative,monitoring:negative,'latestGlucose.value':known(100),'latestGlucose.unit':known('mg/dL'),'latestGlucose.measuredWhen':known('June 2026'),lowEvents:negative,owner:negative,concern:negative}),applicability:'applicable'};
    expect(evaluateTopic(dm,r,evidence).sufficient).toBe(true);
    for(const [path,value] of [['a1c.value',7.2],['a1c.unit','%'],['a1c.measuredWhen','June 2026']] as const){
      expect(guidedFieldForPath(dm,r,path).promptIds).toEqual(['DM03']);
      r=applyGuidedAnswer(dm,r,{path,answer:known(value,'source-2')},evidence);
    }
    expect(r.answers['latestGlucose.value']).toEqual(known(100));
    expect(r.answers['a1c.value']).toEqual(known(7.2,'source-2'));
    expect(evaluateTopic(dm,r,evidence).sufficient).toBe(true);
    expect(toContentContractDefinition(register,[dm]).questions[0].detailTargets).not.toContain('a1c.value');
    const unknownA1c=applyGuidedAnswer(dm,r,{path:'a1c.measuredWhen',answer:unknown},evidence);
    expect(evaluateTopic(dm,unknownA1c,evidence).sufficient).toBe(true);
    expect(unknownA1c.answers['a1c.measuredWhen']?.state).toBe('unknown');
  });
  it('supplies patient-facing purposes and readable condition labels',()=>{
    expect(Object.values(scenarios).every(s=>s.patientSummary.length>0 && !/Q[0-9]|minimum|disposition|unowned|Medplum/.test(s.patientSummary))).toBe(true);
    expect(topic('Q06').slots.find(s=>s.id==='conditions.bloodPressure')?.label).toBe('High blood pressure');
  });
  it('keeps short workflows short, adds only relevant reuse, and handles absent authored context',()=>{
    expect(scenarioTopics(register,'non-visit').map(t=>t.id)).toEqual(['W03']);
    expect(scenarioTopics(register,'non-visit',{relevantTopicIds:['Q02']}).map(t=>t.id)).toEqual(['W03','Q02']);
    expect(()=>scenarioTopics(register,'billing',{relevantTopicIds:['Q04']})).toThrow('topic-not-in-scenario');
    expect(scenarioOpeningPrompt('pre-visit',false)).toBe('S01a');
    expect(scenarioOpeningPrompt('post-visit',false)).toBe('S03a');
    expect(scenarioOpeningPrompt('post-visit',true)).toBe('S03');
    const topics=scenarioTopics(register,'first-intake',{responses:{Q06:response({'conditions.diabetes':known(true)})},evidence});
    expect(topics.map(t=>t.id)).toContain('DM');
    expect(scenarioTopics(register,'first-intake').map(t=>t.id)).not.toContain('DM');
  });
});

describe('exact PHQ-4 response scoring',()=>{
  const answers={MH01:known(2),MH02:known(1),MH03:known(0),MH04:known(0)};
  const context={...evidence,confirmedItemIds:new Set(['MH01','MH02','MH03','MH04']),completedAt:'2026-10-09T18:00:00Z'};
  it('preserves the sourced items, two-week stem and response options',()=>{
    expect(promptsById['MH.stem'].text).toBe('Over the last 2 weeks, how often have you been bothered by the following problems?');
    expect(['MH01','MH02','MH03','MH04'].map(id=>promptsById[id].text)).toEqual(['Feeling nervous, anxious or on edge','Not being able to stop or control worrying','Little interest or pleasure in doing things','Feeling down, depressed, or hopeless']);
    expect(register.mentalHealthOption).toMatchObject({choices:[{value:0,label:'Not at all'},{value:1,label:'Several days'},{value:2,label:'More than half the days'},{value:3,label:'Nearly every day'}]});
  });
  it('keeps every item identity and timeframe in guided labels and source-ready fields',()=>{
    for(const id of ['MH01','MH02','MH03','MH04']){
      const field=guidedFieldForPath(topic('Q16'),response(),id);
      expect(field.label).toBe(`${promptsById[id].text} (over the last 2 weeks)`);
    }
    const labels=topic('Q16').slots.filter(s=>/^MH0[1-4]$/.test(s.id)).map(s=>s.label);
    expect(new Set(labels).size).toBe(4);
  });
  it('scores complete explicit confirmed items and routes subscore >=3 to human assessment only',()=>{
    expect(scorePhq4(answers,context)).toMatchObject({status:'complete',scores:{gad2:3,phq2:0,phq4:3},furtherAssessmentRequested:true,clinicianReviewRequired:true,diagnosis:null,clinicalClearance:false});
    const low=scorePhq4({...answers,MH01:known(0),MH02:known(0)},context);
    expect(low).toMatchObject({status:'complete',furtherAssessmentRequested:false,clinicianReviewRequired:true,clinicalClearance:false});
    expect(low).not.toHaveProperty('crisisClassification');
  });
  it.each(['unknown','uncertain','declined','skipped','negative'] as const)('does not impute or score even a complete subscale when another item is %s',state=>{
    expect(scorePhq4({...answers,MH04:{state,sourceIds:['source-1']}},context)).toMatchObject({status:'incomplete',scores:null});
  });
  it('rejects unconfirmed, unsourced, vague and out-of-range responses',()=>{
    for(const item of [known('Fine'),known(4),known(0,'foreign-source')]) expect(scorePhq4({...answers,MH04:item},context).scores).toBeNull();
    expect(scorePhq4(answers,{...context,confirmedItemIds:new Set(['MH01','MH02'])}).scores).toBeNull();
    expect(scorePhq4(answers,{...context,completedAt:'unknown'}).scores).toBeNull();
  });
});

it('collects explicit logistical choices without forcing arbitrary clinical prose into administrative views',()=>{
  const billing=scenarios.billing.additionalTopics[0],scheduling=scenarios.scheduling.additionalTopics[0];
  expect(billing.slots.find(slot=>slot.id==='issueType')?.choices).toEqual(['bill-question','coverage-question','payment-question','other-request']);
  expect(scheduling.slots.find(slot=>slot.id==='preferredDay')?.choices).toContain('Tuesday');
  expect(scheduling.slots.find(slot=>slot.id==='timezone')?.choices).toContain('America/Los_Angeles');
  expect(scheduling.slots.find(slot=>slot.id==='timezone')?.choices).toContain('Not sure');
  expect(scheduling.slots.find(slot=>slot.id==='requestedDate')?.label).toContain('YYYY-MM-DD');
});
