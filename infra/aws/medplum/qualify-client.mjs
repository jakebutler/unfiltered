/** Synthetic native fixture client, only run on the qualifier's owned internal network. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { CHECK_STAGES } from './qualify-boundaries.mjs';
const [mode, root] = process.argv.slice(2), statePath = join(root, 'fixture.private.json');
const rows = []; let checksStarted = false, checksPassed = false;
const hash = v => createHash('sha256').update(v).digest('hex'), ref = r => `${r.resourceType}/${r.id}`;
async function request(token, path, body, method = body === undefined ? 'GET' : 'POST', extra = {}) {
  assert(path.startsWith('/') && !path.startsWith('//'));
  const r = await fetch(`http://server:8103${path}`, { method, redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { Accept: 'application/fhir+json', 'X-Medplum': 'extended', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/fhir+json' }), ...extra }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  let raw = '', size = 0; for await (const chunk of r.body) { size += chunk.length; if (size > 1048576) throw new Error('fixture-response-bound'); raw += Buffer.from(chunk).toString(); }
  let data; try { data = JSON.parse(raw); } catch { data = raw; } return { status: r.status, data };
}
const ok = r => { assert(r.status >= 200 && r.status < 300); return r.data; };
const tokenResponse = c => request(undefined, '/oauth2/token', new URLSearchParams({ grant_type: 'client_credentials', client_id: c.id, client_secret: c.secret }).toString(), 'POST', { 'Content-Type': 'application/x-www-form-urlencoded' });
const token = async c => ok(await tokenResponse(c)).access_token;
const create = async (t, r) => ok(await request(t, `/fhir/R4/${r.resourceType}`, r));
async function check(s) {
  checksStarted = true;
  async function observed(stage, action, predicate) {
    assert.equal(stage, CHECK_STAGES[rows.length]); let status = 0;
    try { const r = await action(); status = r.status; assert(predicate(r)); rows.push({ stage, status, outcome: 'pass' }); return r.data; }
    catch { rows.push({ stage, status, outcome: status ? 'expectation-failed' : 'transport-or-body-unknown' }); throw new Error('synthetic-check-failed'); }
  }
  const good = r => r.status >= 200 && r.status < 300, denied = r => [401,403,404].includes(r.status);
  const setup = (await observed('setup-token', () => tokenResponse(s.setup), r => good(r) && typeof r.data?.access_token === 'string' && r.data.access_token.length > 0)).access_token;
  const scoped = s.scopedToken, revoked = s.revokedToken; assert(scoped && revoked);
  await observed('setup-current-patient', () => request(setup, `/fhir/R4/${ref(s.patient)}`), r => good(r) && r.data?.meta?.versionId === s.patient.meta.versionId);
  // A scoped404 proves denial only when privileged authority still sees its exact target.
  await observed('setup-other-patient', () => request(setup, `/fhir/R4/${ref(s.other)}`), r => good(r) && r.data?.id === s.other.id && r.data?.meta?.versionId === s.other.meta?.versionId);
  await observed('setup-document', () => request(setup, `/fhir/R4/${ref(s.document)}`), r => good(r) && r.data?.id === s.document.id && r.data?.meta?.versionId === s.document.meta?.versionId && r.data?.subject?.reference === ref(s.patient));
  await observed('patient-history', () => request(setup, `/fhir/R4/${ref(s.patient)}/_history`), r => good(r) && r.data?.entry?.length === 2);
  await observed('patient-first-version', () => request(setup, `/fhir/R4/${ref(s.patient)}/_history/${s.firstVersion}`), r => good(r) && r.data?.name?.[0]?.family === 'SyntheticBefore');
  await observed('scoped-current-patient', () => request(scoped, `/fhir/R4/${ref(s.patient)}`), r => good(r) && r.data?.id === s.patient.id);
  await observed('scoped-other-denial', () => request(scoped, `/fhir/R4/${ref(s.other)}`), denied);
  await observed('revoked-current-denial', () => request(revoked, `/fhir/R4/${ref(s.patient)}`), denied);
  await observed('anonymous-current-denial', () => request(undefined, `/fhir/R4/${ref(s.patient)}`), denied);
  await observed('scoped-binary-bytes', () => request(scoped, `/fhir/R4/${ref(s.binary)}`, undefined, 'GET', { Accept: 'text/plain' }), r => r.status === 200 && typeof r.data === 'string' && hash(r.data) === s.binaryHash);
  await observed('setup-binary-context', () => request(setup, `/fhir/R4/${ref(s.binary)}`), r => good(r) && r.data?.securityContext?.reference === ref(s.document));
  await observed('setup-ledger', () => request(setup, `/fhir/R4/${ref(s.ledger)}`), r => good(r) && r.data?.meta?.versionId === s.ledger.meta.versionId && r.data?.content?.[0]?.attachment?.data === s.ledger.content[0].attachment.data && r.data?.identifier?.[0]?.value === s.ledger.identifier[0].value);
  const system = 'https://unfiltered.example/synthetic-restore-fixture', positive = s.patient.identifier?.find(i => i.system === system);
  const search = value => `/fhir/R4/Patient?identifier=${encodeURIComponent(`${system}|${value}`)}&_count=2&_total=accurate`;
  await observed('identifier-positive-control', () => { assert(positive && typeof positive.value === 'string'); return request(setup, search(positive.value)); }, r => good(r) && r.data?.resourceType === 'Bundle' && r.data.total === 1 && r.data.entry?.length === 1 && r.data.entry[0].resource?.id === s.patient.id && r.data.entry[0].resource?.identifier?.some(i => i.system === system && i.value === positive.value));
  await observed('stale-cas', () => request(setup, `/fhir/R4/${ref(s.patient)}`, s.patient, 'PUT', { 'If-Match': `W/"${s.firstVersion}"` }), r => r.status === 412);
  const rollbackValue = `rollback-${randomUUID()}`;
  await observed('atomic-rollback', () => request(setup, '/fhir/R4', { resourceType: 'Bundle', type: 'transaction', entry: [
    { resource: { resourceType: 'Patient', identifier: [{ system, value: rollbackValue }], name: [{ family: 'SyntheticRollback' }] }, request: { method: 'POST', url: 'Patient' } },
    { resource: s.patient, request: { method: 'PUT', url: ref(s.patient), ifMatch: `W/"${s.firstVersion}"` } },
  ] }), r => r.status === 412);
  await observed('rollback-absence', () => request(setup, search(rollbackValue)), r => good(r) && r.data?.resourceType === 'Bundle' && r.data.total === 0 && (!r.data.entry || Array.isArray(r.data.entry) && r.data.entry.length === 0));
  checksPassed = true;
  return { patientId: s.patient.id, projectId: s.project.id, binaryHash: s.binaryHash, versionId: s.patient.meta.versionId, ledgerNamespace: s.ledger.identifier[0].value, assertions: ['history','scope-stable-precheckpoint-token','precheckpoint-revoke-existing-token','anonymous-denial','binary-bytes-context','ledger-namespace-unknown','stale-cas','atomic-rollback'] };
}
try {
  assert(['seed','verify'].includes(mode));
  let s;
  if (mode === 'seed') {
    const input = JSON.parse(readFileSync(join(root, 'client-input.private.json'))), boot = await token(input);
    const project = await create(boot, { resourceType: 'Project', name: 'Synthetic isolated restore drill', features: ['transaction-bundles'] });
    const setup = ok(await request(boot, `/admin/projects/${project.id}/client`, { name: 'Synthetic native fixture setup' })), t = await token(setup);
    let patient = await create(t, { resourceType: 'Patient', identifier: [{ system: 'https://unfiltered.example/synthetic-restore-fixture', value: `positive-${randomUUID()}` }], name: [{ family: 'SyntheticBefore' }] }); const firstVersion = patient.meta.versionId;
    patient = ok(await request(t, `/fhir/R4/${ref(patient)}`, { ...patient, name: [{ family: 'SyntheticAfter' }] }, 'PUT', { 'If-Match': `W/"${firstVersion}"` }));
    const other = await create(t, { resourceType: 'Patient', name: [{ family: 'SyntheticOther' }] });
    const document = await create(t, { resourceType: 'DocumentReference', status: 'current', subject: { reference: ref(patient) }, content: [{ attachment: { contentType: 'text/plain', data: Buffer.from('synthetic fixture').toString('base64') } }] });
    const bytes = 'Synthetic complete Binary archive fixture', binary = ok(await request(t, '/fhir/R4/Binary', bytes, 'POST', { 'Content-Type': 'text/plain', 'X-Security-Context': ref(document) }));
    const allow = await create(boot, { resourceType: 'AccessPolicy', meta: { project: project.id }, resource: [{ resourceType: 'Patient', criteria: `Patient?_id=${patient.id}`, readonly: true }, { resourceType: 'DocumentReference', criteria: `DocumentReference?_id=${document.id}`, readonly: true }, { resourceType: 'Binary', readonly: true }] });
    const deny = await create(boot, { resourceType: 'AccessPolicy', meta: { project: project.id }, resource: [{ resourceType: 'Patient', criteria: `Patient?_id=${other.id}`, readonly: true }] });
    const scoped = ok(await request(boot, `/admin/projects/${project.id}/client`, { name: 'Synthetic scoped', accessPolicy: { reference: ref(allow) } }));
    const revoked = ok(await request(boot, `/admin/projects/${project.id}/client`, { name: 'Synthetic revoked', accessPolicy: { reference: ref(allow) } }));
    const scopedToken = await token(scoped), revokedToken = await token(revoked);
    const membership = ok(await request(boot, `/fhir/R4/ProjectMembership?project=${project.id}&profile=${ref(revoked)}`)); assert.equal(membership.entry.length, 1);
    const m = membership.entry[0].resource; ok(await request(boot, `/fhir/R4/${ref(m)}`, { ...m, accessPolicy: { reference: ref(deny) } }, 'PUT'));
    const namespace = `synthetic-lifetime-${randomUUID()}`, ledgerBytes = JSON.stringify({ namespace, lifetimeReserved: 1, effect: 'unknown-do-not-replay', automaticRetry: false });
    const ledger = await create(t, { resourceType: 'DocumentReference', status: 'current', identifier: [{ system: 'https://unfiltered.example/synthetic-restore-ledger', value: namespace }], content: [{ attachment: { contentType: 'application/json', data: Buffer.from(ledgerBytes).toString('base64') } }] });
    s = { project, setup, scoped, revoked, scopedToken, revokedToken, patient, other, firstVersion, document, binary, binaryHash: hash(bytes), ledger };
    writeFileSync(statePath, JSON.stringify(s), { flag: 'wx', mode: 0o600 });
  } else s = JSON.parse(readFileSync(statePath));
  const proof = await check(s); writeFileSync(join(root, `${mode}.proof.json`), JSON.stringify(proof), { flag: 'wx', mode: 0o600 });
} catch { process.exitCode = 1; } // Never emit raw upstream errors, tokens or private fixture state.
finally {
  if (['seed','verify'].includes(mode)) writeFileSync(join(root, `${mode}.checks.json`), JSON.stringify({ state: checksPassed ? 'checks-passed' : checksStarted ? 'checks-failed-or-unknown' : 'fixture-construction-failed-or-unknown', rows }), { flag: 'wx', mode: 0o600 });
}
