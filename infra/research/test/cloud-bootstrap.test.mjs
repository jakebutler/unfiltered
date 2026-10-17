import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TARGET, CAPTURE_LIMITS, plan, freshSecrets, phase, secretsValid } from '../cloud-bootstrap.mjs';
import { cloudAdapter, boundedFetch, main } from '../setup-cloud.mjs';
const prepared = () => plan(TARGET, { allocationId: 'cloud-demo-phase-1', expiresAt: Date.now() + 86_000_000 });
const secrets = freshSecrets(TARGET); // Offline, in-memory test key; never written/provisioned.
function fake() {
  const env = new Map([['CONVEX_SITE_URL', TARGET.convexSite]]), calls = [], state = { user: null, allocation: null };
  return { env, calls, state, adapter: { verifyTarget: async () => { calls.push('verify'); }, environment: async name => env.get(name) ?? null,
    updateEnvironment: async changes => { calls.push('env-write'); for (const item of changes) env.set(item.name, item.value); },
    query: async name => name === 'bootstrap:existing' ? state.user : name === 'bootstrap:operatorEmail' ? secrets.email : { allocation: state.allocation },
    action: async () => { calls.push('operator-write'); state.user = 'synthetic-user'; return state.user; },
    mutation: async (_name, args) => { calls.push('allocation-write'); state.allocation = { ...args, requestsConsumed: 0 }; } } };
}
test('default preflight reads public source only and performs zero cloud calls despite ambient local/cloud selectors', async () => {
  const old = globalThis.fetch; globalThis.fetch = () => { throw new Error('Unexpected network'); };
  try { const result = await main(['--manifest', new URL('../cloud-target.json', import.meta.url).pathname, '--allocation-id', 'cloud-demo-phase-1', '--expires-at', new Date(Date.now() + 86_000_000).toISOString()]);
    assert.equal(result.cloudCalls, 0); assert.equal(result.allocation.storageOperationLimit, 25); assert.deepEqual(result.runtimeDefaults, { speechEnabled: false, analysis: { enabled: false }, interview: { enabled: false } }); assert.equal(result.schedulerOrigin, null);
  } finally { globalThis.fetch = old; }
});
test('pins all target fields, prospective bounds and separate cloud credentials', () => {
  for (const key of ['deployment', 'convexSite', 'canonicalOrigin', 'team', 'project', 'vercelProjectId']) assert.throws(() => plan({ ...TARGET, [key]: 'other' }, { allocationId: 'cloud-demo-phase-1', expiresAt: Date.now() + 1000 }));
  assert.throws(() => plan({ ...TARGET, extra: true }, { allocationId: 'cloud-demo-phase-1', expiresAt: Date.now() + 1000 }));
  assert.throws(() => plan(TARGET, { allocationId: 'cloud-demo-phase-1', expiresAt: Date.now() - 1 }));
  assert.throws(() => plan(TARGET, { allocationId: 'cloud-demo-phase-1', expiresAt: Date.now() + 86_400_001 }));
  assert.throws(() => secretsValid({ ...secrets, mode: 'local' }, TARGET)); assert.throws(() => secretsValid({ ...secrets, email: 'operator@corvo.example' }, TARGET));
});
test('aligns only missing env values and refuses existing mismatches or scheduler activation', async () => {
  const f = fake(), p = prepared(); await phase('align-auth', p, secrets, f.adapter); assert.equal(f.calls.filter(c => c === 'env-write').length, 1);
  await phase('align-auth', p, secrets, f.adapter); assert.equal(f.calls.filter(c => c === 'env-write').length, 1);
  f.env.set('JWKS', 'unrelated-existing-key'); await assert.rejects(phase('align-auth', p, secrets, f.adapter));
  f.env.set('RESEARCH_HOSTED_GATEWAY_ORIGIN', TARGET.canonicalOrigin); await assert.rejects(phase('append-allocation', p, secrets, f.adapter)); assert.equal(f.calls.includes('allocation-write'), false);
});
test('unknown create acknowledgement is reconciled by readback only, absence never recreates partial operator', async () => {
  const f = fake(), p = prepared(); await phase('align-auth', p, secrets, f.adapter);
  f.adapter.action = async () => { f.calls.push('operator-write'); throw new Error('Unknown after account creation'); };
  await assert.rejects(phase('bootstrap-operator', p, secrets, f.adapter));
  assert.equal((await phase('bootstrap-operator', p, secrets, f.adapter, { readback: true })).state, 'unconfirmed'); assert.equal(f.calls.filter(c => c === 'operator-write').length, 1);
  f.state.user = 'synthetic-user'; assert.equal((await phase('bootstrap-operator', p, secrets, f.adapter, { readback: true })).state, 'confirmed'); assert.equal(f.calls.filter(c => c === 'operator-write').length, 1);
});
test('immutable allocations preserve charges; mismatched/enlarged envelope cannot append', async () => {
  const f = fake(), p = prepared(); await phase('append-allocation', p, secrets, f.adapter); f.state.allocation.requestsConsumed = 99;
  await phase('append-allocation', p, secrets, f.adapter, { readback: true }); assert.equal(f.state.allocation.requestsConsumed, 99); assert.equal(f.calls.filter(c => c === 'allocation-write').length, 1);
  await assert.rejects(phase('append-allocation', { ...p, allocation: { ...p.allocation, storageOperationLimit: 200 } }, secrets, f.adapter));
  f.state.allocation.expiresAt++; await assert.rejects(phase('append-allocation', p, secrets, f.adapter));
});
test('gateway alignment leaves cleanup origin absent and preserves exact capture/default provider bounds', async () => {
  const f = fake(); await phase('align-gateway', prepared(), secrets, f.adapter);
  assert.deepEqual(JSON.parse(f.env.get('RESEARCH_CAPTURE_LIMITS_JSON')), CAPTURE_LIMITS); assert.equal(f.env.has('RESEARCH_HOSTED_GATEWAY_ORIGIN'), false); assert.equal([...f.env.keys()].some(k => /DEEPGRAM|ELEVEN|DIGITALOCEAN/.test(k)), false);
});
test('existing CLI auth authorizes only pinned deployment, denying changed project before admin or write', async () => {
  const calls = [], adapter = cloudAdapter('offline-only-cli-token', async (url, init) => { calls.push([url, init]); return new Response(JSON.stringify(calls.length === 1 ? { team: TARGET.team, project: TARGET.project } : { deploymentName: TARGET.deploymentName, url: TARGET.deployment, deploymentType: 'dev', adminKey: 'offline-only-admin' })); });
  await adapter.verifyTarget(); assert.equal(calls.length, 2); assert.equal(calls[1][0], 'https://api.convex.dev/api/deployment/authorize_within_current_project'); assert.equal(JSON.parse(calls[1][1].body).selectedDeploymentName, TARGET.deploymentName); assert.equal(calls.some(([url]) => url.includes('provision_and_authorize')), false);
  const denied = cloudAdapter('offline', async () => new Response(JSON.stringify({ team: TARGET.team, project: 'other' }))); await assert.rejects(denied.verifyTarget());
});
test('transport denies wrong endpoint/method/redirect, streams bounded responses and suppresses secret error payload', async () => {
  let calls = 0; const fetcher = async () => { calls++; return new Response('ok'); };
  for (const [url, method] of [[TARGET.deployment + '/api/query', 'GET'], ['https://other.convex.cloud/api/query', 'POST'], [TARGET.deployment + '/api/query?target=x', 'POST'], ['https://api.convex.dev/api/deployment/provision_and_authorize', 'POST']]) await assert.rejects(boundedFetch(fetcher, url.startsWith('https://api.convex.dev') ? 'https://api.convex.dev' : TARGET.deployment, url, { method }));
  assert.equal(calls, 0);
  await assert.rejects(boundedFetch(async () => new Response('private-secret-error', { headers: { 'Content-Length': '9999999' } }), TARGET.deployment, TARGET.deployment + '/api/query', { method: 'POST' }), error => !error.message.includes('private-secret-error'));
  await assert.rejects(boundedFetch(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65_537)); controller.close(); } })), TARGET.deployment, TARGET.deployment + '/api/query', { method: 'POST' }));
  const response = await boundedFetch(async (_url, init) => { assert.equal(init.redirect, 'error'); return new Response('bounded'); }, TARGET.deployment, TARGET.deployment + '/api/query', { method: 'POST' }); assert.equal(await response.text(), 'bounded');
});

test('push credential export is exact dev-only, exclusive and readback-only after acknowledgement loss', async () => {
  const { mkdtemp, rm, stat, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path'); const { pushEnvironment } = await import('../setup-cloud.mjs');
  for (const key of ['prod:elegant-crane-662|x', 'dev:other|x', 'project:team:project|x', 'dev:elegant-crane-662|x\nOTHER=y', 'dev:elegant-crane-662|', 'dev:elegant-crane-662|x|extra']) assert.throws(() => pushEnvironment(key));
  const directory = await mkdtemp(join(tmpdir(), 'offline-cloud-export-')), path = join(directory, 'push.cloud.env'); let calls = 0;
  const adapter = cloudAdapter('offline-token', async () => new Response(JSON.stringify([++calls % 4 === 1 ? { team: TARGET.team, project: TARGET.project } : calls % 4 === 2 ? { deploymentName: TARGET.deploymentName, url: TARGET.deployment, deploymentType: 'dev', adminKey: 'dev:elegant-crane-662|offline_fixture' } : calls % 4 === 3 ? TARGET.deployment : { team: TARGET.team, project: TARGET.project }][0])), { pushEnvPath: path });
  try {
    const receipt = await phase('export-push-credential', prepared(), secrets, adapter); assert.equal(receipt.state, 'confirmed'); assert.equal((await stat(path)).mode & 0o077, 0); assert.equal(await readFile(path, 'utf8'), 'CONVEX_DEPLOY_KEY=dev:elegant-crane-662|offline_fixture\n');
    await assert.rejects(phase('export-push-credential', prepared(), secrets, adapter)); assert.equal((await phase('export-push-credential', prepared(), secrets, adapter, { readback: true })).writes, 0);
    assert.equal(JSON.stringify(receipt).includes('offline_fixture'), false);
  } finally { await rm(directory, { recursive: true }); }
});

test('opaque exact URL/admin export preserves raw credential and contains no ambient project/deployment selectors', async () => {
  const { exactPushEnvironment } = await import('../setup-cloud.mjs'), dotenv = (await import('dotenv')).default;
  const raw = 'opaque-token#with$literal"and\\n_no_prefix';
  const text = exactPushEnvironment(raw), env = dotenv.parse(text);
  assert.deepEqual(env, { CONVEX_SELF_HOSTED_URL: TARGET.deployment, CONVEX_SELF_HOSTED_ADMIN_KEY: raw });
  assert.equal(text.split('\n').filter(Boolean).length, 2); assert.equal('CONVEX_DEPLOYMENT' in env, false); assert.equal('CONVEX_DEPLOY_KEY' in env, false); assert.equal('CONVEX_DEPLOYMENT_TOKEN' in env, false);
  for (const bad of ['', 'x\nCONVEX_DEPLOYMENT=other', 'x\r', "x'y", 'x\0', 'x\\']) assert.throws(() => exactPushEnvironment(bad));
});
test('separate exact export is exclusive, private and never reaches provisioning or guesses token deployment type', async () => {
  const { mkdtemp, rm, readFile, stat } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'offline-exact-export-')), path = join(directory, 'push-exact.cloud.env'), calls = [];
  const adapter = cloudAdapter('offline-token', async (url, init) => { calls.push(url); return new Response(JSON.stringify(url.endsWith('team_and_project') ? { team: TARGET.team, project: TARGET.project } : { deploymentName: TARGET.deploymentName, url: TARGET.deployment, deploymentType: 'dev', adminKey: 'opaque_without_deployment_prefix' })); }, { exactPushEnvPath: path });
  try {
    const receipt = await phase('export-exact-credential', prepared(), secrets, adapter); assert.equal(receipt.deploymentType, 'dev'); assert.equal(receipt.transportSelector, 'explicit-url-admin'); assert.equal((await stat(path)).mode & 0o077, 0);
    const before = await readFile(path, 'utf8'); await assert.rejects(phase('export-exact-credential', prepared(), secrets, adapter));
    assert.equal((await phase('export-exact-credential', prepared(), secrets, adapter, { readback: true })).writes, 0); assert.equal(await readFile(path, 'utf8'), before);
    assert.equal(calls.every(url => url.endsWith('team_and_project') || url.endsWith('authorize_within_current_project')), true); assert.equal(JSON.stringify(receipt).includes('opaque_without'), false);
  } finally { await rm(directory, { recursive: true }); }
});
test('wrong exact cloud URL or prod authorization cannot create an opaque push export', async () => {
  const { mkdtemp, rm, stat } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'offline-denied-export-')), path = join(directory, 'push-exact.cloud.env');
  try { for (const mismatch of [{ url: 'https://other.convex.cloud' }, { deploymentType: 'prod' }]) {
    const adapter = cloudAdapter('offline-token', async url => new Response(JSON.stringify(url.endsWith('team_and_project') ? { team: TARGET.team, project: TARGET.project } : { deploymentName: TARGET.deploymentName, url: TARGET.deployment, deploymentType: 'dev', adminKey: 'opaque', ...mismatch })), { exactPushEnvPath: path });
    await assert.rejects(phase('export-exact-credential', prepared(), secrets, adapter)); await assert.rejects(stat(path), { code: 'ENOENT' });
  } } finally { await rm(directory, { recursive: true }); }
});
