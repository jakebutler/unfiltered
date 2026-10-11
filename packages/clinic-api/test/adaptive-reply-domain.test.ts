import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {canonicalJson} from '../../clinical-core/src/domain.js';
import {prepareDigitalOceanStreamRequest} from '../../clinical-core/src/digitalocean-stream.js';
import {domainOutputMeasurement,domainRepresentativeDraft} from '../../../scripts/qualification/fixtures/adaptive-domain-development.js';
import {fullCaseContext,fullCaseIds,representativeCaseDraft,fullCaseLabels} from '../../../scripts/qualification/fixtures/adaptive-full-cases.js';
import {createFullReplyManifest,prepareFullCapture,prepareFullNavigation} from '../src/adaptive-reply-full.js';
import {createDomainManifest,decodeDomainDraft,encodeDomainDraft,decodeDomainAdvance,domainStreamProposer,domainPromptRevision} from '../src/adaptive-reply-domain.js';
import {selectUsefulAdvance} from '../src/reply-usefulness.js';
import {fullCaseReadback} from '../../../scripts/qualification/fixtures/adaptive-full-readback.js';

it('measures15 source-exact slim catalogs, schema and issued action bytes separately',async()=>{
 const sizes=[];
 for(const id of fullCaseIds){const full=createFullReplyManifest(fullCaseContext(id)),m=createDomainManifest(full);
  const original=JSON.parse(String(full.messages[1].content)),payload=JSON.parse(String(m.messages[1].content));
  expect(payload.source).toEqual(original.source);expect(payload.sections).toHaveLength(new Set(full.targets.map(t=>t.topicId)).size);
  for(const t of full.targets.filter(t=>!t.collection)){if(t.kind==='collection')expect(payload.sections.flatMap((s:any)=>s.lists).some((l:any)=>l.collection===t.path)).toBe(true);else expect(payload.sections.find((s:any)=>s.topicId===t.topicId).fields.some((f:any)=>f.field===t.path)).toBe(true);}
  for(const target of full.targets.filter(t=>t.newItem)){const topic=payload.sections.find((s:any)=>s.topicId===target.topicId);expect(topic.lists.find((l:any)=>l.collection===target.collection).fields.some((f:any)=>f.field===target.definition.id)).toBe(true);}
  expect(m.measurement.catalogBytes).toBeLessThan(Buffer.byteLength(canonicalJson(original.targets)));
  expect(m.measurement.schemaBytes).toBeLessThan(32000);
  const request=await prepareDigitalOceanStreamRequest({endpoint:'https://inference.do-ai.run',model:'qwen3.8-max',apiKey:'offline',timeoutMs:30000,maxOutputTokens:4096,maxRequestBytes:131072,responseFormat:{type:'json-schema',name:'domain_test',schema:m.jsonSchema}},[...m.messages]);
  sizes.push({id,...m.measurement,...domainOutputMeasurement(id,full,m),actualRequestBytes:request.requestBytes});
 }
 console.log('DOMAIN_MEASUREMENTS '+JSON.stringify(sizes));
});
it('roundtrips15 authored representatives with derived IDs and no model or readiness qualification',()=>{
 for(const id of fullCaseIds){const full=createFullReplyManifest(fullCaseContext(id)),m=createDomainManifest(full),draft=representativeCaseDraft(id,full);
  const decoded=decodeDomainDraft(encodeDomainDraft(draft,m),m),capture=prepareFullCapture(decoded,full),original=prepareFullCapture(draft,full);
  expect(capture.claims.map(c=>[c.topicId,c.path.replace(/\[p[^\]]+\]/g,'[item]'),c.state,c.value,c.scope.subject,c.correctsSourceIds]).sort((a,b)=>canonicalJson(a).localeCompare(canonicalJson(b)))).toEqual(original.claims.map(c=>[c.topicId,c.path.replace(/\[p[^\]]+\]/g,'[item]'),c.state,c.value,c.scope.subject,c.correctsSourceIds]).sort((a,b)=>canonicalJson(a).localeCompare(canonicalJson(b))));
 }
});
it('rejects null owners, mismatched presence values, foreign item IDs and positive whole-list reports',()=>{
 const full=createFullReplyManifest(fullCaseContext('B1')),m=createDomainManifest(full),raw=encodeDomainDraft(representativeCaseDraft('B1',full),m);
 expect(raw.sections[0].fields[0].answer.value).toBe(true);
 const invalid=structuredClone(raw);invalid.sections[0].owner=null as never;expect(()=>decodeDomainDraft(invalid,m)).toThrow();
 const prose=structuredClone(raw);prose.sections[0].fields[0].answer.value='diagnosed diabetes';expect(()=>decodeDomainDraft(prose,m)).toThrow();
 const g7=createFullReplyManifest(fullCaseContext('G7')),n=createDomainManifest(g7),known=encodeDomainDraft(representativeCaseDraft('G7',g7),n);known.sections[0].lists[0].items![0].identity={kind:'existing',id:'foreign'};expect(()=>decodeDomainDraft(known,n)).toThrow();
 const g3=createFullReplyManifest(fullCaseContext('G3')),a=createDomainManifest(g3),r=encodeDomainDraft(representativeCaseDraft('G3',g3),a);r.sections[0].lists[0]={collection:'occasions',kind:'whole-list',state:'known'};expect(()=>decodeDomainDraft(r,a)).toThrow();
});
it('requires other-family ownership and retains mixed patient/mother source groups without inheritance',()=>{
 const context=fullCaseContext('G5'),full=createFullReplyManifest(context),m=createDomainManifest(full),raw=encodeDomainDraft(representativeCaseDraft('G5',full),m);
 expect(raw.sections.find(s=>s.section==='familyHistory')!.lists[0].items![0].identity).toMatchObject({subject:'other'});
 const wrong=structuredClone(raw);(wrong.sections.find(s=>s.section==='familyHistory')!.lists[0].items![0].identity as any).subject='patient';expect(()=>decodeDomainDraft(wrong,m)).toThrow();
 const decoded=decodeDomainDraft(raw,m);expect(decoded.claims.filter(c=>full.targets.find(t=>t.id===c.targetId)?.topicId==='Q10').every(c=>c.scope.subject==='other')).toBe(true);
 expect(decoded.claims.filter(c=>full.targets.find(t=>t.id===c.targetId)?.topicId==='Q06').every(c=>c.scope.subject==='patient')).toBe(true);
});
it('versioned P1 narrow-negative refinement remains visible residual with zero broad-negative credit',async()=>{
 const full=createFullReplyManifest(fullCaseContext('P1')),m=createDomainManifest(full),raw=encodeDomainDraft(representativeCaseDraft('P1',full),m),report=raw.sections.find(s=>s.section==='beforeVisit')!.fields.find(f=>f.answer.field==='logistics')!;
 expect(fullCaseLabels('P1').expected.find(e=>e.path==='logistics')!.state).toBe('negative');
 report.answer.state='scoped-detail';report.answer.detail='I need no transport help.';
 const decoded=decodeDomainDraft(raw,m);expect(decoded.claims.some(c=>full.targets.find(t=>t.id===c.targetId)?.path==='logistics')).toBe(false);expect(decoded.residual).toContainEqual({reason:'unsupported-target',evidence:report.evidence});
 const readback=await fullCaseReadback('P1',{draft:decoded,advance:{manifestId:full.id,actionId:full.actions[0].id,controls:[],defer:[]}});
 expect(readback.policyQualified).toBe(false);expect(readback.projection.creditedSourceIds.length).toBe(0);expect(readback.projection.responses.W02?.answers.logistics?.state).not.toBe('negative');
});
it('closed list prefix avoids a repeated opening before tail and leaves partial lists asking for more',()=>{
 const full=createFullReplyManifest(fullCaseContext('G3')),m=createDomainManifest(full),raw=encodeDomainDraft(representativeCaseDraft('G3',full),m),group=structuredClone(raw.sections.find(s=>s.section==='foodAndDrinkDay')!);
 group.fields=[];group.lists[0].items=[];const action=full.actions.find(a=>a.targetPaths.includes('occasions'))!;
 const advance=decodeDomainAdvance({manifestId:m.id,actionId:action.id,controls:[],supplied:[group]},m),nav=prepareFullNavigation(advance,full),useful=selectUsefulAdvance(fullCaseContext('G3'),advance,full.actions,full.targets,nav)!;
 expect(useful.rejectedNomination).toBe('supplied-answer');expect(useful.action.targetPaths).not.toContain('occasions');expect(nav.claims).toHaveLength(0);expect(nav.closures).toHaveLength(1);
 group.lists[0].closure=null;const partial=decodeDomainAdvance({manifestId:m.id,actionId:action.id,controls:[],supplied:[group]},m);expect(selectUsefulAdvance(fullCaseContext('G3'),partial,full.actions,full.targets,prepareFullNavigation(partial,full))!.action.id).toBe(action.id);
});
it('binds exact context before injected dispatch and rejects quote tampering without guessing repairs',async()=>{
 const context=fullCaseContext('G7'),full=createFullReplyManifest(context),m=createDomainManifest(full),raw=encodeDomainDraft(representativeCaseDraft('G7',full),m);raw.sections[0].lists[0].items![0].fields[0].answer.valueSource!.quote='fabricated quote';expect(()=>decodeDomainDraft(raw,m)).toThrow();
 let calls=0;const proposer=domainStreamProposer({endpoint:'https://inference.do-ai.run',model:'qwen3.8-max',apiKey:'offline',timeoutMs:30000,maxOutputTokens:4096},{fetcher:async()=>{calls++;throw Error('must not dispatch');}});await expect(proposer.propose(fullCaseContext('G3'),full,{signal:new AbortController().signal,onAdvance:async()=>{}})).rejects.toThrow();expect(calls).toBe(0);
});
it('keeps collection prefix audit out of clinical projection and retains tail disagreement after saved reply',async()=>{
 const full=createFullReplyManifest(fullCaseContext('G3')),m=createDomainManifest(full),draft=representativeCaseDraft('G3',full),group=encodeDomainDraft(draft,m).sections.find(s=>s.section==='foodAndDrinkDay')!;
 group.fields=[];group.lists[0].items=[];const action=full.actions.find(a=>a.targetPaths.includes('occasions'))!;
 const advance=decodeDomainAdvance({manifestId:m.id,actionId:action.id,controls:[],supplied:[group]},m);
 const tail={...draft,closures:[]};const readback=await fullCaseReadback('G3',{draft:tail,advance}),operation=readback.savedDraft.adaptive!.operations[fullCaseContext('G3').binding.operationId];
 expect(operation.stream!.navigation!.closures).toHaveLength(1);expect(operation.stream!.provisional!.closures).toHaveLength(0);expect(operation.stream!.provisional!.gaps.some(g=>g.reason==='conflict')).toBe(true);
 expect(readback.projection.responses.Q11.answers.occasions.complete).not.toBe(true);expect(readback.projection.creditedSourceIds).toHaveLength(0);expect(readback.savedDraft.adaptive!.exchange!.prompt!.targetPaths).not.toContain('occasions');
});
it('bounded prefix never becomes full extraction and direct quotes have no anchor index bookkeeping',()=>{
 const full=createFullReplyManifest(fullCaseContext('G3')),m=createDomainManifest(full),raw=encodeDomainDraft(representativeCaseDraft('G3',full),m);
 expect(JSON.stringify(raw)).not.toContain('anchors');expect(()=>decodeDomainAdvance({manifestId:m.id,actionId:full.actions[0].id,controls:[],supplied:raw.sections},m)).toThrow('domain-navigation');
 const bad=structuredClone(raw);bad.sections[0].lists[0].items![0].fields[0].predicate.quote='unissued';expect(()=>decodeDomainDraft(bad,m)).toThrow();
});
it('streams one injected request, admits closed prefix before tail, and cannot retract it on malformed tail',async()=>{
 const {consumeDomainStream}=await import('../src/adaptive-reply-domain.js');const context=fullCaseContext('G3'),full=createFullReplyManifest(context),m=createDomainManifest(full);
 const advance={manifestId:m.id,actionId:full.actions.at(-1)!.id,controls:[],supplied:[]};let control!:ReadableStreamDefaultController<Uint8Array>,ready!:()=>void;const early=new Promise<void>(resolve=>{ready=resolve;});let calls=0,saved=0;
 const event=(content:string|null,finish:string|null=null)=>`data: ${JSON.stringify({id:'domain-offline',model:'qwen3.8-max',choices:[{index:0,delta:{content},finish_reason:finish}]})}\n\n`;
 const response=new Response(new ReadableStream<Uint8Array>({start(c){control=c;}}),{headers:{'Content-Type':'text/event-stream'}});
 const pending=consumeDomainStream({endpoint:'https://inference.do-ai.run',model:'qwen3.8-max',apiKey:'offline',timeoutMs:1000,maxOutputTokens:4096,maxRequestBytes:131072},m,{fetcher:async()=>{calls++;return response;},onAdvance:()=>{saved++;ready();}});
 for(const byte of new TextEncoder().encode(event('{"advance":'+JSON.stringify(advance)+',"draft":')))control.enqueue(new Uint8Array([byte]));
 await early;expect(saved).toBe(1);control.enqueue(new TextEncoder().encode(event('{"bad":true}')+event(null,'stop')+'data: [DONE]\n\n'));control.close();
 await expect(pending).rejects.toMatchObject({receipt:{outcome:'rejected',providerExecution:'unknown'}});expect(calls).toBe(1);expect(saved).toBe(1);
});

it('retains an explicitly supplied patient entity at scalar section scope without an owner default',()=>{
 const full=createFullReplyManifest(fullCaseContext('G8')),m=createDomainManifest(full),draft=representativeCaseDraft('G8',full);draft.claims.filter(c=>full.targets.find(t=>t.id===c.targetId)?.topicId==='W07').forEach(c=>{c.scope.entity='Semaglutide';});
 const decoded=decodeDomainDraft(encodeDomainDraft(draft,m),m);expect(decoded.claims.filter(c=>full.targets.find(t=>t.id===c.targetId)?.topicId==='W07').every(c=>c.scope.entity==='Semaglutide')).toBe(true);
});

it('counts scoped and nested reports in the same four-report navigation allowance',()=>{
 const full=createFullReplyManifest(fullCaseContext('P1')),m=createDomainManifest(full),raw=domainRepresentativeDraft('P1',full,m);
 const packet={manifestId:m.id,actionId:full.actions[0].id,controls:[],supplied:raw.sections};
 expect(decodeDomainAdvance(packet,m).suppliedDraft!.claims).toHaveLength(3);
 const scoped=raw.sections[0].fields.find(report=>report.answer.state==='scoped-detail')!;
 raw.sections[0].fields.push(structuredClone(scoped));expect(()=>decodeDomainAdvance(packet,m)).toThrow('domain-navigation-capacity');
 const g3=createFullReplyManifest(fullCaseContext('G3')),n=createDomainManifest(g3),food=domainRepresentativeDraft('G3',g3,n);
 expect(()=>decodeDomainAdvance({manifestId:n.id,actionId:g3.actions[0].id,controls:[],supplied:food.sections},n)).toThrow('domain-navigation-capacity');
});
it('retains validated scoped predicate evidence and rejects unrepresentable period/correction metadata',()=>{
 const full=createFullReplyManifest(fullCaseContext('P1')),m=createDomainManifest(full),raw=domainRepresentativeDraft('P1',full,m);
 const scoped=raw.sections[0].fields.find(report=>report.answer.state==='scoped-detail')!;
 const statement=JSON.parse(String(full.messages[1].content)).statements[0];
 scoped.predicate={statementId:statement.id,quote:statement.text};
 expect(decodeDomainDraft(raw,m).residual[0].evidence).toContainEqual(scoped.predicate);
 const fabricated=structuredClone(raw);fabricated.sections[0].fields.find(report=>report.answer.state==='scoped-detail')!.predicate.quote='fabricated';expect(()=>decodeDomainDraft(fabricated,m)).toThrow();
 for(const metadata of [{period:'last year'},{correctsSourceIds:['unissued-source']}]){
  const unsupported=structuredClone(raw);Object.assign(unsupported.sections[0].fields.find(report=>report.answer.state==='scoped-detail')!,metadata);expect(()=>decodeDomainDraft(unsupported,m)).toThrow('unsupported-domain-detail-metadata');
 }
});
it('rejects nonpatient section or item closures in both tail and navigation',()=>{
 const full=createFullReplyManifest(fullCaseContext('G3')),m=createDomainManifest(full),raw=domainRepresentativeDraft('G3',full,m),group=raw.sections[0];
 for(const owner of [{subject:'other' as const,entity:'mother'},{subject:'unclear' as const}]){
  const copy=structuredClone(raw);copy.sections[0].owner=owner;expect(()=>decodeDomainDraft(copy,m)).toThrow('nonpatient-domain-closure');
  copy.sections[0].lists[0].items=[];expect(()=>decodeDomainAdvance({manifestId:m.id,actionId:full.actions[0].id,controls:[],supplied:copy.sections},m)).toThrow('nonpatient-domain-closure');
 }
 (group.lists[0].items![0].identity as {subject:string}).subject='other';expect(()=>decodeDomainDraft(raw,m)).toThrow('nonpatient-domain-closure');
 (group.lists[0].items![0].identity as {subject:string}).subject='unclear';expect(()=>decodeDomainDraft(raw,m)).toThrow('nonpatient-domain-closure');
});

it('prompt clarification preserves protocol, schema and patient data with one example-only item structure',async()=>{
 const full=createFullReplyManifest(fullCaseContext('G7')),m=createDomainManifest(full),system=String(m.messages[0].content),user=String(m.messages[1].content);
 const old=JSON.parse(readFileSync('docs/implementation/evidence/DO-AF37-PREFLIGHT.json','utf8'));
 expect(m.protocol).toBe(old.protocol);expect(system).toContain(`Prompt revision: ${domainPromptRevision}`);
 expect(system).toContain("If the section's scalar catalog fields is empty, output fields:[]");
 expect(system).toContain('Whole-list unknown requires the patient to express uncertainty about the ENTIRE list');
 expect(system).toContain('Every prefix fact MUST reappear in draft');expect(system).toContain('compare its targetPaths with the source');
 expect(system).toContain('NEVER copy EXAMPLE_ONLY identifiers');expect(user).not.toContain('EXAMPLE_ONLY');
 const example=JSON.parse(system.slice(system.lastIndexOf('\n')+1));expect(example.fields).toEqual([]);expect(example.lists).toHaveLength(1);
 const [newItem,existingItem]=example.lists[0].items;expect(newItem.identity).toMatchObject({kind:'new',subject:'patient'});expect(existingItem.identity).toEqual({kind:'existing',id:'EXAMPLE_ONLY_ISSUED_ITEM_ID'});
 expect(newItem.fields[0].answer.field).toBe('name');expect(existingItem.fields[0].answer.field).toBe('reason');expect(existingItem.fields[0].correctsSourceIds).toEqual(['EXAMPLE_ONLY_PRIOR_SOURCE_ID']);
 expect(JSON.parse(user).source).toEqual(JSON.parse(String(full.messages[1].content)).source);
 const request=await prepareDigitalOceanStreamRequest({endpoint:'https://inference.do-ai.run',model:'qwen3.8-max',apiKey:'offline',timeoutMs:30000,maxOutputTokens:4096,maxRequestBytes:131072,responseFormat:{type:'json-schema',name:'adaptive_reply_domain_v4',schema:m.jsonSchema}},[...m.messages]);
 expect(request.responseSchema).toEqual(old.responseSchema);expect(request.requestBytes).toBeGreaterThan(old.requestBytes);expect(request.requestBytes-old.requestBytes).toBeLessThan(4000);
 console.log('DOMAIN_PROMPT_DELTA '+JSON.stringify({promptRevision:domainPromptRevision,oldRequestBytes:old.requestBytes,requestBytes:request.requestBytes,requestDeltaBytes:request.requestBytes-old.requestBytes,instructionBytes:m.measurement.instructionBytes,instructionDeltaBytes:m.measurement.instructionBytes-old.manifest.measurement.instructionBytes,exampleBytes:Buffer.byteLength(JSON.stringify(example)),schemaUnchanged:true,outputBudgetUnchanged:true}));
});
