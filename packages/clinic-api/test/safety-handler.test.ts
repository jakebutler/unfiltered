import { describe, expect, it, vi } from 'vitest';
import { createClinicHandler } from '../src/handler.js';
import type { Runtime } from '../src/runtime.js';
import { readDraft } from '../src/store.js';
import { readSafetyRecord, type SafetyReviewer } from '../src/safety-review.js';
import type { ClinicApiConfig } from '../src/types.js';
import type { ClinicSessionView } from '../../clinic-contract/src/index.js';
import { MedplumClient } from '../../clinical-core/src/medplum.js';
import { mockFhir } from '../../../scripts/qualification/mock-fhir.js';

const origin = 'http://localhost:5173';
const patient = { reference: 'Patient/fixture', displayName: 'Synthetic', description: 'Fictional', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
const config = { origin, cookieSecret: 'test-secret-'.repeat(5), mentalHealth: 'phq4', patients: Object.fromEntries(['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'].map(id => [id, patient])) } as ClinicApiConfig;

async function fixture(reviewer?: SafetyReviewer) {
  const client = new MedplumClient({ baseUrl: 'http://localhost:8103/fhir/R4/', accessToken: 'synthetic', mode: 'local', timeoutMs: 1000 }, mockFhir({ atomic: false }).fetcher);
  const handler = createClinicHandler(config, { runtime: async () => ({ client, qualification: {} } as unknown as Runtime), safetyReviewer: reviewer });
  let cookie = '', current: ClinicSessionView;
  const call = async <T = ClinicSessionView>(path: string, data: unknown) => {
    const response = await handler(new Request(origin + path, { method: 'POST', headers: { origin, 'Content-Type': 'application/json', cookie }, body: JSON.stringify(data) }));
    const issued = response.headers.get('set-cookie'); if (issued) cookie = issued.split(';')[0];
    return { status: response.status, body: await response.json() as T };
  };
  await call('/api/clinic/sessions', { scenario: 'first-intake', syntheticAcknowledged: true });
  current = (await call('/api/clinic/confirm-identity', { confirmed: true })).body;
  const answer = async (text: string) => {
    const result = await call('/api/clinic/turns', { requestId: crypto.randomUUID(), expectedRevision: current.revision, promptId: current.currentPrompt!.id, action: 'answer', text, channel: 'text' });
    expect(result.status).toBe(200); current = result.body; return current;
  };
  return { client, call, answer, current: () => current, draft: () => readDraft(client, current.id, patient.reference) };
}
const verdict = (result: object): SafetyReviewer => ({ review: vi.fn(async () => ({ concern: true, level: 'moderate', categories: ['mental-distress'], rationale: 'Low mood.', model: 'qwen3.8-max', ...result })) }) as never;

describe('tiered safety through the clinic handler', () => {
  it('queues a review for flagged free text, reviews it without touching the draft, and routes the handoff to a clinician', async () => {
    const reviewer = verdict({}), f = await fixture(reviewer);
    expect(f.current().safetyReview).toBeUndefined();
    const view = await f.answer('Honestly I feel hopeless about my weight.');
    const [signalId] = view.safetyReview!.pendingSignalIds;
    expect(view.safetyReview!.pendingSignalIds).toHaveLength(1);
    expect(view.notice?.tone).not.toBe('urgent');
    const revision = (await f.draft()).draft.revision;
    const reviewed = await f.call<{ state: string; escalated: boolean }>('/api/clinic/safety-reviews', { signalId });
    expect(reviewed).toEqual({ status: 200, body: { signalId, state: 'reviewed', escalated: false } });
    // The background review never makes the patient's next turn stale.
    expect((await f.draft()).draft.revision).toBe(revision);
    expect((await readSafetyRecord(f.client, { sessionId: view.id, patient: patient.reference, scenario: 'first-intake' })).reviews[signalId]).toMatchObject({ status: 'needs-human-review', level: 'moderate' });
    const review = await f.call<{ session: ClinicSessionView }>('/api/clinic/review', { expectedRevision: f.current().revision });
    expect(review.status).toBe(200);
    expect(review.body.session.topics.find(topic => topic.id === 'SAFETY-REVIEW')).toMatchObject({ title: 'Clinician safety review', answer: { sourceIds: [expect.any(String)] } });
    expect(review.body.session.safetyReview).toBeUndefined();
    const saved = (await f.draft()).draft;
    expect(saved.safetySignals![0].review).toEqual({ status: 'needs-human-review', level: 'moderate' });
    expect(saved.preview!.confirmation.submission.work.map(work => work.responsibility)).toContain('medical');
    expect(reviewer.review).toHaveBeenCalledTimes(1);
  });
  it('a cleared review adds no clinician topic', async () => {
    const f = await fixture(verdict({ concern: false, level: 'none', categories: [] }));
    const view = await f.answer('My father had a stroke when I was a kid.');
    await f.call('/api/clinic/safety-reviews', { signalId: view.safetyReview!.pendingSignalIds[0] });
    const review = await f.call<{ session: ClinicSessionView }>('/api/clinic/review', { expectedRevision: f.current().revision });
    expect(review.body.session.topics.some(topic => topic.id === 'SAFETY-REVIEW')).toBe(false);
  });
  it('high-risk model review pauses the intake with authored crisis copy', async () => {
    const f = await fixture(verdict({ level: 'imminent', categories: ['self-harm'] }));
    const view = await f.answer('I keep thinking everyone would be better off without me.');
    const reviewed = await f.call<{ escalated: boolean }>('/api/clinic/safety-reviews', { signalId: view.safetyReview!.pendingSignalIds[0] });
    expect(reviewed.body.escalated).toBe(true);
    const saved = (await f.draft()).draft;
    expect(saved.safety).toMatchObject({ rule: 'E04', paused: true, via: 'model-review' });
    const session = await f.call('/api/clinic/turns', { requestId: crypto.randomUUID(), expectedRevision: saved.revision, promptId: view.currentPrompt!.id, action: 'answer', text: 'more', channel: 'text' });
    expect(session.status).toBe(409);
  });
  it('without a reviewer every signal fails closed to human review at patient review', async () => {
    const f = await fixture();
    await f.answer('I sometimes skip meals and then overeat at night.');
    const review = await f.call<{ session: ClinicSessionView }>('/api/clinic/review', { expectedRevision: f.current().revision });
    expect(review.body.session.topics.some(topic => topic.id === 'SAFETY-REVIEW')).toBe(true);
  });
  it('rejects malformed review requests and unknown signals', async () => {
    const f = await fixture(verdict({}));
    expect((await f.call('/api/clinic/safety-reviews', { signalId: 'nope' })).status).toBe(400);
    expect((await f.call('/api/clinic/safety-reviews', { signalId: crypto.randomUUID() })).status).toBe(404);
  });
});
