import { createHash } from 'node:crypto';
import { describe,it,expect,vi } from 'vitest';
import { buildAdaptiveMessages,prepareAdaptiveRequest,createDigitalOceanProposer,validateAdaptiveProposalResult } from '../src/adaptive.js';
import { createAdaptiveGroupManifest,issuedAdaptiveGroupManifest } from '../src/adaptive-group-manifest.js';
import { adaptiveGroupProtocol,adaptiveGroupGuidanceRevision } from '../src/adaptive-group-guidance.js';
import { selectAdaptiveGroupDialogue,selectAdaptiveDialogue } from '../src/dialogue.js';
import { validateAdaptiveGroupProposal } from '../src/adaptive-group-compile.js';
import { context,withPrior } from './fixtures/adaptive.js';
import type { AdaptiveContext } from '../src/adaptive-validation.js';
import { evaluateTopic } from '../../clinic-content/src/index.js';
const config={endpoint:'https://inference.do-ai.run' as const,apiKey:'offline-mock-only',model:'qwen3.8-max' as const,timeoutMs:15000,maxOutputTokens:4096,maxRequestBytes:60000};
const options={protocol:adaptiveGroupProtocol,guidanceRevision:adaptiveGroupGuidanceRevision};
function packet(ctx:AdaptiveContext){
 const manifest=createAdaptiveGroupManifest(ctx),segments=issuedAdaptiveGroupManifest(manifest,ctx).segments;
 const address=(quote:string)=>{const index=segments.findIndex(segment=>segment.text.includes(quote)&&segment.text.indexOf(quote,segment.text.indexOf(quote)+1)<0);if(index<0)throw new Error(`Missing unique quote: ${quote}`);return {segment:`s${index}`,quote};};
 const answer=(value:string,support=value)=>({state:'known',value:address(value),support:[address(support)]});
 const wire=(groups:unknown[],other={})=>({schema:6,context:manifest.id,groups,completedLists:[],absentLists:[],sharedConcerns:[],acts:[],unmapped:[],...other});
 return {manifest,address,answer,wire};
}
async function mockResult(ctx:AdaptiveContext,raw:unknown){
 const prepared=await prepareAdaptiveRequest(ctx,config,options);
 const fetcher=vi.fn(async(_url,init)=>{expect(init?.body).toBe(prepared.body);return new Response(JSON.stringify({id:'mock-v6',model:config.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(raw)}}]}));});
 const result=await createDigitalOceanProposer(config,fetcher,options).propose(ctx);
 expect(fetcher).toHaveBeenCalledTimes(1);
 return {result,prepared};
}
describe('explicit V6 routing and dialogue, mock transport only',()=>{
 it('prepares native schema and preserves raw groups for trusted context-recreated validation',async()=>{
  const ctx=context('I want more energy.',['Q01']),x=packet(ctx);
  const raw=x.wire([{kind:'Q01',key:'goals',scope:'patient',fields:[{role:'reason',answer:x.answer('more energy')}],correct:[]}]);
  const {result,prepared}=await mockResult(ctx,raw);
  expect(result.proposal).toEqual(raw);expect(result.rawProposal).toEqual(raw);
  expect(result.receipt).toMatchObject({evidenceProtocol:adaptiveGroupProtocol,manifest:prepared.manifest,responseSchema:prepared.responseSchema,guidance:prepared.guidance});
  expect(prepared.guidance?.instructionSha256).toBe(createHash('sha256').update(buildAdaptiveMessages(ctx,adaptiveGroupProtocol,options)[0].content as string).digest('hex'));
  const validated=validateAdaptiveProposalResult(ctx,result,options);
  expect(validated.outcome.responses.Q01?.answers.reason).toMatchObject({state:'known',value:'more energy'});
  expect(validated.admissionPolicy).toBe('admitted-context-topics-v1');
  expect(()=>validateAdaptiveProposalResult(ctx,result)).toThrow('invalid-adaptive-proposal');
 });
 it('rejects canonical shortcuts, stale receipt pins, and provider rejection metadata',async()=>{
  const ctx=context('I want more energy.',['Q01']),x=packet(ctx),raw=x.wire([{kind:'Q01',key:'goals',scope:'patient',fields:[{role:'reason',answer:x.answer('more energy')}],correct:[]}]);
  const {result}=await mockResult(ctx,raw);
  const forged={...result,groups:{patientClarifications:[],rejectedCandidates:[],hasInterpretationGaps:false}};
  expect(validateAdaptiveProposalResult(ctx,forged,options).outcome.responses.Q01?.answers.reason).toMatchObject({value:'more energy'});
  expect(()=>validateAdaptiveProposalResult(ctx,{...result,proposal:{schema:2,facts:[],newItems:[],completedLists:[],acts:[]}},options)).toThrow('group-raw-proposal-mismatch');
  expect(()=>validateAdaptiveProposalResult(ctx,{...result,receipt:{...result.receipt!,manifest:{id:'wrong',sha256:'wrong'}}},options)).toThrow('group-receipt-mismatch');
  const stale={...ctx,binding:{...ctx.binding,revision:ctx.binding.revision+1}};
  expect(()=>validateAdaptiveProposalResult(stale,result,options)).toThrow('group-receipt-mismatch');
 });
 it('keeps unitless strength as a gap while asking only independent label directions and retaining dose reply',async()=>{
  const ctx=context('Amlodipine 5 mg. Should I double my dose?',['Q08']),x=packet(ctx);
  const raw=x.wire([{kind:'Q08.medicines',key:'med',scope:{mode:'new',anchor:{role:'name',answer:x.answer('Amlodipine')}},fields:[{role:'strength',answer:x.answer('5','Amlodipine 5 mg.')}],correct:[]}],{acts:[{kind:'question',reply:'COPY-05',support:[x.address('Should I double my dose?')]}]});
  const {result}=await mockResult(ctx,raw),v=validateAdaptiveProposalResult(ctx,result,options);
  expect(v.outcome.hasUnresolvedInterpretation).toBe(true);expect(v.dialogue.reply?.id).toBe('COPY-05');
  expect(v.dialogue.clarification).toBeUndefined();expect(v.dialogue.prompt?.targetPaths.some(path=>path.endsWith('.strength'))).toBe(false);
  expect(v.dialogue.prompt?.targetPaths.some(path=>path.endsWith('.labelDirections'))).toBe(true);
  expect(v.dialogue.prompt?.text).not.toMatch(/strength/i);
  const required=evaluateTopic(ctx.topics[0],v.outcome.responses.Q08!,{validSourceIds:new Set(ctx.sources.map(source=>source.id))});
  expect(required.sufficient).toBe(false);
 });
 it('returns interpretation review when every remaining required target is machine blocked',async()=>{
  const ctx=context('No reason. No priority.',['Q01']),x=packet(ctx);
  const raw=x.wire([{kind:'Q01',key:'goals',scope:'patient',fields:[{role:'reason',answer:{state:'negative',value:null,support:[x.address('No reason.')]}},{role:'priority',answer:{state:'negative',value:null,support:[x.address('No priority.')]}}],correct:[]}]);
  const {result}=await mockResult(ctx,raw),v=validateAdaptiveProposalResult(ctx,result,options);
  expect(v.dialogue.status).toBe('interpretation-review');expect(v.dialogue.prompt).toBeUndefined();expect(v.dialogue.state.lastUnsuccessful).toBeUndefined();
  expect(v.outcome.hasUnresolvedInterpretation).toBe(true);expect(v.outcome.updates).toEqual([]);
 });
 it('preserves genuine conflict dialogue and rejects forged or changed local dispositions',()=>{
  const known=(value:string)=>({state:'known' as const,value,sourceIds:['prior']});
  const ctx=withPrior(context('Amlodipine 10 mg.',['Q08']),'Q08',{medicines:{state:'known',complete:true,sourceIds:['prior'],items:[{id:'a',answers:{name:known('Amlodipine'),strength:known('5 mg')}}]}}),x=packet(ctx);
  const raw=x.wire([{kind:'Q08.medicines',key:'change',scope:{mode:'existing',ref:'e0',anchor:[x.address('Amlodipine')]},fields:[{role:'strength',answer:x.answer('10 mg')}],correct:[]}]);
  const groups=validateAdaptiveGroupProposal(raw,ctx,x.manifest);
  expect(selectAdaptiveGroupDialogue(ctx,groups).clarification?.reason).toBe('conflict');
  expect(()=>selectAdaptiveGroupDialogue(ctx,{...groups})).toThrow('untrusted-group-result');
  (groups as any).rejectedCandidates=[{...groups.candidates[0],reason:'semantic-rejection'}];expect(()=>selectAdaptiveGroupDialogue(ctx,groups)).toThrow('untrusted-group-result');
 });
 it('preserves legacy dialogue and refuses unsupported V6 guidance or malformed wire without retry',async()=>{
  const ctx=context('I want more energy.',['Q01']);
  expect(selectAdaptiveDialogue(ctx).status).toBe('question');
  await expect(prepareAdaptiveRequest(ctx,config,{protocol:adaptiveGroupProtocol,guidanceRevision:'invented' as any})).rejects.toThrow('invalid-guidance-revision');
  const invalid=vi.fn(async()=>new Response(JSON.stringify({id:'bad',model:config.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify({schema:6})}}]})));
  await expect(createDigitalOceanProposer(config,invalid,options).propose(ctx)).rejects.toMatchObject({code:'invalid-group-proposal',rawProposal:{schema:6}});
  expect(invalid).toHaveBeenCalledTimes(1);
 });
});
