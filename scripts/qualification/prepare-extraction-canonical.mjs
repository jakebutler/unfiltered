/** Offline only: one API-created synthetic source and exact prospective request. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createCanonicalSeed, prepareCanonicalContext } from '../../.extraction-canonical-build/scripts/qualification/fixtures/adaptive-canonical-goals.js';
import { prepareDigitalOceanStreamRequest } from './digitalocean-canonical-flash-low.mjs';
assert.equal(process.argv.length, 2, 'offline only');
const sha = b => createHash('sha256').update(b).digest('hex');
const evidence = 'docs/implementation/evidence/', privateDir = 'infra/cloud/.private';
const seedPath = privateDir + '/canonical-goals-seed-20261010.json', requestPath = evidence + 'S3-SPARSE-CANONICAL-REQUEST.json', candidatePath = evidence + 'S3-SPARSE-CANONICAL-LIVE.json';
for (const path of [seedPath, requestPath, candidatePath]) assert(!existsSync(path), 'preserve prepared candidate');
const seed = await createCanonicalSeed(), prepared = await prepareCanonicalContext(seed);
const config = { endpoint: 'https://inference.do-ai.run', model: 'glm-5.3-flash', apiKey: 'offline-preflight-only', timeoutMs: 30000, maxOutputTokens: 2048, maxRequestBytes: 131072, responseFormat: { type: 'json-schema', name: 'adaptive_extraction_sparse_v3', schema: prepared.manifest.jsonSchema } };
const request = await prepareDigitalOceanStreamRequest(config, [...prepared.manifest.messages]);
mkdirSync(privateDir, { recursive: true });
writeFileSync(seedPath, JSON.stringify(seed, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
writeFileSync(requestPath, JSON.stringify({ schema: 1, caseId: seed.caseId, body: request.body, requestBodySha256: sha(request.body), requestBytes: request.requestBytes, contextSha256: prepared.manifest.contextSha256, manifestSha256: prepared.manifest.sha256, nativeDefinition: prepared.manifest.nativeDefinition, expectedNextTopicId: 'Q02', offlineReadback: prepared.offlineReadback, providerCalls: 0, allowance: false, setup: 'real-handler-synthetic-mock-FHIR', hostedAcceptance: false, nativeEndToEndAcceptance: false, defaultEnabled: false }, null, 2) + '\n', { flag: 'wx' });
const files = [];
function inventory(dir) { for (const d of readdirSync(dir, { withFileTypes: true })) { const path = dir + '/' + d.name; if (d.isDirectory()) inventory(path); else if (d.isFile()) { assert(path.endsWith('.js')); const source = path.replace('.extraction-canonical-build/', '').replace(/\.js$/, '.ts'); assert(existsSync(source), 'exact source for emission'); files.push({ path: source, sha256: sha(readFileSync(source)) }, { path, sha256: sha(readFileSync(path)) }); } } }
inventory('.extraction-canonical-build');
for (const path of ['scripts/qualification/digitalocean-canonical-flash-low.mjs', 'scripts/qualification/qualify-extraction-canonical.mjs', 'scripts/qualification/prepare-extraction-canonical.mjs', 'scripts/qualification/adaptive-full-reservation.mjs', 'scripts/qualification/qualify-extraction-flash-low.mjs', 'packages/clinic-api/test/adaptive-extraction-sparse-route.test.ts', 'tsconfig.extraction-canonical.json', 'scripts/qualification/extraction-canonical-operation.test.mjs', seedPath, requestPath]) files.push({ path, sha256: sha(readFileSync(path)) });
const runtimePath = '.factory/private/native-questionnaire-integration/runtime-2026-10-10-q4f/MANIFEST.json';
const bindings = { operation: { id: 'DO-AF74', caseId: 'CANONICAL-GOALS', maximumOutputTokens: 2048, maximumCalls: 1, timeoutMs: 30000, creditsCap: 1, cashCap: 0 }, files, runtimePath, runtimeSha256: sha(readFileSync(runtimePath)), dependencyInventorySha256: JSON.parse(readFileSync(runtimePath)).inventories['DEPENDENCIES-MANIFEST.json'].sha256, requestBodySha256: sha(request.body), requestPath, seedPath, sourceAdmission: 'normal-api-saved-text', expectedNextTopicId: 'Q02' };
const candidateSha256 = sha(JSON.stringify(bindings));
writeFileSync(candidatePath, JSON.stringify({ schema: 1, candidateSha256, extractionCandidateSha256: sha(JSON.stringify(files.filter(p => p.path.startsWith('packages/clinic-api/src/')))), bindings, providerCalls: 0, allowance: false, holdoutRead: false, defaultEnabled: false }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ candidatePath, candidateSha256, requestPath, requestBodySha256: sha(request.body), requestBytes: request.requestBytes, contextSha256: prepared.manifest.contextSha256, sourceEmissionPairs: (files.length - 10) / 2, expectedNextQuestion: prepared.offlineReadback.nextQuestion, providerCalls: 0, allowance: false }));
