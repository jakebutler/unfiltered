/** Resume the retained native fixture for browser acceptance, without new capture. */
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference as ref } from 'convex/server';
import { loadConfig, privateJson } from '../src/config';
import { startResearchServer } from '../src/server';
import { requireFreeListener } from '../src/listener';
import { clientProjection } from '../../research/src/PublicationPreview';
import { evidenceId } from '../../../packages/research-core/src/analysis';

async function main() {
  if (!process.argv.includes('--allow-local-synthetic-reports')) throw new Error('Explicit local fixture flag required');
  const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
  const config = await loadConfig(resolve(arg('--config'))), output = resolve(arg('--output'));
  const credentials = await privateJson(resolve(arg('--operator'))) as { email: string; password: string };
  const checkpoint = JSON.parse(await readFile(resolve(arg('--checkpoint')), 'utf8'));
  assert(checkpoint.mode === 'synthetic-offline-fixture' && checkpoint.checks.length === 5);
  const { clientId, projectId } = checkpoint.fixture, analysisId = checkpoint.analysisId;
  const receipt: Record<string, unknown> = { state: 'started', at: new Date().toISOString(), mode: 'synthetic-offline-fixture', reusedNativeEvidence: resolve(arg('--checkpoint')), fixture: checkpoint.fixture, analysisId, cloudCalls: 0, providerCalls: 0, newCaptureWrites: 0 };
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  const nativeFetch = fetch;
  const boundedFetch: typeof fetch = (input, init) => {
    const origin = new URL(input instanceof Request ? input.url : String(input)).origin;
    if (![config.deployment, config.bindOrigin, config.publicOrigin].includes(origin as typeof config.deployment)) throw new Error('Loopback target changed');
    return nativeFetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(init?.signal ? [init.signal] : [])]) });
  };
  globalThis.fetch = boundedFetch;
  const operator = new ConvexHttpClient(config.deployment, { logger: false, fetch: boundedFetch });
  let runtime: Awaited<ReturnType<typeof startResearchServer>> | undefined, authenticated = false, loginFileCreated = false, phase = 'preflight';
  try {
    await requireFreeListener(() => boundedFetch(`${config.bindOrigin}/capture/health`));
    phase = 'ordinary operator authentication';
    const signed = await operator.action(ref<'action'>('auth:signIn'), { provider: 'password', params: { flow: 'signIn', email: credentials.email, password: credentials.password } }); assert(signed.tokens?.token); operator.setAuth(signed.tokens.token); authenticated = true;
    phase = 'read retained reviewed analysis';
    const row = await operator.query(ref<'query'>('researchAnalysis:read'), { clientId, projectId, analysisId }); assert.equal(row.state, 'ready'); assert(row.reviewedAt);
    runtime = await startResearchServer(config);
    phase = 'fresh exact preview and publication';
    const args = { clientId, projectId, analysisId, reviewRevision: row.revision, title: 'Synthetic offline fixture · rendered acceptance', grants: row.evidence.map((source: Parameters<typeof evidenceId>[0]) => ({ evidenceId: evidenceId(source), view: true, download: false })) };
    const preview = await operator.query(ref<'query'>('researchReports:preview'), args);
    const publication = await operator.mutation(ref<'mutation'>('researchReports:publish'), { ...args, previewHash: preview.previewHash, requestId: `browser-publication-${checkpoint.id}` });
    phase = 'password grant';
    const body = JSON.stringify({ clientId, projectId, reportId: publication.reportId, requestId: `browser-share-${checkpoint.id}`, password: 'Synthetic-report-only-2026' });
    const response = await boundedFetch(`${config.bindOrigin}/api/research/shares`, { method: 'POST', headers: { Origin: config.publicOrigin, Authorization: `Bearer ${signed.tokens.token}`, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) }, body }); assert.equal(response.status, 200);
    const share = await response.json();
    // Sanitized credentials permit the existing DEV file import to perform ordinary Password sign-in.
    await writeFile(resolve('apps/research-server/runtime/browser-login.private.json'), JSON.stringify({ email: credentials.email, password: credentials.password }), { mode: 0o600, flag: 'wx' });
    loginFileCreated = true;
    receipt.state = 'browser-ready'; receipt.reportId = publication.reportId; receipt.shareId = share.shareId; receipt.slug = share.slug; receipt.url = share.url; receipt.preview = clientProjection(preview);
    await writeFile(output, JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify({ state: receipt.state, evidence: output, url: share.url }));
    await new Promise<void>(resolveDone => { process.once('SIGINT', resolveDone); process.once('SIGTERM', resolveDone); });
  } catch (error) { receipt.state = 'failed'; receipt.failure = { phase, name: (error as Error).name }; process.exitCode = 1; }
  finally {
    await runtime?.close(); receipt.ownedGatewayStopped = true;
    if (authenticated) { try { await operator.action(ref<'action'>('auth:signOut'), {}); receipt.operatorSignedOut = true; } catch { receipt.operatorSignedOut = false; } }
    if (loginFileCreated) await unlink(resolve('apps/research-server/runtime/browser-login.private.json')).catch(() => undefined);
    globalThis.fetch = nativeFetch; receipt.finishedAt = new Date().toISOString(); await writeFile(output, JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify({ state: receipt.state, failure: receipt.failure, evidence: output }));
  }
}
void main().catch(() => { console.error('Browser acceptance preparation failed; private details withheld.'); process.exitCode = 1; });
