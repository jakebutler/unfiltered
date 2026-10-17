import { describe, expect, it, vi } from 'vitest';
import { createClinicHandler } from '../src/handler.js';
import { createProviderAdmission, noUnits, type ProviderBudgetPolicy } from '../src/provider-admission.js';
import { decodeDocument, document, DRAFT_SYSTEM } from '../src/store.js';
import type { AdaptiveProposer } from '../src/adaptive.js';
import type { Draft, ClinicApiConfig } from '../src/types.js';
import type { Runtime } from '../src/runtime.js';
import type { FhirResource } from '../../clinical-core/src/fhir.js';
import type { MedplumClient } from '../../clinical-core/src/medplum.js';
import type { AdaptiveTurnResult, ClinicSessionView } from '../../clinic-contract/src/index.js';
import { TransportError } from '../../clinical-core/src/transport.js';
import { fact, proposal } from './fixtures/adaptive.js';

const origin = 'http://127.0.0.1:5173';
const person = { reference: 'Patient/security-test', displayName: 'Fictional Security Test', description: 'Synthetic only', careTeams: { medical: 'CareTeam/medical', nutrition: 'CareTeam/nutrition', administrative: 'CareTeam/admin' } };
const config = { origin, cookieSecret: 'offline-security-test-'.repeat(3), mentalHealth: 'phq4', patients: Object.fromEntries(['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'].map(id => [id, person])) } as ClinicApiConfig;

function memoryFhir() {
  const records = new Map<string, FhirResource>();
  let seq = 0;
  let staleProcessingAck = false;
  let uncommittedBudgetEcho = false;
  let failNextPut: 'after' | 'before' | undefined;
  const client = { async request(path: string, method = 'GET', body?: FhirResource, headers?: Record<string, string>) {
    if (method === 'GET') {
      const identifier = new URL(path, origin).searchParams.get('identifier');
      const matches = [...records.values()].filter(r => (r.identifier as { system: string; value: string }[]).some(i => `${i.system}|${i.value}` === identifier));
      return { body: { resourceType: 'Bundle', type: 'searchset', total: matches.length, entry: matches.map(resource => ({ resource: structuredClone(resource) })) } };
    }
    if (method === 'POST') {
      const condition = headers?.['If-None-Exist'];
      if (!condition) throw Error('condition-required');
      const identifier = new URLSearchParams(condition).get('identifier');
      const existing = [...records.values()].find(r => (r.identifier as { system: string; value: string }[]).some(i => `${i.system}|${i.value}` === identifier));
      if (existing) return { body: structuredClone(existing) };
      const next = { ...structuredClone(body!), id: String(++seq), meta: { versionId: '1' } };
      records.set(next.id, next); return { body: structuredClone(next) };
    }
    const id = path.split('/')[1], previous = records.get(id)!;
    if (headers?.['If-Match'] !== `W/"${(previous.meta as { versionId: string }).versionId}"`) throw new TransportError('http', 412);
    const draft = decodeDocument<Draft>(body!);
    if (uncommittedBudgetEcho && !draft.adaptive) return { body: { ...structuredClone(body!), meta: previous.meta } };
    if (staleProcessingAck && draft.adaptive?.activeOperationId && draft.adaptive.operations[draft.adaptive.activeOperationId].status === 'processing') return { body: structuredClone(previous) };
    const fail = failNextPut; failNextPut = undefined;
    if (fail === 'before') throw new TransportError('network');
    const next = { ...structuredClone(body!), id, meta: { versionId: String(Number((previous.meta as { versionId: string }).versionId) + 1) } };
    records.set(id, next);
    if (fail === 'after') throw new TransportError('network');
    return { body: structuredClone(next) };
  } } as unknown as MedplumClient;
  return { client, records, staleClaims: () => { staleProcessingAck = true; }, echoBudget: () => { uncommittedBudgetEcho = true; }, failPut: (fault: typeof failNextPut) => { failNextPut = fault; } };
}
function handlerFixture() {
  const fhir = memoryFhir();
  const propose = vi.fn<AdaptiveProposer['propose']>(async context => ({ proposal: proposal([fact(context, 'Q01', 'reason', context.source.text)]), receipt: { requestId: 'offline-only', model: 'offline-test' } }));
  const runtime = async () => ({ client: fhir.client, qualification: {} }) as unknown as Runtime;
  const handler = createClinicHandler(config, { runtime, adaptiveProposer: { propose } });
  let cookie = '';
  async function request<T = ClinicSessionView>(path: string, body?: unknown, customCookie = cookie) {
    const response = await handler(new Request(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: customCookie, ...(body === undefined ? {} : { origin, 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const setCookie = response.headers.get('set-cookie');
    if (setCookie && customCookie === cookie) cookie = setCookie.split(';')[0];
    return { status: response.status, body: await response.json() as T };
  }
  const boot = async () => {
    await request('/api/clinic/sessions', { scenario: 'first-intake', syntheticAcknowledged: true });
    return (await request('/api/clinic/confirm-identity', { confirmed: true })).body;
  };
  const draft = () => [...fhir.records.entries()].map(([id, resource]) => ({ id, resource, value: decodeDocument<Draft>(resource) })).find(x => x.value.adaptive)!;
  const mutate = (change: (d: Draft) => void) => {
    const { id, resource, value } = draft(); change(value);
    fhir.records.set(id, { ...document(DRAFT_SYSTEM, value.id, value.patient, value), id, meta: resource.meta });
  };
  return { ...fhir, request, boot, propose, mutate, draft, cookie: () => cookie };
}
const policy: ProviderBudgetPolicy = { id: 'offline-security-budget', limits: Object.fromEntries(['digitalocean', 'deepgram', 'elevenlabs'].map(provider => [provider, { account: { requests: 10, inputBytes: 600000, outputTokens: 40960, characters: 10000, audioSeconds: 300 }, session: { requests: 3, inputBytes: 180000, outputTokens: 12288, characters: 3000, audioSeconds: 120 }, concurrency: 1, leaseMs: 120000 }])) as ProviderBudgetPolicy['limits'] };
const reservation = () => ({ provider: 'digitalocean' as const, requestId: crypto.randomUUID(), sessionId: 'security-session', units: { ...noUnits(), requests: 1, inputBytes: 1000, outputTokens: 4096 } });

describe('independent S2 durability/security adversarial review', () => {
  it('does not dispatch from a stale successful processing-save acknowledgement', async () => {
    const f = handlerFixture(), s = await f.boot();
    const accepted = await f.request<AdaptiveTurnResult>('/api/clinic/adaptive-turns', { requestId: crypto.randomUUID(), expectedRevision: s.revision, text: 'Improve energy for daily activities.', channel: 'text' });
    expect(accepted.status).toBe(202); f.staleClaims();
    await f.request(`/api/clinic/adaptive-turns/${accepted.body.operation.id}/interpret`, {});
    await f.request(`/api/clinic/adaptive-turns/${accepted.body.operation.id}/interpret`, {});
    expect(f.draft().value.adaptive!.operations[accepted.body.operation.id].status).toBe('accepted');
    expect(f.propose).not.toHaveBeenCalled();
  });
  it('denies operation details and inference while the persona capability is unconfirmed', async () => {
    const f = handlerFixture(), s = await f.boot();
    const accepted = await f.request<AdaptiveTurnResult>('/api/clinic/adaptive-turns', { requestId: crypto.randomUUID(), expectedRevision: s.revision, text: 'Fictional answer.', channel: 'text' });
    const gate = await f.request('/api/clinic/session');
    expect(gate.body.turns).toEqual([]); expect(gate.body.adaptive).toBeUndefined();
    expect((await f.request(`/api/clinic/adaptive-turns/${accepted.body.operation.id}`)).status).toBe(403);
    expect((await f.request(`/api/clinic/adaptive-turns/${accepted.body.operation.id}/interpret`, {})).status).toBe(403);
    expect(f.propose).not.toHaveBeenCalled();
  });
  it('fails closed on a malformed stored operation status rather than allowing new work', async () => {
    const f = handlerFixture(), s = await f.boot();
    const accepted = await f.request<AdaptiveTurnResult>('/api/clinic/adaptive-turns', { requestId: crypto.randomUUID(), expectedRevision: s.revision, text: 'Fictional answer.', channel: 'text' });
    f.mutate(d => { (d.adaptive!.operations[accepted.body.operation.id] as unknown as { status: string }).status = 'processing-unknown'; });
    const review = await f.request('/api/clinic/review', { expectedRevision: accepted.body.session.revision });
    expect(review.status).toBeGreaterThanOrEqual(400);
    expect(f.draft().value.phase).toBe('conversation');
  });
  it('does not grant a lease from an uncommitted ledger echo carrying the old FHIR version', async () => {
    const f = memoryFhir(); f.echoBudget();
    await expect(createProviderAdmission(async () => f.client, policy).reserve(reservation())).rejects.toMatchObject({ code: 'budget-outcome-unknown' });
    expect(decodeDocument<{ claims: unknown[] }>([...f.records.values()][0]).claims).toHaveLength(0);
  });
  it('keeps an ambiguously persisted budget reservation charged across a new admission instance', async () => {
    const f = memoryFhir(), input = reservation(); f.failPut('after');
    await expect(createProviderAdmission(async () => f.client, policy).reserve(input)).rejects.toMatchObject({ code: 'budget-outcome-unknown' });
    await expect(createProviderAdmission(async () => f.client, policy).reserve(input)).rejects.toMatchObject({ code: 'provider-attempt-already-reserved' });
    expect(decodeDocument<{ claims: unknown[] }>([...f.records.values()][0]).claims).toHaveLength(1);
  });
  it('rejects a malformed stored zero-request claim instead of granting fresh concurrency', async () => {
    const f = memoryFhir(), oneRequest = structuredClone(policy);
    oneRequest.limits.digitalocean.account.requests = 1;
    oneRequest.limits.digitalocean.session.requests = 1;
    await createProviderAdmission(async () => f.client, oneRequest).reserve(reservation());
    const [id, resource] = [...f.records.entries()][0];
    const ledger = decodeDocument<{ claims: { units: { requests: number }; startedAt: number; expiresAt: number }[] }>(resource);
    ledger.claims[0].units.requests = 0;
    ledger.claims[0].expiresAt = ledger.claims[0].startedAt - 1;
    const { base64Json } = await import('../../clinical-core/src/fhir.js');
    f.records.set(id, { ...resource, content: [{ attachment: { contentType: 'application/json', data: base64Json(ledger) } }] });
    await expect(createProviderAdmission(async () => f.client, oneRequest).reserve(reservation())).rejects.toMatchObject({ code: 'budget-ledger-invalid' });
  });
});
