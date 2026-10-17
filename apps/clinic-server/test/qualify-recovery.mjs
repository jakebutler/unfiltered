/** Targeted recovery of the preserved S1 attempt, using real local Medplum. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createClinicHandler } from '../../../.qualification-build/packages/clinic-api/src/handler.js';
import { runtimeProvider } from '../../../.qualification-build/packages/clinic-api/src/runtime.js';
import { readDraft } from '../../../.qualification-build/packages/clinic-api/src/store.js';
import { cookies } from '../../../.qualification-build/packages/clinic-api/src/cookies.js';

const config = JSON.parse(readFileSync('infra/local/.clinic-config.json', 'utf8'));
const users = JSON.parse(readFileSync('infra/local/.clinic-users.json', 'utf8'));
const sessionId = '974d2879-4f35-4a95-99d2-422d7ff93ced';
const failures = [], checks = [];
let nativeCalls = 0;
const fetcher = async (input, init) => {
  nativeCalls++;
  const response = await fetch(input, init);
  if (!response.ok) failures.push({ method: init?.method ?? 'GET', resource: new URL(String(input)).pathname.split('/')[3] ?? 'auth', status: response.status });
  return response;
};
const runtime = runtimeProvider(config, fetcher);
const handler = createClinicHandler(config, { runtime, fetcher });
function client(initialCookie = '') {
  let cookie = initialCookie;
  return async (path, data, expected = 200) => {
    const started = performance.now();
    const response = await handler(new Request(config.origin + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { ...(data === undefined ? {} : { Origin: config.origin, 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
      body: data === undefined ? undefined : JSON.stringify(data),
    }));
    const next = response.headers.get('set-cookie');
    if (next) cookie = next.split(';')[0];
    const body = await response.json();
    assert.equal(response.status, expected, `${path}: ${JSON.stringify(body)}`);
    return { body, elapsedMs: Math.round(performance.now() - started) };
  };
}
async function check(name, action) {
  try { checks.push({ name, passed: true, ...await action() }); console.log('PASS', name); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); console.log('FAIL', name, error.message); }
}

await check('read saved uncertain amendment before any confirmation retry', async () => {
  const r = await runtime();
  const saved = await readDraft(r.client, sessionId, config.patients['first-intake'].reference);
  assert.equal(saved.draft.version, 2);
  assert(saved.draft.turns.some(turn => turn.corrects && turn.text.endsWith('Corrected synthetic goal: walk for 30 minutes with fewer rest stops.')));
  const initialPhase = saved.draft.phase;
  // The original qualification process lost its in-memory cookie. This test-only
  // fixture capability restores that exact seeded session after a scoped native
  // read; it is never exposed as an application route or authentication shortcut.
  const cookie = await cookies(config.cookieSecret, false).issue('clinic_patient', {
    kind: 'patient', sessionId, patient: saved.draft.patient, scenario: saved.draft.scenario,
    identityConfirmed: false, expires: Date.now() + 600000,
  });
  const request = client(cookie.split(';')[0]);
  const gate = (await request('/api/clinic/session')).body;
  assert.equal(gate.phase, 'identity');
  let session = (await request('/api/clinic/confirm-identity', { confirmed: true })).body;
  if (session.phase !== 'confirmed') {
    const preview = (await request('/api/clinic/review', { expectedRevision: session.revision })).body;
    session = (await request('/api/clinic/confirm', { expectedRevision: preview.session.revision, digest: preview.digest })).body;
  }
  assert.equal(session.delivery.state, 'received');
  assert.equal(session.delivery.version, 2);
  assert.equal(session.previousDelivery.reference, `${sessionId}.v1`);
  assert(session.delivery.receivedAt);
  return { initialPhase, recovered: session.delivery.reference, receivedAt: session.delivery.receivedAt };
});
if (process.env.RECOVERY_ONLY !== '1') await check('named physician queue has bounded real pages and rejects forged cursor', async () => {
  const request = client(), user = users.find(user => user.role === 'physician');
  await request('/api/staff/login', { email: user.email, password: user.password });
  const first = await request('/api/staff/queue');
  assert(first.body.items.length > 0 && first.body.items.length <= 5);
  assert.equal(first.body.nextCursor, '5');
  const second = await request('/api/staff/queue?cursor=5');
  assert(second.body.items.length > 0 && second.body.items.length <= 5);
  assert(!second.body.items.some(item => first.body.items.some(old => old.id === item.id && old.responsibility === item.responsibility)));
  await request('/api/staff/queue?cursor=https%3A%2F%2Fforeign.example', undefined, 400);
  return { pages: [first.body.items.length, second.body.items.length], elapsedMs: [first.elapsedMs, second.elapsedMs], continuation: second.body.nextCursor };
});
if (process.env.RECOVERY_ONLY !== '1') await check('unassigned named clinician has empty queue and cannot open handoff', async () => {
  const request = client(), user = users.find(user => user.name === 'Dr. Quinn Parker');
  await request('/api/staff/login', { email: user.email, password: user.password });
  const queue = await request('/api/staff/queue');
  assert.deepEqual(queue.body, { items: [] });
  await request(`/api/staff/handoffs/${sessionId}.v2`, undefined, 404);
  return { elapsedMs: queue.elapsedMs };
});
const report = { at: new Date().toISOString(), scope: 'Targeted synthetic recovery and real Medplum queue pages; test-only restoration of preserved patient session; real named staff authentication', passed: checks.every(check => check.passed), checks, nativeCalls, upstreamFailures: failures };
writeFileSync(`apps/clinic-server/test/recovery-${report.at.replaceAll(':', '-').replaceAll('.', '-')}.json`, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ passed: report.passed, checks: checks.length, nativeCalls, upstreamFailures: failures }));
if (!report.passed) process.exitCode = 1;
