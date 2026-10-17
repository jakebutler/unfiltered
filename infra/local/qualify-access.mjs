/** Local synthetic Medplum 5.2.3 access qualification. No dependencies or cloud calls.
 * Run: node infra/local/qualify-access.mjs [--write-runtime-env]
 * Each run creates fresh isolated projects. Credentials remain memory-only unless
 * --write-runtime-env explicitly requests the scoped service client at mode 0600.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const base = 'http://127.0.0.1:8103';
const env = Object.fromEntries(readFileSync(new URL('.env', import.meta.url), 'utf8').trim().split('\n').map((line) => line.split(/=(.*)/s).slice(0, 2)));
const runId = randomUUID();
const results = [];
const observations = [];
const runtimeTypes = ['Patient', 'CareTeam', 'QuestionnaireResponse', 'DocumentReference', 'Binary', 'Task', 'Provenance'];
const runtimeEnv = new URL('.runtime.env', import.meta.url);
const writeRuntime = process.argv.includes('--write-runtime-env');
if (writeRuntime && existsSync(runtimeEnv)) throw new Error('Refusing to overwrite existing .runtime.env; preserve or deliberately move it first.');
const secret = () => randomBytes(32).toString('base64url');
const ref = (resource) => `${resource.resourceType}/${resource.id}`;

async function request(token, path, body, method = body === undefined ? 'GET' : 'POST', headers = {}, retry = 0) {
  const url = new URL(path, base);
  assert(['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === '8103' && url.protocol === 'http:', 'Qualification is loopback-only');
  const response = await fetch(url, {
    method, redirect: 'manual',
    headers: { Accept: 'application/fhir+json', 'X-Medplum': 'extended', ...(body === undefined ? {} : { 'Content-Type': 'application/fhir+json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = raw; }
  // Five named logins per minute is the stock local limit. A rejected login can
  // be retried once after the server's bounded delay; never retry resource writes.
  if (response.status === 429 && url.pathname === '/auth/login' && retry === 0) {
    let waitMs;
    try { waitMs = JSON.parse(data.issue?.[0]?.diagnostics)._msBeforeNext + 500; } catch { /* Fail closed below. */ }
    if (Number.isFinite(waitMs) && waitMs > 0 && waitMs <= 60000) {
      console.log(`Local named login rate-limited; waiting ${Math.ceil(waitMs / 1000)} seconds once.`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return request(token, path, body, method, headers, retry + 1);
    }
  }
  return { status: response.status, data, headers: response.headers };
}
function requireOk(result, action) {
  assert(result.status >= 200 && result.status < 300, `${action}: HTTP ${result.status}; ${JSON.stringify(result.data?.issue ?? result.data?.error ?? 'unexpected response')}`);
  return result.data;
}
async function clientToken(client) {
  const r = await request(undefined, '/oauth2/token', new URLSearchParams({ grant_type: 'client_credentials', client_id: client.id, client_secret: client.secret }).toString(), 'POST', { 'Content-Type': 'application/x-www-form-urlencoded' });
  return requireOk(r, 'client token').access_token;
}
async function create(token, resource) { return requireOk(await request(token, `/fhir/R4/${resource.resourceType}`, resource), `create ${resource.resourceType}`); }
async function check(name, action) {
  try { const evidence = await action(); results.push({ name, passed: true, ...evidence }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, passed: false, error: error.message }); console.log(`FAIL ${name}: ${error.message}`); }
}
async function expectRead(token, resource) {
  const r = await request(token, `/fhir/R4/${ref(resource)}`);
  assert.equal(r.status, 200); assert.equal(r.data.id, resource.id); return r;
}
async function expectDenied(token, path, body, method) {
  const r = await request(token, path, body, method);
  assert([401, 403, 404].includes(r.status), `expected direct denial; got ${r.status}`);
  assert.equal(r.data?.resourceType, 'OperationOutcome'); return { status: r.status };
}
const bootstrap = await clientToken({ id: env.MEDPLUM_DEFAULT_SUPER_ADMIN_CLIENT_ID, secret: env.MEDPLUM_DEFAULT_SUPER_ADMIN_CLIENT_SECRET });
const setupClients = [];
const projectBySetupToken = new Map();
async function createProject(label) {
  const project = await create(bootstrap, { resourceType: 'Project', name: `Unfiltered ${label} synthetic ${runId.slice(0, 8)}`, features: ['transaction-bundles'] });
  assert.equal(project.superAdmin, undefined);
  const setup = requireOk(await request(bootstrap, `/admin/projects/${project.id}/client`, { name: `Disposable setup ${runId}` }), 'setup client');
  setupClients.push(setup);
  const token = await clientToken(setup);
  projectBySetupToken.set(token, project.id);
  return { project, token };
}
async function fixture(token, label) {
  const patient = await create(token, { resourceType: 'Patient', name: [{ family: `Synthetic ${label}`, given: ['Qualification'] }], identifier: [{ system: 'https://unfiltered.example/qualification', value: `${runId}-${label}` }] });
  const details = ['Medical history: synthetic type 2 diabetes', 'Medicine: synthetic metformin report', 'Surgery: synthetic knee surgery', 'Comorbidity: synthetic hypertension', 'Nutrition: synthetic meal pattern', 'Behavior: synthetic stress context'];
  const sourceText = `Synthetic patient ${label}\n${details.join('\n')}`;
  const response = await create(token, { resourceType: 'QuestionnaireResponse', status: 'completed', subject: { reference: ref(patient) }, item: details.map((value, i) => ({ linkId: `field-${i}`, answer: [{ valueString: value }] })) });
  let document = await create(token, { resourceType: 'DocumentReference', status: 'current', subject: { reference: ref(patient) }, content: [{ attachment: { contentType: 'text/plain', data: Buffer.from(sourceText).toString('base64') } }] });
  const binary = requireOk(await request(token, '/fhir/R4/Binary', sourceText, 'POST', { 'Content-Type': 'text/plain', 'X-Security-Context': ref(document) }), 'binary upload');
  document = requireOk(await request(token, `/fhir/R4/${ref(document)}`, { ...document, content: [{ attachment: { contentType: 'text/plain', data: Buffer.from(sourceText).toString('base64') } }, { attachment: { contentType: 'text/plain', url: `${base}/fhir/R4/${ref(binary)}` } }] }, 'PUT'), 'source update');
  const task = await create(token, { resourceType: 'Task', status: 'ready', intent: 'order', for: { reference: ref(patient) }, focus: { reference: ref(response) }, description: `Synthetic clinical review ${label}` });
  return { patient, response, document, binary, task, details, sourceText };
}
async function policy(token, name, resource) {
  const projectId = projectBySetupToken.get(token);
  assert(projectId);
  const created = await create(bootstrap, { resourceType: 'AccessPolicy', meta: { project: projectId }, name, resource });
  assert.equal(created.meta.project, projectId);
  return created;
}
function clinicalRules(patient) {
  return [
    { resourceType: 'Practitioner', criteria: 'Practitioner?_id=%profile.id', readonly: true },
    { resourceType: 'Patient', criteria: `Patient?_id=${patient.id}`, readonly: true },
    ...['CareTeam', 'QuestionnaireResponse', 'DocumentReference', 'Task'].map((resourceType) => ({ resourceType, criteria: `${resourceType}?_compartment=${ref(patient)}`, readonly: true })),
    { resourceType: 'Binary', readonly: true },
  ];
}
async function user(project, role, accessPolicy) {
  const email = `${role}.${runId}@example.invalid`;
  const password = secret();
  const membership = requireOk(await request(bootstrap, `/admin/projects/${project.id}/invite`, { resourceType: 'Practitioner', firstName: 'Synthetic', lastName: role, email, password, scope: 'project', sendEmail: false, membership: { admin: false, accessPolicy: { reference: ref(accessPolicy) } } }), `invite ${role}`);
  assert.equal(membership.admin, false);
  assert.equal(membership.accessPolicy.reference, ref(accessPolicy));
  const verifier = secret();
  const login = requireOk(await request(undefined, '/auth/login', { email, password, projectId: project.id, scope: 'openid', codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256' }), `named login ${role}`);
  assert(login.code, `named login ${role} must return an authorization code`);
  const token = requireOk(await request(undefined, '/oauth2/token', new URLSearchParams({ grant_type: 'authorization_code', code: login.code, code_verifier: verifier }).toString(), 'POST', { 'Content-Type': 'application/x-www-form-urlencoded' }), `named token ${role}`).access_token;
  return { role, token, membership, email };
}

let clinic, other, runtime;
try {
clinic = await createProject('access clinic');
other = await createProject('access other-client');
const assigned = await fixture(clinic.token, 'assigned');
const unrelated = await fixture(clinic.token, 'unrelated');
const foreign = await fixture(other.token, 'foreign');
const logistics = await create(clinic.token, { resourceType: 'Task', status: 'ready', intent: 'order', for: { reference: ref(assigned.patient) }, description: 'Synthetic scheduling: contact preference afternoon; verify appointment time. No clinical content.', identifier: [{ system: 'https://unfiltered.example/logistics', value: runId }] });
const assignedPolicy = await policy(clinic.token, 'Assigned clinician full intake read', clinicalRules(assigned.patient));
const unrelatedPolicy = await policy(clinic.token, 'Other patient clinician full intake read', clinicalRules(unrelated.patient));
const adminPolicy = await policy(clinic.token, 'Administrative staff logistics only', [{ resourceType: 'Practitioner', criteria: 'Practitioner?_id=%profile.id', readonly: true }, { resourceType: 'Task', criteria: `Task?_id=${logistics.id}`, readonly: true }]);
const md = await user(clinic.project, 'assigned-md', assignedPolicy);
const rd = await user(clinic.project, 'assigned-rd', assignedPolicy);
const unassigned = await user(clinic.project, 'unassigned-md', unrelatedPolicy);
const admin = await user(clinic.project, 'administrative-staff', adminPolicy);
const foreignPolicy = await policy(other.token, 'Other client clinician', clinicalRules(foreign.patient));
const crossClient = await user(other.project, 'other-client-md', foreignPolicy);
const careTeam = await create(clinic.token, { resourceType: 'CareTeam', status: 'active', subject: { reference: ref(assigned.patient) }, participant: [md, rd].map((u) => ({ member: u.membership.profile, role: [{ text: u.role }] })) });
const runtimePolicy = await policy(clinic.token, 'Server runtime clinical persistence only', runtimeTypes.map((resourceType) => ({ resourceType, interaction: ['create', 'read', 'search', 'update', 'history', 'vread'] })));
runtime = requireOk(await request(bootstrap, `/admin/projects/${clinic.project.id}/client`, { name: `Scoped runtime ${runId}`, accessPolicy: { reference: ref(runtimePolicy) } }), 'runtime create');
const runtimeToken = await clientToken(runtime);
const runtimeMemberships = requireOk(await request(bootstrap, `/fhir/R4/ProjectMembership?profile=${ref(runtime)}`), 'runtime membership search');
assert.equal(runtimeMemberships.entry.length, 1);
assert.notEqual(runtimeMemberships.entry[0].resource.admin, true);
assert.equal(runtimeMemberships.entry[0].resource.accessPolicy.reference, ref(runtimePolicy));

for (const actor of [md, rd]) {
  await check(`${actor.role}: full assigned intake and source content`, async () => {
    await expectRead(actor.token, assigned.patient); await expectRead(actor.token, careTeam); await expectRead(actor.token, assigned.task);
    const qr = await expectRead(actor.token, assigned.response);
    assert.deepEqual(qr.data.item.map((item) => item.answer[0].valueString), assigned.details);
    const doc = await expectRead(actor.token, assigned.document);
    assert.equal(Buffer.from(doc.data.content[0].attachment.data, 'base64').toString(), assigned.sourceText);
    const binary = await request(actor.token, `/fhir/R4/${ref(assigned.binary)}`, undefined, 'GET', { Accept: 'text/plain' });
    assert.equal(binary.status, 200); assert.equal(binary.data, assigned.sourceText);
    return { status: 200, profile: actor.membership.profile.reference, clinicalFields: assigned.details.length };
  });
  await check(`${actor.role}: unfiltered search includes only assigned intake`, async () => {
    const r = await request(actor.token, '/fhir/R4/QuestionnaireResponse?_count=100');
    assert.equal(r.status, 200); assert.deepEqual((r.data.entry ?? []).map((e) => e.resource.id), [assigned.response.id]); return { status: r.status, matches: 1 };
  });
  for (const fixtureSet of [unrelated, foreign]) for (const key of ['patient', 'response', 'document', 'binary', 'task']) {
    await check(`${actor.role}: deny ${fixtureSet === unrelated ? 'other patient' : 'other project'} ${key}`, () => expectDenied(actor.token, `/fhir/R4/${ref(fixtureSet[key])}`));
  }
  await check(`${actor.role}: deny direct intake mutation`, () => expectDenied(actor.token, `/fhir/R4/${ref(assigned.response)}`, { ...assigned.response, status: 'amended' }, 'PUT'));
  await check(`${actor.role}: deny direct task disposition`, () => expectDenied(actor.token, `/fhir/R4/${ref(assigned.task)}`, { ...assigned.task, status: 'completed' }, 'PUT'));
}
await check('unassigned clinician: positive control on own assigned patient', async () => { await expectRead(unassigned.token, unrelated.response); return { status: 200 }; });
await check('other-client clinician: positive control in own project', async () => { await expectRead(crossClient.token, foreign.response); return { status: 200 }; });
for (const actor of [unassigned, crossClient, admin]) for (const key of ['patient', 'response', 'document', 'binary', 'task']) {
  await check(`${actor.role}: deny target clinical ${key}`, () => expectDenied(actor.token, `/fhir/R4/${ref(assigned[key])}`));
}
await check('administrative staff: sanitized logistics positive control', async () => {
  const r = await expectRead(admin.token, logistics); assert.equal(r.data.focus, undefined); assert.equal(r.data.input, undefined);
  const search = await request(admin.token, '/fhir/R4/Task?_count=100'); assert.equal(search.status, 200); assert.deepEqual(search.data.entry.map((e) => e.resource.id), [logistics.id]); return { status: 200, matches: 1 };
});
for (const actor of [md, rd, unassigned, admin, crossClient]) {
  await check(`${actor.role}: deny policy modification`, () => expectDenied(actor.token, '/fhir/R4/AccessPolicy', { resourceType: 'AccessPolicy', name: 'Unauthorized escalation', resource: [{ resourceType: '*' }] }));
  await check(`${actor.role}: deny project administration`, () => expectDenied(actor.token, `/admin/projects/${clinic.project.id}/invite`, { resourceType: 'Practitioner', firstName: 'Denied', lastName: 'Denied', email: `denied-${runId}@example.invalid`, sendEmail: false }));
}
await check('anonymous: deny clinical source', () => expectDenied(undefined, `/fhir/R4/${ref(assigned.document)}`));
await check('runtime: clinical persistence positive control and service authorship', async () => {
  const created = await create(runtimeToken, { resourceType: 'Task', status: 'draft', intent: 'order', for: { reference: ref(assigned.patient) }, description: 'Synthetic scoped runtime positive control' });
  assert.equal(created.meta.author.reference, ref(runtime)); await expectRead(runtimeToken, assigned.response); return { status: 201, author: created.meta.author.reference };
});
for (const type of ['AccessPolicy', 'ProjectMembership', 'ClientApplication']) await check(`runtime: deny ${type} search`, () => expectDenied(runtimeToken, `/fhir/R4/${type}`));
await check('runtime: deny project administration', () => expectDenied(runtimeToken, `/admin/projects/${clinic.project.id}/client`, { name: 'Unauthorized runtime escalation' }));
await check('runtime: deny other-project intake', () => expectDenied(runtimeToken, `/fhir/R4/${ref(foreign.response)}`));
await check('runtime: deny destructive delete', () => expectDenied(runtimeToken, `/fhir/R4/${ref(assigned.response)}`, undefined, 'DELETE'));
await check('role downgrade: existing RD token loses clinical access', async () => {
  const changed = requireOk(await request(bootstrap, `/admin/projects/${clinic.project.id}/invite`, { resourceType: 'Practitioner', firstName: 'Synthetic', lastName: rd.role, email: rd.email, scope: 'project', sendEmail: false, upsert: true, membership: { admin: false, accessPolicy: { reference: ref(adminPolicy) } } }), 'downgrade membership');
  assert.equal(changed.id, rd.membership.id);
  await expectRead(rd.token, logistics);
  await expectDenied(rd.token, `/fhir/R4/${ref(assigned.document)}`);
  await expectDenied(rd.token, `/fhir/R4/${ref(assigned.binary)}`);
  return expectDenied(rd.token, `/fhir/R4/${ref(assigned.response)}`);
});
await check('source storage: unsigned guessed URL denied', async () => {
  const url = new URL(assigned.binary.url);
  url.searchParams.delete('Signature');
  const response = await request(undefined, url.href);
  assert.equal(response.status, 401);
  return { status: response.status };
});
// Native signed URLs are bearer capabilities. Observe this limitation explicitly;
// do not count continuing access as a successful authorization/revocation test.
const copiedSource = await request(undefined, assigned.binary.url);
observations.push({
  name: 'Native presigned source URL after role downgrade',
  status: copiedSource.status,
  stillReadableWithoutAuthentication: copiedSource.status === 200 && copiedSource.data === assigned.sourceText,
  risk: 'An already issued native storage URL does not reevaluate membership; do not expose these URLs through the application. Use an authenticated proxy of canonical FHIR Binary with a fresh access check.',
});
console.log(`OBSERVATION native presigned source after role downgrade: HTTP ${copiedSource.status}; limitation retained in report.`);

} catch (error) {
  results.push({ name: 'fixture setup or harness completion', passed: false, error: error.message });
  console.error(error.message);
} finally {
  // Disable temporary unrestricted setup clients, including on fixture failures.
  for (const client of setupClients) {
    await check(`disable disposable setup client ${client.id}`, async () => {
      requireOk(await request(bootstrap, `/fhir/R4/${ref(client)}`, { ...client, status: 'inactive' }, 'PUT'), 'disable setup client');
      return { status: 200 };
    });
  }
}
if (writeRuntime && results.every((r) => r.passed)) {
  writeFileSync(runtimeEnv, `MEDPLUM_BASE_URL=${base}\nMEDPLUM_PROJECT_ID=${clinic.project.id}\nMEDPLUM_CLIENT_ID=${runtime.id}\nMEDPLUM_CLIENT_SECRET=${runtime.secret}\n`, { mode: 0o600, flag: 'wx' });
  console.log('Wrote scoped runtime credentials to private .runtime.env; values not printed.');
}
const summary = { qualifiedScope: 'Local named-user direct-FHIR resource access only', applicationAuthorizationQualified: false, nativeStorageImmediateRevocationQualified: false, timestamp: new Date().toISOString(), runId, medplumVersion: '5.2.3', baseUrl: base, projectId: clinic?.project.id, otherProjectId: other?.project.id, runtimeAllowedTypes: runtimeTypes, runtimeInteractions: ['create', 'read', 'search', 'update', 'history', 'vread'], observations, limitations: [
  'Local synthetic Medplum 5.2.3 only; hosted Free entitlements and production authorization are unqualified.',
  'Care-team memberships are compiled into explicit patient-scoped policies by setup; automatic CareTeam enrollment/revocation synchronization remains application work.',
  'Clinical direct FHIR tokens are read-only; role-attributed staff transitions through the narrow application API remain unqualified.',
  'Binary permission relies on mandatory securityContext pointing at an access-controlled resource; uncontextualized Binary creation is not prevented by this runtime policy. Source admission must enforce context and patient association.',
  'The shared runtime is project-scoped and deliberately spans patients; the application must enforce patient capability and staff action scope on every request.',
  'The application must keep staff tokens server-side and must not expose native signed storage URLs if immediate source revocation is required.',
  'Runtime credentials are exported only with --write-runtime-env and an existing file is never overwritten. A plain rerun uses separate fresh fixtures.'
], sources: [
  'https://www.medplum.com/docs/access/access-policies',
  'https://www.medplum.com/docs/access/binary-security-context',
  'https://www.medplum.com/docs/api/project-admin/invite',
  'https://www.medplum.com/docs/api/project-admin/client',
  'https://github.com/medplum/medplum/blob/v5.2.3/packages/server/src/auth/login.ts',
  'https://github.com/medplum/medplum/blob/v5.2.3/packages/server/src/oauth/token.ts',
  'https://github.com/medplum/medplum/blob/v5.2.3/packages/server/src/storage/routes.ts',
  'https://github.com/medplum/medplum/blob/v5.2.3/packages/server/src/storage/presign.ts'
], passed: results.filter((r) => r.passed).length, failed: results.filter((r) => !r.passed).length, results };
writeFileSync(new URL('access-qualification-results.json', import.meta.url), JSON.stringify(summary, null, 2) + '\n');
console.log(`Access qualification: ${summary.passed} passed, ${summary.failed} failed; evidence in infra/local/access-qualification-results.json.`);
if (summary.failed) process.exitCode = 1;
