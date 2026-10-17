/** Offline-only Q4f successor; Q4 freeze and missing-relevance P1 remain unchanged. Deliberately has no live/env/reservation mode. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../../.extraction-object-array-q4f-build/packages/clinical-core/src/domain.js';
import { prepareDigitalOceanStreamRequest, fullStreamLimits } from '../../.extraction-object-array-q4f-build/packages/clinical-core/src/digitalocean-stream.js';
import { createGroupedExtractionManifest, encodeGroupedExtraction } from '../../.extraction-object-array-q4f-build/packages/clinic-api/src/adaptive-extraction-grouped-v2.js';
import { createFullReplyManifest } from '../../.extraction-object-array-q4f-build/packages/clinic-api/src/adaptive-reply-full.js';
import { createDomainManifest, decodeDomainDraft } from '../../.extraction-object-array-q4f-build/packages/clinic-api/src/adaptive-reply-domain.js';
import { groupedRepresentativeDraft, groupedCaseLabels } from '../../.extraction-object-array-q4f-build/scripts/qualification/fixtures/adaptive-extraction-grouped-v2-cases.js';
import { objectArrayCaseContext, objectArrayCaseReadback } from '../../.extraction-object-array-q4f-build/scripts/qualification/fixtures/adaptive-extraction-object-array-readback.js';
import { createObjectArrayManifest, encodeObjectArrayExtraction, decodeObjectArrayExtraction, objectArraySchemaName } from '../../.extraction-object-array-q4f-build/scripts/qualification/extraction-object-array-manifest.js';

assert.equal(process.argv.length, 2, 'offline preparation accepts no live, credential, allocation or operation arguments');
const workspace = resolve(fileURLToPath(new URL('../../', import.meta.url)));
assert.equal(resolve(process.cwd()), workspace);
const sha = value => createHash('sha256').update(value).digest('hex');
assert.equal(sha(readFileSync('packages/clinical-core/src/digitalocean.ts')), '0e40777c1c04ca3a4c8b3dee00240e5242ac4a1027028a89dd9257be2e47403e');
const referencePins = [
  { path: 'docs/implementation/evidence/native-questionnaire-review-q4/MANIFEST.json', sha256: '68f78f9703292a076fff050d8aac418da961e470905fd809d1b4da183c1f2492' },
  { path: '.factory/private/native-questionnaire-integration/freeze-2026-10-10-q4/MANIFEST.json', sha256: '3d75afd4671d25a038a5383dc44da748c228b0c5c99200868857b5cb74af5b11' },
  { path: '.factory/private/native-questionnaire-integration/runtime-2026-10-10-q4f/MANIFEST.json', sha256: 'e0212437c9f6923e7d4cc2fe3b630a63baa26712c728db763181213840db3996' },
  { path: '.factory/private/native-questionnaire-integration/runtime-2026-10-10-q4f/SOURCE-MANIFEST.json', sha256: '68721eecf491025b41eb15fd1cf001645c0b3bbd045ada40d76af4b9b09190c7' },
  { path: 'docs/implementation/evidence/S3-EXTRACTION-OBJECT-ARRAY-FREEZE.json', sha256: 'e10c346fe536717e6bd2f84afc186bd28fde557a642769686a3f8db918483dfc' },
  { path: 'docs/implementation/evidence/S3-EXTRACTION-OBJECT-ARRAY-AUTHORED-PACKET.json', sha256: '108e68d1cb85d9e82925b6edaa096c7a2450bdc60cbb08104601997f28181c76' },
  { path: 'docs/implementation/evidence/S3-EXTRACTION-GROUPED-V2-AUTHORED-PACKET.json', sha256: 'ad7fa1ec22d4ae19285a72f87937ea3a8ec68a6f3603b35076a276594f032771' },
];
for (const pin of referencePins) assert.equal(sha(readFileSync(pin.path)), pin.sha256, 'frozen reference changed');
const parent = JSON.parse(readFileSync('docs/implementation/evidence/S3-EXTRACTION-OBJECT-ARRAY-FREEZE.json'));
const parentSnapshot = JSON.parse(readFileSync(`${parent.candidateArchive}/SNAPSHOT.json`));
assert.equal(sha(readFileSync(`${parent.candidateArchive}/SNAPSHOT.json`)), parent.snapshotSha256);
for (const pin of parentSnapshot.files) assert.equal(sha(readFileSync(`${parent.candidateArchive}/files/${pin.path}`)), pin.sha256, 'preserve Q4 archive');
const build = '.extraction-object-array-q4f-build';
const emitted = readdirSync(build, { recursive: true }).filter(p => typeof p === 'string' && /\.(js|mjs)$/.test(p)).sort();
assert(emitted.length > 0 && emitted.length < 180, 'bounded isolated emit');
const fingerprints = emitted.map(path => {
  const sourcePath = path.endsWith('.mjs') ? path : path.replace(/\.js$/, '.ts');
  const emittedPath = `${build}/${path}`;
  assert(statSync(emittedPath).mtimeMs >= statSync(sourcePath).mtimeMs, 'stale emitted dependency');
  return { source: { path: sourcePath, sha256: sha(readFileSync(sourcePath)) }, dispatched: { path: emittedPath, sha256: sha(readFileSync(emittedPath)) } };
});
const integration = JSON.parse(readFileSync('.factory/private/native-questionnaire-integration/runtime-2026-10-10-q4f/SOURCE-MANIFEST.json'));
for (const pin of integration.files.filter(pin => fingerprints.some(pair => pair.source.path === pin.path))) assert.equal(sha(readFileSync(pin.path)), pin.sha256, 'current emitted integration dependency changed from Q4f');
for (const path of ['scripts/qualification/prepare-extraction-object-array-q4f.mjs', 'scripts/qualification/extraction-object-array-codec.d.mts', 'packages/clinic-api/test/adaptive-extraction-object-array.test.ts', 'tsconfig.extraction-object-array-q4f.json', 'vitest.foundation.config.mts', 'package.json', 'package-lock.json']) fingerprints.push({ source: { path, sha256: sha(readFileSync(path)) }, dispatched: { path, sha256: sha(readFileSync(path)) } });
const candidateSha256 = sha(JSON.stringify(fingerprints));
const prefix = 'docs/implementation/evidence/S3-EXTRACTION-OBJECT-ARRAY-Q4F';
for (const suffix of ['-FREEZE.json', '-AUTHORED-PACKET.json']) assert(!existsSync(prefix + suffix), 'never overwrite prepared evidence');
const historical = JSON.parse(readFileSync('docs/implementation/evidence/S3-EXTRACTION-GROUPED-V2-AUTHORED-PACKET.json'));
const cases = [];
const config = { endpoint: 'https://inference.do-ai.run', model: 'qwen3.8-max', apiKey: 'offline-preflight-only', timeoutMs: 30000, maxOutputTokens: 512, maxRequestBytes: 131072 };
for (const caseId of ['G3', 'P1', 'G7']) {
  const context = objectArrayCaseContext(caseId), full = createFullReplyManifest(context), domain = createDomainManifest(full), grouped = createGroupedExtractionManifest(context), manifest = await createObjectArrayManifest(context, grouped);
  const authored = groupedRepresentativeDraft(caseId, full, domain), groupedWire = encodeGroupedExtraction(authored, grouped), wire = encodeObjectArrayExtraction(groupedWire, manifest), compiled = decodeObjectArrayExtraction(wire, manifest), original = decodeDomainDraft(authored, domain);
  const sort = entries => entries.map(canonicalJson).sort();
  for (const key of ['claims', 'items', 'closures']) assert.deepEqual(sort(compiled.draft[key]), sort(original[key]));
  assert.deepEqual(compiled.draft.residual, original.residual);
  assert.deepEqual(compiled.draft.accounting, original.accounting);
  const oldCase = historical.cases.find(c => c.caseId === caseId);
  assert.equal(sha(context.source.text), oldCase.sourceSha256, 'historical patient source changed');
  const normalizeManifest = raw => ({ ...raw, m: 'manifest-id-only' });
  assert.deepEqual(normalizeManifest(groupedWire), normalizeManifest(oldCase.authored.wire), 'authored semantic wire changed');
  const outputBytes = Buffer.byteLength(JSON.stringify(wire)), conservativeOutputTokens = Math.ceil(outputBytes * .5);
  assert(conservativeOutputTokens <= 400, 'offline preparation ceiling failed; no cap growth');
  const request = await prepareDigitalOceanStreamRequest({ ...config, responseFormat: { type: 'json-schema', name: objectArraySchemaName, schema: manifest.jsonSchema } }, [...manifest.messages]);
  const readback = await objectArrayCaseReadback(caseId, { raw: wire });
  const op = readback.savedDraft.adaptive.operations[readback.savedDraft.adaptive.activeOperationId];
  assert.equal(op.status, 'applied');
  assert.equal(op.stream.capture, 'saved');
  assert.deepEqual(readback.projection.creditedSourceIds, []);
  const usefulBehaviorPass = readback.timings.nextQuestionSavedMs !== null;
  cases.push({ caseId, candidateSha256, sourceSha256: oldCase.sourceSha256, successorLabelsSha256: sha(JSON.stringify(groupedCaseLabels(caseId))), context, renderedManifest: manifest, exactRequest: { body: request.body, bytes: request.requestBytes, sha256: sha(request.body) }, authored: { wire, groupedWire, expandedDraft: compiled.draft, capture: compiled.capture, outputBytes, conservativeOutputTokens, generationMarginTokens: 512 - conservativeOutputTokens, internalSemanticsIdentical: true }, appReadback: readback, usefulBehaviorPass, ...(caseId === 'P1' ? { preservedFailure: { assertion: 'nextQuestionSavedMs must be non-null for useful continuation', observed: readback.timings.nextQuestionSavedMs, missingAuthority: 'No draft relevantTopicIds or previously presented Q02 response; historical capture-only fixture includes reusable topics without API selection.', status: 'P1 useful continuation remains open; no acceptance-oracle relaxation, no relevance fabrication', expectedHistoricalPrompt: 'Q02 current symptoms/concerns', currentStatus: readback.savedDraft.adaptive.exchange?.status } } : {}) });
}
assert.equal(cases[0].usefulBehaviorPass, true, 'G3 potential observation requires useful authored replay');
assert.equal(cases[2].usefulBehaviorPass, true, 'G7 authored replay unexpectedly blocked');
assert.equal(cases[1].usefulBehaviorPass, false, 'preserve missing-authority P1 result');
const packet = { syntheticAuthored: true, providerCalls: 0, holdoutRead: false, defaultEnabled: false, semanticQualification: false, nativeMappingQualified: false, threeCaseUsefulBehaviorAcceptance: false, referencePins, cases };
const archive = `docs/implementation/evidence/OBJECT-ARRAY-Q4F-CANDIDATE-${candidateSha256}`;
assert(!existsSync(archive), 'preserve candidate archive');
mkdirSync(archive, { recursive: true });
const paths = [...new Set(fingerprints.flatMap(pair => [pair.source.path, pair.dispatched.path]))].sort();
const files = paths.map(path => { const target = resolve(archive, 'files', path); mkdirSync(dirname(target), { recursive: true }); copyFileSync(path, target); return { path, sha256: sha(readFileSync(path)), bytes: statSync(path).size }; });
const snapshot = JSON.stringify({ candidateSha256, fingerprints, files }, null, 2) + '\n';
writeFileSync(`${archive}/SNAPSHOT.json`, snapshot, { flag: 'wx' });
const packetBody = JSON.stringify(packet, null, 2) + '\n';
writeFileSync(`${prefix}-AUTHORED-PACKET.json`, packetBody, { flag: 'wx' });
writeFileSync(`${prefix}-FREEZE.json`, JSON.stringify({ candidateSha256, parentCandidateSha256: parent.candidateSha256, sourceSuccessorRuntimeSha256: 'e0212437c9f6923e7d4cc2fe3b630a63baa26712c728db763181213840db3996', candidateArchive: archive, snapshotSha256: sha(snapshot), authoredPacketSha256: sha(packetBody), files: files.length, fingerprintPairs: fingerprints.length, referencePins, prospectiveG3: { operationId: null, rootIssuedOperationRequired: true, allocation: null, maximumCalls: 1, suggestionExistingCreditsCap: 1, cashCap: 0, maxOutputTokens: 512, timeoutMs: 30000, maxRequestBytes: 131072, streamLimits: fullStreamLimits(512), requestBodySha256: cases[0].exactRequest.sha256, requestBytes: cases[0].exactRequest.bytes, schemaSha256: sha(canonicalJson(cases[0].renderedManifest.jsonSchema)), authoredOutputBytes: cases[0].authored.outputBytes, conservativeOutputTokens: cases[0].authored.conservativeOutputTokens, generationMarginTokens: cases[0].authored.generationMarginTokens }, providerCalls: 0, holdoutRead: false, defaultEnabled: false, semanticQualification: false, schemaCompatibilityObserved: false, nativeMappingQualified: false, threeCaseUsefulBehaviorAcceptance: false, limitations: ['P1 current native useful continuation remains blocked by absent trusted relevance.', 'Exact tokenizer unavailable; byte-based estimate is not a guarantee.', 'The separate AF64 harness must be bound and independently reviewed before root allocation; no provider call is authorized by this freeze.'] }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ candidateSha256, archive, files: files.length, fingerprints: fingerprints.length, cases: cases.map(c => ({ caseId: c.caseId, requestBytes: c.exactRequest.bytes, schemaBytes: c.renderedManifest.measurement.schemaBytes, outputBytes: c.authored.outputBytes, conservativeTokens: c.authored.conservativeOutputTokens, usefulBehaviorPass: c.usefulBehaviorPass })), providerCalls: 0 }));
