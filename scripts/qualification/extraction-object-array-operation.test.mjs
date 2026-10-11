/** Credential-free authority checks; never imports the clinical build or calls a provider. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { verifyPins, validateSingleAllocation, oneOperationFetch } from './qualify-extraction-object-array.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const now = Date.parse('2026-10-10T20:00:00Z');
const preflight = { id: 'DO-AF64', caseId: 'G3', developmentCaseIds: ['G3'], candidateSha256: 'a'.repeat(64), requestBodySha256: 'b'.repeat(64), maximumOutputTokens: 512 };
const allocation = () => ({ schema: 1, allocationId: 'TEST-NOT-A-RESERVATION', candidateSha256: preflight.candidateSha256, issuedAt: '2026-10-10T19:59:00Z', expiresAt: '2026-10-10T20:14:00Z', creditsCap: 1, operations: [{ id: 'DO-AF64', caseId: 'G3', requestBodySha256: preflight.requestBodySha256, maxCalls: 1, maxOutputTokens: 512, creditsCap: 1 }] });
test('one exact finite operation is accepted; changed candidate/request/caps and unknown fields reject', () => {
  assert.equal(validateSingleAllocation(allocation(), preflight, now).selected.id, 'DO-AF64');
  for (const mutate of [
    a => { a.candidateSha256 = 'c'.repeat(64); },
    a => { a.operations[0].requestBodySha256 = 'd'.repeat(64); },
    a => { a.operations[0].maxOutputTokens = 4096; },
    a => { a.operations[0].maxCalls = 2; },
    a => { a.operations[0].id = 'DO-AF65'; },
    a => { a.operations[0].caseId = 'P1'; },
    a => { a.creditsCap = 2; },
    a => { a.operations[0].creditsCap = .5; },
    a => { a.operations.push({ ...a.operations[0], id: 'DO-AF65', caseId: 'P1' }); },
    a => { a.expiresAt = '2026-10-10T22:00:00Z'; },
    a => { a.expiresAt = '2026-10-10T20:00:00Z'; },
    a => { a.issuedAt = '2026-10-10T20:01:00Z'; },
    a => { a.cashCap = 25; },
  ]) { const changed = allocation(); mutate(changed); assert.throws(() => validateSingleAllocation(changed, preflight, now)); }
});
test('current and archived pins reject source drift without reading anything else', () => {
  const pins = [{ path: 'current', sha256: sha('bound') }, { path: 'archive', sha256: sha('bound') }];
  verifyPins(pins, () => 'bound');
  assert.throws(() => verifyPins(pins, path => path === 'current' ? 'drift' : 'bound'), /source\/archive drift/);
  assert.throws(() => verifyPins(pins, path => path === 'archive' ? 'drift' : 'bound'), /source\/archive drift/);
});
test('one unchanged request reaches the supplied fake transport once; retry and changed wire reject', async () => {
  let observed = 0;
  const body = '{"synthetic":true}', init = { method: 'POST', body };
  const url = 'https://inference.do-ai.run/v1/chat/completions';
  const one = oneOperationFetch(async (_url, delivered) => { assert.equal(delivered.redirect, 'error'); assert.equal(delivered.body, body); observed++; return new Response('fake', { status: 500 }); }, sha(body));
  await assert.rejects(one.fetcher(url, { ...init, body: '{}' }), /exact issued request/);
  assert.equal(observed, 0);
  await one.fetcher(url, init);
  await assert.rejects(one.fetcher(url, init), /one call only/);
  assert.equal(observed, 1);
  assert.equal(one.count(), 1);
});
