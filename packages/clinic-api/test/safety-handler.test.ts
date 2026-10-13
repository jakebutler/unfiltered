import { describe, expect, it, vi } from 'vitest';
import { createClinicHandler } from '../src/handler.js';
import type { Runtime } from '../src/runtime.js';
import { readDraft } from '../src/store.js';
import { readSafetyRecord, type SafetyReviewer } from '../src/safety-review.js';
import { interpretIntakeResponse, type IntakeInterpreter } from '../src/intake-interpreter.js';
import { safetySignalSeed } from '../src/safety-screen.js';
import type { ClinicApiConfig } from '../src/types.js';
import type { ClinicSessionView } from '../../clinic-contract/src/index.js';
import { MedplumClient } from '../../clinical-core/src/medplum.js';
import { mockFhir } from '../../../scripts/qualification/mock-fhir.js';

const origin = 'http://localhost:5173';
const patient = { reference: 'Patient/fixture', displayName: 'Synthetic', description: 'Fictional', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
const config = { origin, cookieSecret: 'test-secret-'.repeat(5), mentalHealth: 'phq4', patients: Object.fromEntries(['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'].map(id => [id, patient])) } as ClinicApiConfig;
const emptyProposal = { facts: [], items: [], listsDone: [], questions: [], moveOn: null, ack: null };

async function fixture(reviewer?: SafetyReviewer, interpreter?: IntakeInterpreter, options: { failSafetyRecordWrites?: boolean } = {}) {
  const fhir = mockFhir({ atomic: false }).fetcher;
  // Optionally fail every write of the staff safety record, to prove the draft still carries the verdict.
  const fetcher: typeof fhir = async (input, init) => options.failSafetyRecordWrites && init?.method && init.method !== 'GET' && String(init.body ?? '').includes('urn:corvo:clinic:safety-review') ? new Response('{}', { status: 503 }) : fhir(input, init);
  const client = new MedplumClient({ baseUrl: 'http://localhost:8103/fhir/R4/', accessToken: 'synthetic', mode: 'local', timeoutMs: 1000 }, fetcher);
  const handler = createClinicHandler(config, { runtime: async () => ({ client, qualification: {} } as unknown as Runtime), safetyReviewer: reviewer, adaptiveInterpreter: interpreter });
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
  /** Natural conversation: accept, then interpret (the gate runs beside the interpreter). */
  const say = async (text: string) => {
    const accepted = await call<{ session: ClinicSessionView; operation: { id: string } }>('/api/clinic/adaptive-turns', { requestId: crypto.randomUUID(), expectedRevision: current.revision, text, channel: 'text' });
    expect(accepted.status).toBe(202);
    const done = await call<{ session: ClinicSessionView; operation: { status: string } }>(`/api/clinic/adaptive-turns/${accepted.body.operation.id}/interpret`, {});
    current = done.body.session; return done.body;
  };
  return { client, call, answer, say, current: () => current, draft: () => readDraft(client, current.id, patient.reference) };
}
const verdict = (result: object): SafetyReviewer => ({ review: vi.fn(async () => ({ concern: true, level: 'moderate', categories: ['mental-distress'], rationale: 'Low mood.', model: 'qwen3.8-max', ...result })) }) as never;
const interpreter = (): IntakeInterpreter => ({ interpret: vi.fn(async context => ({ outcome: interpretIntakeResponse(emptyProposal, context) })) });

describe('safety gate through the clinic handler', () => {
  it('reviews flagged free text on the same turn and routes the handoff to a clinician', async () => {
    const reviewer = verdict({}), f = await fixture(reviewer);
    expect(f.current().safetyReview).toBeUndefined();
    const view = await f.answer('Honestly I feel hopeless about my weight.');
    // Decided before the next question: nothing is left pending for a background review.
    expect(view.safetyReview).toBeUndefined();
    expect(view.notice?.tone).not.toBe('urgent');
    const saved = (await f.draft()).draft, [signal] = saved.safetySignals!;
    expect(signal.review).toEqual({ status: 'needs-human-review', level: 'moderate' });
    expect((await readSafetyRecord(f.client, { sessionId: view.id, patient: patient.reference, scenario: 'first-intake' })).reviews[signal.id]).toMatchObject({ status: 'needs-human-review', level: 'moderate' });
    // The background endpoint is idempotent: an existing result costs no second model call.
    expect((await f.call('/api/clinic/safety-reviews', { signalId: signal.id })).body).toEqual({ signalId: signal.id, state: 'reviewed', escalated: false });
    const review = await f.call<{ session: ClinicSessionView }>('/api/clinic/review', { expectedRevision: f.current().revision });
    expect(review.status).toBe(200);
    expect(review.body.session.topics.find(topic => topic.id === 'SAFETY-REVIEW')).toMatchObject({ title: 'Clinician safety review', answer: { sourceIds: [expect.any(String)] } });
    expect((await f.draft()).draft.preview!.confirmation.submission.work.map(work => work.responsibility)).toContain('medical');
    expect(reviewer.review).toHaveBeenCalledTimes(1);
  });
  it('a cleared review adds no clinician topic', async () => {
    const f = await fixture(verdict({ concern: false, level: 'none', categories: [] }));
    await f.answer('My father had a stroke when I was a kid.');
    const review = await f.call<{ session: ClinicSessionView }>('/api/clinic/review', { expectedRevision: f.current().revision });
    expect(review.body.session.topics.some(topic => topic.id === 'SAFETY-REVIEW')).toBe(false);
  });
  it('a negated hard-stop phrase is downgraded to the gate instead of pausing, and can be cleared', async () => {
    const reviewer = verdict({ concern: false, level: 'none', categories: [] }), f = await fixture(reviewer);
    const view = await f.answer('I have never had suicidal thoughts.');
    expect(view.notice?.tone).not.toBe('urgent');
    expect(view.currentPrompt).toBeDefined();
    const saved = (await f.draft()).draft;
    expect(saved.safety).toBeUndefined();
    expect(saved.safetySignals![0]).toMatchObject({ categories: ['self-harm'], floor: [{ rule: 'E04', scope: 'negated' }], review: { status: 'cleared', level: 'none' } });
  });
  it('high-risk review pauses the turn itself with authored crisis copy', async () => {
    const f = await fixture(verdict({ level: 'imminent', categories: ['self-harm'] }));
    const view = await f.answer('I keep thinking everyone would be better off without me.');
    expect(view).toMatchObject({ phase: 'conversation', notice: { tone: 'urgent' } });
    expect(view.notice!.text).toContain('988');
    expect(view.currentPrompt).toBeUndefined();
    const saved = (await f.draft()).draft;
    expect(saved.safety).toMatchObject({ rule: 'E04', version: 'E-0.2', paused: true, via: 'model-review' });
    const session = await f.call('/api/clinic/turns', { requestId: crypto.randomUUID(), expectedRevision: saved.revision, promptId: 'Q01:reason', action: 'answer', text: 'more', channel: 'text' });
    expect(session.status).toBe(409);
  });
  it('without a reviewer an urgent flag shows non-blocking help copy and fails closed to clinician review', async () => {
    const f = await fixture();
    const view = await f.answer('I keep thinking everyone would be better off without me.');
    expect(view.notice).toMatchObject({ tone: 'attention' });
    expect(view.notice!.text).toContain('988');
    expect(view.currentPrompt).toBeDefined();
    const saved = (await f.draft()).draft;
    expect(saved.safety).toBeUndefined();
    expect(saved.safetySignals![0].review).toEqual({ status: 'needs-human-review', level: 'moderate' });
    const review = await f.call<{ session: ClinicSessionView }>('/api/clinic/review', { expectedRevision: f.current().revision });
    expect(review.body.session.topics.some(topic => topic.id === 'SAFETY-REVIEW')).toBe(true);
  });
  it('a non-urgent flag without a reviewer fails closed silently', async () => {
    const f = await fixture();
    const view = await f.answer('I sometimes skip meals and then overeat at night.');
    expect(view.notice?.tone).toBe('info');
    const review = await f.call<{ session: ClinicSessionView }>('/api/clinic/review', { expectedRevision: f.current().revision });
    expect(review.body.session.topics.some(topic => topic.id === 'SAFETY-REVIEW')).toBe(true);
  });
  it('natural conversation runs the gate beside the interpreter and pauses before the next question', async () => {
    const reviewer = verdict({ level: 'imminent', categories: ['medical-urgent'] }), model = interpreter(), f = await fixture(reviewer, model);
    const done = await f.say('I have chest pain right now and my left arm feels numb.');
    expect(model.interpret).toHaveBeenCalledTimes(1);
    expect(reviewer.review).toHaveBeenCalledTimes(1);
    expect(done.session.notice).toMatchObject({ tone: 'urgent' });
    expect(done.session.notice!.text).toContain('911');
    expect(done.session.currentPrompt).toBeUndefined();
    expect((await f.draft()).draft.safety).toMatchObject({ rule: 'E01', via: 'model-review' });
  });
  it('natural conversation: a moderate gate result continues and is already reviewed', async () => {
    const f = await fixture(verdict({}), interpreter());
    const done = await f.say('Honestly I feel hopeless about my weight.');
    expect(done.operation.status).toBe('applied');
    expect(done.session.safetyReview).toBeUndefined();
    expect((await f.draft()).draft.safetySignals![0].review).toEqual({ status: 'needs-human-review', level: 'moderate' });
  });
  it('the gate catches indirect wording the screen never flagged', async () => {
    const reviewer = verdict({ level: 'imminent', categories: ['self-harm'] }), f = await fixture(reviewer, interpreter());
    const text = 'I gave my cat to my neighbour and wrote letters to everyone this week.';
    expect(safetySignalSeed(text)).toBeUndefined();
    const done = await f.say(text);
    expect(done.session.notice).toMatchObject({ tone: 'urgent' });
    const saved = (await f.draft()).draft;
    expect(saved.safety).toMatchObject({ rule: 'E04', via: 'model-review' });
    expect(saved.safetySignals).toEqual([expect.objectContaining({ version: 'safety-gate-v1', categories: ['self-harm'], review: { status: 'needs-human-review', level: 'imminent' } })]);
  });
  it('an ordinary answer is checked but records nothing', async () => {
    const reviewer = verdict({ concern: false, level: 'none', categories: [] }), f = await fixture(reviewer);
    await f.answer('I walk my dog every morning.');
    expect(reviewer.review).toHaveBeenCalledTimes(1);
    expect((await f.draft()).draft.safetySignals).toBeUndefined();
    expect((await readSafetyRecord(f.client, { sessionId: f.current().id, patient: patient.reference, scenario: 'first-intake' })).reviews).toEqual({});
  });
  it('a direct hard stop still pauses with no model at all', async () => {
    const model = interpreter(), f = await fixture(undefined, model);
    const accepted = await f.call<{ session: ClinicSessionView; operation: { status: string } }>('/api/clinic/adaptive-turns', { requestId: crypto.randomUUID(), expectedRevision: f.current().revision, text: "I'm going to kill myself tonight.", channel: 'text' });
    expect(accepted.body.operation.status).toBe('failed');
    expect(accepted.body.session.notice).toMatchObject({ tone: 'urgent' });
    expect(model.interpret).not.toHaveBeenCalled();
  });
  it('rejects malformed review requests and unknown signals', async () => {
    const f = await fixture(verdict({}));
    expect((await f.call('/api/clinic/safety-reviews', { signalId: 'nope' })).status).toBe(400);
    expect((await f.call('/api/clinic/safety-reviews', { signalId: crypto.randomUUID() })).status).toBe(404);
  });

  // Independent review (codex, 2026-10-12): the gate must fail closed on reviewer, storage and cancellation failures.
  it('a reviewer failure on an unflagged turn goes to clinician review instead of nothing', async () => {
    const failing: SafetyReviewer = { review: vi.fn(async () => { throw new Error('provider down'); }) } as never;
    const f = await fixture(failing);
    const text = 'I gave my cat to my neighbour and wrote letters to everyone this week.';
    expect(safetySignalSeed(text)).toBeUndefined();
    await f.answer(text);
    expect((await f.draft()).draft.safetySignals).toEqual([expect.objectContaining({ version: 'safety-gate-v1', review: { status: 'needs-human-review', level: 'moderate' } })]);
    const review = await f.call<{ session: ClinicSessionView }>('/api/clinic/review', { expectedRevision: f.current().revision });
    expect(review.body.session.topics.some(topic => topic.id === 'SAFETY-REVIEW')).toBe(true);
  });
  // Independent review (cubic, 2026-10-13).
  it('after continuing past an eating-concern pause, later guided free text is still reviewed', async () => {
    const reviewer = verdict({ level: 'imminent', categories: ['self-harm'] }), f = await fixture(reviewer);
    const paused = await f.answer('I make myself throw up after meals.');
    expect(paused.notice).toMatchObject({ tone: 'attention' });
    const resumed = (await f.call('/api/clinic/topics', { expectedRevision: paused.revision, topicId: 'Q01' })).body;
    expect(resumed.currentPrompt).toBeDefined();
    const calls = vi.mocked(reviewer.review).mock.calls.length;
    const next = await f.call('/api/clinic/turns', { requestId: crypto.randomUUID(), expectedRevision: resumed.revision, promptId: resumed.currentPrompt!.id, action: 'answer', text: 'I gave my cat to my neighbour and wrote letters to everyone this week.', channel: 'text' });
    expect(next.status).toBe(200);
    expect(reviewer.review).toHaveBeenCalledTimes(calls + 1);
    expect((await f.draft()).draft.safety).toMatchObject({ rule: 'E04', via: 'model-review', paused: true });
  });
  it('a spoken reply that cannot fill a fixed-choice item is still reviewed', async () => {
    const reviewer = verdict({ level: 'imminent', categories: ['self-harm'] }), f = await fixture(reviewer);
    const mood = (await f.call('/api/clinic/topics', { expectedRevision: f.current().revision, topicId: 'Q16' })).body;
    expect(mood.currentPrompt?.choices?.length).toBeGreaterThan(0);
    const result = await f.call('/api/clinic/turns', { requestId: crypto.randomUUID(), expectedRevision: mood.revision, promptId: mood.currentPrompt!.id, action: 'answer', text: 'Honestly everyone would be better off without me.', channel: 'unreviewed-transcript', choiceTranscriptOnly: true });
    expect(result.status).toBe(200);
    expect(reviewer.review).toHaveBeenCalledTimes(1);
    expect((await f.draft()).draft.safety).toMatchObject({ rule: 'E04', via: 'model-review', paused: true });
  });
  it('a structured field answer is reviewed like typed text', async () => {
    const reviewer = verdict({ level: 'imminent', categories: ['self-harm'] }), f = await fixture(reviewer);
    const result = await f.call('/api/clinic/turns', { requestId: crypto.randomUUID(), expectedRevision: f.current().revision, promptId: f.current().currentPrompt!.id, action: 'answer', fields: { value: 'I gave my cat to my neighbour and wrote letters to everyone this week.' }, channel: 'text' });
    expect(result.status).toBe(200);
    expect(reviewer.review).toHaveBeenCalledTimes(1);
    expect((await f.draft()).draft.safety).toMatchObject({ rule: 'E04', via: 'model-review', paused: true });
  });
  it('an imminent verdict still pauses when the staff safety record cannot be saved', async () => {
    const f = await fixture(verdict({ level: 'imminent', categories: ['self-harm'] }), undefined, { failSafetyRecordWrites: true });
    const view = await f.answer('I gave my cat to my neighbour and wrote letters to everyone this week.');
    expect(view.notice).toMatchObject({ tone: 'urgent' });
    expect(view.currentPrompt).toBeUndefined();
    expect((await f.draft()).draft.safety).toMatchObject({ rule: 'E04', paused: true, via: 'model-review' });
  });
  it('stopping an interpretation while its safety check is pending still applies the verdict', async () => {
    let release!: () => void;
    const gateOpen = new Promise<void>(resolve => { release = resolve; });
    const slow: SafetyReviewer = { review: vi.fn(async () => { await gateOpen; return { concern: true, level: 'imminent', categories: ['self-harm'], rationale: 'Preparation.', model: 'qwen3.8-max' }; }) } as never;
    const f = await fixture(slow, interpreter());
    const accepted = await f.call<{ session: ClinicSessionView; operation: { id: string } }>('/api/clinic/adaptive-turns', { requestId: crypto.randomUUID(), expectedRevision: f.current().revision, text: 'I gave my cat to my neighbour and wrote letters to everyone this week.', channel: 'text' });
    const running = f.call(`/api/clinic/adaptive-turns/${accepted.body.operation.id}/interpret`, {});
    await vi.waitFor(() => expect(slow.review).toHaveBeenCalled());
    const saved = (await f.draft()).draft;
    const stopped = await f.call(`/api/clinic/adaptive-turns/${accepted.body.operation.id}/discard`, { expectedRevision: saved.revision });
    expect(stopped.status).toBe(200);
    release();
    await running;
    const after = (await f.draft()).draft;
    expect(after.safety).toMatchObject({ rule: 'E04', paused: true, via: 'model-review' });
    expect(after.safetySignals).toEqual([expect.objectContaining({ review: { status: 'needs-human-review', level: 'imminent' } })]);
  });
});
