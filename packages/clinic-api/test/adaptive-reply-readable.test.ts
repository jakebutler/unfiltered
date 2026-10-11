import { expect,it } from 'vitest';
import { fullCaseIds,fullCaseContext,representativeCaseDraft } from '../../../scripts/qualification/fixtures/adaptive-full-cases.js';
import { createFullReplyManifest,prepareFullCapture,prepareFullNavigation } from '../src/adaptive-reply-full.js';
import { createReadableManifest,encodeReadableDraft,decodeReadableDraft,decodeReadableAdvance,readableStreamProposer } from '../src/adaptive-reply-readable.js';
import { selectUsefulAdvance } from '../src/reply-usefulness.js';
import { fullCaseReadback } from '../../../scripts/qualification/fixtures/adaptive-full-readback.js';
import { projectProvisional } from '../src/provisional-projection.js';
import { prepareDigitalOceanStreamRequest } from '../../clinical-core/src/digitalocean-stream.js';

it('roundtrips15 authored same-source representative captures with derived list identity, without model qualification',()=>{
 for(const id of fullCaseIds){const full=createFullReplyManifest(fullCaseContext(id)),manifest=createReadableManifest(full),draft=representativeCaseDraft(id,full),decoded=decodeReadableDraft(encodeReadableDraft(draft,manifest),manifest);
  expect(prepareFullCapture(decoded,full)).toEqual(prepareFullCapture(draft,full));}
});
it('uses descriptive names and strict known/nonknown variants instead of repairing contradictory states',()=>{
 const full=createFullReplyManifest(fullCaseContext('R1')),manifest=createReadableManifest(full),raw=encodeReadableDraft(representativeCaseDraft('R1',full),manifest);
 expect(raw.claims[0].target).toMatch(/^Q\d+:|^W\d+:/);expect(raw.claims[0].report.state).toBe('known');
 const invalid=structuredClone(raw);invalid.claims[0].report={state:'negative',value:'Vitamin C'} as never;
 expect(()=>decodeReadableDraft(invalid,manifest)).toThrow();
 const absent=structuredClone(raw);absent.claims[0].report={state:'known',value:'Vitamin C'} as never;
 expect(()=>decodeReadableDraft(absent,manifest)).toThrow();
});
it('keeps all base cross-topic targets but does not issue diabetes treatment from a medicine alone',()=>{
 const context=fullCaseContext('G8'),full=createFullReplyManifest(context);
 expect(full.targets.some(target=>target.topicId==='Q08')).toBe(true);expect(full.targets.some(target=>target.topicId==='DM')).toBe(false);
 context.responses.DM={presented:true,answers:{},applicability:'applicable'};
 expect(createFullReplyManifest(context).targets.some(target=>target.topicId==='DM')).toBe(true);
});
it('issues fully rendered approved missing-context questions for followup and absent authored plan',()=>{
 for(const id of ['P1','V1']){const full=createFullReplyManifest(fullCaseContext(id));expect(full.actions.every(action=>!/[\[\]]/.test(action.text))).toBe(true);expect(full.actions.some(action=>action.promptId===(id==='P1'?'S01a':'S03a'))).toBe(true);}
});
it('quoted model move-on and legacy defer cannot redirect an otherwise useful issued question or stop a topic',async()=>{
 const context=fullCaseContext('G2'),full=createFullReplyManifest(context),action=full.actions.find(action=>action.topicId==='Q03')!,payload=JSON.parse(String(full.messages[1].content)),ev={statementId:payload.statements.find((s:{text:string})=>s.text.includes('After high school')).id,quote:'After high school my weight increased.'};
 const advance={manifestId:full.id,actionId:action.id,controls:[{kind:'move-on' as const,targetTopicId:'Q03',replyId:null,evidence:[ev]}],defer:[{targetId:full.targets.find(t=>t.topicId==='Q03')!.id,evidence:[ev]}]};
 expect(selectUsefulAdvance(context,advance,full.actions,full.targets)?.action.id).toBe(action.id);
 const draft=representativeCaseDraft('G2',full);draft.acts=[{kind:'move-on',targetTopicId:'Q03',replyId:null,evidence:[ev]}];
 const readback=await fullCaseReadback('G2',{draft,advance});expect(projectProvisional(readback.savedDraft,context.topics,{qualified:true}).responses.Q03?.stopped).toBeUndefined();
});
it('authored supplied prefix selects a missing question with no field or readiness credit and retains tail disagreement',async()=>{
 const context=fullCaseContext('G6'),full=createFullReplyManifest(context),manifest=createReadableManifest(full),draft=representativeCaseDraft('G6',full),height=draft.claims.filter(claim=>full.targets.find(t=>t.id===claim.targetId)?.topicId==='Q04'),question=full.actions.find(action=>action.targetPaths.includes('height.value'))!;
 const raw={manifestId:full.id,actionId:question.id,controls:[],supplied:height.map(claim=>({target:`Q04:${full.targets.find(t=>t.id===claim.targetId)!.path}`,report:{state:'known',value:claim.value,valueSource:claim.valueEvidence},evidence:claim.evidence}))};
 const advance=decodeReadableAdvance(raw,manifest),navigation=prepareFullNavigation(advance,full),useful=selectUsefulAdvance(context,advance,full.actions,full.targets,navigation)!;
 expect(useful.rejectedNomination).toBe('supplied-answer');expect(useful.action.targetPaths).not.toContain('height.value');
 const missing=structuredClone(draft);missing.claims=[];
 const replay=await fullCaseReadback('G6',{draft:missing,advance}),op=replay.savedDraft.adaptive!.operations[context.binding.operationId];
 expect(op.stream!.navigation!.claims).toHaveLength(2);expect(op.stream!.provisional!.gaps.some(gap=>gap.reason==='conflict')).toBe(true);
 expect(replay.savedDraft.adaptive!.exchange!.prompt!.promptId).toBe(useful.action.promptId);
 expect(replay.projection.claims).toHaveLength(0);expect(replay.policyQualified).toBe(false);
 expect(()=>decodeReadableAdvance({...raw,supplied:[...raw.supplied,...raw.supplied,...raw.supplied]},manifest)).toThrow();
 const foreign=structuredClone(raw);foreign.supplied[0].evidence=[{statementId:'foreign',quote:'172cm'}];expect(()=>decodeReadableAdvance(foreign,manifest)).toThrow();
});
it('bounds all15 actual request schemas and preserves exact multipart source',async()=>{
 for(const id of fullCaseIds){const full=createFullReplyManifest(fullCaseContext(id)),manifest=createReadableManifest(full),content=manifest.messages[1].content;
 const text=Array.isArray(content)?content.map(part=>part.type==='text'?part.text:'').join(''):content;
 expect(JSON.parse(String(text)).source).toEqual(JSON.parse(String(full.messages[1].content)).source);
 const request=await prepareDigitalOceanStreamRequest({endpoint:'https://inference.do-ai.run',model:'qwen3.8-max',apiKey:'offline',timeoutMs:30000,maxOutputTokens:4096,maxRequestBytes:131072,responseFormat:{type:'json-schema',name:'readable_test',schema:manifest.jsonSchema}},[...manifest.messages]);expect(request.requestBytes).toBeLessThan(131072);}
});
it('binds context to issued full manifest before any injected dispatch',async()=>{
 const context=fullCaseContext('G1'),manifest=createFullReplyManifest(context);let calls=0;
 const proposer=readableStreamProposer({endpoint:'https://inference.do-ai.run',model:'qwen3.8-max',apiKey:'offline',timeoutMs:30000,maxOutputTokens:4096,maxRequestBytes:131072},{fetcher:async()=>{calls++;throw Error('must not dispatch');}});
 await expect(proposer.propose(fullCaseContext('G2'),manifest,{signal:new AbortController().signal,onAdvance:async()=>{}})).rejects.toThrow();expect(calls).toBe(0);
});
it('full navigation does not mistake resistance about running out or quoted clinician advice for patient topic refusal',()=>{
 for(const text of ['I do not want to run out of metformin.','My doctor told me to move on.']){const ctx=fullCaseContext('G8');ctx.source.text=text;const full=createFullReplyManifest(ctx),action=full.actions.find(action=>action.topicId==='W07')!;expect(selectUsefulAdvance(ctx,{manifestId:full.id,actionId:action.id,controls:[],defer:[]},full.actions,full.targets)?.action.id).toBe(action.id);}
});
it('issued single-detail alternatives preserve a partial grouped answer without reasking it',()=>{
 const ctx=fullCaseContext('G6'),full=createFullReplyManifest(ctx),raw=representativeCaseDraft('G6',full),height=raw.claims.find(claim=>full.targets.find(t=>t.id===claim.targetId)?.path==='height.value')!,action=full.actions.find(action=>action.targetPaths.includes('height.value'))!;
 const advance={manifestId:full.id,actionId:action.id,controls:[],defer:[],supplied:[{targetId:height.targetId,state:height.state,value:height.value,valueEvidence:height.valueEvidence,evidence:height.evidence}]};
 const selected=selectUsefulAdvance(ctx,advance,full.actions,full.targets,prepareFullNavigation(advance,full))!;
 expect(selected.action.topicId).toBe('Q04');expect(selected.action.targetPaths).not.toContain('height.value');expect(selected.action.targetPaths).toContain('height.unit');
});
it('streams readable closed advance before an incomplete fragmented tail and keeps rejection/unknown receipt distinct',async()=>{
 const ctx=fullCaseContext('G6'),full=createFullReplyManifest(ctx),manifest=createReadableManifest(full),advance={manifestId:full.id,actionId:full.actions.at(-1)!.id,controls:[],supplied:[]};
 let control!:ReadableStreamDefaultController<Uint8Array>,saved!:()=>void;const early=new Promise<void>(resolve=>{saved=resolve;});let notified=0;
 const event=(content:string|null,finish:string|null=null)=>`data: ${JSON.stringify({id:'readable-offline',model:'qwen3.8-max',choices:[{index:0,delta:{content},finish_reason:finish}]})}\n\n`;
 const stream=new Response(new ReadableStream<Uint8Array>({start(controller){control=controller;}}),{headers:{'Content-Type':'text/event-stream'}});
 const {consumeReadableStream}=await import('../src/adaptive-reply-readable.js');
 const pending=consumeReadableStream({endpoint:'https://inference.do-ai.run',model:'qwen3.8-max',apiKey:'offline',timeoutMs:1000,maxOutputTokens:4096,maxRequestBytes:131072},manifest,{fetcher:async()=>stream,onAdvance:()=>{notified++;saved();}});
 for(const byte of new TextEncoder().encode(event('{"advance":'+JSON.stringify(advance)+',"draft":')))control.enqueue(new Uint8Array([byte]));
 await early;expect(notified).toBe(1);control.enqueue(new TextEncoder().encode(event('{"bad":true}')+event(null,'stop')+'data: [DONE]\n\n'));control.close();
 await expect(pending).rejects.toMatchObject({receipt:{outcome:'rejected',providerExecution:'unknown'}});expect(notified).toBe(1);
});
it('a complete direct patient command defers navigation only while factual and reported move-on cannot',async()=>{
 for(const [text,attribution,expected] of [
  ['Please move on from weight.','direct-patient-command',true],
  ['After high school my weight increased.','direct-patient-command',false],
  ['My doctor told me to move on.','direct-patient-command',false],
  ['I do not want to run out of metformin.','direct-patient-command',false],
  ['Please move on from weight.','reported-content',false],
 ] as const){const ctx=fullCaseContext('G6');ctx.source.text=text;ctx.sources=[ctx.source];const full=createFullReplyManifest(ctx),manifest=createReadableManifest(full),statement=JSON.parse(String(full.messages[1].content)).statements[0],action=full.actions.find(action=>action.topicId==='Q04')!;
 const advance=decodeReadableAdvance({manifestId:full.id,actionId:action.id,controls:[{kind:'move-on',attribution,targetTopicId:'Q04',replyId:null,evidence:[{statementId:statement.id,quote:text}]}],supplied:[]},manifest);
 const selected=selectUsefulAdvance(ctx,advance,full.actions,full.targets,prepareFullNavigation(advance,full))!;
 expect(selected.action.topicId!=='Q04').toBe(expected);expect(ctx.responses.Q04?.stopped).toBeUndefined();}
});
it('dispatches exactly one injected readable packet through the full factory with typed capture parity',async()=>{
 const ctx=fullCaseContext('G4'),full=createFullReplyManifest(ctx),manifest=createReadableManifest(full),draft=representativeCaseDraft('G4',full),advance={manifestId:full.id,actionId:full.actions.at(-1)!.id,controls:[],supplied:[]};let calls=0,notified=0;
 const chunk=(content:string|null,finish:string|null=null)=>`data: ${JSON.stringify({id:'readable-complete',model:'qwen3.8-max',choices:[{index:0,delta:{content},finish_reason:finish}]})}\n\n`;
 const proposer=readableStreamProposer({endpoint:'https://inference.do-ai.run',model:'qwen3.8-max',apiKey:'offline',timeoutMs:1000,maxOutputTokens:4096,maxRequestBytes:131072},{fetcher:async()=>{calls++;return new Response(chunk(JSON.stringify({advance,draft:encodeReadableDraft(draft,manifest)}))+chunk(null,'stop')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});}});
 const result=await proposer.propose(ctx,full,{signal:new AbortController().signal,onAdvance:async()=>{notified++;}});
 expect(calls).toBe(1);expect(notified).toBe(1);expect(prepareFullCapture(result.draft,full)).toEqual(prepareFullCapture(draft,full));expect(result.receipt).toMatchObject({outcome:'complete',providerExecution:'completed',usage:'unknown'});
});
