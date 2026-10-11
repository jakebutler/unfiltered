import { expect, it } from 'vitest';
import { canonicalJson } from '../../clinical-core/src/domain.js';
import { createFullReplyManifest, prepareFullCapture, prepareFullNavigation } from '../src/adaptive-reply-full.js';
import { createDomainManifest, decodeDomainDraft, decodeDomainAdvance } from '../src/adaptive-reply-domain.js';
import { compactBoundedDomainDraft, createBoundedDomainManifest, decodeBoundedDomainAdvance, decodeBoundedDomainDraft, consumeBoundedDomainStream, type BoundedDomainAdvance, type BoundedFact } from '../src/adaptive-reply-domain-bounded.js';
import { fullCaseContext } from '../../../scripts/qualification/fixtures/adaptive-full-cases.js';
import { domainRepresentativeDraft } from '../../../scripts/qualification/fixtures/adaptive-domain-development.js';
import { fullCaseReadback } from '../../../scripts/qualification/fixtures/adaptive-full-readback.js';
const fixture=(id:string)=>{const full=createFullReplyManifest(fullCaseContext(id)),old=createDomainManifest(full),manifest=createBoundedDomainManifest(full),legacy=domainRepresentativeDraft(id,full,old);return {full,old,manifest,legacy,raw:compactBoundedDomainDraft(legacy)};};
const prefix=(f:ReturnType<typeof fixture>,facts:BoundedFact[]=[],closure:BoundedDomainAdvance['closure']=null):BoundedDomainAdvance=>({manifestId:f.full.id,actionId:f.full.actions[0].id,controls:[],facts,closure});
it.each(['G3','P1','G7'])('preserves the immutable internal full draft and projection for authored %s',id=>{
 const f=fixture(id),old=decodeDomainDraft(f.legacy,f.old),decoded=decodeBoundedDomainDraft(f.raw,f.manifest);
 expect(canonicalJson(decoded)).toBe(canonicalJson(old));expect(prepareFullCapture(decoded,f.full)).toEqual(prepareFullCapture(old,f.full));
 expect(f.raw.sections.flatMap(s=>s.fields.concat(s.lists.flatMap(l=>l.items?.flatMap(i=>i.fields)??(l.report?[l.report]:[])))).every(r=>r.distinctSources===null)).toBe(true);
});
it('native prefix shape has exactly a flat maximum of four reports and one nullable closure',()=>{
 const f=fixture('P1'),schema=f.manifest.jsonSchema as any;
 const deref=(v:any):any=>v.$ref?deref(v.$ref.split('/').slice(1).reduce((p:any,k:string)=>p[k],schema)):v;
 const advance=deref(schema.properties.advance);expect(advance.properties.facts.maxItems).toBe(4);expect(advance.properties).not.toHaveProperty('supplied');
 const closure=deref(advance.properties.closure);expect(closure.anyOf).toHaveLength(2);expect(closure.anyOf.some((v:any)=>deref(v).type==='null')).toBe(true);
 const group=f.raw.sections[0],facts=group.fields.map(report=>({section:group.section,owner:group.owner,kind:'field' as const,report}));
 expect(decodeBoundedDomainAdvance(prefix(f,facts),f.manifest).suppliedDraft!.claims).toHaveLength(3);
 expect(()=>decodeBoundedDomainAdvance(prefix(f,[...facts,facts[0]]),f.manifest)).toThrow();
 expect(()=>decodeBoundedDomainAdvance({...prefix(f),closure:[null,null]},f.manifest)).toThrow();
 expect(()=>decodeBoundedDomainAdvance({...prefix(f),facts:[{section:group.section,owner:group.owner,kind:'item',collection:'medicines',identity:{kind:'existing',id:'unissued'},reports:group.fields}]},f.manifest)).toThrow();
});
it('flat item reports preserve the same issued item identity and owner as grouped navigation',()=>{
 const f=fixture('G3'),group=f.raw.sections[0],list=group.lists[0],item=list.items![0];
 const facts=item.fields.slice(0,3).map(report=>({section:group.section,owner:group.owner,kind:'item' as const,collection:list.collection,identity:item.identity,report}));
 const compact=decodeBoundedDomainAdvance(prefix(f,facts),f.manifest),oldGroup=structuredClone(f.legacy.sections[0]);
 oldGroup.fields=[];oldGroup.lists=[{...oldGroup.lists[0],items:[{...oldGroup.lists[0].items![0],fields:oldGroup.lists[0].items![0].fields.slice(0,3)}],closure:null}];
 const old=decodeDomainAdvance({manifestId:f.full.id,actionId:f.full.actions[0].id,controls:[],supplied:[oldGroup]},f.old);
 expect(compact).toEqual(old);expect(compact.suppliedDraft!.items).toHaveLength(1);
});
it('one explicit closure remains patient scoped and receives only navigation credit',()=>{
 const f=fixture('G3'),group=f.raw.sections[0],list=group.lists[0],closure={section:group.section,owner:group.owner,collection:list.collection,evidence:list.closure!.evidence};
 const advance=decodeBoundedDomainAdvance(prefix(f,[],closure),f.manifest),nav=prepareFullNavigation(advance,f.full);expect(nav.closures).toHaveLength(1);expect(nav.claims).toHaveLength(0);expect(nav.policy).toBe('provisional-intake-v2');
 for(const owner of [{subject:'other',entity:'mother'},{subject:'unclear'}])expect(()=>decodeBoundedDomainAdvance(prefix(f,[],{...closure,owner} as any),f.manifest)).toThrow('nonpatient-domain-closure');
});
it('explicit distinct evidence/value/predicate addresses roundtrip without guessing or discarded provenance',()=>{
 const f=fixture('G7'),report=f.legacy.sections[0].lists[0].items![0].fields[0],statement=JSON.parse(String(f.old.messages[1].content)).statements[0];
 report.evidence=[report.evidence[0],{statementId:statement.id,quote:statement.text}];report.predicate={statementId:statement.id,quote:statement.text};
 const raw=compactBoundedDomainDraft(f.legacy);expect(raw.sections[0].lists[0].items![0].fields[0].distinctSources).not.toBeNull();
 expect(decodeBoundedDomainDraft(raw,f.manifest)).toEqual(decodeDomainDraft(f.legacy,f.old));
 for(const key of ['predicate','valueSource'] as const){const bad=structuredClone(raw);bad.sections[0].lists[0].items![0].fields[0].distinctSources![key]!.quote='fabricated';expect(()=>decodeBoundedDomainDraft(bad,f.manifest)).toThrow();}
 const wrong=structuredClone(raw);wrong.sections[0].lists[0].items![0].fields[0].distinctSources!.evidence[0]={...wrong.sections[0].lists[0].items![0].fields[0].quote,quote:'500 mg'};expect(()=>decodeBoundedDomainDraft(wrong,f.manifest)).toThrow('invalid-domain-distinct-sources');
 const state=structuredClone(raw);state.sections[0].lists[0].items![0].fields[0].answer={field:'strength',state:'unknown'};expect(()=>decodeBoundedDomainDraft(state,f.manifest)).toThrow('invalid-domain-distinct-sources');
});
it('source-limited absence names unresolved breadth, persists verbatim and never becomes a broad negative',async()=>{
 const f=fixture('P1'),report=f.raw.sections[0].fields.find(r=>r.answer.state==='scoped-detail')!;
 expect(report.answer).toMatchObject({field:'logistics',detail:'I need no transport help.',unresolvedField:'logistics'});
 const decoded=decodeBoundedDomainDraft(f.raw,f.manifest);expect(decoded.claims).toHaveLength(3);expect(decoded.residual).toContainEqual({reason:'unsupported-target',evidence:[report.quote]});
 const readback=await fullCaseReadback('P1',{draft:decoded,advance:decodeBoundedDomainAdvance(prefix(f),f.manifest)});
 expect(readback.policyQualified).toBe(false);expect(readback.projection.creditedSourceIds).toHaveLength(0);expect(readback.projection.responses.W02?.answers.logistics?.state).not.toBe('negative');
 for(const change of [{unresolvedField:'priority'},{detail:'I need no practical help.'}]){const bad=structuredClone(f.raw);Object.assign(bad.sections[0].fields.find(r=>r.answer.state==='scoped-detail')!.answer,change);expect(()=>decodeBoundedDomainDraft(bad,f.manifest)).toThrow();}
 for(const change of [{period:'last week'},{correctsSourceIds:['unissued']}]){const bad=structuredClone(f.raw);Object.assign(bad.sections[0].fields.find(r=>r.answer.state==='scoped-detail')!,change);expect(()=>decodeBoundedDomainDraft(bad,f.manifest)).toThrow('unsupported-domain-detail-metadata');}
 const broad=structuredClone(f.raw);broad.sections[0].fields.find(r=>r.answer.state==='scoped-detail')!.answer={field:'logistics',state:'negative'};
 expect(decodeBoundedDomainDraft(broad,f.manifest).claims.find(c=>f.full.targets.find(t=>t.id===c.targetId)?.path==='logistics')!.state).toBe('negative'); // Never post-hoc repair a semantic error; independent review must reject it.
});
it('existing medication correction and prior source IDs remain exact; foreign correction/identity fails',()=>{
 const f=fixture('G7'),decoded=decodeBoundedDomainDraft(f.raw,f.manifest);
 expect(decoded.items).toHaveLength(0);expect(decoded.claims.map(c=>[c.value,c.correctsSourceIds])).toEqual(decodeDomainDraft(f.legacy,f.old).claims.map(c=>[c.value,c.correctsSourceIds]));
 const bad=structuredClone(f.raw);bad.sections[0].lists[0].items![0].fields[0].correctsSourceIds=['unissued-source'];expect(()=>decodeBoundedDomainDraft(bad,f.manifest)).toThrow();
 const foreign=structuredClone(f.raw);foreign.sections[0].lists[0].items![0].identity={kind:'existing',id:'unissued-item'};expect(()=>decodeBoundedDomainDraft(foreign,f.manifest)).toThrow();
 const other=structuredClone(f.raw);other.sections[0].owner={subject:'other',entity:'mother'};expect(decodeBoundedDomainDraft(other,f.manifest).claims).toEqual(decoded.claims); // Existing issued item identity remains authoritative, never guessed from group owner.
});
it.each(['G3','P1','G7'])('rendered %s prompt has compatible compact item examples without development answers or stale wire keys',caseId=>{
 const f=fixture(caseId),system=String(f.manifest.messages[0].content);expect(system).toContain('FLAT array of at most FOUR');expect(system).toContain('ONE section/owner/collection/evidence');expect(system).toContain('identical meaning');expect(system).toContain('unresolvedField');expect(f.manifest.messages[1]).toEqual(f.old.messages[1]);
 expect(system).not.toContain('advance.supplied');expect(system).not.toContain('mandatory exact valueSource');expect(system).not.toContain('Other states have no value/valueSource');
 expect(system).not.toContain('For example no transport help');expect(system).not.toContain('I need no transport help.');
 const examples=system.slice(system.indexOf('FORMAT EXAMPLES ONLY'));
 for(const id of ['G3','P1','G7'])for(const sentence of fullCaseContext(id).source.text.split(/(?<=[.!?])\s+/))expect(examples).not.toContain(sentence);
 const item=JSON.parse(system.slice(system.lastIndexOf('\n')+1));expect(item.fields).toEqual([]);expect(item.lists[0].items[0].identity).toMatchObject({kind:'new',subject:'patient'});expect(item.lists[0].items[1].identity).toEqual({kind:'existing',id:'EXAMPLE_ONLY_ISSUED_ITEM_ID'});
 expect(item.lists[0].items[0].fields[0].distinctSources).toBeNull();expect(item.lists[0].items[1].fields[0].correctsSourceIds).toEqual(['EXAMPLE_ONLY_PRIOR_SOURCE_ID']);expect(examples).toContain('EXAMPLE_ONLY_reserved_seat');
});
it('retains the early navigation callback when the later stream tail is malformed',async()=>{
 const f=fixture('P1'),advance=prefix(f);let saved=0,calls=0;
 const event=(content:string|null,finish:string|null=null)=>`data: ${JSON.stringify({id:'bounded-test',model:'qwen3.8-max',choices:[{index:0,delta:{content},finish_reason:finish}]})}\n\n`;
 const wire=event('{"advance":'+JSON.stringify(advance)+',"draft":{"bad":true}}')+event(null,'stop')+'data: [DONE]\n\n';
 await expect(consumeBoundedDomainStream({endpoint:'https://inference.do-ai.run',model:'qwen3.8-max',apiKey:'offline-only',timeoutMs:1000,maxOutputTokens:4096},f.manifest,{fetcher:async()=>{calls++;return new Response(wire,{headers:{'Content-Type':'text/event-stream'}});},onAdvance:()=>{saved++;}})).rejects.toMatchObject({receipt:{outcome:'rejected'}});
 expect(saved).toBe(1);expect(calls).toBe(1);
});
