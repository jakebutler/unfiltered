import { ClinicalError, digest, type ConfirmedSubmission } from './domain.js';
import { IDENTIFIER_SYSTEM, identifierQuery, planHandoff, type FhirResource } from './fhir.js';
import { MedplumClient, fhirResource, type AtomicQualification, type MedplumConfig } from './medplum.js';
import { TransportError, type Fetch } from './transport.js';

export interface QualificationReport {
  mode: 'mock' | 'local' | 'live'; runId: string; endpoint: string;
  checks: { batchControl: boolean; atomicRollback: boolean; validTransaction: boolean; conditionalCreate: boolean; versionConflict: boolean; lostResponseRecovery: boolean; payloadConflict: boolean };
  nativeTransactions: 'qualified-for-tested-credentials' | 'mock-pass' | 'not-qualified';
  handoff: 'received' | 'mock-received' | 'not-qualified';
  authorization: 'not-qualified'; providerInference: 'not-called';
  retainedSyntheticIdentifiers: string[];
  qualification?: AtomicQualification;
}
const asRecord = (v: unknown): Record<string, unknown> => v && typeof v === 'object' ? v as Record<string, unknown> : {};
const version = (r: FhirResource): string | undefined => {
  const v = asRecord(r.meta).versionId;
  return typeof v === 'string' && /^[A-Za-z0-9.-]{1,64}$/.test(v) ? v : undefined;
};
function patient(key: string, marker: string): FhirResource {
  return { resourceType: 'Patient', identifier: [{ system: IDENTIFIER_SYSTEM, value: key }], active: true, name: [{ text: `SYNTHETIC QUALIFICATION ${marker}` }] };
}

/** Explicitly writes synthetic fixtures. Preserve resources for inspection; never run on real patients. */
export async function qualifyMedplum(config: MedplumConfig, confirmation: ConfirmedSubmission, fetcher: Fetch = fetch, simulated = false): Promise<QualificationReport> {
  assertSyntheticQualification(confirmation);
  const client = new MedplumClient(config, fetcher);
  const runId = crypto.randomUUID();
  const keys = { batch: `qualification.${runId}.batch`, rollback: `qualification.${runId}.rollback`, conditional: `qualification.${runId}.conditional`, staleTarget: `qualification.${runId}.stale-target` };
  const report: QualificationReport = {
    mode: simulated ? 'mock' : config.mode, runId, endpoint: client.config.baseUrl,
    checks: { batchControl: false, atomicRollback: false, validTransaction: false, conditionalCreate: false, versionConflict: false, lostResponseRecovery: false, payloadConflict: false },
    nativeTransactions: 'not-qualified', handoff: 'not-qualified', authorization: 'not-qualified', providerInference: 'not-called', retainedSyntheticIdentifiers: Object.values(keys),
  };
  const staleTarget = fhirResource((await client.request('Patient', 'POST', patient(keys.staleTarget, 'stale-write-target'), { 'If-None-Exist': identifierQuery(keys.staleTarget) })).body);
  if (!staleTarget.id || !version(staleTarget)) throw new ClinicalError('qualification-control-not-created');
  const staleVersion = version(staleTarget) === '00000000-0000-0000-0000-000000000000' ? '11111111-1111-1111-1111-111111111111' : '00000000-0000-0000-0000-000000000000';
  const testBundle = (type: 'batch' | 'transaction', key: string) => ({
    resourceType: 'Bundle', type, entry: [
      { resource: patient(key, type), request: { method: 'POST', url: 'Patient', ifNoneExist: identifierQuery(key) } },
      // Guaranteed execution-level conflict; schema validation may be permissive on a project.
      { resource: { ...staleTarget, active: false }, request: { method: 'PUT', url: `Patient/${staleTarget.id}`, ifMatch: `W/"${staleVersion}"` } },
    ],
  });
  // A valid batch control must persist alongside a rejected sibling; otherwise absence proves nothing.
  try {
    const batch = await client.request('', 'POST', testBundle('batch', keys.batch));
    const b = asRecord(batch.body);
    const entries = Array.isArray(b.entry) ? b.entry : [];
    report.checks.batchControl = b.type === 'batch-response' && entries.length === 2 && /^20[01]\b/.test(String(asRecord(asRecord(entries[0]).response).status)) && /^412\b/.test(String(asRecord(asRecord(entries[1]).response).status)) && !!(await client.findByIdentifier('Patient', keys.batch));
  } catch { /* Lack of conclusive evidence remains not qualified. */ }
  try {
    let rejected = false;
    try { await client.request('', 'POST', testBundle('transaction', keys.rollback)); }
    catch (error) { rejected = error instanceof TransportError && error.code === 'http' && error.status === 412; }
    report.checks.atomicRollback = report.checks.batchControl && rejected && !(await client.findByIdentifier('Patient', keys.rollback));
  } catch { /* Read failure is not rollback evidence. */ }
  try {
    const original = patient(keys.conditional, 'original');
    const first = fhirResource((await client.request('Patient', 'POST', original, { 'If-None-Exist': identifierQuery(keys.conditional) })).body);
    const again = fhirResource((await client.request('Patient', 'POST', patient(keys.conditional, 'must-not-overwrite'), { 'If-None-Exist': identifierQuery(keys.conditional) })).body);
    const read = await client.findByIdentifier('Patient', keys.conditional);
    report.checks.conditionalCreate = !!first.id && first.id === again.id && read?.id === first.id && JSON.stringify(read.name) === JSON.stringify(original.name);
    if (report.checks.conditionalCreate && read?.id && version(read)) {
      const initialVersion = version(read)!;
      const next = fhirResource((await client.request(`Patient/${read.id}`, 'PUT', { ...read, active: false }, { 'If-Match': `W/"${initialVersion}"` })).body);
      let staleRejected = false;
      try { await client.request(`Patient/${read.id}`, 'PUT', { ...read, active: true }, { 'If-Match': `W/"${initialVersion}"` }); }
      catch (error) { staleRejected = error instanceof TransportError && error.status === 412; }
      const latest = fhirResource((await client.request(`Patient/${read.id}`)).body);
      report.checks.versionConflict = !!version(next) && version(next) !== initialVersion && staleRejected && latest.active === false && version(latest) === version(next);
    }
  } catch { /* Do not proceed as qualified if conditional identity or version checks failed. */ }
  if (report.checks.atomicRollback && report.checks.conditionalCreate && report.checks.versionConflict) {
    const qualification: AtomicQualification = { baseUrl: client.config.baseUrl, mode: config.mode, credentialFingerprint: await digest(config.accessToken), atomicRollback: true, conditionalCreate: true, versionConflict: true, qualifiedAt: new Date().toISOString() };
    let dropped = false;
    let validTransactionResponse = false;
    const expectedEntries = (await planHandoff(confirmation)).components.length;
    const loseReceipt: Fetch = async (url, init) => {
      const response = await fetcher(url, init);
      if (!dropped && init?.method === 'POST' && String(url) === client.config.baseUrl && response.ok) {
        const accepted = asRecord(await response.clone().json());
        validTransactionResponse = accepted.resourceType === 'Bundle' && accepted.type === 'transaction-response' && Array.isArray(accepted.entry) && accepted.entry.length === expectedEntries && accepted.entry.every(e => /^20[01]\b/.test(String(asRecord(asRecord(e).response).status)));
        dropped = true;
        await response.arrayBuffer();
        throw new Error('simulated lost acknowledgement after server response');
      }
      return response;
    };
    const delivery = await new MedplumClient(config, loseReceipt).deliver(confirmation, qualification);
    report.checks.validTransaction = validTransactionResponse && delivery.receipt.state === 'received';
    if (!report.checks.validTransaction) report.checks.atomicRollback = false;
    report.checks.lostResponseRecovery = dropped && delivery.write === 'outcome-unknown' && delivery.receipt.state === 'received';
    report.handoff = delivery.receipt.state === 'received' ? (simulated ? 'mock-received' : 'received') : 'not-qualified';
    const plan = await planHandoff(confirmation);
    report.retainedSyntheticIdentifiers.push(...plan.components.map(c => c.key));
    const changed = structuredClone(confirmation.submission);
    changed.sources[0].text += ' DIFFERENT PAYLOAD';
    const changedDigest = await digest(changed);
    const conflict = await client.check({ ...confirmation, submission: changed, digest: changedDigest, ...(confirmation.sufficiency ? { sufficiency: { ...confirmation.sufficiency, submissionDigest: changedDigest } } : {}) });
    report.checks.payloadConflict = conflict.state === 'conflict';
    if (Object.values(report.checks).every(Boolean)) {
      report.nativeTransactions = simulated ? 'mock-pass' : 'qualified-for-tested-credentials';
      // Never publish a capability before the positive transaction and full recovery proof.
      if (!simulated) report.qualification = qualification;
    }
  }
  return report;
}
export function assertSyntheticQualification(confirmation: ConfirmedSubmission): void {
  if (!confirmation.submission.submissionId.startsWith('qualification-')) throw new ClinicalError('qualification-fixture-required');
}
