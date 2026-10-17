/**
 * Offline PHQ-4 smoke: native handler button submissions -> review -> confirmed
 * in-memory FHIR handoff -> assigned clinician's staff projection. No providers,
 * real credentials or external HTTP. API smoke: npx tsx scripts/dev/phq4-local-smoke.mts --local
 * Browser backend: use --serve-local, then npm run clinic:dev (127.0.0.1 only).
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { nodeHttpHandler } from '../../apps/clinic-server/src/http.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClinicHandler } from '../../packages/clinic-api/src/handler.js';
import { handoffs } from '../../packages/clinic-api/src/handoffs.js';
import type { Runtime } from '../../packages/clinic-api/src/runtime.js';
import type { ClinicApiConfig, StaffAssignment } from '../../packages/clinic-api/src/types.js';
import type { ClinicSessionView, ReviewPreview } from '../../packages/clinic-contract/src/index.js';
import { getNativeQuestionnaireDefinition } from '../../packages/clinic-content/src/native-questionnaire.js';
import { scenarioIds } from '../../packages/clinic-content/src/workflows.js';
import { digest } from '../../packages/clinical-core/src/domain.js';
import { MedplumClient, type DeliveryQualification } from '../../packages/clinical-core/src/medplum.js';
import { mockFhir } from '../qualification/mock-fhir.js';

export function requireOfflineArguments(args: readonly string[]) {
  if (args.length > 1 || args.some(arg => !['--local', '--serve-local'].includes(arg))) {
    throw new Error('Offline smoke accepts only --local or --serve-local; hosted targets and live credentials are unsupported.');
  }
}

/** Disposable synthetic backend for the API smoke and real local PatientApp/StaffApp. */
export async function createOfflinePhq4Clinic() {
  const origin = 'http://127.0.0.1:5173';
  const patient = { reference: 'Patient/phq4-smoke-synthetic', displayName: 'PHQ smoke (synthetic)', description: 'Fictional offline smoke patient', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
  const assignment: StaffAssignment = { membershipId: 'synthetic-md', profile: 'Practitioner/md', policy: 'AccessPolicy/synthetic', name: 'Synthetic physician', role: 'physician', patients: [patient.reference], careTeams: [patient.careTeams.medical] };
  const fhir = mockFhir({ atomic: false });
  const base = { baseUrl: 'http://127.0.0.1:8103/fhir/R4/', accessToken: 'synthetic-offline-token', mode: 'local' as const, timeoutMs: 1000 };
  const initial = new MedplumClient(base, fhir.fetcher);
  const definition = await getNativeQuestionnaireDefinition();
  const questionnaire = (await initial.request('Questionnaire', 'POST', definition.questionnaire)).body as { id: string; meta: { versionId: string } };
  const nativeQuestionnaire = { ...definition.binding, reference: `Questionnaire/${questionnaire.id}/_history/${questionnaire.meta.versionId}` };
  const client = new MedplumClient({ ...base, nativeQuestionnaire }, fhir.fetcher);
  // Qualification applies exclusively to this disposable mock transport, never a live server.
  const qualification: DeliveryQualification = { deliveryContract: 'conditional-resumable-v1', baseUrl: base.baseUrl, mode: 'local', credentialFingerprint: await digest(base.accessToken), conditionalCreate: true, conditionalConcurrency: true, versionConflict: true, versionHistory: true, qualifiedAt: new Date().toISOString() };
  const config = { origin, medplumBaseUrl: 'http://127.0.0.1:8103/', clientId: 'synthetic-client', clientSecret: 'synthetic-secret', projectId: 'synthetic-project', cookieSecret: 'offline-phq4-smoke-secret'.repeat(3), mentalHealth: 'phq4', patients: Object.fromEntries(scenarioIds.map(id => [id, patient])), staff: [assignment], nativeQuestionnaire } as ClinicApiConfig;
  // This synthetic auth adapter is confined to this offline harness. All FHIR
  // requests stay in memory, including reads made by production staff routes.
  let staffActive = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'http://127.0.0.1:8103', 'External targets are forbidden');
    if (url.pathname === '/auth/login') {
      const credentials = JSON.parse(String(init?.body));
      return credentials.email === 'synthetic-md@example.invalid' && credentials.password === 'local-smoke-only'
        ? Response.json({ code: 'synthetic-code' }) : Response.json({}, { status: 401 });
    }
    if (url.pathname === '/oauth2/token') {
      if (new URLSearchParams(String(init?.body)).get('code') !== 'synthetic-code') return Response.json({}, { status: 401 });
      staffActive = true;
      return Response.json({ access_token: 'synthetic-staff-token', expires_in: 1800 });
    }
    if (!staffActive || new Headers(init?.headers).get('Authorization') !== 'Bearer synthetic-staff-token') return Response.json({}, { status: 401 });
    if (url.pathname === '/auth/me') return Response.json({ project: { id: config.projectId }, profile: { resourceType: 'Practitioner', id: 'md' }, membership: { id: assignment.membershipId }, accessPolicy: { id: 'synthetic' } });
    if (url.pathname === '/oauth2/logout') { staffActive = false; return Response.json({ success: true }); }
    assert(url.pathname.startsWith('/fhir/R4/'), 'Unexpected offline mock route');
    return fhir.fetcher(input, init);
  };
  const handler = createClinicHandler(config, { fetcher, runtime: async () => ({ client, qualification } as Runtime) });
  return { origin, client, config, assignment, handler };
}

export async function runOfflinePhq4Smoke() {
  const cases = [];
  for (const answered of [3, 4]) {
    const { origin, client, config, assignment, handler } = await createOfflinePhq4Clinic();
    let cookie = '';
    async function post<T>(path: string, body: unknown): Promise<T> {
      const response = await handler(new Request(origin + path, { method: 'POST', headers: { origin, cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
      const issued = response.headers.get('set-cookie');
      if (issued) cookie = issued.split(';')[0];
      assert.equal(response.status, path === '/api/clinic/sessions' ? 201 : 200, `Unexpected response for ${path}`);
      return await response.json() as T;
    }
    await post('/api/clinic/sessions', { scenario: 'first-intake', syntheticAcknowledged: true });
    let session = await post<ClinicSessionView>('/api/clinic/confirm-identity', { confirmed: true });
    const choices = ['1', '2', '3', '0'];
    for (let i = 0; i < answered; i++) {
      const slot = `MH0${i + 1}`;
      session = await post<ClinicSessionView>('/api/clinic/topics', { expectedRevision: session.revision, topicId: 'Q16', slotPath: slot });
      const prompt = session.currentPrompt!;
      assert.equal(prompt.id, `Q16:${slot}`);
      assert(prompt.choices?.some(choice => choice.value === choices[i]), 'Expected an authored PHQ button');
      session = await post<ClinicSessionView>('/api/clinic/turns', { requestId: crypto.randomUUID(), expectedRevision: session.revision, promptId: prompt.id, action: 'answer', text: choices[i], channel: 'text' });
    }
    const review = await post<ReviewPreview>('/api/clinic/review', { expectedRevision: session.revision });
    const expected = answered === 4 ? { gad2: 3, phq2: 3, phq4: 6 } : null;
    const screening = review.session.topics.find(topic => topic.id === 'Q16')?.screening;
    assert(screening, 'Review must include PHQ screening');
    assert.equal(screening.status, answered === 4 ? 'complete' : 'incomplete');
    assert.deepEqual(screening.scores, expected);
    assert.equal(review.session.completeness, 'partial', 'Unanswered intake topics must stay incomplete');
    const confirmed = await post<ClinicSessionView>('/api/clinic/confirm', { expectedRevision: review.session.revision, digest: review.digest });
    assert.equal(confirmed.delivery?.state, 'received');
    assert.equal(confirmed.completeness, 'partial');
    // The production staff projection checks patient/team assignment and FHIR anchors.
    // Authentication and browser rendering are outside this offline runner's scope.
    const staff = await handoffs(config).view(client, client, assignment, confirmed.delivery!.reference);
    assert.equal(staff.anchorsVerified, true);
    assert.equal(staff.completeness, 'partial');
    const staffScreening = staff.topics.find(topic => topic.id === 'Q16')?.screening;
    assert(staffScreening, 'Assigned staff must see the PHQ screening');
    assert.deepEqual(staffScreening, screening);
    assert.equal(staffScreening.clinicianReviewRequired, true);
    assert.equal(staffScreening.clinicalClearance, false);
    assert.equal(staff.sources.length, answered);
    assert(staff.sources.every(source => source.channel === 'text'));
    const details = staff.topics.find(topic => topic.id === 'Q16')!.details!;
    for (let i = 0; i < 4; i++) {
      const detail = details.find(detail => detail.id === `MH0${i + 1}`);
      assert(detail);
      assert.equal(detail.state, i < answered ? 'answered' : 'not-asked');
      if (i < answered) {
        assert.equal(detail.text, choices[i]);
        assert.equal(detail.sourceIds.length, 1);
        assert(staff.sources.some(source => source.id === detail.sourceIds[0] && source.channel === 'text'));
      } else assert.deepEqual(detail.sourceIds, []);
    }
    cases.push({ answered, screeningStatus: staffScreening.status, scores: staffScreening.scores, intakeCompleteness: staff.completeness, delivery: confirmed.delivery!.state });
  }
  return { mode: 'offline' as const, coverage: 'native-handler-and-staff-projection' as const, cases };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  requireOfflineArguments(process.argv.slice(2));
  if (process.argv.includes('--serve-local')) {
    const { handler } = await createOfflinePhq4Clinic();
    createServer(nodeHttpHandler(handler)).listen(8787, '127.0.0.1', () => {
      console.log('Synthetic offline PHQ backend on 127.0.0.1:8787; start npm run clinic:dev and open http://127.0.0.1:5173');
      console.log('Staff fixture: synthetic-md@example.invalid / local-smoke-only (mock auth only; no real credentials)');
    });
  } else console.log(JSON.stringify(await runOfflinePhq4Smoke(), null, 2));
}
