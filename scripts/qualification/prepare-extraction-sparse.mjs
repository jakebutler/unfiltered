/** Offline authored evidence + hash-only pins. No live mode or credentials. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { canonicalJson } from '../../.extraction-sparse-build/packages/clinical-core/src/domain.js';
import { prepareDigitalOceanStreamRequest } from '../../.extraction-sparse-build/packages/clinical-core/src/digitalocean-stream.js';
import { createFullReplyManifest } from '../../.extraction-sparse-build/packages/clinic-api/src/adaptive-reply-full.js';
import { createDomainManifest, decodeDomainDraft } from '../../.extraction-sparse-build/packages/clinic-api/src/adaptive-reply-domain.js';
import { createGroupedExtractionManifest, encodeGroupedExtraction } from '../../.extraction-sparse-build/packages/clinic-api/src/adaptive-extraction-grouped-v2.js';
import { createSparseManifest, encodeSparseExtraction, decodeSparseExtraction, sparseOutputBudget, sparseSchemaName } from '../../.extraction-sparse-build/scripts/qualification/extraction-sparse-manifest.js';
import { sparseCaseContext, sparseCaseReadback } from '../../.extraction-sparse-build/scripts/qualification/fixtures/adaptive-extraction-sparse-readback.js';
import { groupedRepresentativeDraft } from '../../.extraction-sparse-build/scripts/qualification/fixtures/adaptive-extraction-grouped-v2-cases.js';
assert.equal(process.argv.length, 2, 'offline-only preparation');
const sha = value => createHash('sha256').update(value).digest('hex');
const runtimePath = '.factory/private/native-questionnaire-integration/runtime-2026-10-10-q4f/MANIFEST.json';
assert.equal(sha(readFileSync(runtimePath)), 'e0212437c9f6923e7d4cc2fe3b630a63baa26712c728db763181213840db3996');
assert.equal(sha(readFileSync('packages/clinical-core/src/digitalocean.ts')), '0e40777c1c04ca3a4c8b3dee00240e5242ac4a1027028a89dd9257be2e47403e');
const build = '.extraction-sparse-build', pairs = readdirSync(build, { recursive: true }).filter(p => /\.(js|mjs)$/.test(p)).sort().map(path => {
  const source = path.endsWith('.mjs') ? path : path.replace(/\.js$/, '.ts'), emitted = `${build}/${path}`;
  assert(statSync(emitted).mtimeMs >= statSync(source).mtimeMs, 'stale emission');
  return { source, sourceSha256: sha(readFileSync(source)), emitted, emittedSha256: sha(readFileSync(emitted)) };
});
const q4fSources = JSON.parse(readFileSync('.factory/private/native-questionnaire-integration/runtime-2026-10-10-q4f/SOURCE-MANIFEST.json')).files;
for (const pin of q4fSources.filter(pin => pairs.some(pair => pair.source === pin.path))) assert.equal(sha(readFileSync(pin.path)), pin.sha256, 'Q4f shared runtime source drift');
const authoredPins = ['scripts/qualification/prepare-extraction-sparse.mjs', 'packages/clinic-api/test/adaptive-extraction-sparse.test.ts', 'tsconfig.extraction-sparse.json', 'package.json', 'package-lock.json', 'vitest.foundation.config.mts'].map(path => ({ path, sha256: sha(readFileSync(path)), bytes: statSync(path).size }));
const candidateSha256 = sha(canonicalJson({ pairs, authoredPins, runtimePath, runtimeSha256: sha(readFileSync(runtimePath)) }));
const historical = JSON.parse(readFileSync('docs/implementation/evidence/S3-EXTRACTION-OBJECT-ARRAY-Q4F-AUTHORED-PACKET.json'));
const cases = [];
const blockedModelAlternatives = [{ model: 'glm-5.2', reason: 'Stable digitalocean.ts model enum rejects this model; no bypass or request prepared.' }, { model: 'mimo-v2.5-pro', reason: 'Stable digitalocean.ts model enum rejects this model; no bypass or request prepared.' }];
for (const caseId of ['G3', 'P1', 'G7']) {
  const context = sparseCaseContext(caseId), full = createFullReplyManifest(context), domain = createDomainManifest(full), authored = groupedRepresentativeDraft(caseId, full, domain), grouped = createGroupedExtractionManifest(context), manifest = await createSparseManifest(context, grouped), wire = encodeSparseExtraction(encodeGroupedExtraction(authored, grouped), manifest), compiled = decodeSparseExtraction(wire, manifest), original = decodeDomainDraft(authored, domain);
  const sort = entries => entries.map(canonicalJson).sort();
  for (const key of ['claims', 'items', 'closures']) assert.deepEqual(sort(compiled.draft[key]), sort(original[key]));
  assert.deepEqual(compiled.draft.accounting, original.accounting); assert.deepEqual(compiled.draft.residual, original.residual);
  assert.equal(sha(context.source.text), historical.cases.find(c => c.caseId === caseId).sourceSha256);
  const budget = sparseOutputBudget(wire), requests = [];
  for (const model of ['qwen3.8-max', 'glm-5.3-flash']) {
    const request = await prepareDigitalOceanStreamRequest({ endpoint: 'https://inference.do-ai.run', model, apiKey: 'offline-preflight-only', timeoutMs: 30000, maxOutputTokens: budget.maxOutputTokens, maxRequestBytes: 131072, responseFormat: { type: 'json-schema', name: sparseSchemaName, schema: manifest.jsonSchema } }, [...manifest.messages]);
    requests.push({ model, body: request.body, sha256: sha(request.body), bytes: request.requestBytes, maxOutputTokens: budget.maxOutputTokens, reasoningControlsEmitted: false, reasoningBudgetQualified: false, liveBudgetReady: false, prospectiveProtocolComparison: model === 'qwen3.8-max', blockedDefaultMaxReasoning: model === 'glm-5.3-flash' });
  }
  const readback = await sparseCaseReadback(caseId, { raw: wire });
  const op = readback.savedDraft.adaptive.operations[readback.savedDraft.adaptive.activeOperationId];
  assert.equal(op.status, 'applied'); assert.equal(op.stream.capture, 'saved'); assert.deepEqual(readback.projection.creditedSourceIds, []);
  const usefulBehaviorPass = readback.timings.nextQuestionSavedMs !== null;
  assert.equal(usefulBehaviorPass, caseId !== 'P1', 'historical P1 remains false');
  cases.push({ caseId, sourceSha256: sha(context.source.text), manifest, requests, authored: { wire, budget, claims: compiled.draft.claims.length, items: compiled.draft.items.length, closures: compiled.draft.closures.length, typedDraftSha256: sha(canonicalJson(compiled.draft)), internalSemanticsIdentical: true }, readback: { status: op.status, capture: op.stream.capture, prompt: readback.savedDraft.adaptive.exchange?.prompt ?? null, timings: readback.timings, effectiveResponsesSha256: sha(canonicalJson(readback.projection.responses)), creditedSourceIds: [], usefulBehaviorPass, nativeDefinition: readback.nativeDefinition, historicalP1UsefulContinuation: caseId === 'P1' ? false : null } });
}
const prefix = 'docs/implementation/evidence/S3-EXTRACTION-SPARSE';
const packet = { syntheticAuthored: true, providerCalls: 0, holdoutRead: false, defaultEnabled: false, semanticQualification: false, schemaCompatibilityObserved: false, nativeMappingQualified: false, threeCaseUsefulBehaviorAcceptance: false, candidateSha256, blockedModelAlternatives, cases };
const pins = { candidateSha256, runtimePath, runtimeSha256: sha(readFileSync(runtimePath)), pairs, authoredPins, authoredPacketSha256: sha(JSON.stringify(packet, null, 2) + '\n'), providerCalls: 0, holdoutRead: false, defaultEnabled: false, limitations: ['Hash-only dependency bindings avoid full predecessor archive duplication; recheck every pin before future dispatch.', 'Mixed scalar owners for one topic currently fail closed at the unchanged grouped bridge; residual remains required for unsupported combinations.', 'Exact source addresses do not prove source-to-value semantic fidelity.', 'Output budget is a conservative byte estimate with margin, not tokenizer/provider reasoning qualification.', 'GLM5.3Flash body has max_tokens only, no reasoning control; serialized fact margin does not qualify default-max hidden reasoning plus complete output.', 'Request preflights do not establish schema compatibility, pricing, quality, sufficient reasoning budget or authorization to dispatch.'] };
for (const suffix of ['-AUTHORED-PACKET.json', '-PINS.json']) assert(!existsSync(prefix + suffix), 'preserve evidence');
writeFileSync(prefix + '-AUTHORED-PACKET.json', JSON.stringify(packet, null, 2) + '\n', { flag: 'wx' });
writeFileSync(prefix + '-PINS.json', JSON.stringify(pins, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ candidateSha256, emittedPairs: pairs.length, authoredPins: authoredPins.length, cases: cases.map(c => ({ caseId: c.caseId, ...c.manifest.measurement, ...c.authored.budget, usefulBehaviorPass: c.readback.usefulBehaviorPass })), providerCalls: 0 }));
