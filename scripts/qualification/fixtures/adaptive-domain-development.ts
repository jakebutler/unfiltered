import { canonicalJson } from '../../../packages/clinical-core/src/domain.js';
import { createHash } from 'node:crypto';
import { createDomainManifest, encodeDomainDraft, type DomainManifest } from '../../../packages/clinic-api/src/adaptive-reply-domain.js';
import type { FullReplyManifest } from '../../../packages/clinic-api/src/adaptive-reply-full.js';
import { fullCaseLabels, fullCaseIds, representativeCaseDraft } from './adaptive-full-cases.js';

export const domainProspectiveCases = ['G3','G7','P1'] as const;
export const domainLabelRevision = 'source-meaning-domain-v1';
/** Original source and original15 labels stay untouched. This explicit change
 * corrects a prior broad-negative label, not a source or acceptance threshold. */
export function domainCaseLabels(id:string) {
  const original=fullCaseLabels(id), refined=structuredClone(original);
  if(id==='P1') {
    const label=refined.expected.find(label=>label.topic==='W02'&&label.path==='logistics')!;
    label.state='scoped-detail';label.meaning='No transport help needed only; does not answer all logistics, care barriers, or general help.';
    refined.forbidden.push('Transport-only absence generalized to whole logistics, barrier or help negative.');
  }
  return {revision:domainLabelRevision,originalLabelsSha256:createHash('sha256').update(JSON.stringify(original)).digest('hex'),labelRefinement:id==='P1'?{path:'W02.logistics',originalState:'negative',state:'scoped-detail',allowedRepresentations:['scoped-detail residual','known text limited to transport help'],quote:'I need no transport help.',reason:'Whole logistics absence was unsupported by the narrow transport statement.'}:null,...refined};
}
export function domainRepresentativeDraft(id:string,full:FullReplyManifest,manifest:DomainManifest=createDomainManifest(full)) {
  const raw=encodeDomainDraft(representativeCaseDraft(id,full),manifest);
  if(id==='P1') {
    const field=raw.sections.find(section=>section.section==='beforeVisit')!.fields.find(field=>field.answer.field==='logistics')!;
    field.answer={field:'logistics',state:'scoped-detail',detail:'I need no transport help.'};raw.sourceDisposition='partially-represented';
  }
  return raw;
}
export function domainLabelInventory(){return fullCaseIds.map(domainCaseLabels);}
export function domainOutputMeasurement(id:string,full:FullReplyManifest,manifest:DomainManifest=createDomainManifest(full)) {
  const draft=domainRepresentativeDraft(id,full,manifest),advance={manifestId:full.id,actionId:full.actions.at(-1)!.id,controls:[],supplied:[]};
  const outputBytes=Buffer.byteLength(JSON.stringify({advance,draft}),'utf8');
  return {authoredOutputBytes:outputBytes,estimatedOutputTokensFourBytesEach:Math.ceil(outputBytes/4),actualTokenizerUsed:false,liveObserved:false,emptyPrefixBytes:Buffer.byteLength(canonicalJson(advance),'utf8')};
}
