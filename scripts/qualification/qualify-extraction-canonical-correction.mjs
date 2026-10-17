/** AF85 dependent correction only. Offline by default; frozen actual AF79 state, no setup replay or retry. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadEnvFile } from 'node:process';
import { validateFocusedProviderSchema } from './qualify-extraction-canonical-development.mjs';
import { validateFullDevelopmentAllocation } from './adaptive-full-reservation.mjs';
import { verifyPins, verifyInstalledRuntimeDependencies, oneOperationFetch } from './qualify-extraction-flash-low.mjs';
const sha = b => createHash('sha256').update(b).digest('hex');
const evidence = 'docs/implementation/evidence/', candidatePath = evidence + 'S3-CANONICAL-CORRECTION-CANDIDATE.json';
export const operations = [{ id: 'DO-AF85', caseId: 'D3-CORRECTION', maximumOutputTokens: 2048 }];
const v4CandidatePath = evidence + 'S3-CANONICAL-V4-CANDIDATE.json';
const v5CandidatePath = evidence + 'S3-CANONICAL-V5-CANDIDATE.json';
const v6CandidatePath = evidence + 'S3-CANONICAL-V6-CANDIDATE.json';
const v6PreparationPath = 'infra/cloud/.private/canonical-v6-development-d3-correction-PREPARATION.json';
const v5QwenCandidatePath = evidence + 'S3-CANONICAL-V5-QWEN-CANDIDATE.json';
const v5QwenPreparationPath = 'infra/cloud/.private/canonical-v5-qwen-development-d3-correction-PREPARATION.json';
const v5PreparationPath = 'infra/cloud/.private/canonical-v5-development-d3-correction-PREPARATION.json';
const v4PreparationPath = 'infra/cloud/.private/canonical-v4-development-d3-correction-PREPARATION.json';
export const typedCandidatePath = evidence + 'S3-CANONICAL-TYPED-CANDIDATE.json';
export const typedQwenCandidatePath = evidence + 'S3-CANONICAL-TYPED-QWEN-CANDIDATE.json';
function batchIdentity(path) {
  if (path === typedQwenCandidatePath) return { typed: true, operations: [{ id: 'DO-AF179', caseId: 'D3-CORRECTION', maximumOutputTokens: 4096 }], config: { endpoint: 'https://inference.do-ai.run', model: 'qwen3.8-max', timeoutMs: 30000, maxOutputTokens: 4096, maxRequestBytes: 128000 }, build: '.extraction-canonical-development-typed-build', label: 'S3-CANONICAL-TYPED-QWEN-', preparationPath: 'infra/cloud/.private/canonical-typed-qwen-development-d3-correction-PREPARATION.json', setupId: 'DO-AF173' };

  if (path === typedCandidatePath) return { typed: true, operations: [{ id: 'DO-AF170', caseId: 'D3-CORRECTION', maximumOutputTokens: 4096 }], config: { endpoint: 'https://inference.do-ai.run', model: 'glm-5.3', timeoutMs: 30000, maxOutputTokens: 4096, maxRequestBytes: 128000 }, build: '.extraction-canonical-development-typed-build', label: 'S3-CANONICAL-TYPED-', preparationPath: 'infra/cloud/.private/canonical-typed-development-d3-correction-PREPARATION.json', setupId: 'DO-AF164' };

  assert([candidatePath, v4CandidatePath, v5CandidatePath, v5QwenCandidatePath, v6CandidatePath, typedCandidatePath, typedQwenCandidatePath].includes(path));
  if (path === v6CandidatePath) return { operations: [{ id: 'DO-AF129', caseId: 'D3-CORRECTION', maximumOutputTokens: 4096 }], config: { endpoint: 'https://inference.do-ai.run', model: 'glm-5.3', timeoutMs: 30000, maxOutputTokens: 4096, maxRequestBytes: 128000 }, build: '.extraction-canonical-development-v6-build', preparationPath: v6PreparationPath, setupId: 'DO-AF123', label: 'S3-CANONICAL-V6-' };
  if (path === v5QwenCandidatePath) return { operations: [{ id: 'DO-AF112', caseId: 'D3-CORRECTION', maximumOutputTokens: 4096 }], config: { endpoint: 'https://inference.do-ai.run', model: 'qwen3.8-max', timeoutMs: 30000, maxOutputTokens: 4096, maxRequestBytes: 128000 }, build: '.extraction-canonical-development-v5-build', preparationPath: v5QwenPreparationPath, setupId: 'DO-AF106', label: 'S3-CANONICAL-V5-QWEN-' };
  if (path === v5CandidatePath) return { operations: [{ id: 'DO-AF103', caseId: 'D3-CORRECTION', maximumOutputTokens: 4096 }], config: { endpoint: 'https://inference.do-ai.run', model: 'glm-5.3', timeoutMs: 30000, maxOutputTokens: 4096, maxRequestBytes: 128000 }, build: '.extraction-canonical-development-v5-build', preparationPath: v5PreparationPath, setupId: 'DO-AF97', label: 'S3-CANONICAL-V5-' };
  return path === v4CandidatePath ? { operations: [{ id: 'DO-AF94', caseId: 'D3-CORRECTION', maximumOutputTokens: 4096 }], config: { endpoint: 'https://inference.do-ai.run', model: 'glm-5.3', timeoutMs: 30000, maxOutputTokens: 4096, maxRequestBytes: 131072 }, build: '.extraction-canonical-development-v4-build', preparationPath: v4PreparationPath, setupId: 'DO-AF88', label: 'S3-CANONICAL-V4-' } : { operations, config: { endpoint: 'https://inference.do-ai.run', model: 'qwen3.8-max', timeoutMs: 30000, maxOutputTokens: 2048, maxRequestBytes: 131072 }, build: '.extraction-canonical-correction-build' };
}
export function validateDevelopmentAllocation(raw, preflights, now = Date.now()) {
  assert.equal(preflights.length, 1); assert.equal(raw.operations?.length, 1); assert.equal(raw.creditsCap, 1);
  assert(Date.parse(raw.expiresAt) - Date.parse(raw.issuedAt) <= 3600000);
  return preflights.map((p, i) => { assert.equal(raw.operations[i].id, p.id); assert.equal(raw.operations[i].caseId, p.caseId); assert.equal(raw.operations[i].creditsCap, 1); return validateFullDevelopmentAllocation(raw, p, now); });
}
/** Complete provider outputs may fail schema/semantics without suppressing the
 * independent controls. Unknown/incomplete execution or authority loss stops. */
export async function runDevelopmentBatch(entries, execute) {
  const results = []; let stopped = false;
  for (const entry of entries) {
    if (stopped) { const op = entry.preflight ?? entry; results.push({ id: op.id, caseId: op.caseId, state: 'not-dispatched-after-infrastructure-or-authority-failure', callCount: 0 }); continue; }
    const result = await execute(entry); results.push(result); if (result.stopIndependentCases) stopped = true;
  }
  return results;
}
function privateFile(path, max) {
  assert(path && isAbsolute(path)); const stat = lstatSync(path); assert(stat.isFile() && !stat.isSymbolicLink() && realpathSync(path) === path && stat.size <= max && !(stat.mode & 0o077));
}
export function verifyCandidate(path = candidatePath) {
  const identity = batchIdentity(path);
  const candidate = JSON.parse(readFileSync(path));
  assert.equal(candidate.candidateSha256, sha(JSON.stringify(candidate.bindings))); const sourcePaths = new Set(candidate.bindings.pairs.map(pair => pair.source));
  verifyPins(candidate.bindings.files.map(entry => path !== candidatePath ? entry : sourcePaths.has(entry.path) ? { ...entry, path: '.factory/private/af85-source/' + entry.path } : entry));
  if (path !== candidatePath) {
    assert.deepEqual(candidate.bindings.config, identity.config); const recipe = candidate.bindings.conditionalCorrection;
    assert.equal(recipe.id, identity.operations[0].id); assert.equal(recipe.setupId, identity.setupId); assert.equal(recipe.maximumCalls, 1); assert.equal(recipe.maximumOutputTokens, 4096);
  } else assert.deepEqual(candidate.bindings.operations, operations.map(o => ({ ...o, maximumCalls: 1, timeoutMs: 30000, creditsCap: 1, cashCap: 0 })));
  verifyPins([{ path: candidate.bindings.runtimePath, sha256: candidate.bindings.runtimeSha256 }]);
  const runtime = JSON.parse(readFileSync(candidate.bindings.runtimePath)); assert.equal(runtime.inventories['DEPENDENCIES-MANIFEST.json'].sha256, candidate.bindings.dependencyInventorySha256);
  verifyInstalledRuntimeDependencies(readFileSync(resolve(candidate.bindings.runtimePath, '../DEPENDENCIES-MANIFEST.json')), candidate.bindings.dependencyInventorySha256, resolve('.'));
  const emittedRequire = createRequire(resolve(identity.build + '/packages/clinical-core/src/digitalocean.js'));
  for (const name of ['zod', 'ws']) assert(emittedRequire.resolve(name).startsWith(resolve('node_modules', name) + '/'));
  return candidate;
}
export async function developmentPreflight(path = candidatePath) {
  const identity = batchIdentity(path), candidate = verifyCandidate(path);
  const [fixture, codec, provider, stream] = await Promise.all(['scripts/qualification/fixtures/adaptive-canonical-development.js', identity.typed ? 'packages/clinic-api/src/adaptive-extraction-typed.js' : 'packages/clinic-api/src/adaptive-extraction-sparse.js', identity.typed ? 'packages/clinic-api/src/adaptive-extraction-typed.js' : 'packages/clinic-api/src/adaptive-extraction-sparse-provider.js', 'packages/clinical-core/src/digitalocean-stream.js'].map(file => import(new URL('../../' + identity.build + '/' + file, import.meta.url))));
  const entries = [], config = identity.config, preparation = path !== candidatePath ? JSON.parse(readFileSync(identity.preparationPath)) : undefined;
  if (preparation) { assert.equal(preparation.candidateSha256, candidate.candidateSha256); verifyPins(preparation.pins); }
  for (const op of identity.operations) {
    const pinned = preparation ?? candidate.bindings.inputs.find(p => p.caseId === op.caseId); assert(pinned); privateFile(resolve(pinned.seedPath), 128000);
    const seed = JSON.parse(readFileSync(pinned.seedPath)), request = JSON.parse(readFileSync(pinned.requestPath)); assert.equal(seed.caseId, op.caseId);
    const prepared = await (identity.typed ? fixture.prepareTypedDevelopmentContext : fixture.prepareDevelopmentContext)(seed);
    if (identity.typed) validateFocusedProviderSchema(prepared.manifest.jsonSchema);
    const body = await stream.prepareDigitalOceanStreamRequest({ ...config, apiKey: 'offline-preflight-only', responseFormat: { type: 'json-schema', name: identity.typed ? 'turn_bound_typed_v1' : codec.sparseSchemaName, schema: prepared.manifest.jsonSchema } }, [...prepared.manifest.messages]);
    assert.equal(body.body, request.body); assert.equal(sha(body.body), pinned.requestBodySha256); assert.equal(prepared.manifest.contextSha256, request.contextSha256); assert.equal(prepared.manifest.sha256, request.manifestSha256);
    const preflight = { ...op, developmentCaseIds: identity.operations.map(o => o.caseId), candidateSha256: candidate.candidateSha256, extractionCandidateSha256: candidate.extractionCandidateSha256, model: config.model, reasoningEffortSent: config.model === 'glm-5.3' ? 'low' : null, requestBodySha256: sha(body.body), requestBytes: body.requestBytes, manifestSha256: prepared.manifest.sha256, contextSha256: prepared.manifest.contextSha256, nativeDefinition: prepared.manifest.nativeDefinition, timeoutMs: 30000, maximumCalls: 1, creditsCap: 1, cashCap: 0, setup: 'real-handler-synthetic-mock-FHIR', providerCalls: 0, allowance: false, semanticQualification: false, hostedAcceptance: false, nativeEndToEndAcceptance: false, holdoutRead: false, defaultEnabled: false };
    entries.push({ seed, prepared, preflight });
  }
  return { candidate, entries, config, fixture, codec, provider, stream, identity, path, preparation };
}
async function main() {
  const args = new Map(), allowed = new Set(['--live', '--reservation', '--env', '--review', '--candidate']);
  for (let i = 2; i < process.argv.length; i++) { const key = process.argv[i]; assert(allowed.has(key) && !args.has(key)); args.set(key, key === '--live' ? true : process.argv[++i]); assert(args.get(key)); }
  assert.equal(resolve(process.cwd()), resolve(fileURLToPath(new URL('../../', import.meta.url)))); const live = args.has('--live'); assert(live ? args.size === (args.has('--candidate') ? 5 : 4) : args.size === (args.has('--candidate') ? 1 : 0));
  const p = await developmentPreflight(args.get('--candidate') ?? candidatePath), summaries = p.entries.map(e => e.preflight);
  if (!live) { console.log(JSON.stringify({ state: 'offline-preflight-only', operations: summaries, maximumCalls: 1, creditsCap: 1, cashCap: 0, callCount: 0, allowance: false })); return; }
  privateFile(args.get('--reservation'), 16384); const allocation = JSON.parse(readFileSync(args.get('--reservation'))); let reservations = validateDevelopmentAllocation(allocation, summaries);
  privateFile(args.get('--review'), 8192); const reviewBytes = readFileSync(args.get('--review')), reviewSha256 = sha(reviewBytes), review = JSON.parse(reviewBytes);
  assert.deepEqual(Object.keys(review).sort(), ['candidateSha256', 'decision', 'extractionCandidateSha256', 'harnessSha256', 'reviewer', 'schema', ...(p.preparation ? ['preparationSha256', 'requestBodySha256'] : [])].sort());
  if (p.preparation) { assert.equal(review.preparationSha256, sha(readFileSync(p.identity.preparationPath))); assert.equal(review.requestBodySha256, summaries[0].requestBodySha256); }
  assert.equal(review.schema, 1); assert.equal(review.decision, 'accepted-for-root-allocation'); assert.equal(review.reviewer, 'sol_native_questionnaire_review'); assert.equal(review.candidateSha256, p.candidate.candidateSha256); assert.equal(review.extractionCandidateSha256, p.candidate.extractionCandidateSha256); assert.equal(review.harnessSha256, sha(readFileSync(fileURLToPath(import.meta.url))));
  const ledger = readFileSync('/Volumes/rexy/GitHub/unfiltered/docs/rebuild/USAGE-LEDGER.md', 'utf8').split('\n').filter(r => r.startsWith('| ' + allocation.allocationId + ' /')); assert.equal(ledger.length, 1);
  for (const required of [...p.identity.operations.map(o => o.id.replace('DO-', '')), allocation.candidateSha256, allocation.expiresAt, 'existing-credit', 'cash0']) assert(ledger[0].includes(required));
  const batchPath = evidence + (p.preparation ? p.identity.label : 'S3-CANONICAL-CORRECTION-') + p.candidate.candidateSha256 + '-BATCH.json';
  const combined = p.preparation ? JSON.parse(readFileSync(batchPath)) : undefined;
  if (combined) { assert.equal(combined.candidateSha256, p.candidate.candidateSha256); assert.equal(combined.conditionalCorrection.state, 'awaiting-independent-actual-setup-and-exact-body-review'); assert.equal(combined.conditionalCorrection.callCount, 0); assert.equal(combined.operations.length, 8); } else assert(!existsSync(batchPath));
  for (const o of p.identity.operations) for (const path of [evidence + o.id + '-INTENT.json', evidence + o.id + '.json', resolve('infra/cloud/.private/' + o.id + '-CANONICAL.json'), resolve('infra/cloud/.private/' + o.id + '-PREFIX.json')]) assert(!existsSync(path), 'never retry an issued operation');
  assert.equal(args.get('--env'), '/Volumes/rexy/GitHub/unfiltered/.env.local'); privateFile(args.get('--env'), 65536);
  const revalidate = () => { verifyCandidate(p.path); if (p.preparation) { verifyPins(p.preparation.pins); assert.equal(sha(readFileSync(p.identity.preparationPath)), review.preparationSha256); } reservations = validateDevelopmentAllocation(JSON.parse(readFileSync(args.get('--reservation'))), summaries); assert.equal(sha(readFileSync(args.get('--review'))), reviewSha256); };
  revalidate(); loadEnvFile(args.get('--env')); const apiKey = process.env.DIGITALOCEAN_MODEL_ACCESS_KEY || process.env.DIGITALOCEAN_MODEL_ACESS_KEY; assert(apiKey);
  const results = await runDevelopmentBatch(p.entries, async entry => {
    const preflight = entry.preflight; revalidate(); const reservation = reservations.find(r => r.selected.id === preflight.id), prefix = evidence + preflight.id, privatePrefix = resolve('infra/cloud/.private/' + preflight.id);
    writeFileSync(prefix + '-INTENT.json', JSON.stringify({ ...preflight, state: 'dispatch-intent', at: new Date().toISOString(), reservation, reviewSha256 }, null, 2) + '\n', { flag: 'wx' });
    const one = oneOperationFetch(fetch, preflight.requestBodySha256); let partial = '', actualContext, readback, errorCode; const interpretationStarted = performance.now();
    const extractor = (p.identity.typed ? p.provider.typedTurnProposer : p.provider.sparseExtractionProposer)({ ...p.config, apiKey }, config => ({ async generate(messages, options) {
      return p.stream.digitalOceanStream(config, async (url, init) => { revalidate(); return one.fetcher(url, init); }, () => performance.now(), p.stream.fullStreamLimits(preflight.maximumOutputTokens)).generate(messages, { ...options, onContent: async text => { partial += text; await options.onContent(text); } });
    } }));
    try { readback = await p.fixture.interpretDevelopmentSeed(entry.seed, { async extract(context, manifest, options) {
      actualContext = context; const issued = p.identity.typed ? p.codec.createTypedTurnManifest(context) : await p.codec.createSparseManifest(context, manifest); if (!p.identity.typed) assert.equal(issued.contextSha256, preflight.contextSha256); else assert.equal(p.fixture.typedContextSha(context), preflight.contextSha256); assert.equal(issued.sha256, preflight.manifestSha256); return extractor.extract(context, manifest, options);
    } }, undefined, p.identity.typed ? 30000 : undefined); } catch { errorCode = 'canonical-route-failed'; }
    writeFileSync(privatePrefix + '-PREFIX.json', JSON.stringify({ id: preflight.id, candidateSha256: p.candidate.candidateSha256, partial }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    writeFileSync(privatePrefix + '-CANONICAL.json', JSON.stringify({ id: preflight.id, candidateSha256: p.candidate.candidateSha256, actualContext, readback, errorCode }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const interpretToSavedAndResumeMs = performance.now() - interpretationStarted;
    const op = readback?.savedDraft?.adaptive?.operations[entry.seed.operationId], question = readback?.savedDraft?.adaptive?.exchange?.prompt, receipt = op?.stream?.receipt ?? { outcome: 'unknown', providerExecution: 'unknown', usage: 'unknown' };
    const stopIndependentCases = Boolean(errorCode || readback?.httpStatus !== 200 || readback?.resumeHttpStatus !== 200 || readback?.identityHttpStatus !== 200 || receipt.outcome !== 'complete' || receipt.providerExecution !== 'completed' || one.count() !== 1);
    const result = { ...preflight, interpretToSavedAndResumeMs, timingBoundary: 'interpret request through saved result and restart/identity resume; accepted seed predates timing; not browser p95', state: op?.status === 'applied' ? 'saved-awaiting-independent-semantic-review' : 'qualification-failed', callCount: one.count(), providerReceipt: receipt, errorCode: errorCode ?? op?.errorCode, apiStatus: readback?.httpStatus, resumeHttpStatus: readback?.resumeHttpStatus, identityHttpStatus: readback?.identityHttpStatus, operationStatus: op?.status, captureStatus: op?.stream?.capture, captureClaims: op?.stream?.provisional?.claims.length ?? 0, proposedGaps: op?.stream?.provisional?.gaps ?? [], nextQuestion: question, resumedPrompt: readback?.resumedView?.currentPrompt, rawPrefixSha256: sha(readFileSync(privatePrefix + '-PREFIX.json')), privateReadbackSha256: sha(readFileSync(privatePrefix + '-CANONICAL.json')), stopIndependentCases, reservation: { ...reservation, consumed: one.count() > 0, refund: false }, semanticQualification: false, latencyQualified: false, observedResultRequiresHumanSemanticReview: true, note: 'Complete schema/semantic failures do not suppress independent controls. No retry, automatic correction, injected expected prior facts, hosted acceptance or activation.' };
    writeFileSync(prefix + '.json', JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ id: result.id, state: result.state, callCount: result.callCount, stopIndependentCases, receipt: prefix + '.json' }));
    return result;
  });
  if (combined) { combined.conditionalCorrection = results[0]; combined.operations.push({ id: results[0].id, caseId: results[0].caseId, state: results[0].state, callCount: results[0].callCount, stopIndependentCases: results[0].stopIndependentCases }); combined.callCount += results[0].callCount; combined.state = 'closed-awaiting-independent-semantics'; writeFileSync(batchPath, JSON.stringify(combined, null, 2) + '\n'); }
  else writeFileSync(batchPath, JSON.stringify({ schema: 1, candidateSha256: p.candidate.candidateSha256, operations: results.map(r => ({ id: r.id, caseId: r.caseId, state: r.state, callCount: r.callCount, stopIndependentCases: r.stopIndependentCases ?? false })), callCount: results.reduce((n, r) => n + r.callCount, 0), cashCap: 0, semanticQualification: false, holdoutRead: false, defaultEnabled: false, correctionAutomaticallyDispatched: false }, null, 2) + '\n', { flag: 'wx' });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('Dependent correction qualification blocked or failed. Preserve intents/receipts and unknown charges; never retry.'); process.exitCode = 1; });
