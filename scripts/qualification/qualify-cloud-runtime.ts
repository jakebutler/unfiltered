import { qualifyConditionalClinic, type QualifiedActor } from './conditional-clinic.js';
import { MedplumClient } from '../../packages/clinical-core/src/medplum.js';
/** Loopback-only native validation of portable deployment/runtime boundaries. */
import { readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { digest, type Submission } from '../../packages/clinical-core/src/domain.js';
import { qualifyConditionalMedplum } from '../../packages/clinical-core/src/qualification.js';
import { sealDeploymentQualification, type QualifiedClinicConfig } from '../../packages/clinic-api/src/deployment-qualification.js';
import { runtimeProvider } from '../../packages/clinic-api/src/runtime.js';
import { staffAuthentication } from '../../packages/clinic-api/src/auth.js';
import { cookies } from '../../packages/clinic-api/src/cookies.js';
import { verifyNativeStaffRevocation } from '../../packages/clinic-api/src/deployment-probes.js';

async function main() {
if (!process.argv.includes('--allow-local-synthetic-writes')) throw new Error('explicit-local-synthetic-qualification-required');
const configPath = resolve('infra/local/.clinic-config.json');
if (statSync(configPath).mode & 0o077) throw new Error('private-config-required');
const config = JSON.parse(readFileSync(configPath, 'utf8')) as QualifiedClinicConfig;
if (config.medplumBaseUrl !== 'http://localhost:8103/') throw new Error('qualification-exact-local-stack-required');
const localEnv = Object.fromEntries(readFileSync('infra/local/.env', 'utf8').split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const calls: { phase: string; method: string; path: string }[] = [];
let phase = 'deployment-proof';
const fetcher: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== 'http://localhost:8103') throw new Error('local-qualification-origin-mismatch');
  calls.push({ phase, method: init?.method ?? 'GET', path: url.pathname });
  return fetch(input, { ...init, redirect: 'error', signal: init?.signal ?? AbortSignal.timeout(10000) });
};
async function token(clientId: string, clientSecret: string) {
  const response = await fetcher(new URL('oauth2/token', config.medplumBaseUrl), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'openid' }) });
  if (!response.ok) throw new Error(`local-token-${response.status}`);
  return (await response.json()).access_token as string;
}
const setupToken = await token(localEnv.MEDPLUM_DEFAULT_SUPER_ADMIN_CLIENT_ID, localEnv.MEDPLUM_DEFAULT_SUPER_ADMIN_CLIENT_SECRET);
const projectResponse = await fetcher(new URL(`fhir/R4/Project/${config.projectId}`, config.medplumBaseUrl), { headers: { Authorization: `Bearer ${setupToken}`, 'X-Medplum': 'extended' } });
if (!projectResponse.ok) throw new Error(`local-project-read-${projectResponse.status}`);
const project = await projectResponse.json();
if (project.id !== config.projectId || !project.meta?.versionId) throw new Error('local-project-feature-not-observed');
const observation = { projectId: project.id, projectVersion: project.meta.versionId, features: project.features ?? [], observedAt: new Date().toISOString() };
const accessToken = await token(config.clientId, config.clientSecret);
const medplum = { baseUrl: new URL('fhir/R4/', config.medplumBaseUrl).href, accessToken, mode: 'local' as const, timeoutMs: 10000 };
const patient = config.patients['first-intake'];
const submission: Submission = { submissionId: `qualification-portable-${crypto.randomUUID()}`, version: 1, patient: patient.reference, scenario: 'first-intake', contentVersion: 'technical-deployment-probe', questionnaire: 'https://corvo.example/Questionnaire/technical-deployment-probe', confirmedAt: new Date().toISOString(), completeness: 'partial', sources: [{ id: 'probe', patient: patient.reference, kind: 'patient-statement', text: 'Synthetic deployment storage qualification only. No clinical assessment.', capturedAt: new Date().toISOString() }], answers: [{ questionId: 'probe', state: 'answered', text: 'Synthetic deployment storage qualification only.', sourceIds: ['probe'] }], work: [{ id: 'probe', kind: 'clinical', responsibility: 'medical', owner: patient.careTeams.medical }] };
const report = await qualifyConditionalMedplum(medplum, { submission, digest: await digest(submission) }, fetcher);
if (!report.qualification) throw new Error('selected-storage-qualification-required');
const qualificationUsers = JSON.parse(readFileSync('infra/local/.clinic-users.json', 'utf8')) as { role: string; email: string; password: string }[];
const actors: QualifiedActor[] = [], sessions: Request[] = [], appEvidence: unknown[] = [];
for (const user of qualificationUsers) { const auth = staffAuthentication(config, fetcher, cookies(config.cookieSecret, false)); const login = await auth.login(user.email, user.password); const request = new Request(new URL('api/staff/me', config.origin), { headers: { cookie: login.cookie.split(';')[0] } }); sessions.push(request); actors.push(await auth.read(request)); }
let application;
try { application = await qualifyConditionalClinic(config, new MedplumClient(medplum, fetcher), report.qualification, actors, fetcher, value => appEvidence.push(value)); } finally { for (const request of sessions) await staffAuthentication(config, fetcher, cookies(config.cookieSecret, false)).logout(request); }
const attestation = await sealDeploymentQualification(config, medplum, report, observation, fetcher, application);
const qualifiedConfig = { ...config, storageQualification: attestation };
phase = 'runtime-cold-start';
await runtimeProvider(qualifiedConfig, fetcher)();
phase = 'runtime-restart';
await runtimeProvider(qualifiedConfig, fetcher)();
phase = 'runtime-forced-token-refresh';
const refreshFetcher: typeof fetch = async (input, init) => {
  const response = await fetcher(input, init);
  if (new URL(String(input)).pathname !== '/oauth2/token' || !response.ok) return response;
  const body = await response.json();
  // Force immediate cache expiry without changing the issued native token.
  return Response.json({ ...body, expires_in: 1 });
};
const refreshed = runtimeProvider(qualifiedConfig, refreshFetcher);
await refreshed(); await refreshed();
const runtimeCalls = calls.filter(call => call.phase.startsWith('runtime-'));
if (runtimeCalls.some(call => call.path.startsWith('/fhir/') && call.method !== 'GET')) throw new Error('runtime-repeated-qualification-write');
phase = 'staff-portability';
const users = JSON.parse(readFileSync('infra/local/.clinic-users.json', 'utf8')) as { role: string; email: string; password: string }[];
const medical = users.find(user => user.role === 'physician');
if (!medical) throw new Error('local-medical-fixture-required');
const auth = () => staffAuthentication(config, fetcher, cookies(config.cookieSecret, false));
const login = await auth().login(medical.email, medical.password);
const cookie = login.cookie.split(';')[0];
const request = () => new Request(new URL('api/staff/me', config.origin), { headers: { cookie } });
const actor = await auth().read(request());
await auth().logout(request());
await verifyNativeStaffRevocation(config.medplumBaseUrl, actor.client.config.accessToken, fetcher);
const evidence = { schema: 1, at: new Date().toISOString(), projectId: config.projectId, mode: 'local', report, appEvidence, attestationIdentity: attestation.payload.identity, projectFeatureObservation: observation, runtimeFhirWrites: 0, runtimeRefreshes: runtimeCalls.filter(call => call.path === '/oauth2/token').length, staffCrossInstanceRead: true, nativeLogoutRevokedCopiedCookie: true, calls, providerCalls: 0, cloudCalls: 0 };
const output = resolve(`infra/cloud/.private/local-portability-${Date.now()}.json`);
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ status: 'native-local-portability-passed', runtimeFhirWrites: 0, runtimeRefreshes: evidence.runtimeRefreshes, staffCrossInstanceRead: true, nativeLogoutRevokedCopiedCookie: true, evidence: output, providerCalls: 0, cloudCalls: 0 }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
