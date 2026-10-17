/** Prospective ONE-call compatibility probe. No default live execution, retry, sweep or fallback. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClinicContent } from '../../.stream-compact-build/packages/clinic-content/src/index.js';
import { prepareDigitalOceanStreamRequest } from '../../.stream-compact-build/packages/clinical-core/src/digitalocean-stream.js';
import { createCompactReplyManifest as createReplyDraftManifest, consumeCompactReplyStream as consumeReplyDraftStream, compactReplyProtocol as replyDraftProtocol, compactReplySchemaName as replyDraftSchemaName, compactReplyValidationRevision as replyDraftValidationRevision, createSyntheticPartialCapture } from '../../.stream-compact-build/packages/clinic-api/src/adaptive-reply-compact.js';
const argument = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const allowed = new Set(['--id', '--env', '--live']);
for (let i = 2; i < process.argv.length; i++) { assert(allowed.has(process.argv[i]), 'unsupported argument'); if (process.argv[i] !== '--live') { assert(process.argv[++i], 'missing argument'); } }
const id = argument('--id'), live = process.argv.includes('--live'), envPath = argument('--env');
assert(id !== 'DO-AS1' && /^DO-AS[1-9][0-9]*$/.test(id ?? ''), 'explicit unique DO-AS operation required');
assert(live || !envPath, 'offline preflight must not load an environment');
const workspace = resolve(fileURLToPath(new URL('../../', import.meta.url)));
assert(resolve(process.cwd()) === workspace, 'run in this implementation workspace');
const prefix = `docs/implementation/evidence/${id}`;
for (const suffix of ['-INTENT.json', '.json']) assert(!existsSync(prefix + suffix), 'prior dispatch/result evidence exists; never overwrite/retry it');
if (!live) assert(!existsSync(prefix + '-PREFLIGHT.json'), 'preflight evidence already exists');
const fingerprintPaths = [
  'scripts/qualification/qualify-adaptive-stream-compact.mjs', 'tsconfig.stream-compact.json', 'tsconfig.stream-qualification.json', 'tsconfig.foundation.json',
  'packages/clinical-core/src/streaming-transport.ts', 'packages/clinical-core/src/action-first-object.ts',
  'packages/clinical-core/src/digitalocean-stream.ts', 'packages/clinical-core/src/digitalocean.ts', 'packages/clinical-core/src/transport.ts',
  'packages/clinic-api/src/adaptive-reply-compact.ts', 'packages/clinic-api/src/adaptive-reply.ts', 'packages/clinic-api/src/adaptive-source.ts', 'packages/clinic-api/src/dialogue.ts', 'packages/clinic-api/src/adaptive-validation.ts',
  'packages/clinical-core/src/domain.ts',
  ...['index', 'types', 'content', 'slots', 'register', 'readiness', 'guided', 'branches', 'scenarios', 'mental-health'].map(name => `packages/clinic-content/src/${name}.ts`),
  'scripts/qualification/qualify-adaptive.mjs',
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fingerprints = fingerprintPaths.map(source => {
  const dispatched = source.endsWith('.ts') ? `.stream-compact-build/${source.slice(0, -3)}.js` : source;
  assert(dispatched === source || statSync(dispatched).mtimeMs >= statSync(source).mtimeMs, 'fresh root-reviewed build required before running this harness');
  return { source: { path: resolve(source), sha256: sha(readFileSync(source)) }, dispatched: { path: resolve(dispatched), sha256: sha(readFileSync(dispatched)) } };
});
// Fixed existing development G1 text copied from qualify-adaptive.mjs: no holdout reader exists here.
const source = { id: 'development-g1', role: 'patient', at: '2026-10-09T12:00:00.000Z', text: "I'm five feet eight inches. The scale read 230 pounds on August 12. I'm not sure whether that still reflects my weight; I estimate 235 pounds now." };
const register = createClinicContent({ mentalHealth: 'phq4' });
const context = { binding: { operationId: id, sessionId: 'compatibility-only', patient: 'Patient/synthetic-only', scenario: 'first-intake', revision: 1, contentVersion: 'CC-0.2.phq4', snapshotDigest: 'compatibility-only' }, source, sources: [source],
  topics: register.topics.filter(topic => ['Q04', 'Q05'].includes(topic.id)), responses: {}, displayed: { topicId: 'Q04', promptId: 'Q04', targetPaths: ['height.value', 'height.unit'] } };
const manifest = createReplyDraftManifest(context);
const baseConfig = { endpoint: 'https://inference.do-ai.run', model: 'qwen3.8-max', timeoutMs: 12000, maxOutputTokens: 2048, maxRequestBytes: 60000 };
const prepared = await prepareDigitalOceanStreamRequest({ ...baseConfig, apiKey: 'offline-preflight-only', responseFormat: { type: 'json-schema', name: replyDraftSchemaName, schema: manifest.jsonSchema } }, [...manifest.messages]);
const preflight = { id, purpose: 'single-stream-compact-native-schema-order-compatibility-only', syntheticOnly: true, protocol: replyDraftProtocol, validationRevision: replyDraftValidationRevision,
  model: baseConfig.model, callCount: 0, maximumCalls: 1, maximumOutputTokens: baseConfig.maxOutputTokens, requestBytes: prepared.requestBytes,
  sourceSha256: sha(source.text), manifest: { id: manifest.id, sha256: manifest.sha256 }, responseSchema: prepared.responseSchema, implementationFingerprints: fingerprints,
  semanticsQualified: false, latencyQualified: false, defaultEnabled: false };
if (!live) {
  writeFileSync(prefix + '-PREFLIGHT.json', JSON.stringify(preflight, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ id, state: 'offline-preflight-only', callCount: 0, requestBytes: prepared.requestBytes, receipt: prefix + '-PREFLIGHT.json' }));
} else {
  assert(existsSync(prefix + '-PREFLIGHT.json'), 'reviewed offline preflight required before live');
  assert(JSON.stringify(JSON.parse(readFileSync(prefix + '-PREFLIGHT.json', 'utf8'))) === JSON.stringify(preflight), 'preflight/source/build changed; do not dispatch');
  // Explicit --live is insufficient alone: root must reserve this exact id first.
  assert(envPath && isAbsolute(envPath) && !(statSync(envPath).mode & 0o077), 'private absolute environment file required for separately authorized live execution');
  const ledger = readFileSync('/Volumes/rexy/GitHub/unfiltered/docs/rebuild/USAGE-LEDGER.md', 'utf8');
  assert(ledger.includes(`| ${id} /`), 'root must reserve this exact compatibility operation in the shared ledger first');
  loadEnvFile(envPath);
  const apiKey = process.env.DIGITALOCEAN_MODEL_ACCESS_KEY || process.env.DIGITALOCEAN_MODEL_ACESS_KEY;
  assert(apiKey, 'missing model access key');
  const started = performance.now(), advances = [];
  const partial = createSyntheticPartialCapture();
  const retainSyntheticContent = text => partial.append(text), partialEvidence = () => partial.snapshot();
  let calls = 0;
  writeFileSync(prefix + '-INTENT.json', JSON.stringify({ ...preflight, state: 'dispatch-intent', outcome: 'unknown', at: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' });
  const fetcher = async (url, init) => { assert(++calls === 1, 'one-call limit'); return fetch(url, init); };
  let evidence;
  try {
    const result = await consumeReplyDraftStream({ ...baseConfig, apiKey }, manifest, { fetcher, onSyntheticContent: retainSyntheticContent, onAdvance: packet => { advances.push({ observedAfterDispatchMs: performance.now() - started, packet, durable: false, audible: false }); } });
    evidence = { ...preflight, state: 'compatibility-observed', callCount: calls, providerReceipt: result.receipt, advances, partialContentEvidence: partialEvidence(), draft: result.draft, admission: result.admission,
      note: 'A complete packet is not semantic qualification, a durable app reply or whole-voice latency evidence.' };
  } catch (error) {
    evidence = { ...preflight, state: 'compatibility-failed', callCount: calls, advances, partialContentEvidence: partialEvidence(),
      errorCode: typeof error?.code === 'string' ? error.code : 'stream-probe-failed', ...(error?.receipt ? { providerReceipt: error.receipt } : {}),
      note: 'Unknown provider/billing outcomes retain the reservation; do not retry or fall back.' };
  }
  writeFileSync(prefix + '.json', JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ id, state: evidence.state, callCount: calls, receipt: prefix + '.json', semanticsQualified: false, latencyQualified: false }));
}
