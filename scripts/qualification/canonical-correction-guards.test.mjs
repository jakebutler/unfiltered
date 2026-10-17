import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDevelopmentAllocation, operations } from './qualify-extraction-canonical-correction.mjs';
const now = Date.now();
const preflight = { ...operations[0], candidateSha256: 'a'.repeat(64), requestBodySha256: 'b'.repeat(64), developmentCaseIds: ['D3-CORRECTION'] };
function allocation() { return { schema: 1, allocationId: 'DO-CANONICAL-CORRECTION-ONE', issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 10000).toISOString(), candidateSha256: preflight.candidateSha256, creditsCap: 1, operations: [{ id: 'DO-AF85', caseId: 'D3-CORRECTION', maxCalls: 1, maxOutputTokens: 2048, requestBodySha256: preflight.requestBodySha256, creditsCap: 1 }] }; }
test('dependent allocation accepts only the single issued correction/body and rejects scope expansion or expiry', () => {
    assert.equal(validateDevelopmentAllocation(allocation(), [preflight], now)[0].selected.id, 'DO-AF85');
    for (const mutate of [a => a.operations.push(structuredClone(a.operations[0])), a => a.operations[0].id = 'DO-AF79', a => a.operations[0].caseId = 'D3-SETUP', a => a.operations[0].requestBodySha256 = 'c'.repeat(64), a => a.operations[0].maxCalls = 2, a => a.creditsCap = 2, a => a.expiresAt = new Date(now - 1).toISOString()]) {
        const raw = allocation(); mutate(raw); assert.throws(() => validateDevelopmentAllocation(raw, [preflight], now));
    }
});
