import assert from 'node:assert/strict';
/** Trusted root-authored allocation, not a pricing estimator. Every case is
 * assigned once; even unknown results consume its full call/credit reservation. */
export function validateFullDevelopmentAllocation(raw, preflight, now = Date.now()) {
  assert(raw && Object.keys(raw).sort().join(',') === 'allocationId,candidateSha256,creditsCap,expiresAt,issuedAt,operations,schema', 'invalid allocation fields');
  assert(raw.schema === 1 && /^[A-Za-z0-9_-]{1,80}$/.test(raw.allocationId), 'invalid allocation identity');
  assert(raw.candidateSha256 === preflight.candidateSha256, 'allocation candidate mismatch');
  const issued=Date.parse(raw.issuedAt), expiry=Date.parse(raw.expiresAt);
  assert(Number.isFinite(issued)&&Number.isFinite(expiry)&&issued<=now&&now<expiry&&expiry-issued<=86400000,'allocation expired/future/unbounded');
  assert(Number.isFinite(raw.creditsCap)&&raw.creditsCap>0&&raw.creditsCap<=15,'allocation credit cap outside bounded development envelope');
  assert(Array.isArray(raw.operations)&&raw.operations.length>0&&raw.operations.length<=15,'bounded selected cases required');
  const ids=new Set(),cases=new Set();let total=0;
  for(const op of raw.operations) {
    assert(op&&Object.keys(op).sort().join(',')==='caseId,creditsCap,id,maxCalls,maxOutputTokens,requestBodySha256','invalid operation fields');
    assert(/^DO-AF[1-9][0-9]*$/.test(op.id)&&preflight.developmentCaseIds.includes(op.caseId)&&!ids.has(op.id)&&!cases.has(op.caseId),'duplicate/unissued operation or case');
    ids.add(op.id);cases.add(op.caseId);
    assert(op.maxCalls===1&&Number.isSafeInteger(op.maxOutputTokens)&&op.maxOutputTokens>=1&&op.maxOutputTokens<=4096,'invalid call/output reservation');
    assert(/^[a-f0-9]{64}$/.test(op.requestBodySha256)&&Number.isFinite(op.creditsCap)&&op.creditsCap>0&&op.creditsCap<=1,'invalid exact request/credit reservation');total+=op.creditsCap;
  }
  assert(total<=raw.creditsCap,'operation reservations exceed total allocation');
  const selected=raw.operations.find(op=>op.id===preflight.id);
  assert(selected&&selected.caseId===preflight.caseId&&selected.requestBodySha256===preflight.requestBodySha256&&selected.maxOutputTokens===preflight.maximumOutputTokens,'selected source/request/output reservation mismatch');
  return {allocationId:raw.allocationId,expiresAt:raw.expiresAt,creditsCap:raw.creditsCap,selected};
}
