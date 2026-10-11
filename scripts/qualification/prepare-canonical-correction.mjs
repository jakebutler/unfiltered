/** Dependent AF85 preparation only: actual admitted AF79 state, no provider dispatch. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import * as fixture from '../../.extraction-canonical-correction-build/scripts/qualification/fixtures/adaptive-canonical-development.js';
import * as codec from '../../.extraction-canonical-correction-build/packages/clinic-api/src/adaptive-extraction-sparse.js';
import * as stream from '../../.extraction-canonical-correction-build/packages/clinical-core/src/digitalocean-stream.js';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pin = path => ({ path, sha256: sha(readFileSync(path)) });
// V4 reuses this exact derivation and one-operation runner under the shared batch candidate.
if (process.argv.includes('--candidate')) {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) { const key = process.argv[i]; assert(['--candidate', '--actual-review', '--source-review'].includes(key) && !args.has(key)); args.set(key, process.argv[i + 1]); assert(args.get(key)); }
  assert.equal(args.size, 3); assert(['docs/implementation/evidence/S3-CANONICAL-V4-CANDIDATE.json', 'docs/implementation/evidence/S3-CANONICAL-V5-CANDIDATE.json', 'docs/implementation/evidence/S3-CANONICAL-V5-QWEN-CANDIDATE.json', 'docs/implementation/evidence/S3-CANONICAL-V6-CANDIDATE.json', 'docs/implementation/evidence/S3-CANONICAL-TYPED-CANDIDATE.json', 'docs/implementation/evidence/S3-CANONICAL-TYPED-QWEN-CANDIDATE.json'].includes(args.get('--candidate')));
  const { verifyCandidate } = await import('./qualify-extraction-canonical-development.mjs');
  const candidate = verifyCandidate(args.get('--candidate')), build = candidate.bindings.buildPath, version = build.includes('-typed-') ? (candidate.bindings.config.model === 'qwen3.8-max' ? 'typed-qwen' : 'typed') : build.includes('-v6-') ? 'v6' : candidate.bindings.config.model === 'qwen3.8-max' ? 'v5-qwen' : build.includes('-v5-') ? 'v5' : 'v4', recipe = candidate.bindings.conditionalCorrection;
  const [fixture, codec, stream] = await Promise.all(['scripts/qualification/fixtures/adaptive-canonical-development.js', version.startsWith('typed') ? 'packages/clinic-api/src/adaptive-extraction-typed.js' : 'packages/clinic-api/src/adaptive-extraction-sparse.js', 'packages/clinical-core/src/digitalocean-stream.js'].map(file => import(new URL('../../' + build + '/' + file, import.meta.url))));
  const setup = candidate.bindings.inputs.find(input => input.caseId === 'D3-SETUP'), actualPath = 'infra/cloud/.private/' + recipe.setupId + '-CANONICAL.json', setupReceiptPath = 'docs/implementation/evidence/' + recipe.setupId + '.json';
  const actual = JSON.parse(readFileSync(actualPath)), receipt = JSON.parse(readFileSync(setupReceiptPath));
  assert.equal(actual.candidateSha256, candidate.candidateSha256); assert.equal(receipt.candidateSha256, candidate.candidateSha256);
  assert.equal(receipt.providerReceipt.outcome, 'complete'); assert.equal(receipt.providerReceipt.providerExecution, 'completed'); assert.equal(receipt.operationStatus, 'applied');
  assert.equal(receipt.privateReadbackSha256, sha(readFileSync(actualPath)));
  for (const review of [args.get('--actual-review'), args.get('--source-review')]) assert(existsSync(review));
  const preparationPath = 'infra/cloud/.private/canonical-' + version + '-development-d3-correction-PREPARATION.json'; assert(!existsSync(preparationPath), 'never replace derived input');
  const seed = await fixture.createMedicationCorrectionSeed(JSON.parse(readFileSync(setup.seedPath)), actual.readback), prepared = await (version.startsWith('typed') ? fixture.prepareTypedDevelopmentContext : fixture.prepareDevelopmentContext)(seed);
  const request = await stream.prepareDigitalOceanStreamRequest({ ...candidate.bindings.config, apiKey: 'offline-preflight-only', responseFormat: { type: 'json-schema', name: version.startsWith('typed') ? 'turn_bound_typed_v1' : codec.sparseSchemaName, schema: prepared.manifest.jsonSchema } }, [...prepared.manifest.messages]);
  const seedPath = 'infra/cloud/.private/canonical-' + version + '-development-d3-correction-20261010.json', requestPath = 'infra/cloud/.private/canonical-' + version + '-development-d3-correction-request-20261010.json', contextPath = 'infra/cloud/.private/canonical-' + version + '-development-d3-correction-context-20261010.json';
  for (const [path, data] of [[seedPath, seed], [requestPath, { caseId: seed.caseId, body: request.body, contextSha256: prepared.manifest.contextSha256, manifestSha256: prepared.manifest.sha256 }], [contextPath, prepared.context]]) writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const preparation = { schema: 1, candidateSha256: candidate.candidateSha256, extractionCandidateSha256: candidate.extractionCandidateSha256, id: recipe.id, caseId: seed.caseId, seedPath, requestPath, contextPath, requestBodySha256: sha(request.body), requestBytes: request.requestBytes, contextSha256: prepared.manifest.contextSha256, manifestSha256: prepared.manifest.sha256, pins: [actualPath, setupReceiptPath, setup.seedPath, args.get('--actual-review'), args.get('--source-review'), seedPath, requestPath, contextPath].map(pin), providerCalls: 0, allowance: false, actualSetupOnly: true, expectedOutputInjected: false };
  writeFileSync(preparationPath, JSON.stringify(preparation, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ preparationPath, preparationSha256: sha(readFileSync(preparationPath)), requestBodySha256: preparation.requestBodySha256, providerCalls: 0, allowance: false }));
} else {
const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i]; assert(['--actual-review', '--source-review'].includes(key) && !args.has(key));
  args.set(key, process.argv[++i]); assert(args.get(key));
}
assert.equal(args.size, 2, 'two independent review artifacts are required');
const reviews = [...args.values()]; for (const path of reviews) assert(existsSync(path));
const build = '.extraction-canonical-correction-build', evidence = 'docs/implementation/evidence/';
const priorPath = evidence + 'S3-CANONICAL-DEVELOPMENT-CANDIDATE.json';
const prior = JSON.parse(readFileSync(priorPath));
assert.equal(prior.candidateSha256, '3a9ba4e6b72d4de10fc47c8eeeefcbf5bfdbc39bf315d4921d7b697ab62da6b9');
assert.equal(sha(JSON.stringify(prior.bindings)), prior.candidateSha256);
// Preserve the original source/emission identity despite a reviewed offline successor.
for (const entry of prior.bindings.files) {
  const retained = '.factory/private/af79-navigation-parity/original-source/' + entry.path;
  const path = existsSync(retained) ? retained : entry.path;
  assert.equal(sha(readFileSync(path)), entry.sha256, 'original candidate binding changed: ' + entry.path);
}
const actualPath = 'infra/cloud/.private/DO-AF79-CANONICAL.json';
const setupPath = 'infra/cloud/.private/canonical-development-d3-setup-20261010.json';
const settlementPath = 'infra/cloud/.private/DO-CANONICAL-DEVELOPMENT-20261010-A1-SETTLEMENT.json';
const settlement = JSON.parse(readFileSync(settlementPath));
for (const path of [actualPath, 'infra/cloud/.private/DO-AF79-PREFIX.json', evidence + 'DO-AF79.json']) {
  const binding = settlement.pins.find(entry => entry.path === path); assert(binding); assert.equal(sha(readFileSync(path)), binding.sha256);
}
const actual = JSON.parse(readFileSync(actualPath)); assert.equal(actual.candidateSha256, prior.candidateSha256);
const setup = JSON.parse(readFileSync(setupPath));
const op = actual.readback.savedDraft.adaptive.operations[setup.operationId], capture = op.stream.provisional;
assert.equal(op.status, 'applied'); assert.equal(op.stream.receipt.outcome, 'complete'); assert.equal(op.stream.receipt.providerExecution, 'completed');
assert.equal(capture.items.length, 2); assert.equal(capture.claims.length, 4); assert.equal(capture.closures.length, 0);
assert.equal(capture.gaps.length, 0); assert.equal(capture.accounting.remaining.length, 0);
assert.equal(actual.actualContext.source.id, op.sourceId);
const seedPath = 'infra/cloud/.private/canonical-development-d3-correction-20261010.json';
const requestPath = 'infra/cloud/.private/canonical-development-d3-correction-request-20261010.json';
const contextPath = 'infra/cloud/.private/canonical-development-d3-correction-context-20261010.json';
const candidatePath = evidence + 'S3-CANONICAL-CORRECTION-CANDIDATE.json';
assert(!existsSync(candidatePath), 'never replace an existing correction freeze');
const inputsBefore = [actualPath, setupPath, settlementPath].map(pin);
const seed = existsSync(seedPath) ? JSON.parse(readFileSync(seedPath)) : await fixture.createMedicationCorrectionSeed(structuredClone(setup), structuredClone(actual.readback));
assert.equal(seed.caseId, 'D3-CORRECTION');
const prepared = await fixture.prepareDevelopmentContext(structuredClone(seed));
assert.equal(prepared.context.source.channel, 'text');
assert.equal(prepared.context.displayed.topicId, 'Q08');
// The existing helper reselects Q08 through the normal API before accepting
// correction text. Freeze its actual opening prompt rather than substituting B02.
assert.equal(prepared.context.displayed.promptId, 'Q08');
for (const item of capture.items) assert(prepared.context.captureResponses.Q08.answers.medicines.items.some(saved => saved.id === item.id));
assert(prepared.context.sources.some(source => source.id === op.sourceId));
const config = { endpoint: 'https://inference.do-ai.run', model: 'qwen3.8-max', timeoutMs: 30000, maxOutputTokens: 2048, maxRequestBytes: 131072 };
const request = await stream.prepareDigitalOceanStreamRequest({ ...config, apiKey: 'offline-preflight-only', responseFormat: { type: 'json-schema', name: codec.sparseSchemaName, schema: prepared.manifest.jsonSchema } }, [...prepared.manifest.messages]);
const savedRequest = { caseId: seed.caseId, body: request.body, contextSha256: prepared.manifest.contextSha256, manifestSha256: prepared.manifest.sha256 };
for (const [path, value] of [[seedPath, seed], [requestPath, savedRequest], [contextPath, prepared.context]]) {
  if (!existsSync(path)) writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  assert.equal(sha(JSON.stringify(JSON.parse(readFileSync(path)))), sha(JSON.stringify(value)), 'existing correction input must match serialized value exactly');
}
for (const input of inputsBefore) assert.equal(sha(readFileSync(input.path)), input.sha256);
function files(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(dir + '/' + entry.name) : [dir + '/' + entry.name]).sort(); }
const pairs = files(build).filter(path => path.endsWith('.js')).map(emitted => {
  const source = relative(resolve(build), resolve(emitted)).replace(/\.js$/, '.ts');
  assert(existsSync(source)); return { source, sourceSha256: sha(readFileSync(source)), emitted, emittedSha256: sha(readFileSync(emitted)) };
});
const extractionCandidateSha256 = sha(JSON.stringify(pairs));
const input = { caseId: seed.caseId, seedPath, requestPath, contextPath, requestBodySha256: sha(request.body), requestBytes: request.requestBytes, contextSha256: prepared.manifest.contextSha256, manifestSha256: prepared.manifest.sha256, displayed: prepared.context.displayed, channel: prepared.context.source.channel, nativeDefinition: prepared.manifest.nativeDefinition };
const runtimePath = prior.bindings.runtimePath;
const paths = [...pairs.flatMap(pair => [pair.source, pair.emitted]), ...[seedPath, requestPath, contextPath, priorPath, actualPath, setupPath, settlementPath, 'infra/cloud/.private/DO-AF79-PREFIX.json', evidence + 'DO-AF79.json', ...reviews, evidence + 'S3-AF79-NAVIGATION-PARITY-REPAIR.md', '.factory/private/af79-navigation-parity/REPAIR-PINS.json', 'scripts/qualification/prepare-canonical-correction.mjs', 'scripts/qualification/adaptive-full-reservation.mjs', 'scripts/qualification/qualify-extraction-flash-low.mjs', 'tsconfig.extraction-canonical-correction.json', 'tsconfig.foundation.json', 'packages/clinic-api/test/adaptive-extraction-sparse-route.test.ts']];
const bindings = { schema: 1, extractionCandidateSha256, runtimePath, runtimeSha256: sha(readFileSync(runtimePath)), dependencyInventorySha256: prior.bindings.dependencyInventorySha256, operations: [{ id: 'DO-AF85', caseId: seed.caseId, maximumOutputTokens: 2048, maximumCalls: 1, timeoutMs: 30000, creditsCap: 1, cashCap: 0 }], inputs: [input], pairs, files: [...new Set(paths)].map(pin), predecessorCandidateSha256: prior.candidateSha256, actualSetup: { operationId: setup.operationId, sourceId: op.sourceId, items: capture.items.map(item => ({ id: item.id, entity: item.entity })) }, originalAF79NavigationFailurePreserved: true, qualifiedOptionsInjected: false, providerCalls: 0, allowance: false, semanticQualification: false, hostedAcceptance: false, nativeEndToEndAcceptance: false, holdoutRead: false, defaultEnabled: false };
const candidate = { schema: 1, candidateSha256: sha(JSON.stringify(bindings)), extractionCandidateSha256, bindings };
writeFileSync(candidatePath, JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ candidateSha256: candidate.candidateSha256, extractionCandidateSha256, pairs: pairs.length, files: bindings.files.length, input, actualSetup: bindings.actualSetup, providerCalls: 0, allowance: false }));

}
