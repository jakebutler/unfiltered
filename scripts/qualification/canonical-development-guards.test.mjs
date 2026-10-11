import assert from 'node:assert/strict';
import test from 'node:test';
import { operations, v4Operations, v5Operations, v5QwenOperations, v5QwenConfig, sourceMeaningOperations, sourceMeaningContract, sourceMeaningQuoteAudit, validateDevelopmentAllocation, runDevelopmentBatch } from './qualify-extraction-canonical-development.mjs';
import { oneOperationFetch } from './qualify-extraction-flash-low.mjs';
import { createHash } from 'node:crypto';
const now = 1802217600000, candidate = 'a'.repeat(64), request = 'b'.repeat(64);
const preflights = operations.map(o => ({ ...o, candidateSha256: candidate, developmentCaseIds: operations.map(o => o.caseId), requestBodySha256: request }));
const allocation = () => ({ schema: 1, allocationId: 'DO-CANONICAL-DEVELOPMENT-20261010-A1', candidateSha256: candidate, issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 1800000).toISOString(), creditsCap: 8, operations: operations.map(o => ({ id: o.id, caseId: o.caseId, maxCalls: 1, maxOutputTokens: 2048, creditsCap: 1, requestBodySha256: request })) });
test('exact eight allocation excludes correction, altered request, duplicate, expiry and extra allowance', () => {
  assert.equal(validateDevelopmentAllocation(allocation(), preflights, now).length, 8);
  for (const mutate of [a => a.operations.push({ ...a.operations[0], id: 'DO-AF85', caseId: 'D3-CORRECTION' }), a => a.operations[1].requestBodySha256 = 'c'.repeat(64), a => a.operations[1].id = a.operations[0].id, a => a.expiresAt = new Date(now).toISOString(), a => a.creditsCap = 9]) { const a = allocation(); mutate(a); assert.throws(() => validateDevelopmentAllocation(a, preflights, now)); }
});
test('complete semantic/schema failure still executes independent cases, without retry', async () => {
  const seen = []; const results = await runDevelopmentBatch(operations, async e => { seen.push(e.id); return { ...e, callCount: 1, state: 'qualification-failed', stopIndependentCases: false }; });
  assert.deepEqual(seen, operations.map(o => o.id)); assert.equal(results.reduce((n, r) => n + r.callCount, 0), 8);
});
test('unknown execution stops later cases with their correct operation identities', async () => {
  let calls = 0; const entries = operations.map(preflight => ({ preflight })); const results = await runDevelopmentBatch(entries, async e => { calls++; return { ...e.preflight, callCount: 1, stopIndependentCases: true }; });
  assert.equal(calls, 1); assert.deepEqual(results.slice(1).map(r => r.id), operations.slice(1).map(o => o.id)); assert(results.slice(1).every(r => r.callCount === 0));
});
test('exact one-fetch fence rejects body drift and duplicate dispatch, while forcing redirect error', async () => {
  const body = '{"synthetic":"guard"}', hash = createHash('sha256').update(body).digest('hex'); let calls = 0;
  const one = oneOperationFetch(async (_url, init) => { calls++; assert.equal(init.redirect, 'error'); return new Response(); }, hash);
  await assert.rejects(one.fetcher('https://inference.do-ai.run/v1/chat/completions', { method: 'POST', body: '{}' })); assert.equal(calls, 0);
  await one.fetcher('https://inference.do-ai.run/v1/chat/completions', { method: 'POST', body });
  await assert.rejects(one.fetcher('https://inference.do-ai.run/v1/chat/completions', { method: 'POST', body })); assert.equal(calls, 1);
});
test('completed output/usage and saved source survive a subsequent fake resume authority loss', async () => {
  const fixture = await import('../../.extraction-canonical-development-build/scripts/qualification/fixtures/adaptive-canonical-development.js');
  const { GroupedExtractionOutputFailure } = await import('../../.extraction-canonical-development-build/packages/clinic-api/src/adaptive-extraction-grouped-session-v2.js');
  const seed = await fixture.createDevelopmentSeed('D1');
  const receipt = { model: 'qwen3.8-max', requestBytes: 10, responseSchema: 'test', outcome: 'complete', providerExecution: 'completed', usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }, finishReason: 'stop', timings: { dispatchMs: 0, completedMs: 1 }, contentBytes: 2, wireBytes: 10, eventCount: 2, reasoningBytes: 0, limits: { maxContentBytes: 32000, maxReasoningBytes: 32000, maxWireBytes: 64000, maxEvents: 1000, maxEventBytes: 32000, terminalGraceMs: 100 } };
  let extracts = 0, lostReads = 0;
  const result = await fixture.interpretDevelopmentSeed(seed, { async extract() { extracts++; throw new GroupedExtractionOutputFailure('invalid-sparse-extraction', receipt, '{}'); } }, client => { client.request = async () => { lostReads++; throw Error('synthetic-authority-loss'); }; });
  assert.equal(result.httpStatus, 200); assert.equal(result.resumeHttpStatus, 503); assert.equal(result.identityHttpStatus, undefined); assert.equal(extracts, 1); assert.equal(lostReads, 1);
  const op = result.savedDraft.adaptive.operations[seed.operationId]; assert.deepEqual(op.stream.receipt, receipt); assert(op.rawProposalAudit); assert.equal(op.status, 'failed');
  assert.equal(result.savedDraft.turns.find(t => t.id === op.sourceId).text, fixture.developmentCases[0].text); assert(result.resources.length > 0);
});

test('V4 reuses eight exact-body reservations and excludes the separately reserved dependent correction', () => {
  const preflights = v4Operations.map(o => ({ ...o, candidateSha256: candidate, developmentCaseIds: v4Operations.map(o => o.caseId), requestBodySha256: request }));
  const raw = { ...allocation(), allocationId: 'DO-CANONICAL-V4-GLM-20261010-A1', operations: v4Operations.map(o => ({ id: o.id, caseId: o.caseId, maxCalls: 1, maxOutputTokens: 4096, creditsCap: 1, requestBodySha256: request })) };
  assert.equal(validateDevelopmentAllocation(raw, preflights, now).length, 8);
  const extra = structuredClone(raw); extra.operations.push({ ...extra.operations[0], id: 'DO-AF94', caseId: 'D3-CORRECTION' });
  assert.throws(() => validateDevelopmentAllocation(extra, preflights, now));
  const reduced = structuredClone(raw); reduced.operations[0].maxOutputTokens = 2048;
  assert.throws(() => validateDevelopmentAllocation(reduced, preflights, now));
});

test('V5 retains the exact eight-operation allocation and separately gated ninth operation', () => {
  const preflights = v5Operations.map(o => ({ ...o, candidateSha256: candidate, developmentCaseIds: v5Operations.map(o => o.caseId), requestBodySha256: request }));
  const raw = { ...allocation(), allocationId: 'DO-CANONICAL-V5-GLM-20261010-A1', operations: v5Operations.map(o => ({ id: o.id, caseId: o.caseId, maxCalls: 1, maxOutputTokens: 4096, creditsCap: 1, requestBodySha256: request })) };
  assert.equal(validateDevelopmentAllocation(raw, preflights, now).length, 8);
  raw.operations.push({ ...raw.operations[0], id: 'DO-AF103', caseId: 'D3-CORRECTION' });
  assert.throws(() => validateDevelopmentAllocation(raw, preflights, now));
});


test('same-contract Qwen comparison retains finite independent allocation and separately gated ninth operation', () => {
  assert.equal(v5QwenConfig.model, 'qwen3.8-max'); assert.equal(v5QwenConfig.maxOutputTokens, 4096); assert.equal(v5QwenConfig.maxRequestBytes, 128000);
  const preflights = v5QwenOperations.map(o => ({ ...o, candidateSha256: candidate, developmentCaseIds: v5QwenOperations.map(o => o.caseId), requestBodySha256: request }));
  const raw = { ...allocation(), allocationId: 'DO-CANONICAL-V5-QWEN-20261010-A1', operations: v5QwenOperations.map(o => ({ id: o.id, caseId: o.caseId, maxCalls: 1, maxOutputTokens: 4096, creditsCap: 1, requestBodySha256: request })) };
  assert.equal(validateDevelopmentAllocation(raw, preflights, now).length, 8);
  raw.operations.push({ ...raw.operations[0], id: 'DO-AF112', caseId: 'D3-CORRECTION' });
  assert.throws(() => validateDevelopmentAllocation(raw, preflights, now));
});


test('source-only diagnostic has exactly eight issued once-only operations and no dependent authority', () => {
  const preflights = sourceMeaningOperations.map(o => ({ ...o, candidateSha256: candidate, developmentCaseIds: sourceMeaningOperations.map(o => o.caseId), requestBodySha256: request }));
  const raw = { ...allocation(), allocationId: 'DO-SOURCE-MEANING-GLM-20261010-A1', operations: sourceMeaningOperations.map(o => ({ id: o.id, caseId: o.caseId, maxCalls: 1, maxOutputTokens: 4096, creditsCap: 1, requestBodySha256: request })) };
  assert.equal(validateDevelopmentAllocation(raw, preflights, now).length, 8);
  raw.operations.push({ ...raw.operations[0], id: 'DO-AF121', caseId: 'D3-CORRECTION' }); assert.throws(() => validateDevelopmentAllocation(raw, preflights, now));
});
test('source-only shape cannot introduce native actions or unissued prior-meaning links; quote reuse is valid and repeated source text is ambiguous', () => {
  const schema = sourceMeaningContract().schema;
  const statement = { kind: 'report', subject: 'patient', entity: 'Metformin', meaning: 'Reports taking Metformin850mg.', assertion: 'affirmed', quote: 'Metformin850mg', relation: null };
  const parsed = schema.parse({ statements: [statement, { ...statement, meaning: 'Reports the named medicine strength850mg.' }], unresolved: [] });
  assert(sourceMeaningQuoteAudit(parsed, 'I take Metformin850mg.').every(q => q.exactUniqueCurrentSource));
  assert(sourceMeaningQuoteAudit(parsed, 'Metformin850mg and Metformin850mg').every(q => !q.exactUniqueCurrentSource));
  assert.throws(() => schema.parse({ statements: [{ ...statement, relation: { kind: 'corrects', priorId: 'invented' } }], unresolved: [] }));
  assert.throws(() => schema.parse({ statements: [statement], unresolved: [], nextQuestion: 'DM01' }));
});
