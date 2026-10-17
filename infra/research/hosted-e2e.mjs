/** Root-owned, single-envelope hosted qualification. No implicit provisioning or retries. */
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference as ref } from 'convex/server';
import dotenv from 'dotenv';
import { boundedFetch } from './setup-cloud.mjs';
import { privateJson } from '../../apps/research-server/src/private-json.mjs';
const target = 'https://elegant-crane-662.convex.cloud';
const directory = resolve('infra/cloud/.private');
const planPath = `${directory}/research-hosted-e2e-a1-plan.json`;
const runtimePath = `${directory}/research-hosted-e2e-a1-runtime.json`;
const envelopePath = `${directory}/research-hosted-e2e-a1-envelope.json`;
const bootstrapPath = resolve('infra/research/.env.cloud-bootstrap/bootstrap.cloud.private.json');
const safeWrite = (path, data) => writeFile(path, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const client = () => new ConvexHttpClient(target, { logger: false, fetch: (input, init) => boundedFetch(fetch, target, input, init) });
async function admin() {
  const path = resolve('infra/research/.env.cloud-bootstrap/push-exact.cloud.env');
  const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 10000) throw new Error('Private exact credential required');
  const environment = dotenv.parse(await readFile(path, 'utf8'));
  if (environment.CONVEX_SELF_HOSTED_URL !== target || Object.keys(environment).length !== 2 || !environment.CONVEX_SELF_HOSTED_ADMIN_KEY) throw new Error('Exact target differs');
  const value = client(); value.setAdminAuth(environment.CONVEX_SELF_HOSTED_ADMIN_KEY); return { value, key: environment.CONVEX_SELF_HOSTED_ADMIN_KEY };
}
function exactly(rows, name) { const found = rows.page.filter(row => row.name === name); if (!rows.isDone || found.length !== 1) throw new Error('Unique bounded UI scope unavailable'); return found[0]; }
/** Reconcile only the two historical successful requests adjudicated by root.
 * This is not an expiry sweeper and cannot select a different lease or generation. */
export async function reconcileHistoricalLease(kind) {
  const expected = {
    operation: { leaseId: 'm1713zycnn96heebc5mzwh4zfx8g0c6q', generation: 1, owner: 'c74f4b18fd7a25fd268f834477637b7e', requestId: '273c4a36948d4bcd990c59c75e27a2a8' },
    upload: { leaseId: 'm173a52tx2tw1hbzea4qrtvwbd8g0f3m', generation: 9, owner: '66d4bca868ec1da75c346a97c7a8d78d', requestId: 'd551bdaa5f4a495c16df60abace2b33c' },
  }[kind];
  if (!expected) throw new Error('Exact historical lease required');
  const approval = await privateJson(`${directory}/research-hosted-e2e-a1-reconciliation-approval.json`);
  if (approval.state !== 'root-reviewed-known-terminal' || !approval.kinds?.includes(kind)) throw new Error('Explicit evidence adjudication required');
  const { value } = await admin();
  const before = await value.query(ref('researchGatewayLeases:readiness'), { allocationId: 'research-cloud-20261010-e2e-a1' });
  const row = before.slots.find(row => row.lease.leaseId === expected.leaseId);
  if (!row?.workStarted || row.lease.kind !== kind || row.lease.allocationId !== 'research-cloud-20261010-e2e-a1' || Object.entries(expected).some(([key, value]) => row.lease[key] !== value)) throw new Error('Historical native identity changed');
  const prefix = `${directory}/research-hosted-e2e-a1-reconcile-${kind}`;
  await safeWrite(`${prefix}.intent.json`, { expected, evidence: approval, before, at: new Date().toISOString() });
  const { signGateway } = await import('../../packages/research-capture/src/proof.ts');
  const runtime = await privateJson(runtimePath);
  const proof = await signGateway(runtime.gatewaySecret, 'lease-release', expected);
  const accepted = await client().mutation(ref('researchGatewayLeases:release'), { ...expected, proof });
  await safeWrite(`${prefix}.result.json`, { accepted, at: new Date().toISOString() });
  if (accepted !== true) throw new Error('Historical release unacknowledged; do not replay');
  const after = await value.query(ref('researchGatewayLeases:readiness'), { allocationId: 'research-cloud-20261010-e2e-a1' });
  await safeWrite(`${prefix}.readback.json`, after);
  const settled = after.slots.find(row => row.lease.leaseId === expected.leaseId);
  if (!settled || settled.workStarted || settled.lease.expiresAt !== 0 || Object.entries(expected).some(([key, value]) => settled.lease[key] !== value) || JSON.stringify(before.allocation) !== JSON.stringify(after.allocation)) throw new Error('Historical reconciliation readback differs');
  return { kind, acknowledged: true, countersUnchanged: true, providerCalls: 0, storageCalls: 0 };
}
export async function runContinuation(phase) {
  const envelope = await privateJson(`${directory}/research-hosted-e2e-cont-a1-envelope.json`);
  const expiresAt = Date.parse(envelope.expiresAt);
  if (envelope.id !== 'RESEARCH-HOSTED-E2E-CONT-20261010-A1' || envelope.parent !== 'RESEARCH-HOSTED-E2E-20261010-A1' || envelope.allocationId !== 'research-cloud-20261010-e2e-cont-a1' || envelope.storageOperationLimit !== 80 || envelope.requestLimit !== 500 || envelope.readByteLimit !== 100000000 || envelope.additionalProviderCalls !== 0 || envelope.cashAllowed !== 0 || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new Error('Approved continuation unavailable');
  const prefix = `${directory}/research-hosted-e2e-cont-a1`;
  if (phase === 'prepare') {
    const original = await privateJson(runtimePath);
    if (original.allocationId !== 'research-cloud-20261010-e2e-a1') throw new Error('Original runtime differs');
    await safeWrite(`${prefix}-runtime.json`, { ...original, allocationId: envelope.allocationId });
    return { phase, privateRuntime: `${prefix}-runtime.json`, providerAllowanceChanged: false };
  }
  const { value, key } = await admin();
  if (phase === 'readback') return value.query(ref('researchGatewayLeases:readiness'), { allocationId: envelope.allocationId });
  if (!['allocation', 'bind-allocation'].includes(phase)) throw new Error('Explicit continuation phase required');
  await safeWrite(`${prefix}-${phase}.intent.json`, { phase, envelopeId: envelope.id, target, at: new Date().toISOString() });
  if (phase === 'allocation') await value.mutation(ref('researchGatewayLeases:provisionAllocation'), { allocationId: envelope.allocationId, expiresAt, requestLimit: envelope.requestLimit, readByteLimit: envelope.readByteLimit, storageOperationLimit: envelope.storageOperationLimit });
  else {
    const response = await boundedFetch(fetch, target, `${target}/api/update_environment_variables`, { method: 'POST', headers: { Authorization: `Convex ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ changes: [{ name: 'RESEARCH_HOSTED_GATEWAY_ALLOCATION', value: envelope.allocationId }] }) });
    if (!response.ok) throw new Error('Continuation binding acknowledgement unknown');
  }
  await safeWrite(`${prefix}-${phase}.result.json`, { phase, acknowledgedAt: new Date().toISOString() });
  return { phase, acknowledged: true, providerCalls: 0, storageCalls: 0 };
}
export async function run(phase) {
  const envelope = await privateJson(envelopePath), expiresAt = Date.parse(envelope.expiresAt);
  if (envelope.id !== 'RESEARCH-HOSTED-E2E-20261010-A1' || envelope.allocationId !== 'research-cloud-20261010-e2e-a1' || envelope.storageOperations !== 60 || envelope.digitalOcean.maximumCalls !== 2 || envelope.deepgramSeconds !== 60 || envelope.elevenLabsCharacters !== 600 || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new Error('Approved finite envelope unavailable');
  if (phase === 'prepare') {
    // Reads an already UI-created scope through ordinary operator authority.
    const credentials = await privateJson(bootstrapPath), operator = client(); let signedIn = false;
    try {
      const login = await operator.action(ref('auth:signIn'), { provider: 'password', params: { flow: 'signIn', email: credentials.email, password: credentials.password } });
      if (!login.tokens?.token) throw new Error('Operator authentication unavailable'); operator.setAuth(login.tokens.token); signedIn = true;
      const paginationOpts = { numItems: 25, cursor: null };
      const owner = exactly(await operator.query(ref('research:clients'), { paginationOpts }), 'Synthetic hosted journey E2E-A1');
      const project = exactly(await operator.query(ref('research:projects'), { clientId: owner._id, paginationOpts }), 'Hosted checkout study E2E-A1');
      const scope = { clientId: owner._id, projectId: project._id };
      const study = await operator.query(ref('research:readStudy'), { ...scope, version: 1 });
      if (!study || study.definition.title !== 'Synthetic hosted checkout study' || study.definition.script.length !== 2) throw new Error('Saved UI study differs');
      const plan = { envelopeId: envelope.id, target, scope, studyId: study.studyId, expiresAt,
        allocation: { allocationId: envelope.allocationId, expiresAt, requestLimit: envelope.requests, readByteLimit: envelope.readBytes, storageOperationLimit: envelope.storageOperations },
        speech: { name: 'research-hosted-e2e-speech-a1', studyId: study.studyId, enabled: true, allocatedSeconds: 60, allocatedCharacters: 600, maxSessionSeconds: 60, maxSessionCharacters: 600, expiresAt },
        interview: { enabled: true, allocatedCalls: 1, maxSessionCalls: 1, model: 'qwen3.8-max', maxInputBytes: 64000, maxOutputTokens: 512, expiresAt } };
      await safeWrite(planPath, plan);
      await safeWrite(runtimePath, { gatewaySecret: credentials.gatewaySecret, allocationId: envelope.allocationId, speechEnabled: true,
        analysis: { enabled: true, provider: 'digitalocean', model: 'qwen3.8-max', qualificationId: 'DO-V1', timeoutMs: 15000, maxRequestBytes: 64000, reservations: [{ id: 'research-hosted-e2e-analysis-a1', maxInputBytes: 64000, maxOutputTokens: 1024, expiresAt }] },
        interview: { enabled: true, model: 'qwen3.8-max', timeoutMs: 15000, maxRequestBytes: 64000, maxOutputTokens: 512 } });
      return { phase, scope, studyId: study.studyId, expiresAt, privatePlan: planPath, privateRuntime: runtimePath, adminWrites: 0 };
    } finally { if (signedIn) await operator.action(ref('auth:signOut'), {}); }
  }
  const plan = await privateJson(planPath);
  if (plan.target !== target || plan.envelopeId !== envelope.id || plan.expiresAt !== expiresAt) throw new Error('Prepared envelope differs');
  const { value, key } = await admin();
  const query = (name, args) => value.query(ref(name), args);
  if (phase === 'readback') return { phase,
    allocation: await query('researchGatewayLeases:readiness', { allocationId: plan.allocation.allocationId }),
    speech: await query('researchSpeechGrants:readiness', { name: plan.speech.name, sessionIds: [] }),
    interview: await query('_system/cli/tableData', { table: 'researchInterviewPolicy', order: 'desc', paginationOpts: { numItems: 2, cursor: null } }),
    allocationBinding: await query('_system/cli/queryEnvironmentVariables:get', { name: 'RESEARCH_HOSTED_GATEWAY_ALLOCATION' }) };
  const phases = { allocation: ['researchGatewayLeases:provisionAllocation', plan.allocation], speech: ['researchSpeechGrants:provision', plan.speech], interview: ['researchInterview:provision', plan.interview], 'disable-speech': ['researchSpeechGrants:disable', { name: plan.speech.name }] };
  if (!(phase in phases) && phase !== 'bind-allocation') throw new Error('Explicit supported phase required');
  await safeWrite(`${directory}/research-hosted-e2e-a1-${phase}.intent.json`, { phase, envelopeId: envelope.id, target, preparedAt: new Date().toISOString() });
  if (phase === 'bind-allocation') {
    const response = await boundedFetch(fetch, target, `${target}/api/update_environment_variables`, { method: 'POST', headers: { Authorization: `Convex ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ changes: [{ name: 'RESEARCH_HOSTED_GATEWAY_ALLOCATION', value: plan.allocation.allocationId }] }) });
    if (!response.ok) throw new Error('Binding acknowledgement unknown');
  } else await value.mutation(ref(phases[phase][0]), phases[phase][1]);
  await safeWrite(`${directory}/research-hosted-e2e-a1-${phase}.result.json`, { phase, acknowledgedAt: new Date().toISOString() });
  return { phase, acknowledged: true, providerCalls: 0, storageCalls: 0 };
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  try { console.log(JSON.stringify(await run(process.argv[2]))); } catch { console.error('Hosted qualification phase failed or acknowledgement unknown; do not replay.'); process.exitCode = 1; }
}
