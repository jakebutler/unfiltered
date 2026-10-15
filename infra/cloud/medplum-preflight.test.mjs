import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inventory, observeProjectFeatures, projectFeatureCalibration, serverProjectsProjectFeatures, main } from './medplum-preflight.mjs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLOUD_API_BASE, CLOUD_PROJECT_ID, INVENTORY_TYPES, seedPlan } from './clinic-manifest.mjs';
const clientId = '50db76bd-d099-4305-8ec3-7439ffc38ca1';
const identity = () => ({ project: { id: CLOUD_PROJECT_ID, features: ['transaction-bundles'] }, profile: { resourceType: 'ClientApplication', id: clientId }, membership: { id: 'membership-1', project: { reference: `Project/${CLOUD_PROJECT_ID}` }, profile: { reference: `ClientApplication/${clientId}` } } });
const json = body => Response.json(body);
function mock({ me = identity(), patient = { resourceType: 'Bundle', type: 'searchset' } } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, method: init.method ?? 'GET' });
    if (url === `${CLOUD_API_BASE}oauth2/token`) return json({ access_token: 'private-test-token' });
    if (url === `${CLOUD_API_BASE}auth/me`) return json(me);
    if (url === `${CLOUD_API_BASE}fhir/R4/Project/${CLOUD_PROJECT_ID}`) return json({ resourceType: 'Project', id: CLOUD_PROJECT_ID, features: ['transaction-bundles'] });
    if (new URL(url).pathname === '/fhir/R4/Patient') return json(patient);
    return json({ resourceType: 'Bundle', type: 'searchset' });
  };
  return { fetcher, calls };
}
test('inventory only authenticates then reads pinned project metadata', async () => {
  const state = mock();
  const result = await inventory({ clientId, clientSecret: 'private-test-secret', fetcher: state.fetcher });
  assert.equal(result.requests, INVENTORY_TYPES.length + 3);
  assert.equal(result.completeForListedTypes, true);
  assert.deepEqual(state.calls.filter(x => x.method !== 'GET'), [{ url: `${CLOUD_API_BASE}oauth2/token`, method: 'POST' }]);
  assert(!JSON.stringify(result).includes('private-test'));
});
test('wrong project and wrong client fail before FHIR inventory', async () => {
  for (const mutate of [me => { me.project.id = 'other-project'; }, me => { me.profile.id = 'other-client'; }]) {
    const me = identity(); mutate(me); const state = mock({ me });
    await assert.rejects(inventory({ clientId, clientSecret: 'test', fetcher: state.fetcher }), /identity-project-mismatch/);
    assert.equal(state.calls.length, 2);
  }
});
test('resource project mismatch fails closed and no resource payload is emitted', async () => {
  const state = mock({ patient: { resourceType: 'Bundle', type: 'searchset', entry: [{ resource: { resourceType: 'Patient', id: 'patient-1', meta: { project: 'other-project' }, name: [{ text: 'never emitted' }] } }] } });
  await assert.rejects(inventory({ clientId, clientSecret: 'test', fetcher: state.fetcher }), /resource-project-mismatch/);
});
test('continuation cannot exfiltrate bearer token or cross resource type', async () => {
  for (const url of ['https://example.invalid/fhir/R4/Patient', `${CLOUD_API_BASE}fhir/R4/ClientApplication`, `${CLOUD_API_BASE}fhir/R4/Patient#secret`]) {
    const state = mock({ patient: { resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'next', url }] } });
    await assert.rejects(inventory({ clientId, clientSecret: 'test', fetcher: state.fetcher }), /unsafe-continuation/);
    assert.equal(state.calls.length, 4);
  }
});
test('bounded inventory marks an unfinished page sequence incomplete', async () => {
  const state = mock({ patient: { resourceType: 'Bundle', type: 'searchset', total: 9000, link: [{ relation: 'next', url: `${CLOUD_API_BASE}fhir/R4/Patient?_offset=100` }] } });
  const result = await inventory({ clientId, clientSecret: 'test', fetcher: state.fetcher, maxPages: 1 });
  assert.equal(result.resources.Patient.complete, false);
  assert.equal(result.completeForListedTypes, false);
});
test('seed plan has full clinical RD access and separate administrative policy without deletion', () => {
  const plan = seedPlan();
  assert.equal(plan.staff.find(x => x.key === 'dietitian').policy, plan.staff.find(x => x.key === 'medical').policy);
  assert.equal(plan.authority.accountWideOperations, false);
  assert.equal(plan.authority.deleteOperations, false);
  assert(plan.staff.every(x => !x.membershipAdmin && !x.sendEmail));
  assert.equal(plan.policies.find(x => x.key === 'administrative').resource.resource.length, 2);
});

function featureMock({ meFeatures, adminFeatures = ['transaction-bundles'], admin = true, version = '5.2.4-build', projectStatus = 200 } = {}) {
  const calls = [];
  const me = identity(); if (meFeatures === undefined) delete me.project.features; else me.project.features = meFeatures; me.membership.admin = admin;
  const fetcher = async (url, init) => {
    calls.push({ url, method: init.method ?? 'GET' });
    if (url === `${CLOUD_API_BASE}oauth2/token`) return json({ access_token: 'private-test-token' });
    if (url === `${CLOUD_API_BASE}auth/me`) return json(me);
    if (url === `${CLOUD_API_BASE}fhir/R4/metadata`) return json({ resourceType: 'CapabilityStatement', software: { version } });
    if (url === `${CLOUD_API_BASE}fhir/R4/Project/${CLOUD_PROJECT_ID}`) return projectStatus === 200 ? json({ resourceType: 'Project', id: CLOUD_PROJECT_ID, meta: { versionId: 'v9' }, ...(adminFeatures ? { features: adminFeatures } : {}) }) : new Response(null, { status: projectStatus });
    throw new Error('unexpected-request');
  };
  return { fetcher, calls };
}
test('observe-features reads only token, auth/me and metadata as the demoted runtime client', async () => {
  const state = featureMock({ meFeatures: ['transaction-bundles'], admin: false });
  const result = await observeProjectFeatures({ clientId, clientSecret: 'private-test-secret', fetcher: state.fetcher });
  assert.deepEqual(result.authMeFeatures, ['transaction-bundles']); assert.equal(result.calibration, undefined); assert.equal(result.requests, 3);
  assert(!state.calls.some(call => call.url.includes('/Project/')));
  assert(!JSON.stringify(result).includes('private-test'));
});
test('--calibrate with temporary admin passes only when admin Project.features equals auth/me features', async () => {
  const ok = await observeProjectFeatures({ clientId, clientSecret: 'private-test-secret', fetcher: featureMock({ meFeatures: ['transaction-bundles'] }).fetcher, calibrate: true });
  assert.equal(ok.calibration.featuresMatch, true); assert.equal(ok.membershipAdmin, true); assert.equal(ok.adminProjectVersion, 'v9');
  assert(!JSON.stringify(ok).includes('private-test'));
  const empty = await observeProjectFeatures({ clientId, clientSecret: 'test', fetcher: featureMock({ meFeatures: undefined, adminFeatures: null }).fetcher, calibrate: true });
  assert.deepEqual(empty.calibration.features, []);
  await assert.rejects(observeProjectFeatures({ clientId, clientSecret: 'test', fetcher: featureMock({ meFeatures: undefined }).fetcher, calibrate: true }), /calibration-project-features-mismatch/);
  await assert.rejects(observeProjectFeatures({ clientId, clientSecret: 'test', fetcher: featureMock({ meFeatures: ['bots'], adminFeatures: ['bots', 'transaction-bundles'] }).fetcher, calibrate: true }), /calibration-project-features-mismatch/);
});
test('--calibrate refuses without temporary admin or Project read, and on servers that may not project features', async () => {
  await assert.rejects(observeProjectFeatures({ clientId, clientSecret: 'test', fetcher: featureMock({ meFeatures: [], admin: false }).fetcher, calibrate: true }), /calibration-requires-temporary-project-admin/);
  await assert.rejects(observeProjectFeatures({ clientId, clientSecret: 'test', fetcher: featureMock({ meFeatures: [], projectStatus: 403 }).fetcher, calibrate: true }), /calibration-admin-project-read-403/);
  await assert.rejects(observeProjectFeatures({ clientId, clientSecret: 'test', fetcher: featureMock({ meFeatures: undefined, version: '5.1.3' }).fetcher }), /server-does-not-project-features/);
  assert.equal(serverProjectsProjectFeatures('5.1.4'), true); assert.equal(serverProjectsProjectFeatures('5.1.3-abc'), false); assert.equal(serverProjectsProjectFeatures('nightly'), false);
  assert.throws(() => projectFeatureCalibration({ meProject: { id: CLOUD_PROJECT_ID, features: ['a'] }, adminProject: { resourceType: 'Project', id: CLOUD_PROJECT_ID, features: ['b'] }, serverVersion: '5.2.0' }), /calibration-project-features-mismatch/);
  assert.equal(projectFeatureCalibration({ meProject: { id: CLOUD_PROJECT_ID, features: ['b', 'a'] }, adminProject: { resourceType: 'Project', id: CLOUD_PROJECT_ID, features: ['a', 'b'] }, serverVersion: '5.2.0' }).featuresMatch, true);
});
test('calibrate flag is rejected outside observe-features and needs explicit cloud read', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'calibrate-'));
  try {
    await assert.rejects(main(['inventory', '--output', join(directory, 'x.json'), '--calibrate']), /usage/);
    await assert.rejects(main(['observe-features', '--output', join(directory, 'y.json'), '--calibrate']), /explicit-cloud-read/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
