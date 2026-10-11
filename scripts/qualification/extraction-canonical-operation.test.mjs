import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { operation, validateCanonicalAllocation } from './qualify-extraction-canonical.mjs';
import { oneOperationFetch } from './qualify-extraction-flash-low.mjs';
import { createCanonicalSeed, prepareCanonicalContext, interpretCanonicalSeed } from '../../.extraction-canonical-build/scripts/qualification/fixtures/adaptive-canonical-goals.js';
import { sparseExtractionProposer } from '../../.extraction-canonical-build/packages/clinic-api/src/adaptive-extraction-sparse-provider.js';
import { createFullReplyManifest } from '../../.extraction-canonical-build/packages/clinic-api/src/adaptive-reply-full.js';
import { digitalOceanStream, prepareDigitalOceanStreamRequest, fullStreamLimits } from './digitalocean-canonical-flash-low.mjs';
const sha = b => createHash('sha256').update(b).digest('hex'), candidate = 'a'.repeat(64), now = Date.parse('2026-10-10T20:00:00Z');
const preflight = { ...operation, developmentCaseIds: ['CANONICAL-GOALS'], candidateSha256: candidate, requestBodySha256: 'b'.repeat(64) };
const allocation = () => ({ schema: 1, allocationId: 'offline-only', candidateSha256: candidate, issuedAt: new Date(now - 1).toISOString(), expiresAt: new Date(now + 1800000).toISOString(), creditsCap: 1, operations: [{ id: operation.id, caseId: operation.caseId, maxCalls: 1, maxOutputTokens: 2048, creditsCap: 1, requestBodySha256: preflight.requestBodySha256 }] });
test('canonical envelope permits exactly one matching existing-credit request', () => {
  assert.equal(validateCanonicalAllocation(allocation(), preflight, now).selected.id, 'DO-AF74');
  for (const change of ['extra', 'tokens', 'body', 'calls', 'credits', 'case', 'expired']) { const a = allocation(); if (change === 'extra') a.operations.push({ ...a.operations[0] }); if (change === 'tokens') a.operations[0].maxOutputTokens = 512; if (change === 'body') a.operations[0].requestBodySha256 = 'c'.repeat(64); if (change === 'calls') a.operations[0].maxCalls = 2; if (change === 'credits') a.creditsCap = 2; if (change === 'case') a.operations[0].caseId = 'G3'; if (change === 'expired') a.expiresAt = new Date(now).toISOString(); assert.throws(() => validateCanonicalAllocation(a, preflight, now)); }
});
for (const mode of ['valid', 'duplicate', 'network']) test(`exact emitted API/Flash-low path ${mode} retains expected source/receipt boundary once`, async () => {
  const seed = await createCanonicalSeed(), prep = await prepareCanonicalContext(seed), targets = createFullReplyManifest(prep.context).targets, bank = JSON.parse(String(prep.manifest.messages[1].content)).bank;
  const raw = { m: prep.manifest.id, f: [['reason', 'managing my weight'], ['priority', 'more energy for walks with my family']].map(([path, v]) => ({ f: targets.find(t => t.topicId === 'Q01' && t.path === path).id, o: 'patient', k: 'k', s: bank[0].id, v })), i: [], c: [], e: [], r: [], d: 'represented' };
  if (mode === 'duplicate') raw.f.push(structuredClone(raw.f[0]));
  const config = { endpoint: 'https://inference.do-ai.run', apiKey: 'offline-only', model: 'glm-5.3-flash', timeoutMs: 2000, maxOutputTokens: 2048, maxRequestBytes: 131072 };
  const issued = await prepareDigitalOceanStreamRequest({ ...config, responseFormat: { type: 'json-schema', name: 'adaptive_extraction_sparse_v3', schema: prep.manifest.jsonSchema } }, [...prep.manifest.messages]);
  const one = oneOperationFetch(async (_url, init) => {
    const body = JSON.parse(init.body); assert.equal(body.reasoning_effort, 'low'); assert.equal(body.response_format.type, 'json_schema'); assert.equal(body.max_tokens, 2048); assert.equal(init.redirect, 'error');
    if (mode === 'network') throw Error('synthetic transport unknown');
    const event = (choices, usage) => `data: ${JSON.stringify({ id: 'synthetic-canonical', model: config.model, choices, ...(usage ? { usage } : {}) })}\n\n`;
    return new Response(event([{ index: 0, delta: { content: JSON.stringify(raw) }, finish_reason: null }]) + event([{ index: 0, delta: {}, finish_reason: 'stop' }]) + event([], { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  }, sha(issued.body));
  const result = await interpretCanonicalSeed(seed, sparseExtractionProposer(config, c => digitalOceanStream(c, one.fetcher, () => performance.now(), fullStreamLimits(2048))));
  const op = result.savedDraft.adaptive.operations[seed.operationId]; assert.equal(one.count(), 1); assert.equal(op.stream.receipt.requestBytes, issued.requestBytes);
  assert.equal(result.savedDraft.turns.find(t => t.id === op.sourceId).channel, 'text');
  if (mode === 'valid') { assert.equal(op.status, 'applied'); assert.equal(result.savedDraft.adaptive.exchange.prompt.topicId, 'Q02'); assert.equal(op.stream.provisional.claims.length, 2); }
  if (mode === 'duplicate') { assert.equal(op.status, 'failed'); assert.equal(op.errorCode, 'invalid-sparse-extraction'); assert.equal(op.stream.receipt.providerExecution, 'completed'); assert.equal(op.rawProposalAudit.content, JSON.stringify(raw)); assert.equal(op.stream.provisional, undefined); }
  if (mode === 'network') { assert.equal(op.status, 'unresolved'); assert.equal(op.stream.receipt.outcome, 'unknown'); assert.equal(op.stream.receipt.usage, 'unknown'); }
  await assert.rejects(one.fetcher('https://inference.do-ai.run/v1/chat/completions', { method: 'POST', body: issued.body })); assert.equal(one.count(), 1);
});
