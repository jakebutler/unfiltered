/** Prospective AF63 structural diagnosis only. No accepted output or clinical credit. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnvFile } from 'node:process';
import { validateFullDevelopmentAllocation } from './adaptive-full-reservation.mjs';

const workspace = resolve(fileURLToPath(new URL('../../', import.meta.url)));
assert(resolve(process.cwd()) === workspace, 'run in the qualification workspace');
const args = new Map(), allowed = new Set(['--id', '--case', '--live', '--env', '--reservation']);
for (let i = 2; i < process.argv.length; i++) {
  const name = process.argv[i];
  assert(allowed.has(name) && !args.has(name), 'unsupported/duplicate argument');
  args.set(name, name === '--live' ? true : process.argv[++i]);
  assert(args.get(name), 'missing argument');
}
assert(args.get('--id') === 'DO-AF63' && args.get('--case') === 'G3', 'fixed distinct control required');
const id = 'DO-AF63', live = args.has('--live'), prefix = 'docs/implementation/evidence/' + id;
assert(live || (!args.has('--env') && !args.has('--reservation')), 'offline must not access credentials');
const privatePath = resolve('infra/cloud/.private', id + '-STREAM-DIAGNOSTIC.json');
for (const path of [prefix + '-INTENT.json', prefix + '.json', privatePath])
  assert(!existsSync(path), 'preserve prior dispatch/evidence; never repeat');
if (!live) assert(!existsSync(prefix + '-PREFLIGHT.json'), 'preserve prior preflight');
const sha = value => createHash('sha256').update(value).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const pin = path => ({ path, sha256: sha(readFileSync(path)) });
function pinned(path, digest) {
  assert(sha(readFileSync(path)) === digest, 'frozen reference changed');
  return read(path);
}

const historicalFreezePath = 'docs/implementation/evidence/S3-EXTRACTION-SETTLEMENT-FREEZE.json';
const historical = pinned(historicalFreezePath, '708cda74a175c5ea1768dfd3c860e3208730c1ee077561721f87677a1873ec00');
assert(historical.candidateSha256 === '31a116f0d09ebb4a4061b7c803d59c4b179ac36ca8656522f7aeb7ab5927f2b0');
const historicalSnapshotPath = resolve(historical.candidateArchive, 'SNAPSHOT.json');
const snapshot = pinned(historicalSnapshotPath, historical.snapshotSha256);
// Reference the historical archive; do not copy its implementation again.
for (const entry of snapshot.files)
  assert(sha(readFileSync(resolve(historical.candidateArchive, 'files', entry.path))) === entry.sha256,
    'historical archived implementation changed');
const compiledPath = path => {
  assert(snapshot.files.some(entry => entry.path === path), 'compiled module not historically pinned');
  return pathToFileURL(resolve(historical.candidateArchive, 'files', path)).href;
};
const { createScopedExtractionManifest } = await import(compiledPath(
  '.extraction-settlement-build/packages/clinic-api/src/adaptive-extraction-scoped.js'));
const build = '.stream-chunk-diagnostic-build/packages/clinical-core/src/';
const { digitalOceanStream, prepareDigitalOceanStreamRequest, fullStreamLimits } = await import(pathToFileURL(resolve(build, 'digitalocean-stream.js')).href);
const { streamChunkDiagnosticBounds } = await import(pathToFileURL(resolve(build, 'stream-chunk-diagnostics.js')).href);
const { syntheticDiagnosticPrefix, syntheticDiagnosticPrefixBytes } = await import(pathToFileURL(resolve(build, 'synthetic-diagnostic-prefix.js')).href);
const authoredPacket = pinned(historical.authoredPacket.path, historical.authoredPacket.sha256);
const original = authoredPacket.cases.find(entry => entry.id === 'DO-AF52' && entry.caseId === 'G3');
assert(original, 'historical G3 authored packet required');
const priorPreflightPath = 'docs/implementation/evidence/DO-AF52-PREFLIGHT.json';
const prior = pinned(priorPreflightPath, '95f2e7a67e7ac3c8f3a817fc7325436331bb413ab2e9dd779cc5e18d7eb19ef7');
const priorReceiptPath = 'docs/implementation/evidence/DO-AF52.json';
const priorReceipt = read(priorReceiptPath);
assert(priorReceipt.providerReceipt?.outcome === 'complete' &&
  priorReceipt.requestBodySha256 === prior.requestBodySha256, 'historical control did not complete');

const diagnosticFreezePath = 'docs/implementation/evidence/S3-EXTRACTION-HTTP-DIAGNOSTIC-FREEZE.json';
const diagnostic = pinned(diagnosticFreezePath, 'cbf48d8e3ad28dd2b228a08e0cea7d1f099d019caf44afceaeb3abc5c2582672');
const diagnosticSnapshot = pinned(resolve(diagnostic.candidateArchive, 'SNAPSHOT.json'), diagnostic.snapshotSha256);
const wrapperPaths = [
  'packages/clinical-core/src/http-rejection-diagnostics.ts',
  '.extraction-grouped-diagnostic-build/packages/clinical-core/src/http-rejection-diagnostics.js',
  'packages/clinical-core/test/http-rejection-diagnostics.test.ts',
];
const wrapperPins = wrapperPaths.map(path => {
  const entry = diagnosticSnapshot.files.find(item => item.path === path);
  assert(entry, 'reviewed diagnostic wrapper pin required');
  const archivedPath = resolve(diagnostic.candidateArchive, 'files', path);
  assert(sha(readFileSync(archivedPath)) === entry.sha256, 'reviewed diagnostic wrapper changed');
  return { ...entry, archivedPath };
});
const { diagnosticFetch, rejectionDiagnosticBounds } = await import(pathToFileURL(wrapperPins[1].archivedPath).href);

const manifest = createScopedExtractionManifest(original.context);
assert(manifest.id === original.manifest.id && manifest.sha256 === original.manifest.sha256,
  'historical manifest reconstruction changed');
const config = {
  endpoint: 'https://inference.do-ai.run', model: 'qwen3.8-max',
  timeoutMs: 30000, maxOutputTokens: 4096, maxRequestBytes: 131072,
  responseFormat: { type: 'json-schema', name: 'adaptive_extraction_scoped_v1', schema: manifest.jsonSchema },
};
const request = await prepareDigitalOceanStreamRequest({ ...config, apiKey: 'offline-control-only' }, [...manifest.messages]);
const expectedRequestSha = '44c4e286cf6484fbf243f74aaeeb23ae21a36433f9cb81019fda99d652038a86';
assert(sha(request.body) === expectedRequestSha && request.requestBytes === 47524 &&
  sha(JSON.stringify(original.requestBody)) === expectedRequestSha, 'AF52 wire must remain byte-identical');
assert(JSON.stringify(request.responseSchema) === JSON.stringify(prior.responseSchema), 'historical schema changed');
const staged = read('.stream-chunk-diagnostic-stage/DEPENDENCIES.json');
assert(staged.historicalSnapshotSha256 === historical.snapshotSha256);
const sourcePins = [
  'scripts/qualification/qualify-stream-chunk-diagnostic.mjs',
  'scripts/qualification/prepare-stream-chunk-diagnostic.mjs',
  'scripts/qualification/adaptive-full-reservation.mjs',
  'tsconfig.stream-chunk-diagnostic.json',
  'packages/clinical-core/test/stream-chunk-diagnostics.test.ts',
  '.stream-chunk-diagnostic-stage/DEPENDENCIES.json',
  ...staged.pins.map(entry => entry.stagedPath),
  ...staged.pins.filter(entry => !entry.historical).map(entry => entry.path),
  ...staged.pins.map(entry => build + entry.path.split('/').at(-1).replace(/\.ts$/, '.js')),
].map(pin);
for (const entry of staged.pins) {
  assert(sha(readFileSync(entry.stagedPath)) === entry.sha256, 'isolated staged source changed');
  if (entry.historical) assert(sha(readFileSync(entry.origin)) === entry.sha256, 'archived dependency changed');
  else assert(sha(readFileSync(entry.path)) === entry.sha256, 'diagnostic source changed after staging');
}
const baselinePath = 'docs/implementation/evidence/STREAM-CHUNK-DIAGNOSTIC-BASELINE-14e42545/BASELINE.json';
const baseline = pinned(baselinePath, '9337656705346f568b10f14f647ae6a270b6c0188ac4dd2ecdb671aeb93abd5c');
for (const entry of baseline.files) assert(sha(readFileSync(entry.archived)) === entry.sha256, 'pre-edit baseline changed');
const referencePins = [pin(historicalFreezePath), pin(historicalSnapshotPath), pin(historical.authoredPacket.path),
  pin(priorPreflightPath), pin(priorReceiptPath), pin(diagnosticFreezePath), pin(baselinePath),
  ...baseline.files.map(entry => pin(entry.archived))];
const candidateSha256 = sha(JSON.stringify({ sourcePins, referencePins, wrapperPins }));
const preflight = {
  id, caseId: 'G3', purpose: 'historical-control-structural-stream-diagnosis-only',
  historicalOperation: 'DO-AF52', historicalCandidate: historical.candidateSha256,
  protocol: 'historical-stream-chunk-diagnostic-v1', historicalProtocol: 'adaptive-extraction-scoped-v1',
  model: config.model, maximumCalls: 1, callCount: 0, maximumOutputTokens: 4096,
  timeoutMs: config.timeoutMs, maxRequestBytes: config.maxRequestBytes,
  requestBytes: request.requestBytes, requestBodySha256: expectedRequestSha,
  responseSchema: request.responseSchema, streamLimits: fullStreamLimits(4096),
  sourceSha256: prior.sourceSha256, labelsSha256: prior.labelsSha256,
  candidateSha256, sourcePins, referencePins, wrapperPins, diagnosticBounds: rejectionDiagnosticBounds,
  streamChunkDiagnosticBounds, syntheticPrefixMaxBytes: syntheticDiagnosticPrefixBytes,
  prefixPrivateOnly: true, acceptedOutput: false, productionMount: false,
  historicalArchive: historical.candidateArchive, historicalSnapshotSha256: historical.snapshotSha256,
  historicalFilesVerified: snapshot.files.length, developmentCaseIds: ['G3'],
  requestIdenticalToAF52: true, semanticsQualified: false, latencyQualified: false,
  clinicalCredit: false, appSettlement: false, defaultEnabled: false, holdoutRead: false,
};
if (!live) {
  const folder = 'docs/implementation/evidence/STREAM-CHUNK-DIAGNOSTIC-CANDIDATE-' + candidateSha256;
  assert(!existsSync(folder), 'preserve control archive');
  mkdirSync(resolve(folder, 'files'), { recursive: true });
  for (const entry of sourcePins) {
    const dest = resolve(folder, 'files', entry.path);
    mkdirSync(resolve(dest, '..'), { recursive: true });
    copyFileSync(entry.path, dest); chmodSync(dest, 0o444);
  }
  writeFileSync(resolve(folder, 'SNAPSHOT.json'), JSON.stringify({ candidateSha256,
    files: sourcePins, referencePins, wrapperPins }, null, 2) + '\n', { flag: 'wx' });
  chmodSync(resolve(folder, 'SNAPSHOT.json'), 0o444);
  writeFileSync(prefix + '-PREFLIGHT.json', JSON.stringify(preflight, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ id, state: 'offline-preflight-only', callCount: 0,
    candidateSha256, requestBytes: request.requestBytes, requestBodySha256: expectedRequestSha }));
} else {
  assert(JSON.stringify(read(prefix + '-PREFLIGHT.json')) === JSON.stringify(preflight), 'control preflight changed');
  const allocation = args.get('--reservation'), env = args.get('--env');
  assert(allocation && isAbsolute(allocation) && statSync(allocation).size <= 16384 &&
    !(statSync(allocation).mode & 0o077), 'private exact allocation required');
  const reservation = validateFullDevelopmentAllocation(read(allocation), preflight);
  assert(reservation.selected.maxCalls === 1 && reservation.selected.maxOutputTokens === 4096,
    'exact historical control allowance required');
  assert(env && isAbsolute(env) && !(statSync(env).mode & 0o077), 'private runtime environment required');
  assert(readFileSync('/Volumes/rexy/GitHub/unfiltered/docs/rebuild/USAGE-LEDGER.md', 'utf8')
    .includes(`| ${reservation.allocationId} /`), 'root ledger reservation required');
  loadEnvFile(env);
  const apiKey = process.env.DIGITALOCEAN_MODEL_ACCESS_KEY || process.env.DIGITALOCEAN_MODEL_ACESS_KEY;
  assert(apiKey, 'missing model key');
  writeFileSync(prefix + '-INTENT.json', JSON.stringify({ ...preflight, reservation,
    state: 'dispatch-intent', outcome: 'unknown', at: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' });
  let calls = 0;
  const observer = diagnosticFetch(async (url, init) => {
    assert(++calls === 1 && typeof init?.body === 'string' && sha(init.body) === expectedRequestSha,
      'one exact historical request only');
    return fetch(url, init);
  }, Date.now() + config.timeoutMs);
  let evidence;
  const partial = syntheticDiagnosticPrefix();
  let streamChunkDiagnostic;
  try {
    const result = await digitalOceanStream({ ...config, apiKey }, observer.fetcher,
      () => performance.now(), fullStreamLimits(4096)).generate([...manifest.messages], { onContent: text => partial.append(text),
        onInvalidChunk: diagnostic => { streamChunkDiagnostic = diagnostic; } });
    evidence = { ...preflight, state: 'compatibility-observed', callCount: calls,
      providerReceipt: result.receipt,
      note: 'Diagnostic only. Private synthetic prefix is unaccepted evidence, even on transport completion.' };
  } catch (error) {
    evidence = { ...preflight, state: 'compatibility-failed', callCount: calls,
      errorCode: typeof error?.code === 'string' ? error.code : 'control-failed',
      ...(error?.receipt ? { providerReceipt: error.receipt } : {}),
      note: 'Execution/usage ambiguity retains allowance. No retry or schema-cause assertion.' };
  }
  const httpDiagnostic = observer.snapshot();
  const privateEvidence = { id, candidateSha256, requestBodySha256: expectedRequestSha,
    syntheticSourceSha256: prior.sourceSha256, acceptedOutput: false,
    prefix: partial.snapshot(), ...(httpDiagnostic ? { httpDiagnostic } : {}),
    ...(streamChunkDiagnostic ? { streamChunkDiagnostic } : {}) };
  if (streamChunkDiagnostic) assert(Buffer.byteLength(JSON.stringify(streamChunkDiagnostic)) <= 2048);
  const privateBytes = JSON.stringify(privateEvidence) + '\n';
  assert(Buffer.byteLength(privateBytes) <= 65536, 'private diagnostic evidence bound');
  writeFileSync(privatePath, privateBytes, { flag: 'wx', mode: 0o600 });
  evidence.privateEvidenceSha256 = sha(readFileSync(privatePath));
  evidence.syntheticPrefixBytes = privateEvidence.prefix.bytes;
  evidence.syntheticPrefixTruncated = privateEvidence.prefix.truncated;
  evidence.invalidChunkObserved = Boolean(streamChunkDiagnostic);
  if (httpDiagnostic) evidence.httpDiagnostic = httpDiagnostic;
  evidence.reservation = { ...reservation, consumed: true, refund: false };
  writeFileSync(prefix + '.json', JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ id, state: evidence.state, callCount: calls, receipt: prefix + '.json',
    semanticsQualified: false, latencyQualified: false }));
}
