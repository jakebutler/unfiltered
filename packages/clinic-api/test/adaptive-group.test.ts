import { describe, it, expect } from 'vitest';
import { createClinicContent } from '../../clinic-content/src/index.js';
import { createAdaptiveGroupManifest, adaptiveGroupFamilies, issuedAdaptiveGroupManifest } from '../src/adaptive-group-manifest.js';
import { compileAdaptiveGroupProposal, validateAdaptiveGroupProposal } from '../src/adaptive-group-compile.js';
import { context, withPrior } from './fixtures/adaptive.js';
import type { AdaptiveContext } from '../src/adaptive-validation.js';
import { prepareDigitalOceanRequest } from '../../clinical-core/src/digitalocean.js';

const register = createClinicContent({ mentalHealth: 'phq4' });
const known = (value: string) => ({ state: 'known' as const, value, sourceIds: ['prior'] });
function setup(ctx: AdaptiveContext, candidates: typeof ctx.topics = []) {
  const manifest = createAdaptiveGroupManifest(ctx, { candidateTopics: candidates });
  const bound = issuedAdaptiveGroupManifest(manifest, ctx);
  const address = (quote: string) => { const index = bound.segments.findIndex(segment => segment.text.includes(quote) && segment.text.indexOf(quote, segment.text.indexOf(quote) + 1) < 0); if (index < 0) throw new Error(`Ambiguous/missing test quote: ${quote}`); return { segment: `s${index}`, quote }; };
  const answer = (value: string, support = value) => ({ state: 'known', value: address(value), support: [address(support)] });
  const state = (state: string, quote: string) => ({ state, value: null, support: [address(quote)] });
  const wire = (groups: unknown[] = [], other = {}) => ({ schema: 6, context: manifest.id, groups, completedLists: [], absentLists: [], sharedConcerns: [], acts: [], unmapped: [], ...other });
  const patient = (kind: string, fields: unknown[], correct: number[] = [], key = kind) => ({ kind, key, scope: 'patient', fields, correct });
  return { manifest, bound, address, answer, state, wire, patient };
}

describe('sparse adaptive group contract, no runtime integration', () => {
  it('maps every reviewed leaf across all seven workflows and four branches with explicit trusted exclusions', () => {
    const topics = [...register.topics, ...Object.values(register.branches).map(branch => branch.topic), ...Object.values(register.scenarios).flatMap(scenario => scenario.additionalTopics)];
    const families = adaptiveGroupFamilies(topics, new Set(topics.map(topic => topic.id)));
    const actual = families.flatMap(family => family.roles.map(role => `${family.topicId}:${family.collection ? `${family.collection}.` : ''}${role.role}`)).sort();
    const expected = topics.flatMap(topic => topic.slots.flatMap(slot => slot.kind === 'collection' ? slot.fields!.map(field => `${topic.id}:${slot.id}.${field.id}`) : /^MH0[1-4]$/.test(slot.id) || slot.kind === 'configuration' || slot.id === 'currentWeightEstimate.statedAt' || topic.id === 'W02' && slot.id === 'appointmentContext' || topic.id === 'W04' && slot.id === 'planContext' ? [] : [`${topic.id}:${slot.id}`])).sort();
    expect(actual).toEqual(expected);
    expect(families.filter(family => family.collection).every(family => family.anchorRoles.length > 0)).toBe(true);
    expect(families.find(family => family.kind === 'W07')!.anchorRoles).toEqual(['medicine']);
    for (const family of families) for (const role of family.roles) {
      expect(role.states.includes('negative')).toBe(!!role.definition.acceptsNegative);
      expect(role.states.includes('not-applicable')).toBe(!!role.definition.acceptsNotApplicable);
    }
  });
  it('does not freeze caller state or disclose persisted identity/source lineage in provider payload', () => {
    const ctx = context('My height is 172 cm.');
    const { manifest } = setup(ctx);
    expect(Object.isFrozen(ctx.displayed)).toBe(false);
    const text = JSON.stringify(manifest.payloads);
    expect(text).not.toContain(ctx.binding.patient);
    expect(text).not.toContain(ctx.binding.sessionId);
    expect(text).not.toContain(ctx.binding.operationId);
    ctx.source.text = 'Changed source';
    expect(() => compileAdaptiveGroupProposal({}, ctx, manifest)).toThrow('stale-group-manifest');
  });
  it('retains distinct measurement values and lets the unchanged guard derive composite units', () => {
    const ctx = context('I am five feet eight inches. The scale read 230 pounds on August 12. I am not sure whether that still reflects my weight; I estimate 235 pounds now.');
    const x = setup(ctx);
    const raw = x.wire([x.patient('Q04', [
      { role: 'height.value', answer: x.answer('five feet eight inches') },
      { role: 'lastMeasuredWeight.value', answer: x.answer('230', 'The scale read 230 pounds on August 12.') },
      { role: 'lastMeasuredWeight.unit', answer: x.answer('pounds', 'The scale read 230 pounds on August 12.') },
      { role: 'lastMeasuredWeight.measuredWhen', answer: x.answer('August 12') },
      { role: 'lastMeasuredWeight.representsCurrent', answer: x.state('uncertain', 'I am not sure whether that still reflects my weight;') },
      { role: 'currentWeightEstimate.value', answer: x.answer('235', 'I estimate 235 pounds now.') },
      { role: 'currentWeightEstimate.unit', answer: x.answer('pounds now'.slice(0,6), 'I estimate 235 pounds now.') },
    ])]);
    // Repeated unit literals are issued independently; select the estimate's literal segment.
    const entries = (raw.groups[0] as any).fields;
    const estimateUnit = x.bound.segments.findIndex(segment => segment.kind === 'literal' && segment.text === 'pounds' && segment.start > ctx.source.text.indexOf('235'));
    entries.at(-1).answer.value = { segment: `s${estimateUnit}`, quote: 'pounds' };
    const result = validateAdaptiveGroupProposal(raw, ctx, x.manifest);
    expect(result.outcome.responses.Q04!.answers['height.value']).toMatchObject({ state: 'known', value: { feet: 5, inches: 8 } });
    expect(result.outcome.responses.Q04!.answers['lastMeasuredWeight.value']).toMatchObject({ value: 230 });
    expect(result.outcome.responses.Q04!.answers['currentWeightEstimate.value']).toMatchObject({ value: 235 });
    expect(result.outcome.responses.Q04!.answers['lastMeasuredWeight.representsCurrent'].state).toBe('uncertain');
  });
  it('structurally separates item concerns, whole-list absence and supported completion', () => {
    const ctx = context('Amlodipine 5 mg. Iron 18 mg. No concerns with either. That is all of my medicines.', ['Q08']);
    const x = setup(ctx);
    const groups = [['a','Amlodipine','5 mg'],['i','Iron','18 mg']].map(([key,name,strength]) => ({ kind:'Q08.medicines', key, scope:{mode:'new',anchor:{role:'name',answer:x.answer(name)}}, fields:[{role:'strength',answer:x.answer(strength)}], correct:[] }));
    const raw = x.wire(groups, { sharedConcerns:[{family:'Q08.medicines',entities:['a','i'],answer:x.state('negative','No concerns with either.')}], completedLists:[{family:'Q08.medicines',support:[x.address('That is all of my medicines.')]}] });
    const result = validateAdaptiveGroupProposal(raw, ctx, x.manifest);
    const medicines = result.outcome.responses.Q08!.answers.medicines as any;
    expect(medicines.complete).toBe(true);
    expect(medicines.items.map((item: any) => item.answers.concerns.state)).toEqual(['negative','negative']);
    expect(result.outcome.clarifications).toEqual([]);
  });
  it('rejects forbidden role states locally without losing independent fields or question acts', () => {
    const ctx = context('I am 172 cm. No concerns. Should I double my dose?');
    const x = setup(ctx);
    const raw = x.wire([x.patient('Q04',[{role:'height.value',answer:x.answer('172')},{role:'height.unit',answer:x.answer('cm')},{role:'lastMeasuredWeight.value',answer:x.state('negative','No concerns.')}])], {acts:[{kind:'question',reply:'COPY-05',support:[x.address('Should I double my dose?')]}]});
    const result = validateAdaptiveGroupProposal(raw, ctx, x.manifest);
    expect(result.rejectedCandidates).toMatchObject([{role:'lastMeasuredWeight.value',reason:'unsupported-role-state'}]);
    expect(result.outcome.responses.Q04!.answers['height.value']).toMatchObject({value:172});
    expect(result.outcome.responses.Q04!.answers['lastMeasuredWeight.value']).toBeUndefined();
    expect(result.outcome.acts).toMatchObject([{kind:'question',replyId:'COPY-05'}]);
    expect(result.hasInterpretationGaps).toBe(true);
  });
  it('does not turn invalid auxiliary completion into patient ambiguity', () => {
    const ctx = context('In my teens my weight stayed steady. After high school my weight increased. I cannot recall the past 18 months.', ['Q03']);
    const x = setup(ctx);
    const raw = x.wire([x.patient('Q03',[{role:'teenage',answer:x.answer('my weight stayed steady','In my teens my weight stayed steady.')},{role:'afterSchool',answer:x.answer('my weight increased','After high school my weight increased.')},{role:'past18Months',answer:x.state('unknown','I cannot recall the past 18 months.')}])],{completedLists:[{family:'Q03.majorChanges',support:[x.address('I cannot recall the past 18 months.')]}]});
    const result = validateAdaptiveGroupProposal(raw, ctx, x.manifest);
    expect(result.patientClarifications).toEqual([]);
    expect(result.semanticRejections).toMatchObject([{path:'majorChanges',reason:'unscoped-response'}]);
    expect(result.outcome.responses.Q03!.answers.past18Months.state).toBe('unknown');
    expect(result.outcome.responses.Q03!.answers.majorChanges).toBeUndefined();
  });
  it('binds corrections to an issued entity and exact prior lineage through unchanged guards', () => {
    const ctx = withPrior(context('Correction: Amlodipine is 10 mg, not 5 mg; iron is still 18 mg.', ['Q08']), 'Q08', {medicines:{state:'known',complete:true,sourceIds:['prior'],items:[{id:'a',answers:{name:known('Amlodipine'),strength:known('5 mg')}},{id:'i',answers:{name:known('iron'),strength:known('18 mg')}}]}});
    const x = setup(ctx);
    const raw = x.wire([{kind:'Q08.medicines',key:'correctA',scope:{mode:'existing',ref:'e0',anchor:[x.address('Amlodipine')]},fields:[{role:'strength',answer:x.answer('10 mg','Correction: Amlodipine is 10 mg, not 5 mg;')}],correct:[0]}]);
    const result = validateAdaptiveGroupProposal(raw, ctx, x.manifest);
    expect(result.proposal.facts[0].correctsSourceIds).toEqual(['prior']);
    const medicines = result.outcome.responses.Q08!.answers.medicines as any;
    expect(medicines.items[0].answers.strength.value).toBe('10 mg');
    expect(medicines.items[1].answers.strength.value).toBe('18 mg');
    expect(result.outcome.provenance[0].supportSourceText).toEqual(['Correction: Amlodipine is 10 mg, not 5 mg;']);
    expect((ctx.responses.Q08!.answers.medicines as any).items[0].answers.strength.value).toBe('5 mg');
    const wrong = structuredClone(raw); (wrong.groups[0] as any).scope.ref = 'e1';
    expect(compileAdaptiveGroupProposal(wrong,ctx,x.manifest).rejectedCandidates.map(candidate=>candidate.reason)).toEqual(['entity-anchor-unresolved','dependent-anchor-rejected']);
  });
  it('requires a source-backed refill identity rather than orphan directions', () => {
    const ctx = context('Please renew semaglutide. The label says weekly. I take it Sundays.', ['W07'], 'refill');
    const x = setup(ctx);
    const raw = x.wire([{kind:'W07',key:'request',scope:{mode:'new',anchor:{role:'medicine',answer:x.answer('semaglutide')}},fields:[{role:'directions',answer:x.answer('weekly','The label says weekly.')},{role:'actualUse',answer:x.answer('Sundays','I take it Sundays.')}],correct:[]}]);
    const result = validateAdaptiveGroupProposal(raw,ctx,x.manifest);
    expect(result.outcome.responses.W07!.answers.medicine).toMatchObject({value:'semaglutide'});
    const orphan = structuredClone(raw); delete (orphan.groups[0] as any).scope.anchor;
    expect(()=>compileAdaptiveGroupProposal(orphan,ctx,x.manifest)).toThrow('invalid-group-proposal');
  });
  it('keeps scenario candidates distinct from admission and rejects invented topics', () => {
    const ctx = context('Amlodipine 5 mg.', ['W07'], 'refill');
    const medicine = register.topics.find(topic=>topic.id==='Q08')!;
    const x = setup(ctx,[medicine]);
    const raw = x.wire([{kind:'Q08.medicines',key:'new',scope:{mode:'new',anchor:{role:'name',answer:x.answer('Amlodipine')}},fields:[{role:'strength',answer:x.answer('5 mg')}],correct:[]}]);
    const result = compileAdaptiveGroupProposal(raw,ctx,x.manifest);
    expect(result.proposal.newItems).toEqual([]);
    expect(result.rejectedCandidates.map(candidate=>candidate.reason)).toEqual(['requires-topic-admission','dependent-anchor-rejected']);
    expect(()=>createAdaptiveGroupManifest(ctx,{candidateTopics:[register.topics.find(topic=>topic.id==='Q10')!]})).toThrow('group-candidate-not-permitted');
  });
  it('resolves every auxiliary address before preserving valid facts and rejects duplicate/correction aliases', () => {
    const ctx = context('I am 172 cm.'); const x = setup(ctx);
    const raw = x.wire([x.patient('Q04',[{role:'height.value',answer:x.answer('172')}])],{unmapped:[{reason:'ambiguous',support:[{segment:'s999',quote:'I am 172 cm.'}]}]});
    expect(()=>compileAdaptiveGroupProposal(raw,ctx,x.manifest)).toThrow('invalid-source-segment');
    const duplicate = x.wire([x.patient('Q04',[{role:'height.value',answer:x.answer('172')},{role:'height.value',answer:x.answer('172')}])]);
    expect(()=>compileAdaptiveGroupProposal(duplicate,ctx,x.manifest)).toThrow('duplicate-group-role');
    const invalidIndex = x.wire([x.patient('Q04',[{role:'height.value',answer:x.answer('172')}],[1])]);
    expect(()=>compileAdaptiveGroupProposal(invalidIndex,ctx,x.manifest)).toThrow('invalid-group-correction-index');
  });
  it('preserves a real same-field conflict after isolated checks and retains the independent question', () => {
    const ctx = withPrior(context('Amlodipine 10 mg. Should I double my dose?', ['Q08']), 'Q08', {medicines:{state:'known',complete:true,sourceIds:['prior'],items:[{id:'a',answers:{name:known('Amlodipine'),strength:known('5 mg')}}]}});
    const x = setup(ctx);
    const raw = x.wire([{kind:'Q08.medicines',key:'change',scope:{mode:'existing',ref:'e0',anchor:[x.address('Amlodipine')]},fields:[{role:'strength',answer:x.answer('10 mg')}],correct:[]}], {acts:[{kind:'question',reply:'COPY-05',support:[x.address('Should I double my dose?')]}]});
    const result = validateAdaptiveGroupProposal(raw,ctx,x.manifest);
    expect(result.patientClarifications).toMatchObject([{reason:'conflict',previous:{value:'5 mg'},proposed:{value:'10 mg'}}]);
    expect((result.outcome.responses.Q08!.answers.medicines as any).items[0].answers.strength.state).toBe('conflicting');
    expect(result.outcome.provenance.some(entry=>entry.path==='medicines[a].strength')).toBe(false);
    expect(result.outcome.acts).toMatchObject([{kind:'question',replyId:'COPY-05'}]);
  });
  it('removes children of a semantically rejected new medicine anchor without losing the independent question', () => {
    const ctx = context('I might take Amlodipine 5 mg. Should I double my dose?', ['Q08']);
    const x = setup(ctx);
    const raw = x.wire([{kind:'Q08.medicines',key:'medicine',scope:{mode:'new',anchor:{role:'name',answer:x.answer('Amlodipine')}},fields:[{role:'strength',answer:x.answer('5 mg')}],correct:[]}], {acts:[{kind:'question',reply:'COPY-05',support:[x.address('Should I double my dose?')]}]});
    const result = validateAdaptiveGroupProposal(raw,ctx,x.manifest);
    expect(result.rejectedCandidates).toEqual(expect.arrayContaining([expect.objectContaining({role:'strength',reason:'dependent-anchor-rejected'})]));
    expect(result.outcome.responses.Q08?.answers.medicines).toBeUndefined();
    expect(result.outcome.provenance).toEqual([]);
    expect(result.patientClarifications).toEqual([]);
    expect(result.outcome.acts).toMatchObject([{kind:'question',replyId:'COPY-05'}]);
  });
  it('does not swallow safety failure while isolating an invalid strength declaration', () => {
    const ctx = context('Amlodipine 5 mg. Should I double my dose?', ['Q08']);
    ctx.safetyPaused = true;
    const x = setup(ctx);
    const raw = x.wire([{kind:'Q08.medicines',key:'medicine',scope:{mode:'new',anchor:{role:'name',answer:x.answer('Amlodipine')}},fields:[{role:'strength',answer:x.answer('5','Amlodipine 5 mg.')}],correct:[]}]);
    expect(()=>validateAdaptiveGroupProposal(raw,ctx,x.manifest)).toThrow('safety-interruption');
  });
  it('prepares all maximum scenario catalogs with the complete native schema without network', async () => {
    const results: unknown[] = [];
    for (const [scenario,template] of Object.entries(register.scenarios)) {
      const topics = [...register.topics.filter(topic=>template.reusableTopicIds.includes(topic.id as never)),...template.additionalTopics,...(template.reusableTopicIds.includes('Q06')?Object.values(register.branches).map(branch=>branch.topic):[])];
      const ctx = context('I have a question for my care team.', topics.map(topic=>topic.id), scenario as any);
      const manifest = createAdaptiveGroupManifest(ctx);
      const prepared = await prepareDigitalOceanRequest({endpoint:'https://inference.do-ai.run',apiKey:'offline-test-only',model:'qwen3.8-max',timeoutMs:15000,maxOutputTokens:4096,maxRequestBytes:60000,responseFormat:{type:'json-schema',name:'adaptive_scoped_groups_v6',schema:manifest.jsonSchema}},[{role:'system',content:manifest.instruction},...manifest.payloads.map(payload=>({role:'user' as const,content:JSON.stringify(payload)}))]);
      const schemaBytes=Buffer.byteLength(JSON.stringify(manifest.jsonSchema));
      expect(schemaBytes).toBeLessThanOrEqual(32000); expect(prepared.requestBytes).toBeLessThanOrEqual(60000);
      results.push({scenario,schemaBytes,requestBytes:prepared.requestBytes});
    }
    console.info(JSON.stringify({kind:'actual-v6-module-maximum-sizes',results}));
  });
});
