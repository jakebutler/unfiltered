import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { diagnose, STAGES } from '../medplum/diagnose-source-client.mjs';
import { sanitize } from '../medplum/diagnose-source.mjs';
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const resource = (type, n) => ({ resourceType: type, id: id(n), meta: { versionId: id(n + 20) } });
function fixture() {
  const bytes = 'Synthetic complete Binary archive fixture';
  return { setup: { id: id(1), secret: 'private-secret-do-not-emit' }, scopedToken: 'private-scoped-token', revokedToken: 'private-revoked-token',
    patient: resource('Patient', 2), other: resource('Patient', 3), document: resource('DocumentReference', 4), binary: resource('Binary', 5),
    firstVersion: id(10), binaryHash: createHash('sha256').update(bytes).digest('hex'),
    ledger: { ...resource('DocumentReference', 6), content: [{ attachment: { data: 'private-ledger-bytes' } }], identifier: [{ value: 'private-namespace' }] }, bytes };
}
function responses(s) {
  return [
    [200, { access_token: 'private-setup-token' }], [200, s.patient], [200, s.other], [200, { ...s.document, subject: { reference: `Patient/${s.patient.id}` } }],
    [200, { entry: [{}, {}] }], [200, { name: [{ family: 'SyntheticBefore' }] }], [200, s.patient], [404, {}], [403, {}], [401, {}],
    [200, s.bytes], [200, { securityContext: { reference: `DocumentReference/${s.document.id}` } }], [200, s.ledger],
  ];
}
function fetcher(list, calls) {
  return async (url, init) => { calls.push({ url, init }); const [status, body] = list[calls.length - 1]; return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }); };
}
test('complete diagnostic sends one setup grant then twelve fixed GETs, no data echo', async () => {
  const s = fixture(), calls = [], result = await diagnose(s, fetcher(responses(s), calls));
  assert.equal(result.state, 'read-checks-passed-mutation-boundary-not-replayed'); assert.equal(calls.length, 13);
  assert.deepEqual(result.rows.map(r => r.stage), STAGES); assert(result.rows.every(r => r.outcome === 'pass'));
  assert.equal(calls[0].url, 'http://server:8103/oauth2/token'); assert.equal(calls[0].init.method, 'POST');
  assert.equal(new URLSearchParams(calls[0].init.body).get('grant_type'), 'client_credentials');
  for (const c of calls.slice(1)) { assert.equal(c.init.method, 'GET'); assert(!('body' in c.init)); assert(c.url.startsWith('http://server:8103/fhir/R4/')); assert.equal(c.init.redirect, 'manual'); assert(c.init.signal instanceof AbortSignal); }
  for (const privateValue of [s.setup.secret, s.scopedToken, s.revokedToken, 'private-setup-token', s.ledger.identifier[0].value, s.ledger.content[0].attachment.data, s.patient.id]) assert(!JSON.stringify(result).includes(privateValue));
});
test('privileged missing other Patient stops before scoped404 can be counted as denial', async () => {
  const s = fixture(), calls = [], list = responses(s); list[2] = [404, { diagnostics: 'private-upstream-message' }];
  const r = await diagnose(s, fetcher(list, calls)); assert.equal(calls.length, 3);
  assert.deepEqual(r.rows.at(-1), { stage: 'setup-other-patient', status: 404, outcome: 'expectation-failed' }); assert(!JSON.stringify(r).includes('private-upstream-message'));
});
test('still-authorized old revoked token is an observed failure without rerunning or replacing token', async () => {
  const s = fixture(), calls = [], list = responses(s); list[8] = [200, s.patient];
  const r = await diagnose(s, fetcher(list, calls)); assert.equal(calls.length, 9); assert.equal(r.rows.at(-1).stage, 'revoked-current-denial'); assert.equal(r.rows.at(-1).outcome, 'expectation-failed');
  assert.equal(calls[8].init.headers.Authorization, `Bearer ${s.revokedToken}`);
});
test('Binary hash mismatch stops before metadata and ledger checks', async () => {
  const s = fixture(), calls = [], list = responses(s); list[10] = [200, 'wrong-bytes'];
  const r = await diagnose(s, fetcher(list, calls)); assert.equal(calls.length, 11); assert.equal(r.rows.at(-1).stage, 'scoped-binary-bytes'); assert.equal(r.rows.at(-1).outcome, 'expectation-failed');
});
test('oversized streamed response cancels reader and retains only unknown fixed stage', async () => {
  const s = fixture(); let cancelled = false;
  const r = await diagnose(s, async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1048577)); }, cancel() { cancelled = true; } }), { status: 200 }));
  assert(cancelled); assert.deepEqual(r.rows, [{ stage: 'setup-token', status: 0, outcome: 'transport-or-body-unknown' }]);
});
test('transport exception strings never enter result and are not retried', async () => {
  let calls = 0; const r = await diagnose(fixture(), async () => { calls++; throw new Error('private-secret-do-not-emit'); });
  assert.equal(calls, 1); assert(!JSON.stringify(r).includes('private-secret')); assert.equal(r.automaticRetry, false);
});
test('incomplete private fixture rejected before any network request', async () => {
  const s = fixture(); delete s.other.meta; let calls = 0;
  await assert.rejects(diagnose(s, async () => { calls++; }), /private-fixture-invalid/); assert.equal(calls, 0);
});
test('host receipt sanitizer strips arbitrary strings and rejects fabricated completion', () => {
  const clean = sanitize({ state: 'read-boundary-failed-or-unknown', rows: [{ stage: 'setup-token', status: 401, outcome: 'expectation-failed', raw: 'secret' }], raw: 'secret', failureStage: 'secret' });
  assert(!JSON.stringify(clean).includes('secret'));
  assert.throws(() => sanitize({ state: 'read-checks-passed-mutation-boundary-not-replayed', rows: [] }));
});
