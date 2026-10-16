import { afterEach, describe, expect, it, vi } from 'vitest';
import { scenarioIds } from '../../clinic-content/src/workflows.js';
import { MedplumClient, type DeliveryQualification } from '../../clinical-core/src/medplum.js';
import { mockFhir } from '../../../scripts/qualification/mock-fhir.js';
import { createClinicHandler } from '../src/handler.js';
import { cookies } from '../src/cookies.js';
import { staffSessionCookies } from '../src/staff-session.js';
import { readDraft, saveDraft } from '../src/store.js';
import type { ClinicApiConfig } from '../src/types.js';
import * as priorContext from '../src/prior-context.js';
const origin = 'https://clinic.example';
const patient = { reference: 'Patient/synthetic-patient', displayName: 'Invited synthetic patient', description: 'Fictional only', careTeams: { medical: 'CareTeam/medical', nutrition: 'CareTeam/nutrition', administrative: 'CareTeam/admin' } };
const assignment = { membershipId: 'member-1', profile: 'Practitioner/staff-1', policy: 'AccessPolicy/staff-policy', name: 'Synthetic physician', role: 'physician' as const, patients: [patient.reference], careTeams: [patient.careTeams.medical] };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
async function setup() {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const config: ClinicApiConfig = { origin, medplumBaseUrl: 'https://medplum.example/', projectId: 'synthetic-project', clientId: 'synthetic-client', clientSecret: 'synthetic-secret', cookieSecret: 'synthetic-cookie-key-at-least32characters', mentalHealth: 'phq4', patients: Object.fromEntries(scenarioIds.map(scenario => [scenario, scenario === 'first-intake' ? patient : { ...patient, reference: `Patient/${scenario}`, displayName: `Other patient for ${scenario}` }])) as ClinicApiConfig['patients'], staff: [assignment] };
  const native = mockFhir({ atomic: false });
  const state = { loseTaskPutResponse: false };
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === 'https://medplum.example/auth/me') return Response.json({ profile: { resourceType: 'Practitioner', id: 'staff-1' }, project: { id: config.projectId }, membership: { id: assignment.membershipId }, accessPolicy: { id: 'staff-policy' } });
    if (String(url) === 'https://api.resend.com/emails') return Response.json({ id: 'synthetic-delivery' });
    const response = await native.fetcher(url, init);
    if (state.loseTaskPutResponse && init?.method === 'PUT' && new URL(String(url)).pathname.includes('/Task/') && response.ok) throw new Error('uncertain-synthetic-response');
    return response;
  });
  const client = new MedplumClient({ baseUrl: 'http://localhost/fhir/R4/', accessToken: 'synthetic-service-token', timeoutMs: 1000, mode: 'local' }, fetcher);
  const handler = () => createClinicHandler(config, { fetcher, runtime: async () => ({ client, qualification: {} as DeliveryQualification }) });
  const jar = staffSessionCookies(config.cookieSecret, `${origin}|${config.medplumBaseUrl}|${config.projectId}`, true);
  const staffCookie = (await jar.issue({ schema: 1, sessionId: crypto.randomUUID(), token: 'synthetic-named-token', profile: assignment.profile, membershipId: assignment.membershipId, issuedAt: Date.now(), expires: Date.now() + 60000 })).split(';')[0];
  const call = (path: string, body?: unknown, cookie = '', suppliedOrigin: string | null = origin) => handler()(new Request(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { cookie } : {}), ...(suppliedOrigin ? { origin: suppliedOrigin } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const issue = async (requestId = crypto.randomUUID()) => {
    const response = await call('/api/clinic/staff/invitations', { patient: patient.reference, scenario: 'pre-visit', requestId }, staffCookie);
    const issued = await response.json() as { invitationId: string; expiresAt: string; link?: string; emailStatus: string };
    return { response, issued, requestId, token: issued.link ? new URLSearchParams(new URL(issued.link).hash.slice(1)).get('token')! : '' };
  };
  return { config, native, client, fetcher, staffCookie, call, issue, state };
}
describe('invitation HTTP authorization and session flow', () => {
  it('requires staff and same Origin for issue and returns only assigned configured choices', async () => {
    const f = await setup();
    expect((await f.call('/api/clinic/staff/invitations', { patient: patient.reference, scenario: 'pre-visit', requestId: crypto.randomUUID() })).status).toBe(401);
    expect((await f.call('/api/clinic/staff/invitations', { patient: patient.reference, scenario: 'pre-visit', requestId: crypto.randomUUID() }, f.staffCookie, null)).status).toBe(403);
    const response = await f.call('/api/clinic/staff/invitations', undefined, f.staffCookie);
    expect(response.status).toBe(200);
    const options = await response.json();
    expect(options.patients).toEqual([{ reference: patient.reference, displayName: patient.displayName, scenarios: [...scenarioIds] }]);
    expect(JSON.stringify(options)).not.toContain('synthetic-secret');
    expect(f.native.counters.writes).toBe(0);
  });
  it('writes invitations with named authority and does not allow staff-selected email destinations', async () => {
    const f = await setup(), { response, issued } = await f.issue();
    expect(response.status).toBe(201); expect(issued.emailStatus).toBe('copy-only');
    const taskPost = f.fetcher.mock.calls.find(([, init]) => init?.method === 'POST' && JSON.parse(String(init.body)).resourceType === 'Task')!;
    expect(new Headers(taskPost[1]?.headers).get('Authorization')).toBe('Bearer synthetic-named-token');
    expect((await f.call('/api/clinic/staff/invitations', { patient: patient.reference, scenario: 'pre-visit', requestId: crypto.randomUUID(), to: 'unapproved@example.invalid' }, f.staffCookie)).status).toBe(400);
    expect(f.fetcher.mock.calls.filter(([url]) => String(url).startsWith('https://api.resend.com/'))).toHaveLength(0);
  });
  it('requires synthetic acknowledgment before consumption, then identity confirmation before answers', async () => {
    const f = await setup(), { token } = await f.issue();
    const noAck = await f.call('/api/clinic/invitations/redeem', { token });
    expect(noAck.status).toBe(400); expect(noAck.headers.get('set-cookie')).toBeNull();
    expect([...f.native.resources.values()].filter(row => row.resourceType === 'Task')[0].status).toBe('requested');
    const joined = await f.call('/api/clinic/invitations/redeem', { token, syntheticAcknowledged: true });
    expect(joined.status).toBe(201);
    const view = await joined.json(); expect(view).toMatchObject({ scenario: 'pre-visit', phase: 'identity', persona: { displayName: patient.displayName } });
    const cookie = joined.headers.get('set-cookie')!.split(';')[0];
    const claims = await cookies(f.config.cookieSecret, true).read(new Request(`${origin}/`, { headers: { cookie } }), 'clinic_patient');
    expect(claims).toMatchObject({ patient: patient.reference, scenario: 'pre-visit', identityConfirmed: false });
    expect((await f.call('/api/clinic/review', { expectedRevision: 0 }, cookie)).status).toBe(403);
    expect((await f.call('/api/clinic/confirm-identity', { confirmed: true }, cookie)).status).toBe(200);
    const second = await f.call('/api/clinic/invitations/redeem', { token, syntheticAcknowledged: true });
    expect(second.status).toBe(410); expect(second.headers.get('set-cookie')).toBeNull();
  });
  it('preserves actual invited patient and authorization marker when resuming the same workflow', async () => {
    const f = await setup(), { token } = await f.issue();
    const joined = await f.call('/api/clinic/invitations/redeem', { token, syntheticAcknowledged: true });
    const original = await joined.json(), cookie = joined.headers.get('set-cookie')!.split(';')[0];
    const resumed = await f.call('/api/clinic/sessions', { scenario: 'pre-visit', syntheticAcknowledged: true }, cookie);
    expect(resumed.status).toBe(201); expect(await resumed.json()).toMatchObject({ id: original.id, scenario: 'pre-visit', persona: { displayName: patient.displayName } });
    expect((await readDraft(f.client, original.id, patient.reference)).draft.patient).toBe(patient.reference);
  });
  it('freezes prior context after retrieval completes so newly read records remain readable', async () => {
    const f = await setup(), { token } = await f.issue();
    vi.useFakeTimers();
    const later = Date.now() + 1000, recordedAt = new Date(later).toISOString();
    vi.spyOn(priorContext, 'loadPriorContext').mockImplementationOnce(async () => {
      vi.setSystemTime(later);
      return { context: { appointment: { reference: 'Appointment/just-loaded', version: '1', startsAt: new Date(later + 86400000).toISOString(), timezone: 'UTC', recordedAt } }, sources: [{ reference: 'Appointment/just-loaded', version: '1', recordedAt, kind: 'appointment' }] };
    });
    const joined = await f.call('/api/clinic/invitations/redeem', { token, syntheticAcknowledged: true });
    expect(joined.status).toBe(201);
    const view = await joined.json(), cookie = joined.headers.get('set-cookie')!.split(';')[0];
    const stored = await readDraft(f.client, view.id, patient.reference);
    expect(stored.draft.priorContext?.loadedAt).toBe(recordedAt);
    expect(stored.draft.priorContext?.sources[0].recordedAt).toBe(recordedAt);
    expect((await f.call('/api/clinic/session', undefined, cookie)).status).toBe(200);
  });
  it('retains legacy mismatched-cookie rejection without invitation authority', async () => {
    const f = await setup();
    const cookie = (await cookies(f.config.cookieSecret, true).issue('clinic_patient', { kind: 'patient', sessionId: crypto.randomUUID(), patient: patient.reference, scenario: 'pre-visit', expires: Date.now() + 60000 })).split(';')[0];
    expect((await f.call('/api/clinic/session', undefined, cookie)).status).toBe(403);
  });
  it('binds invitation cookie authority to the exact persisted draft marker', async () => {
    const f = await setup(), { token } = await f.issue();
    const joined = await f.call('/api/clinic/invitations/redeem', { token, syntheticAcknowledged: true });
    const view = await joined.json(), cookie = joined.headers.get('set-cookie')!.split(';')[0];
    const stored = await readDraft(f.client, view.id, patient.reference);
    await saveDraft(f.client, stored, { ...stored.draft, invitationId: 'different-invitation', revision: stored.draft.revision + 1 });
    expect((await f.call('/api/clinic/session', undefined, cookie)).status).toBe(403);
  });
  it('sends once only for explicit allowlisted server recipients, never on request replay', async () => {
    const f = await setup();
    f.config.invitationEmail = { apiKey: 'server-only-resend-key', from: 'demo@example.invalid', allowlist: ['synthetic@example.invalid'], recipients: { [patient.reference]: 'synthetic@example.invalid' } };
    const first = await f.issue(); expect(first.issued.emailStatus).toBe('sent');
    const replay = await f.issue(first.requestId); expect(replay.issued.link).toBeUndefined(); expect(replay.issued.emailStatus).toBe('not-repeated');
    expect(f.fetcher.mock.calls.filter(([url]) => String(url) === 'https://api.resend.com/emails')).toHaveLength(1);
    const options = await f.call('/api/clinic/staff/invitations', undefined, f.staffCookie); const text = await options.text();
    expect(text).not.toContain('server-only-resend-key'); expect(text).not.toContain('synthetic@example.invalid');
  });
  it('rejects a query token without logging it and sets no session cookie', async () => {
    const f = await setup(), token = 'b'.repeat(64);
    const response = await f.call(`/api/clinic/invitations/redeem?token=${token}`, { token, syntheticAcknowledged: true });
    expect(response.status).toBe(400); expect(response.headers.get('set-cookie')).toBeNull();
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(token);
  });
  it('does not issue any cookie when native consumption succeeds but its response is lost', async () => {
    const f = await setup(), { token } = await f.issue(); f.state.loseTaskPutResponse = true;
    const response = await f.call('/api/clinic/invitations/redeem', { token, syntheticAcknowledged: true });
    expect(response.status).toBe(503); expect(response.headers.get('set-cookie')).toBeNull();
    expect([...f.native.resources.values()].filter(row => row.resourceType === 'Task')[0].status).toBe('completed');
    expect([...f.native.resources.values()].filter(row => row.resourceType === 'DocumentReference')).toHaveLength(0);
    expect((await f.call('/api/clinic/invitations/redeem', { token, syntheticAcknowledged: true })).status).toBe(410);
  });
});
