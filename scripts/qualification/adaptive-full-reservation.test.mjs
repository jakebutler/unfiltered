import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateFullDevelopmentAllocation as validate} from './adaptive-full-reservation.mjs';
const now=Date.parse('2026-10-10T12:00:00Z'),preflight={id:'DO-AF3',caseId:'G1',candidateSha256:'a'.repeat(64),requestBodySha256:'b'.repeat(64),maximumOutputTokens:4096,developmentCaseIds:['G1','G2']};
const allocation=()=>({schema:1,allocationId:'development15',candidateSha256:preflight.candidateSha256,issuedAt:'2026-10-10T11:00:00Z',expiresAt:'2026-10-10T13:00:00Z',creditsCap:1,operations:[{id:'DO-AF3',caseId:'G1',requestBodySha256:preflight.requestBodySha256,maxCalls:1,maxOutputTokens:4096,creditsCap:1}]});
test('accepts exact bounded root reservation',()=>assert.equal(validate(allocation(),preflight,now).selected.caseId,'G1'));
test('rejects expired/future/unbounded allocations',()=>{for(const delta of [{expiresAt:'2026-10-10T12:00:00Z'},{issuedAt:'2026-10-10T12:01:00Z'},{expiresAt:'2026-10-12T12:00:00Z'}])assert.throws(()=>validate({...allocation(),...delta},preflight,now));});
test('rejects wrong candidate/request/case/output authority',()=>{for(const key of ['candidateSha256','requestBodySha256','caseId','maximumOutputTokens'])assert.throws(()=>validate(allocation(),{...preflight,[key]:key==='maximumOutputTokens'?2048:'wrong'},now));});
test('rejects duplicate case IDs, retries and credit over-allocation',()=>{const a=allocation();a.operations.push({...a.operations[0],id:'DO-AF4'});assert.throws(()=>validate(a,preflight,now));const b=allocation();b.operations[0].maxCalls=2;assert.throws(()=>validate(b,preflight,now));assert.throws(()=>validate({...allocation(),creditsCap:0.5},preflight,now));});
