/** AF64 only. Offline by default; authority and immutable source checks precede credentials. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { validateFullDevelopmentAllocation } from './adaptive-full-reservation.mjs';

export const extractionCandidate = 'faa1c44b014758c9e013fb3d2d0c2f5fc1fb3d8927df15e34d812d892214aa01';
const sha = value => createHash('sha256').update(value).digest('hex');
const evidence = 'docs/implementation/evidence/';
const freezePath = evidence + 'S3-EXTRACTION-OBJECT-ARRAY-Q4F-FREEZE.json';
const packetPath = evidence + 'S3-EXTRACTION-OBJECT-ARRAY-Q4F-AUTHORED-PACKET.json';
const harnessFreezePath = evidence + 'S3-EXTRACTION-OBJECT-ARRAY-AF64-HARNESS-V2-FREEZE.json';
const operation = 'DO-AF64', caseId = 'G3';

export function verifyPins(pins, read = readFileSync) {
  assert(Array.isArray(pins) && pins.length > 0 && pins.length < 1000, 'bounded immutable pins required');
  for (const pin of pins) assert.equal(sha(read(pin.path)), pin.sha256, `source/archive drift: ${pin.path}`);
}
export function validateSingleAllocation(raw, preflight, now = Date.now()) {
  const reservation = validateFullDevelopmentAllocation(raw, preflight, now);
  assert.equal(raw.operations.length, 1, 'exactly one allocated operation');
  assert.equal(raw.operations[0].id, operation);
  assert.equal(raw.operations[0].caseId, caseId);
  assert.equal(raw.operations[0].maxOutputTokens, 512);
  assert(raw.creditsCap <= 1 && raw.operations[0].creditsCap === raw.creditsCap, 'one existing-credit bound, no unassigned allowance');
  assert(Date.parse(raw.expiresAt) - Date.parse(raw.issuedAt) <= 3600000, 'finite allocation window <= one hour');
  return reservation;
}
export function oneOperationFetch(fetcher, requestBodySha256) {
  let calls = 0;
  return { count: () => calls, fetcher: async (url, init) => {
    assert.equal(String(url), 'https://inference.do-ai.run/v1/chat/completions');
    assert.equal(init?.method, 'POST');
    assert.equal(typeof init?.body, 'string');
    assert.equal(sha(init.body), requestBodySha256, 'exact issued request body required');
    assert.equal(calls, 0, 'one call only; no retry or fallback');
    calls++;
    return fetcher(url, { ...init, redirect: 'error' });
  } };
}
function privateFile(path, maximumBytes) {
  assert(path && isAbsolute(path), 'absolute private file required');
  const stat = statSync(path);
  assert(stat.isFile() && stat.size <= maximumBytes && !(stat.mode & 0o077), 'bounded private file required');
}
function verifyCandidate() {
  assert.equal(sha(readFileSync(freezePath)), '5dec4f81f407572f5632ece8a62f2a5123a6f2511b7a9622ddcfc210cbc980a8');
  assert.equal(sha(readFileSync(packetPath)), 'c55171fcc0d1571f98d47aed6755bdb3db406947185a1ef89c0f14438cc8bee0');
  const freeze = JSON.parse(readFileSync(freezePath));
  assert.equal(freeze.candidateSha256, extractionCandidate);
  const snapshotPath = resolve(freeze.candidateArchive, 'SNAPSHOT.json');
  assert.equal(sha(readFileSync(snapshotPath)), freeze.snapshotSha256);
  const snapshot = JSON.parse(readFileSync(snapshotPath));
  assert.equal(sha(JSON.stringify(snapshot.fingerprints)), extractionCandidate);
  verifyPins(snapshot.files);
  verifyPins(snapshot.files.map(pin => ({ ...pin, path: resolve(freeze.candidateArchive, 'files', pin.path) })));
  verifyPins(freeze.referencePins);
  const harness = JSON.parse(readFileSync(harnessFreezePath));
  assert.equal(harness.extractionCandidateSha256, extractionCandidate);
  assert.equal(sha(JSON.stringify(harness.bindings)), harness.candidateSha256);
  verifyPins(harness.bindings.files);
  for (const inventoryPath of harness.bindings.runtimeInventories) verifyPins(JSON.parse(readFileSync(inventoryPath)).files);
  assert.equal(harness.bindings.extractionFreezeSha256, sha(readFileSync(freezePath)));
  assert.equal(harness.bindings.authoredPacketSha256, sha(readFileSync(packetPath)));
  assert.equal(harness.bindings.extractionSnapshotSha256, freeze.snapshotSha256);
  const packet = JSON.parse(readFileSync(packetPath));
  assert.equal(packet.threeCaseUsefulBehaviorAcceptance, false);
  assert.equal(packet.cases.find(c => c.caseId === 'P1').usefulBehaviorPass, false, 'P1 failure must remain open');
  return { freeze, harness, authored: packet.cases.find(c => c.caseId === caseId) };
}
async function main() {
  const allowed = new Set(['--live', '--reservation', '--env', '--review']);
  const args = new Map();
  for (let i = 2; i < process.argv.length; i++) {
    const key = process.argv[i];
    assert(allowed.has(key) && !args.has(key), 'unsupported/duplicate argument');
    args.set(key, key === '--live' ? true : process.argv[++i]);
    assert(args.get(key), 'missing argument');
  }
  const live = args.has('--live');
  assert(live || args.size === 0, 'offline does not read allocations, reviews or credentials');
  const workspace = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  assert.equal(resolve(process.cwd()), workspace, 'run in exact workspace');
  const { freeze, harness, authored } = verifyCandidate();
  // Import only after every frozen current/archive source and emitted dependency matches.
  const build = '../../.extraction-object-array-q4f-build/';
  const [stream, codec, fixture, compact, domain, diagnostics] = await Promise.all([
    import(build + 'packages/clinical-core/src/digitalocean-stream.js'),
    import(build + 'scripts/qualification/extraction-object-array-manifest.js'),
    import(build + 'scripts/qualification/fixtures/adaptive-extraction-object-array-readback.js'),
    import(build + 'packages/clinic-api/src/adaptive-reply-compact.js'),
    import(build + 'packages/clinical-core/src/domain.js'),
    import('../../.extraction-grouped-diagnostic-build/packages/clinical-core/src/http-rejection-diagnostics.js'),
  ]);
  const context = fixture.objectArrayCaseContext(caseId);
  const manifest = await codec.createObjectArrayManifest(context);
  assert.equal(sha(domain.canonicalJson(context)), authored.renderedManifest.contextSha256);
  assert.deepEqual(manifest, authored.renderedManifest, 'exact manifest, native binding, schema and messages required');
  const config = { endpoint: 'https://inference.do-ai.run', model: 'qwen3.8-max', timeoutMs: 30000, maxOutputTokens: 512, maxRequestBytes: 131072,
    responseFormat: { type: 'json-schema', name: codec.objectArraySchemaName, schema: manifest.jsonSchema } };
  const request = await stream.prepareDigitalOceanStreamRequest({ ...config, apiKey: 'offline-preflight-only' }, [...manifest.messages]);
  assert.equal(request.body, authored.exactRequest.body);
  assert.equal(sha(request.body), freeze.prospectiveG3.requestBodySha256);
  assert.deepEqual(stream.fullStreamLimits(512), freeze.prospectiveG3.streamLimits);
  const preflight = { id: operation, caseId, developmentCaseIds: [caseId], candidateSha256: harness.candidateSha256,
    extractionCandidateSha256: extractionCandidate, requestBodySha256: sha(request.body), requestBytes: request.requestBytes,
    maximumOutputTokens: 512, timeoutMs: 30000, cashCap: 0, maximumCalls: 1, manifestSha256: manifest.sha256,
    contextSha256: manifest.contextSha256, nativeDefinition: manifest.nativeDefinition, streamLimits: stream.fullStreamLimits(512),
    P1UsefulBehaviorPass: false, threeCaseUsefulBehaviorAcceptance: false, nativeMappingQualified: false };
  if (!live) {
    console.log(JSON.stringify({ ...preflight, state: 'offline-preflight-only', callCount: 0, allowance: false }));
    return;
  }
  privateFile(args.get('--reservation'), 16384);
  const reservation = validateSingleAllocation(JSON.parse(readFileSync(args.get('--reservation'))), preflight);
  privateFile(args.get('--review'), 8192);
  const review = JSON.parse(readFileSync(args.get('--review')));
  assert.deepEqual(Object.keys(review).sort(), ['candidateSha256', 'decision', 'extractionCandidateSha256', 'harnessSha256', 'reviewer', 'schema']);
  assert.equal(review.schema, 1);
  assert.equal(review.decision, 'accepted-for-root-allocation');
  assert.equal(review.reviewer, 'sol_native_questionnaire_review');
  assert.equal(review.candidateSha256, harness.candidateSha256);
  assert.equal(review.extractionCandidateSha256, extractionCandidate);
  assert.equal(review.harnessSha256, sha(readFileSync(fileURLToPath(import.meta.url))));
  const ledger = readFileSync('/Volumes/rexy/GitHub/unfiltered/docs/rebuild/USAGE-LEDGER.md', 'utf8');
  const rows = ledger.split('\n').filter(row => row.startsWith(`| ${reservation.allocationId} /`));
  assert(rows.length === 1 && rows[0].includes('AF64 G3') && rows[0].includes(harness.candidateSha256)
    && rows[0].includes('existing-credit') && rows[0].includes('cash0') && rows[0].includes(reservation.expiresAt), 'exact root ledger credit-only reservation required');
  privateFile(args.get('--env'), 65536);
  const prefix = evidence + operation;
  const lock = evidence + `OBJECT-ARRAY-${harness.candidateSha256}-${caseId}-INTENT.json`;
  const privatePrefix = resolve(workspace, 'infra/cloud/.private', operation);
  for (const path of [prefix + '-INTENT.json', prefix + '.json', lock, privatePrefix + '-PREFIX.json', privatePrefix + '-HTTP-DIAGNOSTIC.json']) assert(!existsSync(path), 'prior intent/result retained; never retry');
  mkdirSync(resolve(workspace, 'infra/cloud/.private'), { recursive: true });
  loadEnvFile(args.get('--env'));
  const apiKey = process.env.DIGITALOCEAN_MODEL_ACCESS_KEY || process.env.DIGITALOCEAN_MODEL_ACESS_KEY;
  assert(apiKey, 'missing model key');
  // Recheck expiry and all sources immediately before durable intent and dispatch.
  validateSingleAllocation(JSON.parse(readFileSync(args.get('--reservation'))), preflight);
  verifyCandidate();
  const intent = { ...preflight, state: 'dispatch-intent', outcome: 'unknown', reservation, reviewSha256: sha(readFileSync(args.get('--review'))), at: new Date().toISOString() };
  writeFileSync(lock, JSON.stringify(intent, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(prefix + '-INTENT.json', JSON.stringify(intent, null, 2) + '\n', { flag: 'wx' });
  const one = oneOperationFetch(fetch, preflight.requestBodySha256);
  const diagnostic = diagnostics.diagnosticFetch(one.fetcher, Date.now() + config.timeoutMs);
  const partial = compact.createSyntheticPartialCapture();
  let result, compiled, raw, errorCode, appReadback;
  try {
    result = await stream.digitalOceanStream({ ...config, apiKey }, diagnostic.fetcher, () => performance.now(), preflight.streamLimits)
      .generate([...manifest.messages], { onContent: text => partial.append(text) });
    raw = JSON.parse(result.text);
    compiled = codec.decodeObjectArrayExtraction(raw, manifest);
  } catch (error) {
    errorCode = typeof error?.code === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(error.code) ? error.code : 'object-array-qualification-failed';
    if (!result && error?.receipt) result = { receipt: error.receipt };
  }
  try {
    appReadback = await fixture.objectArrayCaseReadback(caseId, { ...(compiled ? { raw } : {}), receipt: result?.receipt, errorCode });
  } catch { appReadback = { offlineResponseReplay: true, state: 'readback-failed', usefulBehaviorPass: false }; }
  writeFileSync(privatePrefix + '-PREFIX.json', JSON.stringify({ id: operation, candidateSha256: harness.candidateSha256, partial: partial.snapshot() }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const httpDiagnostic = diagnostic.snapshot();
  if (httpDiagnostic) writeFileSync(privatePrefix + '-HTTP-DIAGNOSTIC.json', JSON.stringify(httpDiagnostic, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const receipt = { ...preflight, state: compiled ? 'output-decoded-awaiting-semantic-review' : 'qualification-failed', callCount: one.count(),
    providerReceipt: result?.receipt ?? { outcome: 'unknown', providerExecution: 'unknown', usage: 'unknown' },
    ...(errorCode ? { errorCode } : {}), ...(compiled ? { rawOutput: raw, draft: compiled.draft, normalizedCapture: compiled.capture } : {}),
    appReadback, httpDiagnostic, partialContentEvidence: { ...partial.snapshot(), utf8: undefined, privateSha256: sha(readFileSync(privatePrefix + '-PREFIX.json')) },
    reservation: { ...reservation, consumed: true, refund: false },
    observedResultRequiresHumanSemanticReview: true, semanticQualification: false, schemaCompatibilityObserved: Boolean(compiled),
    authoredSemanticOraclePass: Boolean(compiled && ['claims', 'items', 'closures'].every(key => {
      const sort = entries => entries.map(domain.canonicalJson).sort();
      return domain.canonicalJson(sort(compiled.draft[key])) === domain.canonicalJson(sort(authored.authored.expandedDraft[key]));
    }) && domain.canonicalJson(compiled.draft.accounting) === domain.canonicalJson(authored.authored.expandedDraft.accounting)
      && domain.canonicalJson(compiled.draft.residual) === domain.canonicalJson(authored.authored.expandedDraft.residual)),
    G3UsefulBehaviorPass: Boolean(compiled && appReadback?.timings?.nextQuestionSavedMs != null),
    latencyQualified: false, holdoutRead: false, defaultEnabled: false,
    note: 'One operation only. Unknown charges retained. P1 remains open. No retry/fallback, native qualification or activation.' };
  writeFileSync(prefix + '.json', JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ id: operation, state: receipt.state, callCount: one.count(), receipt: prefix + '.json', semanticQualification: false, nativeMappingQualified: false }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Object-array operation blocked or failed; preserve any durable intent and reservation. No retry.'); process.exitCode = 1; });
}
