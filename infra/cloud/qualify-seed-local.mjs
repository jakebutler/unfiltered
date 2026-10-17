import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { seedClinic } from './seed-clinic.mjs';
if (!process.argv.includes('--allow-local-synthetic-writes')) throw new Error('local-write-flag-required');
const baseUrl = 'http://localhost:8103/';
const env = Object.fromEntries(readFileSync('infra/local/.env', 'utf8').split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
let token;
async function request(path, body, method = body === undefined ? 'GET' : 'POST', headers = {}) {
  const response = await fetch(new URL(path, baseUrl), { method, redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/fhir+json', 'X-Medplum': 'extended', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`local-seed-qualification-http-${response.status}`);
  return response.json();
}
token = (await request('oauth2/token', new URLSearchParams({ grant_type: 'client_credentials', client_id: env.MEDPLUM_DEFAULT_SUPER_ADMIN_CLIENT_ID, client_secret: env.MEDPLUM_DEFAULT_SUPER_ADMIN_CLIENT_SECRET }).toString(), 'POST', { 'Content-Type': 'application/x-www-form-urlencoded' })).access_token;
const runId = randomUUID(), evidence = [];
for (const injectFailure of [false, true]) {
  const project = await request('fhir/R4/Project', { resourceType: 'Project', name: `Corvo portable seed qualification ${runId} ${injectFailure ? 'failure' : 'success'}`, features: [] });
  const client = await request(`admin/projects/${project.id}/client`, { name: 'Synthetic seed qualification setup' });
  const found = await request(`fhir/R4/ProjectMembership?profile=ClientApplication/${client.id}&_count=2`);
  assert.equal(found.entry.length, 1);
  const member = found.entry[0].resource;
  // Test-fixture setup only: the local server super-admin is outside the fresh
  // project's membership context. The actual seed uses the project admin API.
  await request(`fhir/R4/ProjectMembership/${member.id}`, { ...member, admin: true }, 'PUT');
  const privateDirectory = `infra/cloud/.private/seed-${runId}-${injectFailure ? 'failure' : 'success'}`;
  let result, failure;
  const options = { baseUrl, projectId: project.id, clientId: client.id, clientSecret: client.secret, origin: 'http://127.0.0.1:5173', privateDirectory, localQualification: true, ...(injectFailure ? { failAfterStep: 'patient-primary' } : {}) };
  try { result = await seedClinic(options); } catch (error) { failure = error.message; }
  const after = await request(`fhir/R4/ProjectMembership/${member.id}`);
  const journal = JSON.parse(readFileSync(`${privateDirectory}/seed-journal.json`, 'utf8'));
  evidence.push({ projectId: project.id, injectFailure, result, failure, adminAfter: after.admin, cleanup: journal.cleanup, privateDirectory });
  assert.equal(after.admin, false);
  assert.equal(journal.cleanup, 'demotion-verified');
  if (injectFailure) assert.match(failure, /injected-local-seed-failure/);
  else {
    assert.equal(result.status, 'seed-complete-awaiting-qualification');
    const again = await seedClinic({ ...options, fetcher: () => { throw new Error('repeat-must-not-write-or-authenticate'); } });
    assert.equal(again.status, 'already-complete');
    assert.equal(JSON.parse(readFileSync(`${privateDirectory}/seed-journal.json`, 'utf8')).state, 'complete');
  }
}
mkdirSync('infra/cloud/.private', { recursive: true, mode: 0o700 });
writeFileSync(`infra/cloud/.private/seed-qualification-${runId}.json`, `${JSON.stringify({ at: new Date().toISOString(), evidence, cloudCalls: 0, providerCalls: 0 }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ status: 'native-local-seed-qualified', evidence, cloudCalls: 0, providerCalls: 0 }));
