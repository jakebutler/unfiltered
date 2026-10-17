import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateDomainComparisonAllocation as validate } from './adaptive-domain-comparison-reservation.mjs';
const digest = 'a'.repeat(64), now = Date.parse('2026-10-10T18:00:00Z');
const operations = [ ['DO-AF42','G3','kimi-k3'],['DO-AF43','P1','kimi-k3'],['DO-AF44','G3','deepseek-v4.1-flash'],['DO-AF45','P1','deepseek-v4.1-flash'] ]
  .map(([id,caseId,model]) => ({id,caseId,model,creditsCap:1,maxCalls:1,maxOutputTokens:4096,requestBodySha256:digest}));
const allocation = () => ({schema:2,allocationId:'DO-DOMAIN-COMPARE',candidateSha256:digest,promptCandidateSha256:'b'.repeat(64),creditsCap:4,issuedAt:'2026-10-10T17:59:00Z',expiresAt:'2026-10-10T19:00:00Z',operations:structuredClone(operations)});
const preflight = (op = operations[0]) => ({ ...op, maximumOutputTokens:op.maxOutputTokens,candidateSha256:digest,promptCandidateSha256:'b'.repeat(64),developmentCaseIds:['G3','P1'] });
test('same case on distinct fixed models receives separate one-call reservations', () => {
  for (const op of operations) assert.equal(validate(allocation(),preflight(op),now).selected.id,op.id);
});
test('substituted model, case, request, prompt or implementation cannot consume reservation', () => {
  for (const change of [{model:'qwen3.8-max'},{caseId:'P1'},{requestBodySha256:'c'.repeat(64)},{promptCandidateSha256:'c'.repeat(64)},{candidateSha256:'c'.repeat(64)}]) {
    assert.throws(() => validate(allocation(),{...preflight(),...change},now));
  }
});
test('duplicate model/case, reused ID, extra operations, excess credits and expired windows fail closed', () => {
  for (const mutate of [a=>a.operations[2]=structuredClone(a.operations[0]),a=>a.operations.push(structuredClone(a.operations[0])),a=>a.creditsCap=5,a=>a.operations[0].maxCalls=2,a=>a.expiresAt=a.issuedAt]) {
    const a=allocation(); mutate(a); assert.throws(() => validate(a,preflight(),now));
  }
});
