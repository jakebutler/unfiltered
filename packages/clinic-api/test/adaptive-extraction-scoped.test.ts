import { expect,it } from 'vitest';
import { canonicalJson } from '../../clinical-core/src/domain.js';
import { createFullReplyManifest,prepareFullCapture } from '../src/adaptive-reply-full.js';
import { createDomainManifest,decodeDomainDraft } from '../src/adaptive-reply-domain.js';
import { createScopedExtractionManifest,encodeScopedExtraction,compileScopedExtraction,planScopedExtractionQuestion,consumeScopedExtraction } from '../src/adaptive-extraction-scoped.js';
import { fullCaseContext } from '../../../scripts/qualification/fixtures/adaptive-full-cases.js';
import { fullDevelopmentContext } from '../../../scripts/qualification/fixtures/adaptive-full-development.js';
import { domainRepresentativeDraft } from '../../../scripts/qualification/fixtures/adaptive-domain-development.js';
const fixture=(id:string)=>{const context=fullCaseContext(id),full=createFullReplyManifest(context),legacy=createDomainManifest(full),m=createScopedExtractionManifest(context),old=domainRepresentativeDraft(id,full,legacy);return {context,full,legacy,m,old,wire:encodeScopedExtraction(old,m)};};
it.each(['G3','P1','G7'])('authored %s compiles to the unchanged full draft/capture',id=>{
 const f=fixture(id),compiled=compileScopedExtraction(f.wire,f.m),original=decodeDomainDraft(f.old,f.legacy);
 expect(canonicalJson(compiled.draft)).toBe(canonicalJson(original));expect(compiled.capture).toEqual(prepareFullCapture(original,f.full));
 expect(f.m.messages[0].content).not.toContain('advance');expect(JSON.parse(String(f.m.messages[1].content))).not.toHaveProperty('actions');expect(f.m.jsonSchema.properties).not.toHaveProperty('advance');
});
it.each(['first-intake','pre-visit','non-visit','post-visit','billing','scheduling','refill'] as const)('%s catalog has bounded native typed/scoped target branches',scenario=>{
 const m=createScopedExtractionManifest(fullDevelopmentContext(scenario));expect(m.measurement.schemaBytes).toBeLessThanOrEqual(32000);expect(m.measurement.requestBodyBytes).toBeLessThanOrEqual(131072);
 const empty={manifestId:m.id,reports:[],closures:[],residual:[],sourceDisposition:'partially-represented'};expect(compileScopedExtraction(empty,m).draft.claims).toEqual([]);
 expect(planScopedExtractionQuestion(empty,m).status).toBe('interpretation-review');
});
it('the actual G3/G7 scalar placement failures and cross-neighbor item IDs are rejected natively/locally',()=>{
 for(const id of ['G3','G7']){const f=fixture(id),bad=structuredClone(f.wire),item=bad.reports.find(r=>r.kind.endsWith('item'))!;delete item.identity;item.kind='scalar';item.owner={subject:'patient'};expect(()=>compileScopedExtraction(bad,f.m)).toThrow();}
 const f=fixture('G7'),bad=structuredClone(f.wire),first=bad.reports[0],neighbor=bad.reports.find(r=>r.identity.id!==first.identity.id)!;first.identity=neighbor.identity;expect(()=>compileScopedExtraction(bad,f.m)).toThrow();
 const correction=structuredClone(f.wire);correction.reports[0].correctsSourceIds=['foreign-source'];expect(()=>compileScopedExtraction(correction,f.m)).toThrow();
 expect(compileScopedExtraction(f.wire,f.m).draft.claims.map(c=>c.correctsSourceIds)).toEqual(decodeDomainDraft(f.old,f.legacy).claims.map(c=>c.correctsSourceIds));
});
it('source-limited absence remains verbatim unresolved breadth and unsupported overrides fail without negative repair',()=>{
 const f=fixture('P1'),detail=f.wire.reports.find(r=>r.answer.state==='scoped-detail')!;
 expect(detail.answer.detail).toBe('I need no transport help.');const result=compileScopedExtraction(f.wire,f.m);expect(result.draft.claims).toHaveLength(3);expect(result.draft.residual).toHaveLength(1);expect(planScopedExtractionQuestion(f.wire,f.m).status).toBe('interpretation-review');
 for(const delta of [{unresolvedTargetId:f.wire.reports[0].targetId},{detail:'I have no practical needs.'}]){const bad=structuredClone(f.wire);Object.assign(bad.reports.find(r=>r.answer.state==='scoped-detail')!.answer,delta);expect(()=>compileScopedExtraction(bad,f.m)).toThrow();}
 const broad=structuredClone(f.wire);broad.reports.find(r=>r.answer.state==='scoped-detail')!.answer={state:'negative'};expect(compileScopedExtraction(broad,f.m).draft.claims.at(-1)!.state).toBe('negative'); // Remains a model semantic failure, never repaired into known/scoped text.
 const uncertain=structuredClone(f.wire);uncertain.reports.find(r=>r.answer.state==='scoped-detail')!.answer={state:'uncertain'};expect(compileScopedExtraction(uncertain,f.m).draft.claims.at(-1)!.state).toBe('uncertain');
});
it('unsupported state/type and fabricated distinct sources fail',()=>{
 const f=fixture('G3');for(const answer of [{state:'known',value:27},{state:'negative'}]){const bad=structuredClone(f.wire);bad.reports.find(r=>r.answer.state==='known')!.answer=answer;expect(()=>compileScopedExtraction(bad,f.m)).toThrow();}
 const bad=structuredClone(f.wire),r=bad.reports[0];r.distinctSources={evidence:[r.quote],predicate:{...r.quote,quote:'fabricated'},valueSource:r.quote};expect(()=>compileScopedExtraction(bad,f.m)).toThrow();
});
it('new entities and source owners remain explicit; no readiness or conversational-control authority is added',()=>{
 const f=fixture('G3'),compiled=compileScopedExtraction(f.wire,f.m);expect(compiled.draft.items).toHaveLength(2);expect(compiled.draft.acts).toEqual([]);expect(compiled.capture.policy).toBe('provisional-intake-v2');
 const plan=planScopedExtractionQuestion(f.wire,f.m);expect(plan.status).toBe('question');expect(plan.question?.id).toBeDefined();
 const system=String(f.m.messages[0].content);expect(system).toContain('genuine patient questions');expect(system).toContain('move-on requests');expect(system).toContain('does not implement conversational control');
 const examples=system.slice(system.indexOf('FORMAT EXAMPLE ONLY'));for(const id of ['G3','P1','G7'])for(const sentence of fullCaseContext(id).source.text.split(/(?<=[.!?])\s+/))expect(examples).not.toContain(sentence);
});
it('an incomplete or rejected stream never plans a question or admits a capture',async()=>{
 const f=fixture('P1'),event=(content:string|null,finish:string|null=null)=>`data: ${JSON.stringify({id:'extraction-test',model:'qwen3.8-max',choices:[{index:0,delta:{content},finish_reason:finish}]})}\n\n`,wire=event('{"manifestId":')+event(null,'stop')+'data: [DONE]\n\n';let calls=0;
 await expect(consumeScopedExtraction({endpoint:'https://inference.do-ai.run',model:'qwen3.8-max',apiKey:'offline-only',timeoutMs:1000,maxOutputTokens:4096},f.m,{fetcher:async()=>{calls++;return new Response(wire,{headers:{'Content-Type':'text/event-stream'}});}})).rejects.toMatchObject({code:'scoped-extraction-rejected',receipt:{outcome:'rejected'}});expect(calls).toBe(1);
});

it.each([['negative','I need no practical help before my visit.'],['unknown','I do not know what practical help I need before my visit.'],['uncertain','I am unsure what practical help I need before my visit.'],['declined','I decline to discuss practical help before my visit.']])('authored whole-field %s remains distinct from source-limited absence', (state,text)=>{
 const base=fullCaseContext('P1'),context={...base,source:{...base.source,text},sources:[{...base.source,text}]},m=createScopedExtractionManifest(context),payload=JSON.parse(String(m.messages[1].content)),target=payload.targets.find((t:any)=>t.topicId==='W02'&&t.path==='logistics'),quote={statementId:payload.statements[0].id,quote:payload.statements[0].text};
 const wire={manifestId:m.id,reports:[{kind:'scalar',owner:{subject:'patient'},targetId:target.id,answer:{state},quote,distinctSources:null,period:null,correctsSourceIds:[]}],closures:[],residual:[],sourceDisposition:'represented'};
 const result=compileScopedExtraction(wire,m);expect(result.draft.claims).toHaveLength(1);expect(result.draft.claims[0].state).toBe(state);expect(result.draft.residual).toEqual([]);if(state==='negative'){expect(result.capture.claims).toHaveLength(0);expect(result.capture.gaps.some(g=>g.reason==='unsupported-state')).toBe(true);}else expect(result.capture.claims).toHaveLength(1);
});
it('retains genuine questions/move-on in unresolved source and withholds experimental planning',()=>{
 const base=fullCaseContext('P1'),text='Why do I need to tell you this? Please move on.',context={...base,source:{...base.source,text},sources:[{...base.source,text}]},m=createScopedExtractionManifest(context),p=JSON.parse(String(m.messages[1].content));
 const wire={manifestId:m.id,reports:[],closures:[],residual:p.statements.filter((s:any)=>!s.id.startsWith('current_')).map((s:any)=>({reason:'ambiguous',evidence:[{statementId:s.id,quote:s.text}]})),sourceDisposition:'partially-represented'};
 const result=compileScopedExtraction(wire,m);expect(result.draft.acts).toEqual([]);expect(result.draft.residual).toHaveLength(2);expect(planScopedExtractionQuestion(wire,m).status).toBe('interpretation-review');
});

it('next-question planning respects issued existing neighbor identities and avoids the already supplied medicine opening',()=>{const f=fixture('G7'),plan=planScopedExtractionQuestion(f.wire,f.m);expect(plan.status).toBe('question');expect(plan.question!.targetPaths).not.toEqual(['medicines']);expect(plan.question!.text).not.toContain('What medicines, vitamins');expect(plan.question!.text).toContain('Metformin');});
it('whole-list scoped detail preserves exact limited narrative/provenance as residual without manufacturing a list state',()=>{
 const f=fixture('G3'),payload=JSON.parse(String(f.m.messages[1].content)),target=payload.targets.find((t:any)=>t.topicId==='Q11'&&t.path==='occasions'),s=payload.statements.find((s:any)=>s.text.includes("I don't remember")),quote={statementId:s.id,quote:s.text};
 const wire={manifestId:f.m.id,reports:[{kind:'whole-list',owner:{subject:'patient'},targetId:target.id,answer:{state:'scoped-detail',detail:s.text,unresolvedTargetId:target.id},quote,distinctSources:null,period:null,correctsSourceIds:[]}],closures:[],residual:[],sourceDisposition:'partially-represented'};
 const result=compileScopedExtraction(wire,f.m);expect(result.draft.claims).toEqual([]);expect(result.draft.residual).toEqual([{reason:'unsupported-target',evidence:[quote]}]);expect(wire.reports[0].answer.detail).toBe(s.text);expect(planScopedExtractionQuestion(wire,f.m).status).toBe('interpretation-review');
 const bad=structuredClone(wire);bad.reports[0].answer.detail='No food or drink that day.';expect(()=>compileScopedExtraction(bad,f.m)).toThrow();
});

it('family item ownership and cross-topic volunteered facts are preserved without inheriting a relative disease',()=>{const f=fixture('G5'),result=compileScopedExtraction(f.wire,f.m);expect(result.draft).toEqual(decodeDomainDraft(f.old,f.legacy));const family=f.wire.reports.find(r=>r.kind==='new-item')!;expect(family.identity.subject).toBe('other');const bad=structuredClone(f.wire);bad.reports.find(r=>r.kind==='new-item')!.identity.subject='patient';expect(()=>compileScopedExtraction(bad,f.m)).toThrow();expect(planScopedExtractionQuestion(f.wire,f.m).status).toBe('interpretation-review');});
