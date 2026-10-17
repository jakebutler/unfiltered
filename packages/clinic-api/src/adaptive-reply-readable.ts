import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { canonicalJson } from '../../clinical-core/src/domain.js';
import { ActionFirstObjectDecoder } from '../../clinical-core/src/action-first-object.js';
import { digitalOceanStream, DigitalOceanStreamFailure, fullStreamLimits } from '../../clinical-core/src/digitalocean-stream.js';
import type { DigitalOceanConfig, InferenceMessage } from '../../clinical-core/src/digitalocean.js';
import type { Fetch } from '../../clinical-core/src/transport.js';
import { AdaptiveError, type AdaptiveContext } from './adaptive-validation.js';
import { assertFullReplyManifest, validateFullAdvance, validateFullDraft, type FullReplyDraft, type FullReplyManifest, type FullReplyTarget } from './adaptive-reply-full.js';
import type { AdaptiveStreamProposer } from './adaptive-stream-session.js';
import type { SourceAddress, ReplyAdvance } from './adaptive-reply.js';

export const readableProtocol = 'adaptive-reply-readable-v3';
export const readableSchemaName = 'adaptive_reply_readable_v3';
export const readableValidationRevision = 'readable-source-shape-v3';
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const key = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/);
const ref = z.number().int().min(0).max(559), refs = z.array(ref).min(1).max(4);
const address = z.strictObject({ statementId: z.string().min(1).max(160), quote: z.string().min(1).max(8000) });
const evidence = z.array(address).min(1).max(4);
const owner = z.strictObject({ subject: z.enum(['patient','other','unclear']), entity: z.string().min(1).max(300).nullable() });
const value = z.union([z.string().min(1).max(8000),z.number().finite(),z.strictObject({ feet: z.number().int().nonnegative(), inches: z.number().nonnegative().lt(12) })]);
const otherState = z.enum(['negative','unknown','declined','uncertain','not-applicable']);
const report = z.union([z.strictObject({ state: z.literal('known'), value, valueSource: ref }),z.strictObject({ state: otherState })]);
const navigationReport = z.union([z.strictObject({ state: z.literal('known'), value: z.union([z.string().min(1).max(300),z.number().finite(),value.options[2]]), valueSource: address }),z.strictObject({ state: otherState })]);
const targetName = z.string().min(1).max(350);
const acts = z.strictObject({ kind: z.enum(['answer','question','correction','move-on','topic-switch','unclear']), targetTopicId: z.string().min(1).max(40).nullable(), replyId: z.null(), evidence: refs });
const draftSchema = z.strictObject({ manifestId: z.string().regex(/^[a-f0-9]{24}$/), anchors: z.array(address).max(560),
  claims: z.array(z.strictObject({ target: targetName, item: key.nullable(), report, owner: owner.nullable(), evidence: refs,
    scope: z.strictObject({ period: z.string().min(1).max(300).nullable(), predicate: ref }), correctsSourceIds: z.array(z.string().min(1).max(160)).max(8) })).max(64),
  items: z.array(z.strictObject({ collectionTarget: targetName, newKey: key, entity: z.string().min(1).max(300), subject: z.enum(['patient','other','unclear']), evidence: refs })).max(16),
  closures: z.array(z.strictObject({ collectionTarget: targetName, evidence: refs })).max(16), acts: z.array(acts).max(4),
  residual: z.array(z.strictObject({ evidence: refs, reason: z.enum(['ambiguous','unsupported-target','capacity','conflict','recognition-unreviewed']) })).max(8),
  sourceDisposition: z.enum(['represented','partially-represented']) });
export type ReadableDraft = z.infer<typeof draftSchema>;
export interface ReadableManifest { readonly protocol: typeof readableProtocol; readonly id: string; readonly sha256: string; readonly messages: readonly InferenceMessage[]; readonly jsonSchema: Record<string,unknown> }
interface RecordData { full: FullReplyManifest; signature: string; targets: Map<string,FullReplyTarget>; schema: z.ZodType<ReadableDraft>; advance: z.ZodType; prior: Record<string,{answers:Record<string,unknown>}> }
const issued = new WeakMap<ReadableManifest,RecordData>();
const exactEnum = (values: string[]) => values.length ? z.enum(values as [string,...string[]]) : z.never();
const name = (target: FullReplyTarget) => `${target.topicId}:${target.path}`;
export function createReadableManifest(full: FullReplyManifest): ReadableManifest {
  assertFullReplyManifest(full);
  const payload = JSON.parse(String(full.messages[1].content));
  const targets = new Map(full.targets.map(target => [name(target),target]));
  const statements = exactEnum(payload.statements.map((statement:{id:string})=>statement.id));
  const quote = address.extend({statementId:statements}), ev = z.array(quote).min(1).max(4);
  const collections = full.targets.filter(target=>target.kind==='collection').map(name);
  const constrained = draftSchema.extend({manifestId:z.literal(full.id),anchors:z.array(quote).max(560),
    claims:z.array(draftSchema.shape.claims.element.extend({target:exactEnum([...targets.keys()])})).max(64),
    items:z.array(draftSchema.shape.items.element.extend({collectionTarget:exactEnum(collections)})).max(16),
    closures:z.array(draftSchema.shape.closures.element.extend({collectionTarget:exactEnum(collections)})).max(16)});
  const prefixReport = z.union([navigationReport.options[0].extend({valueSource:quote}),navigationReport.options[1]]);
  const advance = z.strictObject({manifestId:z.literal(full.id),actionId:exactEnum(full.actions.map(action=>action.id)),
    controls:z.array(z.strictObject({kind:z.enum(['question','move-on','topic-switch']),attribution:z.enum(['direct-patient-command','reported-content','unclear']),targetTopicId:exactEnum([...new Set(full.targets.map(target=>target.topicId))]).nullable(),replyId:z.null(),evidence:ev})).max(4),
    supplied:z.array(z.strictObject({target:exactEnum(full.targets.filter(target=>!target.collection&&target.kind!=='collection').map(name)),report:prefixReport,evidence:ev})).max(4)});
  const jsonSchema = z.toJSONSchema(z.strictObject({advance,draft:constrained}),{target:'draft-7'});
  const system = String(full.messages[0].content).replace('Preserve move-on/topic-switch/questions in controls and defer only a redundant supplied target with evidence.','Controls are proposed patient intentions, not stop authority. Mark attribution direct-patient-command only for the patient’s complete imperative/refusal about a named/current topic; quoted advice or facts are reported-content, ambiguity unclear. Direct commands may defer navigation only, never stopped/readiness. supplied replaces defer: include at most4 scalar reports already supplied in this source, for navigation only. Choose an issued genuinely unanswered question, not a question repeating supplied facts.')
    .replace('Known requires a typed proposed value and exact valueEvidence; all other states have null value/valueEvidence.','Report variants: known has state known, typed value and mandatory valueSource. negative/unknown/declined/uncertain/not-applicable have only state; no value or valueSource. negative means an explicit whole-field none/no, never merely a narrower absent detail.')
    .replace('Lists: declare an item key for each new entity, then use that key only on matching [new] field targets; existing item targets use itemKey null.','Lists: declare each newKey/entity/subject once in items. New child targets reference newKey in item and set owner null; the server derives entity/subject. Existing-item targets and scalars set item null. Existing children set owner null, and the server uses the issued existing identity. Scalars provide owner. Never put an existing ID in a newKey. Attach correctsSourceIds to the replacement known report, not a separate uncertain report.')
    +'\nReadable draft uses descriptive issued target names, English field names/states and one shared anchors array. evidence/predicate/valueSource inside draft refer to zero-based anchor indexes; each anchor is exact and referenced. Advance supplied reports copy exact quote addresses directly (the tail anchor table is not available yet). Supply only volunteered facts; do not populate catalog omissions as unknown. A self-report is known as a patient report without claiming verification. State uncertainty preserves expressed uncertainty; do not convert supplied facts to unknown because they are unverified. Retain narrower scope: no transport help is a transport report, not absence of every care barrier; wheelchair access is an accessibility request, not a general support assessment. Only issued applicable branch targets are allowed. Do not infer diabetes from a medicine. All fields required within their selected schema variant.';
  const content = canonicalJson({...payload,targets:payload.targets.map((target:{id:string})=>({...target,id:name(full.targets.find(t=>t.id===target.id)!)})),protocol:readableProtocol});
  if(content.length>64000)throw new AdaptiveError('readable-message-too-large');
  const parts:{type:'text';text:string}[]=[];
  for(let start=0;start<content.length;){let end=Math.min(start+16000,content.length);if(end<content.length&&/[\uD800-\uDBFF]/.test(content[end-1])&&/[\uDC00-\uDFFF]/.test(content[end]))end--;parts.push({type:'text',text:content.slice(start,end)});start=end;}
  if(parts.length>4)throw new AdaptiveError('readable-message-too-large');
  const messages:InferenceMessage[]=[{role:'system',content:system},{role:'user',content:content.length<=32000?content:parts}];
  const manifest:ReadableManifest=Object.freeze({protocol:readableProtocol,id:full.id,sha256:hash({full:full.sha256,jsonSchema,messages}),jsonSchema,messages});
  issued.set(manifest,{full,signature:hash(manifest),targets,schema:constrained,advance,prior:payload.prior});return manifest;
}
function trusted(manifest:ReadableManifest){const record=issued.get(manifest);if(!record||record.signature!==hash(manifest))throw new AdaptiveError('unissued-or-mutated-readable-manifest');assertFullReplyManifest(record.full);return record;}
function existingOwner(record:RecordData,target:FullReplyTarget){
  if(target.newItem)return;
  const match=/^([^[]+)\[([^\]]+)\]\./.exec(target.path);if(!match)return;
  const list=record.prior[target.topicId]?.answers[match[1]] as {state?:string;items?:{id:string;answers:Record<string,{state:string;value?:unknown}>}[]} | undefined;
  const item=list?.state==='known'?list.items?.find(item=>item.id===match[2]):undefined;if(!item)throw new AdaptiveError('unissued-readable-existing-item');
  const primary=['name','relationship','time','term','approach','event','substance','record'].map(key=>item.answers[key]).find(answer=>answer?.state==='known'&&typeof answer.value==='string');
  return {subject:target.topicId==='Q10'&&match[1]==='familyHistory'?'other' as const:'patient' as const,entity:(primary?.value as string|undefined)??null};
}
export function decodeReadableDraft(raw:unknown,manifest:ReadableManifest):FullReplyDraft{
  const record=trusted(manifest),draft=record.schema.parse(raw),used=new Set<number>(),seen=new Set<string>();
  const anchors=draft.anchors.map(anchor=>{const key=canonicalJson(anchor);if(seen.has(key))throw new AdaptiveError('duplicate-readable-anchor');seen.add(key);return anchor;});
  const address=(index:number):SourceAddress=>{if(!anchors[index])throw new AdaptiveError('invalid-readable-anchor');used.add(index);return anchors[index];};
  const target=(value:string)=>{const target=record.targets.get(value);if(!target)throw new AdaptiveError('unissued-readable-target');return target;};
  const items=new Map(draft.items.map(item=>[item.newKey,item]));if(items.size!==draft.items.length)throw new AdaptiveError('duplicate-readable-item-key');
  const expanded:FullReplyDraft={manifestId:draft.manifestId,claims:draft.claims.map(claim=>{
    const issuedTarget=target(claim.target),item=claim.item?items.get(claim.item):undefined,existing=existingOwner(record,issuedTarget);
    if(issuedTarget.newItem? !item||item.collectionTarget!==`${issuedTarget.topicId}:${issuedTarget.collection}`||claim.owner!==null : claim.item!==null||!!existing&&claim.owner!==null||!existing&&claim.owner===null)throw new AdaptiveError('invalid-readable-item-owner');
    const derived=item?{subject:item.subject,entity:item.entity}:existing??claim.owner!;
    return{targetId:issuedTarget.id,itemKey:claim.item,state:claim.report.state,value:claim.report.state==='known'?claim.report.value:null,valueEvidence:claim.report.state==='known'?address(claim.report.valueSource):null,evidence:claim.evidence.map(address),scope:{...derived,period:claim.scope.period,predicate:address(claim.scope.predicate)},correctsSourceIds:claim.correctsSourceIds};
  }),items:draft.items.map(item=>({collectionId:target(item.collectionTarget).id,key:item.newKey,entity:item.entity,evidence:item.evidence.map(address)})),closures:draft.closures.map(closure=>({collectionId:target(closure.collectionTarget).id,evidence:closure.evidence.map(address)})),acts:draft.acts.map(act=>({...act,evidence:act.evidence.map(address)})),residual:draft.residual.map(gap=>({...gap,evidence:gap.evidence.map(address)})),sourceDisposition:draft.sourceDisposition};
  if(used.size!==anchors.length)throw new AdaptiveError('unused-readable-anchor');return validateFullDraft(expanded,record.full);
}
export function decodeReadableAdvance(raw:unknown,manifest:ReadableManifest):ReplyAdvance{
  const record=trusted(manifest),advance=record.advance.parse(raw) as {manifestId:string;actionId:string;controls:ReplyAdvance['controls'];supplied:{target:string;report:z.infer<typeof navigationReport>;evidence:SourceAddress[]}[]};
  return validateFullAdvance({manifestId:advance.manifestId,actionId:advance.actionId,controls:advance.controls,defer:[],supplied:advance.supplied.map(item=>({targetId:record.targets.get(item.target)!.id,state:item.report.state,value:item.report.state==='known'?item.report.value:null,valueEvidence:item.report.state==='known'?item.report.valueSource:null,evidence:item.evidence}))},record.full);
}
/** Authored serializer for offline representatives; never model qualification. */
export function encodeReadableDraft(draft:FullReplyDraft,manifest:ReadableManifest):ReadableDraft{
  const record=trusted(manifest),anchors:SourceAddress[]=[],indexes=new Map<string,number>();
  const address=(anchor:SourceAddress)=>{const key=canonicalJson(anchor);if(!indexes.has(key)){indexes.set(key,anchors.length);anchors.push(anchor);}return indexes.get(key)!;};
  const target=(id:string)=>name(record.full.targets.find(target=>target.id===id)!);
  return record.schema.parse({manifestId:draft.manifestId,anchors,claims:draft.claims.map(claim=>({target:target(claim.targetId),item:claim.itemKey,report:claim.state==='known'?{state:'known',value:claim.value,valueSource:address(claim.valueEvidence!)}:{state:claim.state},owner:claim.itemKey||existingOwner(record,record.full.targets.find(target=>target.id===claim.targetId)!)?null:{subject:claim.scope.subject,entity:claim.scope.entity},evidence:claim.evidence.map(address),scope:{period:claim.scope.period,predicate:address(claim.scope.predicate)},correctsSourceIds:claim.correctsSourceIds})),items:draft.items.map(item=>({collectionTarget:target(item.collectionId),newKey:item.key,entity:item.entity,subject:draft.claims.find(claim=>claim.itemKey===item.key)?.scope.subject??'patient',evidence:item.evidence.map(address)})),closures:draft.closures.map(closure=>({collectionTarget:target(closure.collectionId),evidence:closure.evidence.map(address)})),acts:draft.acts.map(act=>({...act,evidence:act.evidence.map(address)})),residual:draft.residual.map(gap=>({...gap,evidence:gap.evidence.map(address)})),sourceDisposition:draft.sourceDisposition});
}
export async function consumeReadableStream(config:Omit<DigitalOceanConfig,'responseFormat'>,manifest:ReadableManifest,options:{fetcher?:Fetch;signal?:AbortSignal;onAdvance?:(packet:ReplyAdvance)=>void|Promise<void>;onSyntheticContent?:(text:string)=>void;now?:()=>number}={}){
  trusted(manifest);const decoder=new ActionFirstObjectDecoder();let advance:ReplyAdvance|undefined,draft:FullReplyDraft|undefined;
  const result=await digitalOceanStream({...config,responseFormat:{type:'json-schema',name:readableSchemaName,schema:manifest.jsonSchema}},options.fetcher,options.now,fullStreamLimits(config.maxOutputTokens)).generate([...manifest.messages],{signal:options.signal,onContent:async text=>{options.onSyntheticContent?.(text);for(const packet of decoder.feed(text)){trusted(manifest);if(packet.kind==='advance'){advance=decodeReadableAdvance(packet.value,manifest);await options.onAdvance?.(advance);}else draft=decodeReadableDraft(packet.value,manifest);}}});
  try{decoder.finish();}catch{throw new DigitalOceanStreamFailure('incomplete-readable-tail',{...result.receipt,outcome:'rejected'});}
  if(!advance||!draft)throw new DigitalOceanStreamFailure('incomplete-readable-tail',{...result.receipt,outcome:'rejected'});
  return{advance,draft,rawOutput:result.text,admission:'unqualified-provisional' as const,receipt:result.receipt,validationRevision:readableValidationRevision};
}
export function readableStreamProposer(config:Omit<DigitalOceanConfig,'responseFormat'>,options:{fetcher?:Fetch;now?:()=>number}={}):AdaptiveStreamProposer{
  return{async propose(context,manifest,run){if(manifest.protocol!=='adaptive-reply-full-v2')throw new AdaptiveError('full-stream-manifest-required');assertFullReplyManifest(manifest,context);return consumeReadableStream(config,createReadableManifest(manifest),{...options,...run});}};
}
