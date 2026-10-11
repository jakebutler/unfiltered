import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { canonicalJson } from '../../clinical-core/src/domain.js';
import { ActionFirstObjectDecoder } from '../../clinical-core/src/action-first-object.js';
import { digitalOceanStream, DigitalOceanStreamFailure, fullStreamLimits } from '../../clinical-core/src/digitalocean-stream.js';
import type { DigitalOceanConfig, InferenceMessage } from '../../clinical-core/src/digitalocean.js';
import type { Fetch } from '../../clinical-core/src/transport.js';
import { AdaptiveError } from './adaptive-validation.js';
import { createDomainManifest, decodeDomainDraft, type DomainManifest, type DomainSection, type DomainDraft } from './adaptive-reply-domain.js';
import { assertFullReplyManifest, validateFullAdvance, type FullReplyManifest } from './adaptive-reply-full.js';
import type { SourceAddress, ReplyAdvance } from './adaptive-reply.js';

export const boundedDomainProtocol = 'adaptive-reply-domain-bounded-v1';
export const boundedDomainSchemaName = 'adaptive_reply_domain_bounded_v1';
export const boundedDomainValidationRevision = 'domain-bounded-identical-quotes-v1';
export const boundedDomainPromptRevision = 'domain-flat-prefix-source-limited-v1';
type LegacyField = DomainSection['fields'][number];
type Identity = NonNullable<DomainSection['lists'][number]['items']>[number]['identity'];
interface CompactReport {
  answer: Omit<LegacyField['answer'],'valueSource'> & { unresolvedField?:string };
  quote:SourceAddress;
  distinctSources:{evidence:SourceAddress[];predicate:SourceAddress;valueSource:SourceAddress|null}|null;
  period:string|null;correctsSourceIds:string[];
}
interface CompactList {
  collection:string;kind:'items'|'whole-list';
  items?:{identity:Identity;fields:CompactReport[]}[];closure?:{evidence:SourceAddress[]}|null;
  report?:CompactReport;
}
export interface BoundedDomainDraft {
  manifestId:string;sections:{section:string;owner:DomainSection['owner'];fields:CompactReport[];lists:CompactList[]}[];
  residual:DomainDraft['residual'];sourceDisposition:DomainDraft['sourceDisposition'];
}
export type BoundedFact = {section:string;owner:DomainSection['owner']} & (
  {kind:'field';report:CompactReport} | {kind:'item';collection:string;identity:Identity;report:CompactReport} | {kind:'whole-list';collection:string;report:CompactReport});
export interface BoundedDomainAdvance {
  manifestId:string;actionId:string;controls:ReplyAdvance['controls'];facts:BoundedFact[];
  closure:{section:string;owner:DomainSection['owner'];collection:string;evidence:SourceAddress[]}|null;
}
export interface BoundedDomainManifest extends Omit<DomainManifest,'protocol'> { readonly protocol:typeof boundedDomainProtocol }
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const issued=new WeakMap<BoundedDomainManifest,{legacy:DomainManifest;full:FullReplyManifest;signature:string;draft:z.ZodType;advance:z.ZodType}>();
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
const enumeration=(values:string[])=>z.enum(values as [string,...string[]]);

/** Wire-only defaults: the model asserts that the single quote supports the
 * evidence, value and predicate identically. Distinct addresses are explicit.
 * No state, value, identity, scope or correction is inferred from source text. */
function expandReport(report:CompactReport):LegacyField {
  const {unresolvedField,valueSource:_unused,...answer}=report.answer as LegacyField['answer'] & {unresolvedField?:string};
  if(answer.state==='scoped-detail' ? unresolvedField!==answer.field : unresolvedField!==undefined)throw new AdaptiveError('invalid-domain-unresolved-field');
  const sources=report.distinctSources;
  if(sources && (!same(sources.evidence[0],report.quote) || (answer.state==='known') !== (sources.valueSource!==null)))throw new AdaptiveError('invalid-domain-distinct-sources');
  return {answer:{...answer,...(answer.state==='known'?{valueSource:sources?.valueSource??report.quote}:{})},
    evidence:sources?.evidence??[report.quote],predicate:sources?.predicate??report.quote,period:report.period,correctsSourceIds:report.correctsSourceIds};
}
function compactReport(report:LegacyField):CompactReport {
  const {valueSource,...answer}=report.answer,quote=report.evidence[0];
  const identical=report.evidence.length===1&&same(report.predicate,quote)&&(answer.state!=='known'||same(valueSource,quote));
  return {answer:{...answer,...(answer.state==='scoped-detail'?{unresolvedField:answer.field}:{})},quote,
    distinctSources:identical?null:{evidence:report.evidence,predicate:report.predicate,valueSource:valueSource??null},period:report.period,correctsSourceIds:report.correctsSourceIds};
}
function expandDraft(draft:BoundedDomainDraft):DomainDraft {
  return {...draft,sections:draft.sections.map(group=>({...group,fields:group.fields.map(expandReport),lists:group.lists.map(list=>list.kind==='items'
    ?{collection:list.collection,kind:'items',items:list.items!.map(item=>({...item,fields:item.fields.map(expandReport)})),closure:list.closure}
    :{collection:list.collection,kind:'whole-list',...wholeList(list.report!,list.collection)})}))};
}
function wholeList(report:CompactReport,collection:string) {
  const expanded=expandReport(report);
  if(expanded.answer.field!==collection||expanded.answer.state==='known'||expanded.answer.state==='scoped-detail')throw new AdaptiveError('invalid-domain-whole-list-report');
  return {state:expanded.answer.state,evidence:expanded.evidence,predicate:expanded.predicate,period:expanded.period,correctsSourceIds:expanded.correctsSourceIds};
}
export function compactBoundedDomainDraft(raw:DomainDraft):BoundedDomainDraft {
  return {...raw,sections:raw.sections.map(group=>({...group,fields:group.fields.map(compactReport),lists:group.lists.map(list=>list.kind==='items'
    ?{collection:list.collection,kind:'items',items:list.items!.map(item=>({...item,fields:item.fields.map(compactReport)})),closure:list.closure}
    :{collection:list.collection,kind:'whole-list',report:compactReport({answer:{field:list.collection,state:list.state!},evidence:list.evidence!,predicate:list.predicate!,period:list.period!,correctsSourceIds:list.correctsSourceIds!})})}))};
}
export function createBoundedDomainManifest(full:FullReplyManifest):BoundedDomainManifest {
  assertFullReplyManifest(full);const legacy=createDomainManifest(full),payload=JSON.parse(String(legacy.messages[1].content));
  const quote=z.strictObject({statementId:enumeration(payload.statements.map((s:{id:string})=>s.id)),quote:z.string().min(1).max(8000)}),ev=z.array(quote).min(1).max(4);
  const owner=z.union([z.strictObject({subject:z.literal('patient')}),z.strictObject({subject:z.literal('patient'),entity:z.string().min(1).max(300)}),z.strictObject({subject:z.literal('other'),entity:z.string().min(1).max(300)}),z.strictObject({subject:z.literal('unclear')})]);
  const field=z.string().min(1).max(300);
  const report=z.strictObject({answer:z.union([
    z.strictObject({field,state:z.literal('known'),value:z.union([z.string().min(1).max(8000),z.number().finite(),z.boolean(),z.strictObject({feet:z.number().int().nonnegative(),inches:z.number().nonnegative().lt(12)})])}),
    z.strictObject({field,state:z.enum(['negative','unknown','declined','uncertain','not-applicable'])}),
    z.strictObject({field,state:z.literal('scoped-detail'),detail:z.string().min(1).max(8000),unresolvedField:field})]),
    quote,distinctSources:z.strictObject({evidence:ev,predicate:quote,valueSource:quote.nullable()}).nullable(),period:z.string().min(1).max(300).nullable(),correctsSourceIds:z.array(z.string().min(1).max(160)).max(8)});
  const existing=payload.sections.flatMap((s:any)=>s.lists.flatMap((l:any)=>l.existing.map((i:any)=>i.id)));
  const fresh=z.strictObject({kind:z.literal('new'),subject:z.enum(['patient','other','unclear']),entity:z.string().min(1).max(300),evidence:ev});
  const identity=existing.length?z.union([fresh,z.strictObject({kind:z.literal('existing'),id:enumeration(existing)})]):fresh;
  const section=enumeration(payload.sections.map((s:any)=>s.section)),collection=enumeration([...new Set<string>(payload.sections.flatMap((s:any)=>s.lists.map((l:any)=>l.collection)))]);
  const shared={section,owner};
  const list=z.union([z.strictObject({collection,kind:z.literal('items'),items:z.array(z.strictObject({identity,fields:z.array(report).min(1).max(64)})).max(16),closure:z.strictObject({evidence:ev}).nullable()}),z.strictObject({collection,kind:z.literal('whole-list'),report})]);
  const group=z.strictObject({...shared,fields:z.array(report).max(64),lists:z.array(list).max(16)});
  const facts=z.union([z.strictObject({...shared,kind:z.literal('field'),report}),z.strictObject({...shared,kind:z.literal('item'),collection,identity,report}),z.strictObject({...shared,kind:z.literal('whole-list'),collection,report})]);
  const draft=z.strictObject({manifestId:z.literal(full.id),sections:z.array(group).max(64),residual:z.array(z.strictObject({evidence:ev,reason:z.enum(['ambiguous','unsupported-target','capacity','conflict','recognition-unreviewed'])})).max(8),sourceDisposition:z.enum(['represented','partially-represented'])});
  const advance=z.strictObject({manifestId:z.literal(full.id),actionId:enumeration(full.actions.map(a=>a.id)),controls:z.array(z.strictObject({kind:z.enum(['question','move-on','topic-switch']),attribution:z.enum(['direct-patient-command','reported-content','unclear']),targetTopicId:enumeration(payload.sections.map((s:any)=>s.topicId)).nullable(),replyId:z.null(),evidence:ev})).max(4),facts:z.array(facts).max(4),closure:z.strictObject({...shared,collection,evidence:ev}).nullable()});
  const jsonSchema=z.toJSONSchema(z.strictObject({advance,draft}),{target:'draft-7',reused:'ref'});
  const oldSystem=String(legacy.messages[0].content);
  const exampleSection=JSON.parse(oldSystem.slice(oldSystem.lastIndexOf('\n')+1)) as DomainSection;
  const itemExample=canonicalJson(compactBoundedDomainDraft({manifestId:'EXAMPLE_ONLY_MANIFEST',sections:[exampleSection],residual:[],sourceDisposition:'represented'}).sections[0]);
  const absenceExample=canonicalJson({answer:{field:'EXAMPLE_ONLY_event_arrangements',state:'scoped-detail',detail:'EXAMPLE ONLY: I do not need an EXAMPLE_ONLY_reserved_seat.',unresolvedField:'EXAMPLE_ONLY_event_arrangements'},quote:{statementId:'EXAMPLE_ONLY_VENUE_STATEMENT',quote:'EXAMPLE ONLY: I do not need an EXAMPLE_ONLY_reserved_seat.'},distinctSources:null,period:null,correctsSourceIds:[]});
  const system=oldSystem
    .replace('known includes the native typed value and mandatory exact valueSource. Other states have no value/valueSource.', 'known includes its native typed value. Other states have no value. Every fact carries one exact quote. Set distinctSources:null ONLY when that same quote supports evidence, value and predicate with identical meaning. Otherwise explicitly supply distinctSources with evidence (first address equals quote), predicate and valueSource (null for non-known). Never derive values, states, ownership or corrections from another fact or quote.')
    .replace('For example no transport help does not mean no care barriers or no practical needs.', 'A narrower absence never answers unsupplied needs in the broader field.')
    .replace('Its predicate must be exact source evidence', 'Its quote and any distinct predicate must be exact source evidence')
    .replace('For a narrower statement use scoped-detail with its exact detail text; it remains unresolved evidence, not a broad negative.', 'For a narrower absence author scoped-detail with exact source-limited detail text and unresolvedField equal to the issued broader field name. It retains that narrow meaning as unresolved evidence; it is never a whole-field negative. Do not claim the broader question was answered.')
    .replace('advance.supplied uses the SAME section/item/field representation for at most FOUR field reports and ONE explicit list closure.', 'advance.facts is a FLAT array of at most FOUR individual reports. Each fact names its section and owner plus kind: field (scalar report), item (collection, identity, ONE report), or whole-list (collection, ONE report). Use advance.closure separately: null or ONE section/owner/collection/evidence object. No nested prefix fields/items arrays. Draft retains grouped sections/lists/items; whole-list uses a compact report whose answer.field equals collection.')
    .replace('supplied facts/unknown/refusal','facts/unknown/refusal').replace('supplied reports','facts')
    .replace(`Prompt revision: ${'domain-item-placement-v1'}.`,`Prompt revision: ${boundedDomainPromptRevision}.`)
    .replace(/FORMAT EXAMPLE ONLY[\s\S]*$/, `FORMAT EXAMPLES ONLY, not patient data. Assume all EXAMPLE_ONLY statements, fields, items and earlier source IDs are issued only inside these fictitious examples. NEVER copy any EXAMPLE_ONLY identifiers, values or quotes into the patient answer. One source-limited absence: a reserved-seat absence leaves all other event arrangements unresolved. The model authors the exact limited narrative and names the unresolved broader field:
${absenceExample}
One new item and one correction to an issued existing item. The section scalar fields remain empty; item reports belong under the collection's items fields:
${itemExample}`);
  const messages:InferenceMessage[]=[{role:'system',content:system},legacy.messages[1]];
  const bytes=(v:unknown)=>Buffer.byteLength(typeof v==='string'?v:canonicalJson(v));
  if(bytes(jsonSchema)>32000||bytes({messages,jsonSchema})>131072)throw new AdaptiveError('domain-request-capacity');
  const manifest:BoundedDomainManifest=Object.freeze({protocol:boundedDomainProtocol,id:legacy.id,sha256:hash({legacy:legacy.sha256,messages,jsonSchema}),messages,jsonSchema,measurement:{...legacy.measurement,schemaBytes:bytes(jsonSchema),instructionBytes:bytes(system),requestBodyBytes:bytes({messages,jsonSchema})}});
  issued.set(manifest,{legacy,full,signature:hash(manifest),draft,advance});return manifest;
}
function trusted(manifest:BoundedDomainManifest){const record=issued.get(manifest);if(!record||record.signature!==hash(manifest))throw new AdaptiveError('unissued-or-mutated-domain-manifest');return record;}
export function decodeBoundedDomainDraft(raw:unknown,manifest:BoundedDomainManifest){const record=trusted(manifest);return decodeDomainDraft(expandDraft(record.draft.parse(raw) as BoundedDomainDraft),record.legacy);}
export function decodeBoundedDomainAdvance(raw:unknown,manifest:BoundedDomainManifest):ReplyAdvance {
  if(Buffer.byteLength(canonicalJson(raw))>8192)throw new AdaptiveError('domain-navigation-byte-capacity');
  const record=trusted(manifest),advance=record.advance.parse(raw) as BoundedDomainAdvance,groups:DomainSection[]=[];
  const group=(fact:{section:string;owner:DomainSection['owner']})=>{let found=groups.find(g=>g.section===fact.section&&same(g.owner,fact.owner));if(!found){found={section:fact.section,owner:fact.owner,fields:[],lists:[]};groups.push(found);}return found;};
  for(const fact of advance.facts){const g=group(fact);
    if(fact.kind==='field'){g.fields.push(expandReport(fact.report));continue;}
    if(fact.kind==='whole-list'){g.lists.push({collection:fact.collection,kind:'whole-list',...wholeList(fact.report,fact.collection)});continue;}
    let list=g.lists.find(l=>l.kind==='items'&&l.collection===fact.collection);if(!list){list={kind:'items',collection:fact.collection,items:[],closure:null};g.lists.push(list);}
    let item=list.items!.find(i=>same(i.identity,fact.identity));if(!item){item={identity:fact.identity,fields:[]};list.items!.push(item);}item.fields.push(expandReport(fact.report));
  }
  if(advance.closure){const c=advance.closure,g=group(c);let list=g.lists.find(l=>l.kind==='items'&&l.collection===c.collection);if(!list){list={kind:'items',collection:c.collection,items:[],closure:null};g.lists.push(list);}list.closure={evidence:c.evidence};}
  const navigation=decodeDomainDraft({manifestId:advance.manifestId,sections:groups,residual:[],sourceDisposition:'partially-represented'},record.legacy);
  return validateFullAdvance({manifestId:advance.manifestId,actionId:advance.actionId,controls:advance.controls,defer:[],suppliedDraft:navigation},record.full);
}
export async function consumeBoundedDomainStream(config:Omit<DigitalOceanConfig,'responseFormat'>,manifest:BoundedDomainManifest,options:{fetcher?:Fetch;signal?:AbortSignal;onAdvance?:(packet:ReplyAdvance)=>void|Promise<void>;onSyntheticContent?:(text:string)=>void;now?:()=>number}={}) {
  trusted(manifest);const decoder=new ActionFirstObjectDecoder();let advance:ReplyAdvance|undefined,draft:ReturnType<typeof decodeBoundedDomainDraft>|undefined;
  const result=await digitalOceanStream({...config,responseFormat:{type:'json-schema',name:boundedDomainSchemaName,schema:manifest.jsonSchema}},options.fetcher,options.now,fullStreamLimits(config.maxOutputTokens)).generate([...manifest.messages],{signal:options.signal,onContent:async text=>{options.onSyntheticContent?.(text);for(const packet of decoder.feed(text)){if(packet.kind==='advance'){advance=decodeBoundedDomainAdvance(packet.value,manifest);await options.onAdvance?.(advance);}else draft=decodeBoundedDomainDraft(packet.value,manifest);}}});
  try{decoder.finish();}catch{throw new DigitalOceanStreamFailure('incomplete-domain-tail',{...result.receipt,outcome:'rejected'});}
  if(!advance||!draft)throw new DigitalOceanStreamFailure('incomplete-domain-tail',{...result.receipt,outcome:'rejected'});
  return {advance,draft,rawOutput:result.text,admission:'unqualified-provisional' as const,receipt:result.receipt,validationRevision:boundedDomainValidationRevision};
}
