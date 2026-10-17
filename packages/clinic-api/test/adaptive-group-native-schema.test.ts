import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { describe,it,expect,vi } from 'vitest';
import { createAdaptiveGroupManifest,issuedAdaptiveGroupManifest } from '../src/adaptive-group-manifest.js';
import { adaptiveGroupProtocol,adaptiveGroupGuidanceRevision } from '../src/adaptive-group-guidance.js';
import { normalizeAdaptiveGroupNativeSchema,draft7AdaptiveGroupNativeSchemaRevision,historicalAdaptiveGroupNativeSchemaRevision } from '../src/adaptive-group-native-schema.js';
import { createDigitalOceanProposer,prepareAdaptiveRequest,validateAdaptiveProposalResult } from '../src/adaptive.js';
import { context,register,withPrior } from './fixtures/adaptive.js';
import type { AdaptiveContext } from '../src/adaptive-validation.js';
const config={endpoint:'https://inference.do-ai.run' as const,apiKey:'offline-mock-only',model:'qwen3.8-max' as const,timeoutMs:15000,maxOutputTokens:4096,maxRequestBytes:60000};
const options={protocol:adaptiveGroupProtocol,guidanceRevision:adaptiveGroupGuidanceRevision,nativeSchemaRevision:draft7AdaptiveGroupNativeSchemaRevision};
const address={segment:'s0',quote:'source'},answer={state:'known',value:address,support:[address]};
const wire=(id:string,groups:unknown[]=[],other={})=>({schema:6,context:id,groups,completedLists:[],absentLists:[],sharedConcerns:[],acts:[],unmapped:[],...other});

describe('explicit V6 native dialect revision, no provider',()=>{
 it('reproduces every historical V6 V1 preflight identity and omits the new receipt field',async()=>{
  const saved=JSON.parse(readFileSync(new URL('../../../docs/implementation/evidence/DO-A16-PREFLIGHT.json',import.meta.url),'utf8'));
  for(const item of saved.results){
   for(const nativeSchemaRevision of [undefined,historicalAdaptiveGroupNativeSchemaRevision]){
    const prepared=await prepareAdaptiveRequest(item.context,config,{protocol:adaptiveGroupProtocol,guidanceRevision:adaptiveGroupGuidanceRevision,nativeSchemaRevision});
    expect(createHash('sha256').update(prepared.body).digest('hex')).toBe(item.preflight.requestSha256);
    expect(prepared.manifest).toEqual(item.manifest);expect(prepared.responseSchema).toEqual(item.responseSchema);expect(prepared.guidance).toEqual(item.guidance);
    expect(prepared).not.toHaveProperty('nativeSchemaRevision');
   }
  }
 });
 it('normalizes only schema locations and preserves const/enum data and additionalProperties:false',()=>{
  const input={type:'object',additionalProperties:false,properties:{x:false,y:{const:false},z:{enum:[false]},a:{anyOf:[{$ref:'#/$defs/A'}]}},$defs:{A:{type:'array',items:false,maxItems:0}}};
  expect(normalizeAdaptiveGroupNativeSchema(input)).toEqual({$schema:'http://json-schema.org/draft-07/schema#',type:'object',additionalProperties:false,properties:{x:{not:{}},y:{const:false},z:{enum:[false]},a:{$ref:'#/definitions/A'}},definitions:{A:{type:'array',items:{not:{}},maxItems:0}}});
  expect(input.properties.x).toBe(false);expect(input.$defs.A.items).toBe(false);
 });
 it('keeps native acceptance equal across all seven full catalogs, role/states, anchors and adversarial packets',()=>{
  let checked=0;
  for(const [scenario,template]of Object.entries(register.scenarios)){
   const topics=[...register.topics.filter(topic=>template.reusableTopicIds.includes(topic.id as never)),...template.additionalTopics,...(template.reusableTopicIds.includes('Q06')?Object.values(register.branches).map(branch=>branch.topic):[])];
   const ctx=context('source',topics.map(topic=>topic.id),scenario as any),v1=createAdaptiveGroupManifest(ctx),v2=createAdaptiveGroupManifest(ctx,{nativeSchemaRevision:draft7AdaptiveGroupNativeSchemaRevision});
   const schema2=structuredClone(v2.jsonSchema) as any;schema2.properties.context.const=v1.id;
   const engine=new Ajv({allErrors:true}),old=engine.compile(v1.jsonSchema),normalized=engine.compile(schema2);
   const bound=issuedAdaptiveGroupManifest(v1,ctx);
   expect(issuedAdaptiveGroupManifest(v2,ctx).families).toEqual(bound.families);expect(v2.instruction).toBe(v1.instruction);
   const check=(packet:unknown)=>{expect(normalized(packet)).toBe(old(packet));checked++;};
   check(wire(v1.id));check(wire(v1.id,[],{extra:true}));check(wire('foreign'));
   for(const family of bound.families){
    for(const role of family.roles){
     for(const state of ['known','unknown','uncertain','declined','negative','not-applicable']){
      const value=state==='known'?answer:{state,value:null,support:[address]};
      const scope=family.anchorRoles.length?{mode:'new',anchor:{role:family.anchorRoles[0],answer:role.role===family.anchorRoles[0]?value:answer}}:'patient';
      const group={kind:family.kind,key:'group',scope,fields:family.anchorRoles[0]===role.role?[]:[{role:role.role,answer:value}],correct:[]};
      const packet=wire(v1.id,[group]);expect(old(packet)).toBe(true);check(packet);
      check(wire(v1.id,[{...group,fields:[{role:'foreign-role',answer}]}]));
      check(wire(v1.id,[{...group,fields:[{role:role.role,answer:{...value,value:state==='known'?null:address}}]}]));
      if(family.anchorRoles.length)check(wire(v1.id,[{...group,scope:{mode:'new'}}]));
     }
    }
   }
   for(const family of bound.families.filter(family=>family.collection)){
    check(wire(v1.id,[],{completedLists:[{family:family.kind,support:[address]}]}));
    check(wire(v1.id,[],{absentLists:[{family:family.kind,support:[address]}]}));
   }
   check(wire(v1.id,[],{completedLists:[{family:'foreign',support:[address]}]}));
   check(wire(v1.id,[],{acts:[{kind:'question',reply:'COPY-05',support:[address]}]}));
   expect(JSON.stringify(v2.jsonSchema)).not.toContain('#/$defs/');expect(v2.jsonSchema.$defs).toBeUndefined();
  }
  expect(checked).toBeGreaterThan(1000);
 });
 it('preserves trusted correction lineage and independent dose dialogue on mocked V2 dispatch, and pins revision',async()=>{
  const known=(value:string)=>({state:'known' as const,value,sourceIds:['prior']});
  const ctx=withPrior(context('Correction: Amlodipine is 10 mg, not 5 mg. Should I double my dose?',['Q08']),'Q08',{medicines:{state:'known',complete:true,sourceIds:['prior'],items:[{id:'a',answers:{name:known('Amlodipine'),strength:known('5 mg')}}]}});
  const manifest=createAdaptiveGroupManifest(ctx,{nativeSchemaRevision:draft7AdaptiveGroupNativeSchemaRevision}),segments=issuedAdaptiveGroupManifest(manifest,ctx).segments;
  const at=(quote:string)=>({segment:`s${segments.findIndex(segment=>segment.text.includes(quote)&&segment.text.indexOf(quote,segment.text.indexOf(quote)+1)<0)}`,quote});
  const raw=wire(manifest.id,[{kind:'Q08.medicines',key:'correction',scope:{mode:'existing',ref:'e0',anchor:[at('Amlodipine')]},fields:[{role:'strength',answer:{state:'known',value:at('10 mg'),support:[at('Correction: Amlodipine is 10 mg, not 5 mg.')]}}],correct:[0]}],{acts:[{kind:'question',reply:'COPY-05',support:[at('Should I double my dose?')]}]});
  const oldManifest=createAdaptiveGroupManifest(ctx),engine=new Ajv({allErrors:true}),old=engine.compile(oldManifest.jsonSchema),normalized=engine.compile(manifest.jsonSchema);
  expect(old({...raw,context:oldManifest.id})).toBe(true);expect(normalized(raw)).toBe(true);
  for(const mutate of [(group:any)=>({...group,scope:{...group.scope,ref:'e999'}}),(group:any)=>({...group,correct:[32]}),(group:any)=>({...group,scope:{mode:'new',anchor:{role:'name',answer}}})]){
   const changed={...raw,groups:[mutate(raw.groups[0])]};expect(normalized(changed)).toBe(false);expect(old({...changed,context:oldManifest.id})).toBe(false);
  }
  const prepared=await prepareAdaptiveRequest(ctx,config,options);
  const mock=vi.fn(async(_url,init)=>{expect(init?.body).toBe(prepared.body);return new Response(JSON.stringify({id:'native-v2-mock',model:config.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(raw)}}]}));});
  const result=await createDigitalOceanProposer(config,mock,options).propose(ctx),validated=validateAdaptiveProposalResult(ctx,result,options);
  expect(result.receipt?.nativeSchemaRevision).toBe(draft7AdaptiveGroupNativeSchemaRevision);expect(prepared.nativeSchemaRevision).toBe(draft7AdaptiveGroupNativeSchemaRevision);
  expect((validated.outcome.responses.Q08!.answers.medicines as any).items[0].answers.strength).toMatchObject({value:'10 mg'});
  expect(validated.outcome.provenance[0].correctsSourceIds).toEqual(['prior']);expect(validated.dialogue.reply?.id).toBe('COPY-05');expect(mock).toHaveBeenCalledTimes(1);
  expect(()=>validateAdaptiveProposalResult(ctx,{...result,receipt:{...result.receipt!,nativeSchemaRevision:undefined}},options)).toThrow('group-receipt-mismatch');
  expect(()=>validateAdaptiveProposalResult(ctx,result,{protocol:adaptiveGroupProtocol})).toThrow('group-receipt-mismatch');
 });
 it('refuses unknown revisions or a native revision on a legacy protocol',async()=>{
  const ctx=context('source');
  await expect(prepareAdaptiveRequest(ctx,config,{protocol:adaptiveGroupProtocol,nativeSchemaRevision:'invented' as any})).rejects.toThrow('invalid-native-schema-revision');
  await expect(prepareAdaptiveRequest(ctx,config,{protocol:'contextual-values-v5',nativeSchemaRevision:historicalAdaptiveGroupNativeSchemaRevision})).rejects.toThrow('native-schema-requires-group-protocol');
 });
});
