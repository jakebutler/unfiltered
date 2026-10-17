/** Separate one-shot GET diagnostic. Never imports/replays the original fixture client. */
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const STAGES = Object.freeze(['setup-token', 'setup-current-patient', 'setup-other-patient',
  'setup-document', 'patient-history', 'patient-first-version', 'scoped-current-patient',
  'scoped-other-denial', 'revoked-current-denial', 'anonymous-current-denial',
  'scoped-binary-bytes', 'setup-binary-context', 'setup-ledger']);
const uuid = v => typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v);
const ref = r => `${r.resourceType}/${r.id}`;
const sha = b => createHash('sha256').update(b).digest('hex');
const success = r => r.status >= 200 && r.status < 300;
const denied = r => [401, 403, 404].includes(r.status);

export async function diagnose(s, fetcher = fetch) {
  const rows = [], deadline = AbortSignal.timeout(180000);
  let setup, requests = 0;
  // Validate private input without emitting its fields or upstream exceptions.
  if (!s || !uuid(s.setup?.id) || typeof s.setup.secret !== 'string' || !s.setup.secret.length || s.setup.secret.length > 16384 ||
      !['scopedToken', 'revokedToken'].every(k => typeof s[k] === 'string' && s[k].length > 0 && s[k].length <= 32768) ||
      ![['patient', 'Patient'], ['other', 'Patient'], ['document', 'DocumentReference'], ['binary', 'Binary'], ['ledger', 'DocumentReference']]
        .every(([k, type]) => s[k]?.resourceType === type && uuid(s[k].id)) ||
      !['patient', 'other', 'document', 'ledger'].every(k => uuid(s[k]?.meta?.versionId)) ||
      typeof s.ledger.content?.[0]?.attachment?.data !== 'string' || typeof s.ledger.identifier?.[0]?.value !== 'string' ||
      !uuid(s.firstVersion) || !/^[a-f0-9]{64}$/.test(s.binaryHash)) throw new Error('private-fixture-invalid');
  async function request(path, bearer, accept = 'application/fhir+json', grant = false) {
    if (++requests > 13 || !path.startsWith('/') || path.startsWith('//') || (grant && path !== '/oauth2/token')) throw new Error('fixed-request-bound');
    const response = await fetcher(`http://server:8103${path}`, {
      method: grant ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.any([deadline, AbortSignal.timeout(15000)]),
      headers: { Accept: accept, 'X-Medplum': 'extended', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(grant ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      ...(grant ? { body: new URLSearchParams({ grant_type: 'client_credentials', client_id: s.setup.id, client_secret: s.setup.secret }).toString() } : {}),
    });
    const chunks = []; let size = 0;
    if (!response.body) throw new Error('response-body-required');
    for await (const chunk of response.body) { size += chunk.length; if (size > 1048576) throw new Error('response-bound'); chunks.push(Buffer.from(chunk)); }
    const bytes = Buffer.concat(chunks); let data;
    try { data = JSON.parse(bytes.toString('utf8')); } catch { data = undefined; }
    return { status: response.status, bytes, data };
  }
  const steps = [
    [() => request('/oauth2/token', undefined, 'application/fhir+json', true), r => {
      if (!success(r) || typeof r.data?.access_token !== 'string' || !r.data.access_token.length || r.data.access_token.length > 32768) return false;
      setup = r.data.access_token; return true;
    }],
    [() => request(`/fhir/R4/${ref(s.patient)}`, setup), r => success(r) && r.data?.meta?.versionId === s.patient.meta?.versionId],
    [() => request(`/fhir/R4/${ref(s.other)}`, setup), r => success(r) && r.data?.id === s.other.id && r.data?.meta?.versionId === s.other.meta?.versionId],
    [() => request(`/fhir/R4/${ref(s.document)}`, setup), r => success(r) && r.data?.id === s.document.id && r.data?.meta?.versionId === s.document.meta?.versionId && r.data?.subject?.reference === ref(s.patient)],
    [() => request(`/fhir/R4/${ref(s.patient)}/_history`, setup), r => success(r) && r.data?.entry?.length === 2],
    [() => request(`/fhir/R4/${ref(s.patient)}/_history/${s.firstVersion}`, setup), r => success(r) && r.data?.name?.[0]?.family === 'SyntheticBefore'],
    [() => request(`/fhir/R4/${ref(s.patient)}`, s.scopedToken), r => success(r) && r.data?.id === s.patient.id],
    [() => request(`/fhir/R4/${ref(s.other)}`, s.scopedToken), denied],
    [() => request(`/fhir/R4/${ref(s.patient)}`, s.revokedToken), denied],
    [() => request(`/fhir/R4/${ref(s.patient)}`), denied],
    [() => request(`/fhir/R4/${ref(s.binary)}`, s.scopedToken, 'text/plain'), r => r.status === 200 && sha(r.bytes) === s.binaryHash],
    [() => request(`/fhir/R4/${ref(s.binary)}`, setup), r => success(r) && r.data?.securityContext?.reference === ref(s.document)],
    [() => request(`/fhir/R4/${ref(s.ledger)}`, setup), r => success(r) && r.data?.meta?.versionId === s.ledger.meta?.versionId && r.data?.content?.[0]?.attachment?.data === s.ledger.content?.[0]?.attachment?.data && r.data?.identifier?.[0]?.value === s.ledger.identifier?.[0]?.value],
  ];
  for (let i = 0; i < steps.length; i++) {
    let status = 0, outcome = 'transport-or-body-unknown';
    try { const r = await steps[i][0](); status = r.status; outcome = steps[i][1](r) ? 'pass' : 'expectation-failed'; } catch { /* Fixed outcome only. */ }
    rows.push({ stage: STAGES[i], status, outcome });
    if (outcome !== 'pass') return { state: 'read-boundary-failed-or-unknown', rows, automaticRetry: false, mutationChecksReplayed: false };
  }
  return { state: 'read-checks-passed-mutation-boundary-not-replayed', rows, automaticRetry: false, mutationChecksReplayed: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result = { state: 'private-input-rejected', rows: [], automaticRetry: false, mutationChecksReplayed: false };
  try {
    if (process.argv.slice(2).length) throw new Error('fixed-paths-only');
    const path = '/private/fixture.private.json', info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1048576 || info.mode & 0o077) throw new Error('private-file-required');
    result = await diagnose(JSON.parse(readFileSync(path, 'utf8')));
  } catch { /* Never expose parsed fixture data, credentials, bodies, or exception text. */ }
  writeFileSync('/diagnostic/read-status.json', JSON.stringify(result), { flag: 'wx', mode: 0o600 });
  if (result.state !== 'read-checks-passed-mutation-boundary-not-replayed') process.exitCode = 1;
}
