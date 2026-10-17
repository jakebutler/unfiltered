/** AF75 only. Actual API interpretation over synthetic/mock FHIR; offline by default. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadEnvFile } from 'node:process';
import { validateFullDevelopmentAllocation } from './adaptive-full-reservation.mjs';
import { verifyPins, verifyInstalledRuntimeDependencies, oneOperationFetch } from './qualify-extraction-flash-low.mjs';
const sha = b => createHash('sha256').update(b).digest('hex');
const evidence = 'docs/implementation/evidence/', candidatePath = evidence + 'S3-SPARSE-CANONICAL-QWEN-LIVE.json';
export const operation = { id: 'DO-AF75', caseId: 'CANONICAL-GOALS', maximumOutputTokens: 2048 };
export function validateCanonicalAllocation(raw, preflight, now = Date.now()) {
  assert.equal(raw.operations?.length, 1); assert.equal(raw.creditsCap, 1); assert.equal(raw.operations[0].creditsCap, 1);
  assert(Date.parse(raw.expiresAt) - Date.parse(raw.issuedAt) <= 3600000);
  return validateFullDevelopmentAllocation(raw, preflight, now);
}
function privateFile(path, max) {
  assert(path && isAbsolute(path)); const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && realpathSync(path) === path && stat.size <= max && !(stat.mode & 0o077));
}
function verifyCandidate() {
  const candidate = JSON.parse(readFileSync(candidatePath));
  assert.equal(candidate.candidateSha256, sha(JSON.stringify(candidate.bindings))); verifyPins(candidate.bindings.files);
  assert.deepEqual(candidate.bindings.operation, { ...operation, maximumCalls: 1, timeoutMs: 30000, creditsCap: 1, cashCap: 0 });
  verifyPins([{ path: candidate.bindings.runtimePath, sha256: candidate.bindings.runtimeSha256 }]);
  const runtime = JSON.parse(readFileSync(candidate.bindings.runtimePath));
  assert.equal(runtime.inventories['DEPENDENCIES-MANIFEST.json'].sha256, candidate.bindings.dependencyInventorySha256);
  verifyInstalledRuntimeDependencies(readFileSync(resolve(candidate.bindings.runtimePath, '../DEPENDENCIES-MANIFEST.json')), candidate.bindings.dependencyInventorySha256, resolve('.'));
  const emittedRequire = createRequire(resolve('.extraction-canonical-build/packages/clinical-core/src/digitalocean.js'));
  for (const name of ['zod', 'ws']) assert(emittedRequire.resolve(name).startsWith(resolve('node_modules', name) + '/'));
  return candidate;
}
export async function canonicalPreflight() {
  const candidate = verifyCandidate();
  privateFile(resolve(candidate.bindings.seedPath), 64000);
  const seed = JSON.parse(readFileSync(candidate.bindings.seedPath)), request = JSON.parse(readFileSync(candidate.bindings.requestPath));
  const [fixture, codec, provider, stream] = await Promise.all([import('../../.extraction-canonical-build/scripts/qualification/fixtures/adaptive-canonical-goals.js'), import('../../.extraction-canonical-build/packages/clinic-api/src/adaptive-extraction-sparse.js'), import('../../.extraction-canonical-build/packages/clinic-api/src/adaptive-extraction-sparse-provider.js'), import('../../.extraction-canonical-build/packages/clinical-core/src/digitalocean-stream.js')]);
  const prepared = await fixture.prepareCanonicalContext(seed), config = { endpoint: 'https://inference.do-ai.run', model: 'qwen3.8-max', timeoutMs: 30000, maxOutputTokens: 2048, maxRequestBytes: 131072 };
  const body = await stream.prepareDigitalOceanStreamRequest({ ...config, apiKey: 'offline-preflight-only', responseFormat: { type: 'json-schema', name: codec.sparseSchemaName, schema: prepared.manifest.jsonSchema } }, [...prepared.manifest.messages]);
  assert.equal(body.body, request.body); assert.equal(sha(body.body), candidate.bindings.requestBodySha256); assert.equal(prepared.manifest.contextSha256, request.contextSha256); assert.equal(prepared.manifest.sha256, request.manifestSha256);
  const preflight = { ...operation, developmentCaseIds: ['CANONICAL-GOALS'], candidateSha256: candidate.candidateSha256, extractionCandidateSha256: candidate.extractionCandidateSha256, model: config.model, reasoningEffortSent: null, reasoningControlHonored: false, requestBodySha256: sha(body.body), requestBytes: body.requestBytes, manifestSha256: prepared.manifest.sha256, contextSha256: prepared.manifest.contextSha256, nativeDefinition: prepared.manifest.nativeDefinition, timeoutMs: 30000, maximumCalls: 1, creditsCap: 1, cashCap: 0, expectedNextTopicId: 'Q02', setup: 'real-handler-synthetic-mock-FHIR', providerCalls: 0, allowance: false, hostedAcceptance: false, nativeEndToEndAcceptance: false, semanticQualification: false, holdoutRead: false, defaultEnabled: false };
  return { candidate, seed, request, prepared, config, fixture, codec, provider, stream, preflight };
}
async function main() {
  const args = new Map(), allowed = new Set(['--live', '--reservation', '--env', '--review']);
  for (let i = 2; i < process.argv.length; i++) { const key = process.argv[i]; assert(allowed.has(key) && !args.has(key)); args.set(key, key === '--live' ? true : process.argv[++i]); assert(args.get(key)); }
  assert.equal(resolve(process.cwd()), resolve(fileURLToPath(new URL('../../', import.meta.url))));
  const live = args.has('--live'); assert(live ? args.size === 4 : args.size === 0);
  const p = await canonicalPreflight();
  if (!live) { console.log(JSON.stringify(p.preflight)); return; }
  privateFile(args.get('--reservation'), 16384); const allocation = JSON.parse(readFileSync(args.get('--reservation'))), reservation = validateCanonicalAllocation(allocation, p.preflight);
  privateFile(args.get('--review'), 8192); const reviewBytes = readFileSync(args.get('--review')), reviewSha256 = sha(reviewBytes), review = JSON.parse(reviewBytes);
  assert.deepEqual(Object.keys(review).sort(), ['candidateSha256', 'decision', 'extractionCandidateSha256', 'harnessSha256', 'reviewer', 'schema']);
  assert.equal(review.schema, 1); assert.equal(review.decision, 'accepted-for-root-allocation'); assert.equal(review.reviewer, 'sol_native_questionnaire_review');
  assert.equal(review.candidateSha256, p.candidate.candidateSha256); assert.equal(review.extractionCandidateSha256, p.candidate.extractionCandidateSha256); assert.equal(review.harnessSha256, sha(readFileSync(fileURLToPath(import.meta.url))));
  const ledger = readFileSync('/Volumes/rexy/GitHub/unfiltered/docs/rebuild/USAGE-LEDGER.md', 'utf8').split('\n').filter(r => r.startsWith('| ' + allocation.allocationId + ' /'));
  assert.equal(ledger.length, 1); for (const required of ['AF75', allocation.candidateSha256, allocation.expiresAt, 'existing-credit', 'cash0']) assert(ledger[0].includes(required));
  const prefix = evidence + operation.id, privatePrefix = resolve('infra/cloud/.private/' + operation.id);
  for (const path of [prefix + '-INTENT.json', prefix + '.json', privatePrefix + '-CANONICAL.json', privatePrefix + '-PREFIX.json']) assert(!existsSync(path), 'never retry prior intent/output');
  assert.equal(args.get('--env'), '/Volumes/rexy/GitHub/unfiltered/.env.local'); privateFile(args.get('--env'), 65536);
  // Action-time source, review, allowance and exact request checks precede secrets.
  verifyCandidate(); validateCanonicalAllocation(JSON.parse(readFileSync(args.get('--reservation'))), p.preflight);
  assert.equal(sha(readFileSync(args.get('--review'))), reviewSha256, 'review bytes changed');
  loadEnvFile(args.get('--env')); const apiKey = process.env.DIGITALOCEAN_MODEL_ACCESS_KEY || process.env.DIGITALOCEAN_MODEL_ACESS_KEY; assert(apiKey);
  writeFileSync(prefix + '-INTENT.json', JSON.stringify({ ...p.preflight, state: 'dispatch-intent', at: new Date().toISOString(), reservation, reviewSha256: sha(readFileSync(args.get('--review'))) }, null, 2) + '\n', { flag: 'wx' });
  const one = oneOperationFetch(fetch, p.preflight.requestBodySha256); let partial = '', actualContext;
  const extractor = p.provider.sparseExtractionProposer({ ...p.config, apiKey }, config => ({ async generate(messages, options) {
    return p.stream.digitalOceanStream(config, async (url, init) => { verifyCandidate(); validateCanonicalAllocation(JSON.parse(readFileSync(args.get('--reservation'))), p.preflight); assert.equal(sha(readFileSync(args.get('--review'))), reviewSha256); return one.fetcher(url, init); }, () => performance.now(), p.stream.fullStreamLimits(2048)).generate(messages, { ...options, onContent: async text => { partial += text; await options.onContent(text); } });
  } }));
  let readback, errorCode;
  try { readback = await p.fixture.interpretCanonicalSeed(p.seed, { async extract(context, manifest, options) {
    actualContext = context; const issued = await p.codec.createSparseManifest(context, manifest); assert.equal(issued.contextSha256, p.preflight.contextSha256); assert.equal(issued.sha256, p.preflight.manifestSha256);
    return extractor.extract(context, manifest, options);
  } }); } catch { errorCode = 'canonical-route-failed'; }
  writeFileSync(privatePrefix + '-PREFIX.json', JSON.stringify({ id: operation.id, candidateSha256: p.candidate.candidateSha256, partial }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  writeFileSync(privatePrefix + '-CANONICAL.json', JSON.stringify({ id: operation.id, candidateSha256: p.candidate.candidateSha256, actualContext, readback, errorCode }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const op = readback?.savedDraft?.adaptive?.operations[p.seed.operationId], question = readback?.savedDraft?.adaptive?.exchange?.prompt;
  const receipt = { ...p.preflight, state: op?.status === 'applied' ? 'saved-awaiting-independent-semantic-review' : 'qualification-failed', callCount: one.count(), providerReceipt: op?.stream?.receipt ?? { outcome: 'unknown', providerExecution: 'unknown', usage: 'unknown' }, errorCode: errorCode ?? op?.errorCode, apiStatus: readback?.httpStatus, operationStatus: op?.status, captureStatus: op?.stream?.capture, captureClaims: op?.stream?.provisional?.claims.length ?? 0, proposedGaps: op?.stream?.provisional?.gaps ?? [], nextQuestion: question, observedExpectedQ02: Boolean(op?.status === 'applied' && op?.stream?.reply === 'saved' && question?.topicId === 'Q02'), observedTwoQ01ClaimsAndQ02Navigation: Boolean(op?.stream?.provisional?.claims.filter(c => c.topicId === 'Q01').length === 2 && question?.topicId === 'Q02'), rawPrefixSha256: sha(readFileSync(privatePrefix + '-PREFIX.json')), privateReadbackSha256: sha(readFileSync(privatePrefix + '-CANONICAL.json')), reservation: { ...reservation, consumed: one.count() > 0, refund: false }, semanticQualification: false, latencyQualified: false, observedResultRequiresHumanSemanticReview: true, note: 'One canonical API interpretation over synthetic/mock FHIR. No retry/fallback, hosted/native delivery acceptance or voice-complete acceptance.' };
  writeFileSync(prefix + '.json', JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ id: operation.id, state: receipt.state, callCount: one.count(), observedExpectedQ02: receipt.observedExpectedQ02, receipt: prefix + '.json', semanticQualification: false }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('Canonical qualification blocked or failed. Preserve intent/receipt and unknown charge; never retry.'); process.exitCode = 1; });
