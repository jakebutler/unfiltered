import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClinicHandler } from '../src/handler.js';
import { conversation } from '../src/conversation.js';
import { handoffs } from '../src/handoffs.js';
import { readDraft } from '../src/store.js';
import type { ClinicApiConfig, StaffAssignment } from '../src/types.js';
import type { Runtime } from '../src/runtime.js';
import type { ClinicSessionView, ReviewPreview } from '../../clinic-contract/src/index.js';
import { getNativeQuestionnaireDefinition } from '../../clinic-content/src/native-questionnaire.js';
import { promptsById } from '../../clinic-content/src/register.js';
import { MedplumClient, type DeliveryQualification } from '../../clinical-core/src/medplum.js';
import { digest } from '../../clinical-core/src/domain.js';
import { mockFhir } from '../../../scripts/qualification/mock-fhir.js';
import { appointment, clientFor, json, patientReference, plan, prior, recordedAt } from './fixtures/prior-context.js';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-16T12:00:00.000Z')); });
afterEach(() => { vi.useRealTimers(); });
const origin = 'http://127.0.0.1:5173';
const patient = { reference: patientReference, displayName: 'Synthetic prior patient', description: 'Synthetic only', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };

async function fixture(options: { scenario?: 'pre-visit' | 'post-visit'; fail?: boolean; staticContext?: boolean; priorItem?: string } = {}) {
  const scenario = options.scenario ?? 'pre-visit', previous = await prior('Q02', options.priorItem), a = appointment(), p = plan();
  const priorClient = clientFor({ ...previous, appointment: a, plan: p }, path => options.fail && path.startsWith('Appointment?') ? json({}, 403) : undefined);
  const native = mockFhir({ atomic: false }), definition = await getNativeQuestionnaireDefinition();
  const base = { baseUrl: 'http://localhost:8103/fhir/R4/', accessToken: 'synthetic-prior-session', timeoutMs: 1000, mode: 'local' as const };
  const initial = new MedplumClient(base, native.fetcher);
  const questionnaire = (await initial.request('Questionnaire', 'POST', definition.questionnaire)).body as { id: string; meta: { versionId: string } };
  const nativeQuestionnaire = { ...definition.binding, reference: `Questionnaire/${questionnaire.id}/_history/${questionnaire.meta.versionId}` };
  const client = new MedplumClient({ ...base, nativeQuestionnaire }, async (input, init) => {
    const url = new URL(String(input)), path = url.pathname.replace('/fhir/R4/', '');
    const lookup = url.searchParams.has('questionnaire') || path === 'Appointment' || url.searchParams.has('category') || /^(?:DocumentReference\/prior-(?:sources|plan)|QuestionnaireResponse\/prior-response|Appointment\/prior-appointment)\/_history\//.test(path);
    return (init?.method ?? 'GET') === 'GET' && lookup ? priorClient.fetcher(input, init) : native.fetcher(input, init);
  });
  const config = { origin, medplumBaseUrl: base.baseUrl, projectId: 'synthetic-project', clientId: 'synthetic-client', clientSecret: 'synthetic-secret', cookieSecret: 'prior-context-session'.repeat(4), mentalHealth: 'phq4', patients: Object.fromEntries(['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'].map(id => [id, patient])), staff: [], nativeQuestionnaire } as ClinicApiConfig;
  if (options.staticContext) config.patients[scenario] = { ...patient, nativeContext: { appointment: { reference: 'Appointment/static', version: '9', startsAt: '2026-10-25T15:00:00.000Z', timezone: 'America/Chicago', priorUpdateAt: '2026-09-01T12:00:00.000Z' } } };
  const qualification: DeliveryQualification = { deliveryContract: 'conditional-resumable-v1', baseUrl: base.baseUrl, mode: 'local', credentialFingerprint: await digest(base.accessToken), conditionalCreate: true, conditionalConcurrency: true, versionConflict: true, versionHistory: true, qualifiedAt: new Date().toISOString() };
  const makeHandler = () => createClinicHandler(config, { runtime: async () => ({ client, qualification } as unknown as Runtime) });
  let handler = makeHandler(), cookie = '';
  const call = async <T = ClinicSessionView>(path: string, data?: unknown) => {
    const response = await handler(new Request(origin + path, { method: data === undefined ? 'GET' : 'POST', headers: { cookie, ...(data === undefined ? {} : { origin, 'content-type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }));
    const issued = response.headers.get('set-cookie'); if (issued) cookie = issued.split(';')[0];
    return { status: response.status, body: await response.json() as T };
  };
  const boot = async () => {
    const started = await call('/api/clinic/sessions', { scenario, syntheticAcknowledged: true }); expect(started.status).toBe(201);
    const identity = await call('/api/clinic/confirm-identity', { confirmed: true }); expect(identity.status).toBe(200);
    return identity.body;
  };
  const answer = (session: ClinicSessionView, text: string) => call('/api/clinic/turns', { requestId: crypto.randomUUID(), expectedRevision: session.revision, promptId: session.currentPrompt!.id, action: 'answer', text, channel: 'text' });
  return { scenario, config, client, priorClient, a, p, call, boot, answer, restart: () => { handler = makeHandler(); } };
}

describe('frozen prior context through real session creation and confirmation', () => {
  it('preserves an oversized exact quote as prior context without displaying or truncating an unsavable changes prompt', async () => {
    const item = 'x'.repeat(8000), f = await fixture({ priorItem: item }); let session = await f.boot();
    for (const text of ['Please check the visit.', 'Synthetic current priority', '__negative']) {
      expect(session.currentPrompt?.text.length).toBeLessThanOrEqual(8000);
      const answered = await f.answer(session, text); expect(answered.status).toBe(200); session = answered.body;
    }
    expect(session.currentPrompt).toBeUndefined();
    const saved = (await readDraft(f.client, session.id, patientReference)).draft;
    expect(saved.priorContext?.context.priorSubmission?.item).toBe(item);
    expect(saved.topics.W02.answers.changes).toBeUndefined();
    expect((await conversation(f.config).preview(saved)).confirmation.submission.completeness).toBe('partial');
  });
  it('loads once, preserves the initial record versions across save/resume/restart, and fills only the prior readback question', async () => {
    const f = await fixture(); let session = await f.boot();
    expect(session.currentPrompt?.text).toContain('2026-10-20T15:00:00.000Z America/New_York');
    expect(session.currentPrompt?.text).not.toContain('[');
    const saved = (await readDraft(f.client, session.id, patientReference)).draft;
    expect(saved.priorContext).toMatchObject({ loadedAt: '2026-10-16T12:00:00.000Z', context: { priorSubmission: { item: 'My knees hurt when I walk.' } } });
    expect(saved.topics).toEqual({});
    expect(saved.turns).toEqual([]);
    expect(f.priorClient.fetcher).toHaveBeenCalledTimes(3);
    f.a.start = '2026-10-30T15:00:00.000Z'; f.restart();
    expect((await f.call('/api/clinic/sessions', { scenario: f.scenario, syntheticAcknowledged: true })).status).toBe(201);
    session = (await f.call('/api/clinic/confirm-identity', { confirmed: true })).body;
    expect(session.currentPrompt?.text).toContain('2026-10-20T15:00:00.000Z');
    expect(f.priorClient.fetcher).toHaveBeenCalledTimes(3);
    const answered = await f.answer(session, 'Please check the appointment details.'); expect(answered.status).toBe(200);
    session = answered.body;
    expect(session.currentPrompt).toMatchObject({ id: 'W02:changes', text: 'What has changed about My knees hurt when I walk. since 2026-10-01T12:00:00.000Z?' });
    const current = (await readDraft(f.client, session.id, patientReference)).draft;
    expect(current.topics.Q02?.answers.concern).toBeUndefined();
    expect(current.topics.W02.answers.changes).toBeUndefined();
    expect(current.turns.every(turn => turn.id !== 'prior-turn')).toBe(true);
    expect(current.priorContext).toEqual(saved.priorContext);
  });
  it('keeps explicit deployment fixture context authoritative over loaded appointment context', async () => {
    const f = await fixture({ staticContext: true }), session = await f.boot();
    expect(session.currentPrompt?.text).toContain('2026-10-25T15:00:00.000Z America/Chicago');
    expect(session.currentPrompt?.text).toContain('2026-09-01T12:00:00.000Z');
    expect(session.currentPrompt?.text).not.toContain('[');
    const saved = (await readDraft(f.client, session.id, patientReference)).draft;
    expect(conversation(f.config).nativeContext(saved)?.appointment?.reference).toBe('Appointment/static');
    expect(saved.priorContext?.context.appointment?.reference).toBe('Appointment/prior-appointment');
  });
  it('keeps failures frozen as missing context and preserves the changes gap on confirmed partial handoff', async () => {
    const f = await fixture({ fail: true }); let session = await f.boot();
    expect(session.currentPrompt?.text).toBe(promptsById.S01a.text);
    for (const text of ['Please check the visit.', 'Synthetic current priority', '__negative']) {
      const answered = await f.answer(session, text); expect(answered.status).toBe(200); session = answered.body;
    }
    expect(session.currentPrompt).toBeUndefined();
    const review = await f.call<ReviewPreview>('/api/clinic/review', { expectedRevision: session.revision }); expect(review.status).toBe(200);
    const confirmed = await f.call('/api/clinic/confirm', { expectedRevision: review.body.session.revision, digest: review.body.digest }); expect(confirmed.status).toBe(200);
    const saved = (await readDraft(f.client, session.id, patientReference)).draft;
    expect(saved.priorContext).toMatchObject({ context: {}, sources: [] });
    expect(saved.topics.W02.answers.changes).toBeUndefined();
    expect(saved.confirmed?.confirmation.submission.completeness).toBe('partial');
  });
  it('binds loaded sources into the confirmed capture and excludes source metadata from administrative staff readback', async () => {
    const f = await fixture(); let session = await f.boot();
    for (const text of ['Please check the visit.', 'The symptom is unchanged.', 'Synthetic current priority', '__negative']) {
      const answered = await f.answer(session, text); expect(answered.status).toBe(200); session = answered.body;
    }
    const review = await f.call<ReviewPreview>('/api/clinic/review', { expectedRevision: session.revision }); expect(review.status).toBe(200);
    const confirmed = await f.call('/api/clinic/confirm', { expectedRevision: review.body.session.revision, digest: review.body.digest }); expect(confirmed.status).toBe(200);
    const saved = (await readDraft(f.client, session.id, patientReference)).draft, capture = saved.confirmed!.confirmation.submission.questionnaireCapture!;
    expect(capture.context?.priorSubmission).toMatchObject({ item: 'My knees hurt when I walk.', recordedAt });
    const clinical: StaffAssignment = { membershipId: 'clinical', profile: 'Practitioner/md', policy: 'AccessPolicy/clinical', name: 'Synthetic clinician', role: 'physician', patients: [patientReference], careTeams: ['CareTeam/md'] };
    const admin: StaffAssignment = { ...clinical, membershipId: 'admin', profile: 'Practitioner/admin', policy: 'AccessPolicy/admin', role: 'administrative', careTeams: ['CareTeam/admin'] };
    const api = handoffs(f.config), id = `${session.id}.v1`;
    const shown = await api.view(f.client, f.client, clinical, id);
    expect(shown.contextSources?.map(source => source.reference)).toEqual(['Appointment/prior-appointment', 'QuestionnaireResponse/prior-response']);
    expect((await api.view(f.client, f.client, admin, id)).contextSources).toBeUndefined();
  });
});
