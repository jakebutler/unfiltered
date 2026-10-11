import { expect,it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fullCaseIds,fullCaseContext,fullCaseLabels,fullDevelopmentCases } from '../../../scripts/qualification/fixtures/adaptive-full-cases.js';
import { createFullReplyManifest, prepareFullCapture, type FullReplyDraft } from '../src/adaptive-reply-full.js';
import { fullCaseReadback } from '../../../scripts/qualification/fixtures/adaptive-full-readback.js';
import { representativeFullDraft } from '../../../scripts/qualification/fixtures/adaptive-full-development.js';
import { adaptiveSession } from '../src/adaptive-session.js';
import { conversation } from '../src/conversation.js';
import type { ClinicApiConfig,Draft,StoredDraft } from '../src/types.js';
import { createFullCompactManifest } from '../src/adaptive-reply-full-compact.js';
import { prepareDigitalOceanStreamRequest } from '../../clinical-core/src/digitalocean-stream.js';
it('preserves the oversized existing-item G7 catalog as bounded supported text parts',async()=>{
  const full=createFullReplyManifest(fullCaseContext('G7')),compact=createFullCompactManifest(full),content=compact.messages[1].content;
  expect(String(full.messages[1].content).length).toBeGreaterThan(32000);
  if(!Array.isArray(content))throw Error('expected supported text parts');
  expect(content).toHaveLength(3);
  expect(content.every(part=>part.type==='text'&&part.text.length<=16000)).toBe(true);
  expect(content.map(part=>part.type==='text'?part.text:'').join('')).toBe(full.messages[1].content);
  const request=await prepareDigitalOceanStreamRequest({endpoint:'https://inference.do-ai.run',model:'qwen3.8-max',apiKey:'offline-only',timeoutMs:30000,maxOutputTokens:4096,maxRequestBytes:131072,responseFormat:{type:'json-schema',name:'full_g7',schema:compact.jsonSchema}},[...compact.messages]);
  expect(request.requestBytes).toBeLessThan(131072);
});
it('freezes exactly15 source-addressed cases across all7 scenarios without executing the old harness',()=>{
  expect(fullCaseIds).toHaveLength(15);expect(new Set(fullCaseIds).size).toBe(15);expect(new Set(fullDevelopmentCases.map(c=>c.scenario)).size).toBe(7);
  const originals=readFileSync('scripts/qualification/qualify-adaptive.mjs','utf8');
  for(const spec of fullDevelopmentCases){const context=fullCaseContext(spec.id),labels=fullCaseLabels(spec.id),manifest=createFullReplyManifest(context);
    for(const item of [...labels.expected,...labels.closures,...labels.residual])expect(context.source.text.slice(item.sourceAddress.start,item.sourceAddress.end)).toBe(item.quote);
    for(const item of labels.expected)expect(manifest.targets.some(t=>t.topicId===item.topic&&(item.path.includes('[existing]')?t.path.startsWith(item.path.split('[')[0]+'[')&&t.path.endsWith(item.path.split(']')[1]):t.path===item.path))).toBe(true);
    if(/^G[1-8]$/.test(spec.id))expect(originals).toContain(JSON.stringify(spec.text).slice(1,-1).replaceAll('\\"','"'));
  }
});
it('retains failure readback and immutable source for every selected case without a provider call',async()=>{
  for(const id of fullCaseIds){const result=await fullCaseReadback(id,{errorCode:'offline-failure'});expect(result.defaultEnabled).toBe(false);expect(result.view.completeness).toBe('partial');expect(result.savedDraft.turns.at(-1)!.text).toBe(fullCaseContext(id).source.text);expect(result.savedDraft.adaptive!.operations[fullCaseContext(id).binding.operationId].status).toBe('unresolved');}
});
it('replays complete capture and existing-item correction through saved-state projection without granting qualification',async()=>{
  const rContext=fullCaseContext('R1'),rManifest=createFullReplyManifest(rContext);
  const r=await fullCaseReadback('R1',{draft:representativeFullDraft(rManifest),advance:{manifestId:rManifest.id,actionId:rManifest.actions.at(-1)!.id,controls:[],defer:[]}});
  expect(r.savedDraft.adaptive!.operations[rContext.binding.operationId].status).toBe('applied');expect(r.policyQualified).toBe(false);expect(r.view.completeness).toBe('partial');
  const context=fullCaseContext('G7'),manifest=createFullReplyManifest(context),statement=JSON.parse(String(manifest.messages[1].content)).statements[0],ev={statementId:statement.id,quote:statement.text};
  const list=context.captureResponses!.Q08!.answers.medicines!;if(list.state!=='known'||!list.items)throw Error('prior fixture');
  const claims=list.items.map((item,index)=>({targetId:manifest.targets.find(t=>t.path===`medicines[${item.id}].strength`)!.id,itemKey:null,state:'known' as const,value:index===0?'500 mg':'1000 IU',valueEvidence:ev,evidence:[ev],scope:{subject:'patient' as const,entity:index===0?'Metformin':'Vitamin D',period:null,predicate:ev},correctsSourceIds:index===0?[context.sources[0].id]:[]}));
  const draft:FullReplyDraft={manifestId:manifest.id,claims,items:[],closures:[],acts:[],residual:[],sourceDisposition:'represented'};
  const g=await fullCaseReadback('G7',{draft,advance:{manifestId:manifest.id,actionId:manifest.actions.at(-1)!.id,controls:[],defer:[]}});
  expect(g.savedDraft.adaptive!.operations[context.binding.operationId].status).toBe('applied');
  const projected=g.projection.responses.Q08.answers.medicines!;if(projected.state!=='known'||!projected.items)throw Error('projection');
  expect(projected.items.map(item=>item.id)).toEqual(list.items.map(item=>item.id));expect(projected.items.map(item=>item.answers.strength)).toMatchObject([{state:'known',value:'500 mg'},{state:'known',value:'1000 IU'}]);
  expect(g.savedDraft.turns.map(turn=>turn.text)).toEqual(context.sources.map(turn=>turn.text));
});
it('keeps explicit family ownership through admission and stored readback without assigning mother diabetes to patient',async()=>{
  const context=fullCaseContext('G5'),manifest=createFullReplyManifest(context),statement=JSON.parse(String(manifest.messages[1].content)).statements[0],ev={statementId:statement.id,quote:statement.text},target=(topic:string,path:string)=>manifest.targets.find(t=>t.topicId===topic&&t.path===path)!.id;
  const field=(path:string,value:string)=>({targetId:target('Q10',path),itemKey:'mother',state:'known' as const,value,valueEvidence:ev,evidence:[ev],scope:{subject:'other' as const,entity:'Mother',period:null,predicate:ev},correctsSourceIds:[]});
  const raw:FullReplyDraft={manifestId:manifest.id,claims:[field('familyHistory[new].condition','diabetes'),field('familyHistory[new].relationship','mother'),{...field('familyHistory[new].condition','true'),targetId:target('Q06','conditions.diabetes'),itemKey:null}],items:[{collectionId:target('Q10','familyHistory'),key:'mother',entity:'Mother',evidence:[ev]}],closures:[],acts:[],residual:[],sourceDisposition:'partially-represented'};
  const capture=prepareFullCapture(raw,manifest);expect(capture.claims).toHaveLength(2);expect(capture.claims.every(c=>c.scope.subject==='other'&&c.scope.entity==='Mother')).toBe(true);expect(capture.gaps.some(g=>g.reason==='ownership')).toBe(true);
  const saved=await fullCaseReadback('G5',{draft:raw,advance:{manifestId:manifest.id,actionId:manifest.actions.at(-1)!.id,controls:[],defer:[]}});
  expect(saved.savedDraft.adaptive!.operations[context.binding.operationId].status).toBe('applied');expect(saved.projection.claims.every(c=>c.scope.subject==='other')).toBe(true);expect(saved.projection.responses.Q06?.answers['conditions.diabetes']).toBeUndefined();
  const ambiguous=structuredClone(raw);ambiguous.claims=ambiguous.claims.slice(0,2).map(c=>({...c,scope:{...c.scope,entity:null}}));expect(prepareFullCapture(ambiguous,manifest).claims).toHaveLength(0);
});
it('stores explicit full-mode35s deadline while legacy retains15s execution plus5s recovery grace',async()=>{
  for(const fullCapture of [true,false]){
    const now=Date.now(),ctx=fullCaseContext('R1'),content=conversation({mentalHealth:'phq4',patients:{}} as ClinicApiConfig);
    let entered!:()=>void,finish!:(value:{draft:unknown})=>void;const started=new Promise<void>(r=>{entered=r;}),tail=new Promise<{draft:unknown}>(r=>{finish=r;});
    const api=adaptiveSession(content,undefined,{now:()=>now,timeoutMs:45000,fullCapture,streamProposer:{propose:async()=>{entered();return tail;}}});
    const initial=api.initialize({schema:1,id:ctx.binding.sessionId,patient:ctx.binding.patient,scenario:'first-intake',revision:0,createdAt:new Date(now).toISOString(),savedAt:new Date(now).toISOString(),phase:'conversation',turns:[],topics:{},requests:{},version:1} as Draft);
    let stored:StoredDraft={draft:initial,versionId:'1',resource:{resourceType:'DocumentReference'}};
    const store={read:async()=>structuredClone(stored),save:async(_previous:StoredDraft,next:Draft)=>{stored={...stored,draft:structuredClone(next),versionId:String(Number(stored.versionId)+1)};return structuredClone(stored);}};
    const accepted=await api.accept(store,{requestId:crypto.randomUUID(),expectedRevision:0,text:ctx.source.text,channel:'text'}),running=api.interpret(store,accepted.operation.id);await started;
    expect(Date.parse(stored.draft.adaptive!.operations[accepted.operation.id].deadlineAt!)-now).toBe(fullCapture?35000:20000);
    finish({draft:{}});await running;
  }
});
