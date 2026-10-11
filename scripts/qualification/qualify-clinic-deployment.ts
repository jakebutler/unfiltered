import { qualifyConditionalClinic, type QualifiedActor } from './conditional-clinic.js';
/** Explicit synthetic deployment qualification; never imported by request handlers. */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { digest, type Submission } from '../../packages/clinical-core/src/domain.js';
import { qualifyConditionalMedplum } from '../../packages/clinical-core/src/qualification.js';
import { MedplumClient } from '../../packages/clinical-core/src/medplum.js';
import { observeRuntimeIdentity, sealDeploymentQualification, type QualifiedClinicConfig, type ProjectFeatureObservation } from '../../packages/clinic-api/src/deployment-qualification.js';
import { runtimeProvider } from '../../packages/clinic-api/src/runtime.js';
import { staffAuthentication } from '../../packages/clinic-api/src/auth.js';
import { cookies } from '../../packages/clinic-api/src/cookies.js';
import { TransportError } from '../../packages/clinical-core/src/transport.js';
import { assertDeploymentStaffRoster, verifyNativeStaffRevocation } from '../../packages/clinic-api/src/deployment-probes.js';
import { deploymentFixtures, type FixtureIntent } from './deployment-fixtures.js';

async function main() {
  const arg = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
  if (!process.argv.includes('--allow-synthetic-qualification-writes') || !arg('--config') || !arg('--output')) throw new Error('explicit-config-output-and-synthetic-write-flag-required');
  const path = resolve(arg('--config')!), output = resolve(arg('--output')!), directory = dirname(path);
  const privateJson = (file: string) => { if (statSync(file).mode & 0o077) throw new Error('qualification-private-file-required'); return JSON.parse(readFileSync(file, 'utf8')); };
  const config = privateJson(path) as QualifiedClinicConfig;
  const local = config.medplumBaseUrl === 'http://localhost:8103/';
  if (!local && (config.medplumBaseUrl !== 'https://api.medplum.com/' || config.projectId !== '13eaac67-a2c3-4aa1-aa9e-590a083e5fef' || config.clientId !== '50db76bd-d099-4305-8ec3-7439ffc38ca1')) throw new Error('qualification-target-not-authorized');
  const observation = privateJson(`${directory}/project-feature-observation.json`) as ProjectFeatureObservation;
  const users = privateJson(`${directory}/clinic-users.json`) as { role: string; name: string; email: string; password: string }[];
  assertDeploymentStaffRoster(config, users);
  if (observation?.projectId !== config.projectId || !observation.projectVersion || !Array.isArray(observation.features) || !Number.isFinite(Date.parse(observation.observedAt)) || Math.abs(Date.now() - Date.parse(observation.observedAt)) > 900000) throw new Error('fresh-project-feature-observation-required');
  const evidence: Record<string, unknown> = { state: 'intent', at: new Date().toISOString(), projectId: config.projectId, mode: local ? 'local' : 'live', calls: [] as unknown[], checks: [] as unknown[], fixtures: [] as FixtureIntent[], providerCalls: 0 };
  writeFileSync(`${output}.evidence.json`, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const save = () => writeFileSync(`${output}.evidence.json`, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  const calls = evidence.calls as { phase: string; method: string; path: string }[];
  const checks = evidence.checks as { check: string; passed: boolean }[];
  let phase = 'qualification';
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== new URL(config.medplumBaseUrl).origin) throw new Error('qualification-origin-mismatch');
    calls.push({ phase, method: init?.method ?? 'GET', path: url.pathname }); save();
    return fetch(input, { ...init, redirect: 'error', signal: init?.signal ?? AbortSignal.timeout(10000) });
  };
  const check = (name: string, passed: boolean) => { checks.push({ check: name, passed }); save(); if (!passed) throw new Error(`deployment-check-failed:${name}`); };
  try {
    const response = await fetcher(new URL('oauth2/token', config.medplumBaseUrl), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret, scope: 'openid' }) });
    if (!response.ok) throw new Error(`deployment-auth-http-${response.status}`);
    const accessToken = (await response.json()).access_token;
    if (typeof accessToken !== 'string') throw new Error('deployment-token-missing');
    const medplum = { baseUrl: new URL('fhir/R4/', config.medplumBaseUrl).href, accessToken, mode: local ? 'local' as const : 'live' as const, timeoutMs: 10000 };
    const identity = await observeRuntimeIdentity(config, medplum, fetcher);
    if (!local && identity.membershipId !== '6e565de2-837d-4618-9578-f6428fbb0be1') throw new Error('qualification-membership-not-authorized');
    const patient = config.patients['first-intake'];
    const submission: Submission = { submissionId: `qualification-deployment-${crypto.randomUUID()}`, version: 1, patient: patient.reference, scenario: 'first-intake', contentVersion: 'technical-deployment-probe', questionnaire: 'https://corvo.example/Questionnaire/technical-deployment-probe', confirmedAt: new Date().toISOString(), completeness: 'partial', sources: [{ id: 'probe', patient: patient.reference, kind: 'patient-statement', text: 'Synthetic deployment storage qualification. No clinical assessment.', capturedAt: new Date().toISOString() }], answers: [{ questionId: 'probe', state: 'answered', text: 'Synthetic deployment storage qualification only.', sourceIds: ['probe'] }], work: [{ id: 'probe', kind: 'clinical', responsibility: 'medical', owner: patient.careTeams.medical }] };
    const confirmation = { submission, digest: await digest(submission) };
    evidence.submissionId = submission.submissionId; save();
    const report = await qualifyConditionalMedplum(medplum, confirmation, fetcher);
    evidence.storageReport = report; save();
    if (!report.qualification) throw new Error('selected-conditional-storage-qualification-required');
    const client = new MedplumClient(medplum, fetcher);
    const receipt = await client.check(confirmation);
    check('native-receipt-received', receipt.state === 'received');
    if (receipt.state !== 'received') throw new Error('receipt-required');
    const reference = (type: string) => { const found = Object.values(receipt.resources).find(value => value.startsWith(`${type}/`)); if (!found) throw new Error('required-native-resource-absent'); return found; };
    const unrelated = config.staff.find(staff => staff.name === 'Dr. Quinn Parker')?.patients[0];
    if (!unrelated || unrelated === patient.reference) throw new Error('unrelated-fixture-required');
    const fixtures = deploymentFixtures(client, fetcher, evidence.fixtures as FixtureIntent[], save);
    const logistics = await fixtures.resource(`${submission.submissionId}.logistics`, { resourceType: 'Task', status: 'ready', intent: 'order', for: { reference: patient.reference }, code: { coding: [{ system: 'urn:corvo:clinical:work-kind', code: 'administrative' }] }, description: 'Synthetic scheduling assistance requested.' });
    const unrelatedSource = await fixtures.resource(`${submission.submissionId}.unrelated-source`, { resourceType: 'DocumentReference', status: 'current', subject: { reference: unrelated }, content: [{ attachment: { contentType: 'text/plain', data: btoa('Synthetic unrelated patient source.') } }] });
    const binaryKey = `${submission.submissionId}.binary-source`;
    const binaryText = `Synthetic source access qualification only. Fixture: ${binaryKey}`;
    const binary = await fixtures.binary(binaryKey, reference('DocumentReference'), binaryText);
    const denied = async (named: MedplumClient, path: string) => { try { await named.request(path); return false; } catch (error) { return error instanceof TransportError && [401, 403, 404].includes(error.status ?? 0); } };
    phase = 'role-authorization';
    for (const user of users) {
      const auth = () => staffAuthentication(config, fetcher, cookies(config.cookieSecret, !local));
      const login = await auth().login(user.email, user.password);
      const request = new Request(new URL('api/staff/me', config.origin), { headers: { cookie: login.cookie.split(';')[0] } });
      const actor = await auth().read(request);
      check(`${user.name}:cross-instance-identity`, actor.assignment.name === user.name);
      if (user.name === 'Dr. Quinn Parker' || user.role === 'administrative') {
        check(`${user.name}:patient-denied`, await denied(actor.client, patient.reference));
        check(`${user.name}:response-denied`, await denied(actor.client, reference('QuestionnaireResponse')));
        check(`${user.name}:source-denied`, await denied(actor.client, reference('DocumentReference')));
        check(`${user.name}:clinical-task-denied`, await denied(actor.client, reference('Task')));
        check(`${user.name}:binary-denied`, await denied(actor.client, `Binary/${binary.id}`));
        if (user.role === 'administrative') check(`${user.name}:logistics-readable`, (await actor.client.request(`Task/${logistics.id}`)).status === 200);
        else check(`${user.name}:own-patient-readable`, (await actor.client.request(unrelated)).status === 200);
      } else {
        for (const path of [patient.reference, reference('QuestionnaireResponse'), reference('DocumentReference'), reference('Task')]) check(`${user.name}:read:${path.split('/')[0]}`, (await actor.client.request(path)).status === 200);
        check(`${user.name}:unrelated-patient-denied`, await denied(actor.client, unrelated));
        check(`${user.name}:unrelated-source-denied`, await denied(actor.client, `DocumentReference/${unrelatedSource.id}`));
        const source = await fetcher(new URL(`Binary/${binary.id}`, medplum.baseUrl), { headers: { Authorization: `Bearer ${actor.client.config.accessToken}`, Accept: 'text/plain' } });
        check(`${user.name}:binary-readable`, source.ok && await source.text() === binaryText);
      }
      await auth().logout(request);
      const revoked = await verifyNativeStaffRevocation(config.medplumBaseUrl, actor.client.config.accessToken, fetcher);
      check(`${user.name}:logout-revokes-cookie`, revoked.state === 'revoked');
    }
    phase = 'application-contract';
    const actors: QualifiedActor[] = [], sessions: Request[] = [];
    for (const user of users) { const auth = staffAuthentication(config, fetcher, cookies(config.cookieSecret, !local)); const login = await auth.login(user.email, user.password); const request = new Request(new URL('api/staff/me', config.origin), { headers: { cookie: login.cookie.split(';')[0] } }); sessions.push(request); actors.push(await auth.read(request)); }
    let application;
    try { application = await qualifyConditionalClinic(config, client, report.qualification, actors, fetcher, value => { if (!Array.isArray(evidence.applicationFixtures)) evidence.applicationFixtures = []; (evidence.applicationFixtures as unknown[]).push(value); save(); }); } finally { for (const request of sessions) await staffAuthentication(config, fetcher, cookies(config.cookieSecret, !local)).logout(request); }
    const attestation = await sealDeploymentQualification(config, medplum, report, observation, fetcher, application);
    const qualifiedConfig = { ...config, storageQualification: attestation };
    check('runtime-project-membership-denied', await denied(client, `ProjectMembership/${attestation.payload.identity.membershipId}`));
    check('runtime-access-policies-denied', await denied(client, 'AccessPolicy'));
    check('runtime-clients-denied', await denied(client, 'ClientApplication'));
    phase = 'runtime-refresh';
    const refreshFetcher: typeof fetch = async (input, init) => { const result = await fetcher(input, init); if (new URL(String(input)).pathname !== '/oauth2/token' || !result.ok) return result; return Response.json({ ...await result.json(), expires_in: 1 }); };
    const runtime = runtimeProvider(qualifiedConfig, refreshFetcher);
    await runtime(); await runtime(); await runtimeProvider(qualifiedConfig, fetcher)();
    check('refresh-and-restart-have-zero-fhir-writes', !calls.some(call => call.phase === phase && call.path.startsWith('/fhir/') && call.method !== 'GET'));
    writeFileSync(output, `${JSON.stringify(qualifiedConfig, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    evidence.state = 'passed'; evidence.attestationIdentity = attestation.payload.identity; evidence.expiresAt = attestation.payload.expiresAt; save();
    console.log(JSON.stringify({ status: 'deployment-qualified', projectId: config.projectId, checks: checks.length, configuration: output, expiresAt: attestation.payload.expiresAt, providerCalls: 0 }));
  } catch (error) { evidence.state = 'failed-retain-native-fixtures'; evidence.error = error instanceof Error ? error.message : 'qualification-failed'; save(); throw error; }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
