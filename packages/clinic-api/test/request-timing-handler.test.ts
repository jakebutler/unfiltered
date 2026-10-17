import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClinicHandler } from '../src/handler.js';
import type { ClinicApiConfig } from '../src/types.js';
import type { Runtime } from '../src/runtime.js';

import type { AdaptiveTurnResult, ClinicSessionView } from '../../clinic-contract/src/index.js';
import { MedplumClient } from '../../clinical-core/src/medplum.js';
import { mockFhir } from '../../../scripts/qualification/mock-fhir.js';
import { interpretIntakeResponse, type IntakeInterpreter } from '../src/intake-interpreter.js';
import type { SafetyReviewer } from '../src/safety-review.js';
import { readDraft } from '../src/store.js';

const origin = 'https://clinic.example';
const patient = { reference: 'Patient/synthetic', displayName: 'Synthetic patient', description: 'Synthetic only', careTeams: { medical: 'CareTeam/medical', nutrition: 'CareTeam/nutrition', administrative: 'CareTeam/administrative' } };
const config = { origin, medplumBaseUrl: 'https://api.medplum.com/', projectId: 'synthetic-project', clientId: 'synthetic-client', clientSecret: 'synthetic-secret', cookieSecret: 'synthetic-cookie-secret-at-least-32-characters', mentalHealth: 'phq4', staff: [], patients: Object.fromEntries(['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'].map(id => [id, patient])) } as ClinicApiConfig;
const opaqueId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const handler = () => createClinicHandler(config, { runtime: async () => ({ client: {}, qualification: {} }) as unknown as Runtime, fetcher: async () => Response.json({}, { status: 401 }) });

function logged(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.map(([line]) => String(line)).filter(line => line.startsWith('{"event":"clinic.request"')).map(line => JSON.parse(line));
}

describe('clinic request correlation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('mints an id, returns Server-Timing, and logs one line for a plain route', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const response = await handler()(new Request(`${origin}/api/clinic/config`, { headers: { origin } }));
    const id = response.headers.get('X-Request-Id') ?? '';
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get('Server-Timing')).toMatch(/^total;dur=\d+(\.\d)?$/);
    expect(logged(spy)).toEqual([expect.objectContaining({ requestId: id, route: 'GET /api/clinic/config', status: 200, phases: {} })]);
  });

  it('echoes a well-formed incoming X-Request-Id and replaces a malformed one', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const echoed = await handler()(new Request(`${origin}/api/clinic/config`, { headers: { origin, 'X-Request-Id': opaqueId } }));
    expect(echoed.headers.get('X-Request-Id')).toBe(opaqueId);
    const replaced = await handler()(new Request(`${origin}/api/clinic/config`, { headers: { origin, 'X-Request-Id': 'client-req.0001' } }));
    expect(replaced.headers.get('X-Request-Id')).not.toBe('client-req.0001');
    expect(replaced.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports the session phase on a turn route without leaking the submitted words', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const words = 'Synthetic words that must never be logged';
    const response = await handler()(new Request(`${origin}/api/clinic/turns`, {
      method: 'POST', headers: { origin, 'Content-Type': 'application/json', 'X-Request-Id': opaqueId },
      body: JSON.stringify({ requestId: crypto.randomUUID(), expectedRevision: 0, promptId: 'first-intake.name', action: 'answer', text: words }),
    }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get('X-Request-Id')).toBe(opaqueId);
    expect(response.headers.get('Server-Timing')).toMatch(/^session;dur=\d+(\.\d)?, total;dur=\d+(\.\d)?$/);
    const [entry] = logged(spy);
    expect(entry).toMatchObject({ requestId: opaqueId, route: 'POST /api/clinic/turns', status: response.status, phases: { session: expect.any(Number) } });
    expect(JSON.stringify(spy.mock.calls)).not.toContain('Synthetic words');
  });
});

// Exercise real successful requests with local synthetic FHIR, not an authentication failure.
async function successfulFixture(reviewer: SafetyReviewer, interpreter?: IntakeInterpreter) {
  const fhir = mockFhir({ atomic: false }).fetcher;
  const client = new MedplumClient({ baseUrl: 'http://localhost:8103/fhir/R4/', accessToken: 'synthetic', mode: 'local', timeoutMs: 1000 }, fhir);
  const handle = createClinicHandler(config, { runtime: async () => ({ client, qualification: {} }) as unknown as Runtime, safetyReviewer: reviewer, adaptiveInterpreter: interpreter });
  let cookie = '';
  const call = async <T = ClinicSessionView>(path: string, data?: unknown) => {
    const response = await handle(new Request(origin + path, { method: data === undefined ? 'GET' : 'POST', headers: { origin, cookie, 'Content-Type': 'application/json', 'X-Request-Id': opaqueId }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }));
    const issued = response.headers.get('set-cookie'); if (issued) cookie = issued.split(';')[0];
    return { response, body: await response.json() as T };
  };
  expect((await call('/api/clinic/sessions', { scenario: 'first-intake', syntheticAcknowledged: true })).response.status).toBe(201);
  const current = (await call('/api/clinic/confirm-identity', { confirmed: true })).body;
  return { call, current, draft: () => readDraft(client, current.id, patient.reference) };
}

const cleared = { concern: false, level: 'none', categories: [], rationale: 'Synthetic clear', model: 'synthetic' } as const;
const imminent = { concern: true, level: 'imminent', categories: ['self-harm'], rationale: 'Synthetic concern', model: 'synthetic' } as const;
const proposal = { facts: [], items: [], listsDone: [], questions: [], moveOn: null, ack: null };
const makeInterpreter = (): IntakeInterpreter => ({ interpret: vi.fn(async context => ({ outcome: interpretIntakeResponse(proposal, context) })) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function expectPhases(response: Response, expected: string[]) {
  const header = response.headers.get('Server-Timing') ?? '';
  expect(header.split(', ').map(metric => metric.split(';')[0])).toEqual(expected);
  expect(header).toMatch(/^(?:[a-z]+;dur=\d+(?:\.\d)?, )*total;dur=\d+(?:\.\d)?$/);
  expect(response.headers.get('X-Request-Id')).toBe(opaqueId);
}
const turnInput = (current: ClinicSessionView, text: string) => ({ requestId: crypto.randomUUID(), expectedRevision: current.revision, promptId: current.currentPrompt!.id, action: 'answer', text, channel: 'text' });

describe('successful turn timing and safety ordering', () => {
  afterEach(() => vi.restoreAllMocks());

  it('times guided dialogue, awaited safety and persistence without logging patient words', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const f = await successfulFixture({ review: async () => ({ ...cleared, categories: [] }) });
    spy.mockClear();
    const text = 'Synthetic words that must never be logged';
    const result = await f.call('/api/clinic/turns', turnInput(f.current, text));
    expect(result.response.status).toBe(200);
    expect(result.body.revision).toBeGreaterThan(f.current.revision);
    expect(result.body.currentPrompt).toBeDefined();
    expectPhases(result.response, ['session', 'dialogue', 'safety', 'store', 'total']);
    expect(logged(spy)).toEqual([expect.objectContaining({ requestId: opaqueId, route: 'POST /api/clinic/turns', status: 200, phases: { session: expect.any(Number), dialogue: expect.any(Number), safety: expect.any(Number), store: expect.any(Number) } })]);
    expect(JSON.stringify(spy.mock.calls)).not.toContain(text);
  });

  it('times adaptive acceptance and successful interpretation with safety and persistence', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const f = await successfulFixture({ review: async () => ({ ...cleared, categories: [] }) }, makeInterpreter());
    spy.mockClear();
    const accepted = await f.call<AdaptiveTurnResult>('/api/clinic/adaptive-turns', { requestId: crypto.randomUUID(), expectedRevision: f.current.revision, text: 'Synthetic unlogged answer', channel: 'text' });
    expect(accepted.response.status).toBe(202);
    expectPhases(accepted.response, ['session', 'store', 'accept', 'total']);
    const result = await f.call<AdaptiveTurnResult>(`/api/clinic/adaptive-turns/${accepted.body.operation.id}/interpret`, {});
    expect(result.response.status).toBe(200);
    expect(result.body.operation.status).toBe('applied');
    expect(result.body.session.currentPrompt).toBeDefined();
    // Nested asynchronous spans finish in execution order; all required phases must be present.
    const phases = logged(spy).at(-1).phases;
    expect(Object.keys(phases).sort()).toEqual(['interpret', 'safety', 'session', 'store']);
    expectPhases(result.response, [...Object.keys(phases), 'total']);
    expect(logged(spy)).toHaveLength(2);
    expect(logged(spy).map(entry => entry.route)).toEqual(['POST /api/clinic/adaptive-turns', 'POST /api/clinic/adaptive-turns/:id/interpret']);
    expect(JSON.stringify(spy.mock.calls)).not.toContain('Synthetic unlogged answer');
  });

  it.each(['guided', 'adaptive'] as const)('%s cannot publish the next question before a deferred safety verdict', async mode => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const entered = deferred<void>(), verdict = deferred<Awaited<ReturnType<SafetyReviewer['review']>>>();
    const model = makeInterpreter();
    const f = await successfulFixture({ review: async () => { entered.resolve(); return verdict.promise; } }, mode === 'adaptive' ? model : undefined);
    let path = '/api/clinic/turns', input: unknown = turnInput(f.current, 'I gave my cat to my neighbour and wrote letters to everyone this week.');
    let accepted: AdaptiveTurnResult | undefined;
    if (mode === 'adaptive') {
      const result = await f.call<AdaptiveTurnResult>('/api/clinic/adaptive-turns', { requestId: crypto.randomUUID(), expectedRevision: f.current.revision, text: 'I gave my cat to my neighbour and wrote letters to everyone this week.', channel: 'text' });
      expect(result.response.status).toBe(202); accepted = result.body;
      path = `/api/clinic/adaptive-turns/${accepted.operation.id}/interpret`; input = {};
    }
    spy.mockClear();
    let returned = false;
    const pending = f.call<ClinicSessionView | AdaptiveTurnResult>(path, input).then(result => { returned = true; return result; });
    await entered.promise;
    expect(returned).toBe(false);
    if (mode === 'adaptive') {
      // The browser can poll this view while interpretation is still running.
      const polled = await f.call<AdaptiveTurnResult>(`/api/clinic/adaptive-turns/${accepted!.operation.id}`);
      expect(polled.response.status).toBe(200);
      expect(polled.body.session.currentPrompt).toEqual(accepted!.session.currentPrompt);
      expect(polled.body.session.turns.filter(turn => turn.role === 'assistant')).toEqual(accepted!.session.turns.filter(turn => turn.role === 'assistant'));
      expect(polled.body.operation.status).toBe('processing');
    } else {
      // Session GET deliberately removes identity confirmation; inspect the saved draft directly.
      const saved = (await f.draft()).draft;
      expect(saved.revision).toBe(f.current.revision);
      expect(saved.turns).toEqual(f.current.turns);
    }
    expect(logged(spy).some(entry => entry.route === `POST ${mode === 'guided' ? '/api/clinic/turns' : '/api/clinic/adaptive-turns/:id/interpret'}`)).toBe(false);
    verdict.resolve({ ...imminent, categories: ['self-harm'] });
    const result = await pending;
    expect(result.response.status).toBe(200);
    const session = mode === 'guided' ? result.body as ClinicSessionView : (result.body as AdaptiveTurnResult).session;
    expect(session.notice).toMatchObject({ tone: 'urgent' });
    expect(session.notice!.text).toContain('988');
    expect(session.currentPrompt).toBeUndefined();
    const timing = result.response.headers.get('Server-Timing') ?? '';
    expect(timing).toContain('safety;dur=');
    expect(timing).toContain('store;dur=');
    expect(timing).toMatch(/total;dur=\d+(?:\.\d)?$/);
  });

  it('never logs patient-looking request IDs or unknown path segments on failed requests', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const response = await handler()(new Request(`${origin}/api/clinic/adaptive-turns/Mary%20Smith/interpret`, { method: 'POST', headers: { origin, 'X-Request-Id': 'patient-has-chest-pain', 'Content-Type': 'application/json' }, body: '{}' }));
    expect(response.status).toBe(404);
    expect(logged(spy)).toEqual([expect.objectContaining({ route: 'POST /api/clinic/adaptive-turns/:id/interpret', requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) })]);
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/Mary|patient-has-chest-pain/);
  });
});
