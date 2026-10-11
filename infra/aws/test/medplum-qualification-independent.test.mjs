import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

test('restored scope denial must not qualify when its target is missing to privileged authority', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'uf-native-proof-independent-')));
  const originalFetch = globalThis.fetch, originalArgs = process.argv, originalExitCode = process.exitCode;
  const bytes = 'synthetic Binary bytes';
  const patient = { resourceType: 'Patient', id: 'patient', meta: { versionId: '2' } };
  const ledger = { resourceType: 'DocumentReference', id: 'ledger', meta: { versionId: '1' }, identifier: [{ value: 'synthetic-lifetime' }], content: [{ attachment: { data: 'synthetic-unknown-state' } }] };
  writeFileSync(join(root, 'fixture.private.json'), JSON.stringify({ setup: { id: 'synthetic-client', secret: 'synthetic-no-authority' }, scopedToken: 'synthetic-scoped', revokedToken: 'synthetic-revoked', patient,
    other: { resourceType: 'Patient', id: 'missing-denied-target' }, firstVersion: '1', document: { resourceType: 'DocumentReference', id: 'doc' }, binary: { resourceType: 'Binary', id: 'binary' },
    binaryHash: createHash('sha256').update(bytes).digest('hex'), ledger, project: { id: 'synthetic-project' } }), { mode: 0o600 });
  const observed = [];
  globalThis.fetch = async (url, init) => {
    observed.push({ url, authorization: init.headers.Authorization });
    const path = new URL(url).pathname, auth = init.headers.Authorization;
    const response = (value, status = 200) => new Response(typeof value === 'string' ? value : JSON.stringify(value), { status });
    if (path === '/oauth2/token') return response({ access_token: 'synthetic-setup' });
    if (init.method === 'PUT' || path === '/fhir/R4') return response({}, 412);
    if (path === '/fhir/R4/Patient/missing-denied-target') return response({}, 404); // Missing for BOTH setup and scoped authorities.
    if (path === '/fhir/R4/Patient/patient' && (auth === 'Bearer synthetic-revoked' || !auth)) return response({}, 403);
    if (path === '/fhir/R4/Patient/patient') return response(patient);
    if (path === '/fhir/R4/Patient/patient/_history') return response({ entry: [{}, {}] });
    if (path === '/fhir/R4/Patient/patient/_history/1') return response({ name: [{ family: 'SyntheticBefore' }] });
    if (path === '/fhir/R4/Binary/binary') return response(init.headers.Accept === 'text/plain' ? bytes : { securityContext: { reference: 'DocumentReference/doc' } });
    if (path === '/fhir/R4/DocumentReference/ledger') return response(ledger);
    if (path.startsWith('/fhir/R4/Patient/')) return response({}, 404); // Rolled-back generated Patient.
    throw new Error('Unexpected offline request');
  };
  try {
    process.argv = [originalArgs[0], 'offline-client-proof', 'verify', root];
    await import(`../medplum/qualify-client.mjs?independent=${Date.now()}`);
    assert.equal(existsSync(join(root, 'verify.proof.json')), false, 'missing denied Patient must fail qualification, not be recorded as preserved scope');
    assert.ok(observed.some(r => r.url.endsWith('/Patient/missing-denied-target') && r.authorization === 'Bearer synthetic-setup'));
  } finally {
    globalThis.fetch = originalFetch; process.argv = originalArgs; process.exitCode = originalExitCode;
    rmSync(root, { recursive: true, force: true });
  }
});
