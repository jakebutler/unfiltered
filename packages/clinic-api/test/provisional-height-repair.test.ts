import { expect, it } from 'vitest';
import { context } from './fixtures/adaptive.js';
import { createFullReplyManifest, prepareFullCapture, type FullReplyDraft } from '../src/adaptive-reply-full.js';
import { fullPolicyRevision, policyQualified, type ProvisionalQualification } from '../src/provisional-projection.js';
function fixture(value: FullReplyDraft['claims'][number]['value'], unit?: string, whole = false) {
  const ctx = context("I'm five feet eight inches.", ['Q04','Q05']);
  const manifest = createFullReplyManifest(ctx), payload = JSON.parse(String(manifest.messages[1].content));
  const address = {statementId:payload.statements[0].id,quote:whole ? payload.statements[0].text : 'five feet eight inches'};
  const target = (path:string) => manifest.targets.find(target => target.path === path)!.id;
  const claim = (path:string,value:FullReplyDraft['claims'][number]['value'],ev=address): FullReplyDraft['claims'][number] => ({targetId:target(path),itemKey:null,state:'known',value,valueEvidence:ev,evidence:[address],scope:{subject:'patient',entity:null,period:null,predicate:address},correctsSourceIds:[]});
  const draft: FullReplyDraft = {manifestId:manifest.id,claims:[claim('height.value',value),...(unit ? [claim('height.unit',unit,{...address,quote:'inches'})] : [])],items:[],closures:[],acts:[],residual:[],sourceDisposition:'represented'};
  return {ctx,manifest,draft};
}
it.each([{feet:9,inches:11},999])('rejects invented height %j despite a real exact quotation', value => {
  const f=fixture(value,'in'), capture=prepareFullCapture(f.draft,f.manifest);
  expect(capture.claims.some(claim=>claim.path==='height.value')).toBe(false);
  expect(capture.gaps.some(gap=>gap.reason==='value-not-in-source')).toBe(true);
});
it('preserves exact word height and equivalent scalar inch normalization', () => {
  for (const [value,unit] of [[{feet:5,inches:8},undefined],[68,'in']] as const) {
    const f=fixture(value,unit), capture=prepareFullCapture(f.draft,f.manifest);
    expect(capture.claims.find(claim=>claim.path==='height.value')).toMatchObject({value,fidelity:'literal-supported'});
  }
});
it('does not invent units for a bare scalar proposed against a composite height', () => {
  const f=fixture(68), capture=prepareFullCapture(f.draft,f.manifest);
  expect(capture.claims.some(claim=>claim.path==='height.value')).toBe(false);
  expect(capture.gaps.some(gap=>gap.reason==='value-not-in-source')).toBe(true);
});
it('preserves equivalent metric normalization when an existing context explicitly fixes the unit', () => {
  const f=fixture(172.72); f.ctx.responses.Q04={presented:true,answers:{'height.unit':{state:'known',value:'cm',sourceIds:[f.ctx.source.id]}}};
  const manifest=createFullReplyManifest(f.ctx); f.draft.manifestId=manifest.id;
  expect(prepareFullCapture(f.draft,manifest).claims.find(claim=>claim.path==='height.value')).toMatchObject({value:172.72});
});
it('rejects a fabricated whole-sentence height while preserving an honest whole-sentence interpretation', () => {
  const wrong=fixture({feet:9,inches:11},undefined,true), honest=fixture({feet:5,inches:8},undefined,true);
  expect(prepareFullCapture(wrong.draft,wrong.manifest).claims.some(claim=>claim.path==='height.value')).toBe(false);
  expect(prepareFullCapture(honest.draft,honest.manifest).claims.find(claim=>claim.path==='height.value')).toMatchObject({value:{feet:5,inches:8}});
});
it('rejects conflicting recognized height quantities instead of selecting the first', () => {
  const f=fixture({feet:5,inches:8},undefined,true); f.ctx.source.text='I was five feet eight inches but now I am six feet zero inches.';
  const manifest=createFullReplyManifest(f.ctx), payload=JSON.parse(String(manifest.messages[1].content)), ev={statementId:payload.statements[0].id,quote:payload.statements[0].text};
  f.draft.manifestId=manifest.id; f.draft.claims[0].valueEvidence=ev; f.draft.claims[0].evidence=[ev]; f.draft.claims[0].scope.predicate=ev;
  const capture=prepareFullCapture(f.draft,manifest);
  expect(capture.claims).toHaveLength(0); expect(capture.gaps.some(gap=>gap.reason==='ambiguous')).toBe(true);
});
it('does not give the changed normalization policy readiness authority from an older receipt', () => {
  const current: ProvisionalQualification = {...fullPolicyRevision,status:'qualified',evidenceDigest:'a'.repeat(64)};
  expect(policyQualified({...current,normalization:'typed-context-v2'} as unknown as ProvisionalQualification)).toBe(false);
  expect(policyQualified(current)).toBe(true); // Synthetic authority only; no production receipt is issued.
});
