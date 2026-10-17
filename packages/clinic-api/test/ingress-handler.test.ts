import { describe, expect, it, vi } from 'vitest';
import { createClinicHandler } from '../src/handler.js';
import { ApiFailure, type ClinicApiConfig } from '../src/types.js';
import type { Runtime } from '../src/runtime.js';
import type { IngressAdmission } from '../src/ingress-admission.js';
import type { FhirResource } from '../../clinical-core/src/fhir.js';

const origin = 'https://clinic.example';
const patient = { reference: 'Patient/synthetic', displayName: 'Synthetic patient', description: 'Synthetic only', careTeams: { medical: 'CareTeam/medical', nutrition: 'CareTeam/nutrition', administrative: 'CareTeam/administrative' } };
const config = { origin, medplumBaseUrl: 'https://api.medplum.com/', projectId: 'synthetic-project', clientId: 'synthetic-client', clientSecret: 'synthetic-secret', cookieSecret: 'synthetic-cookie-secret-at-least-32-characters', mentalHealth: 'phq4', staff: [], patients: Object.fromEntries(['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'].map(id => [id, patient])) } as ClinicApiConfig;
const grant = () => ({ expiresAt: 0, close: async () => undefined });
function fixture() {
  let native: FhirResource | undefined, readFailure = false;
  const request = vi.fn(async (_path: string, method = 'GET', body?: FhirResource) => {
    if (method === 'GET') {
      if (readFailure) throw new Error('synthetic read failure');
      return { body: { resourceType: 'Bundle', type: 'searchset', total: native ? 1 : 0, entry: native ? [{ resource: structuredClone(native) }] : [] } };
    }
    native = { ...structuredClone(body!), id: 'native-draft', meta: { versionId: '1' } };
    return { body: structuredClone(native) };
  });
  const runtime = vi.fn(async () => ({ client: { request }, qualification: {} }) as unknown as Runtime);
  const fetcher = vi.fn(async () => Response.json({ resourceType: 'OperationOutcome' }, { status: 401 }));
  const make = (reserve: IngressAdmission['reserve']) => createClinicHandler(config, { runtime, fetcher, ingress: { reserve } });
  const call = (path: string, body: unknown, cookie = '', signal?: AbortSignal, suppliedOrigin = origin) => new Request(origin + path, { method: 'POST', headers: { origin: suppliedOrigin, 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body), signal });
  return { make, call, runtime, request, fetcher, failReads: () => { readFailure = true; }, writes: () => request.mock.calls.filter(([, method]) => method === 'POST' || method === 'PUT').length };
}

describe('clinic ingress placement', () => {
  it.each(['origin', 'body'])('rejects invalid %s before admission or native work', async variant => {
    const f = fixture(), reserve = vi.fn(async () => grant()), handler = f.make(reserve);
    const response = await handler(f.call('/api/clinic/sessions', variant === 'body' ? { scenario: 'bad' } : { scenario: 'first-intake', syntheticAcknowledged: true }, '', undefined, variant === 'origin' ? 'https://other.example' : origin));
    expect(response.status).toBe(variant === 'origin' ? 403 : 400);
    expect(reserve).not.toHaveBeenCalled(); expect(f.runtime).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(['ingress-rate-limited', 'ingress-outcome-unknown'])('does no clinical create or login after %s', async code => {
    const f = fixture(), reserve = vi.fn(async () => { throw new ApiFailure(code, code.endsWith('unknown') ? 503 : 429, false); });
    const handler = f.make(reserve);
    const create = await handler(f.call('/api/clinic/sessions', { scenario: 'first-intake', syntheticAcknowledged: true }));
    const login = await handler(f.call('/api/staff/login', { email: 'synthetic@example.invalid', password: 'synthetic' }));
    expect((await create.json()).error.code).toBe(code); expect((await login.json()).error.code).toBe(code);
    expect(f.writes()).toBe(0); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('resumes the same valid session across instances without a new allocation or draft', async () => {
    const f = fixture(), reserve = vi.fn(async () => grant());
    const first = await f.make(reserve)(f.call('/api/clinic/sessions', { scenario: 'first-intake', syntheticAcknowledged: true }));
    expect(first.status).toBe(201); const firstView = await first.json(), cookie = first.headers.get('set-cookie')!.split(';')[0];
    const denied = vi.fn(async () => { throw new ApiFailure('ingress-allocation-exhausted', 429); });
    const resumed = await f.make(denied)(f.call('/api/clinic/sessions', { scenario: 'first-intake', syntheticAcknowledged: true }, cookie));
    expect(resumed.status).toBe(201); expect((await resumed.json()).id).toBe(firstView.id);
    expect(reserve).toHaveBeenCalledOnce(); expect(denied).not.toHaveBeenCalled(); expect(f.writes()).toBe(1);
    f.failReads();
    const uncertain = await f.make(denied)(f.call('/api/clinic/sessions', { scenario: 'first-intake', syntheticAcknowledged: true }, cookie));
    expect(uncertain.status).toBeGreaterThanOrEqual(500); expect(denied).not.toHaveBeenCalled(); expect(f.writes()).toBe(1);
  });
  it('reserves a new allocation for a different scenario and preserves the old draft when denied', async () => {
    const f = fixture(), reserve = vi.fn(async () => grant());
    const first = await f.make(reserve)(f.call('/api/clinic/sessions', { scenario: 'first-intake', syntheticAcknowledged: true }));
    const cookie = first.headers.get('set-cookie')!.split(';')[0];
    const denied = vi.fn(async () => { throw new ApiFailure('ingress-allocation-exhausted', 429); });
    const different = await f.make(denied)(f.call('/api/clinic/sessions', { scenario: 'pre-visit', syntheticAcknowledged: true }, cookie));
    expect(different.status).toBe(429); expect(denied).toHaveBeenCalledOnce(); expect(f.writes()).toBe(1);
  });
  it.each(['session', 'login'])('does not dispatch an aborted %s after its reservation resolves', async kind => {
    const f = fixture(), abort = new AbortController();
    const reserve = vi.fn(async () => { abort.abort(); return grant(); });
    const response = await f.make(reserve)(f.call(kind === 'session' ? '/api/clinic/sessions' : '/api/staff/login', kind === 'session' ? { scenario: 'first-intake', syntheticAcknowledged: true } : { email: 'synthetic@example.invalid', password: 'synthetic' }, '', abort.signal));
    expect(response.status).toBe(499); expect(reserve).toHaveBeenCalledOnce(); expect(f.writes()).toBe(0); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('charges login admission before the native credential attempt, including rejected credentials', async () => {
    const f = fixture(), reserve = vi.fn(async () => { expect(f.fetcher).not.toHaveBeenCalled(); return grant(); });
    const response = await f.make(reserve)(f.call('/api/staff/login', { email: 'synthetic@example.invalid', password: 'synthetic' }));
    expect(response.status).toBe(401); expect(reserve).toHaveBeenCalledOnce(); expect(reserve.mock.calls[0][0]).toMatchObject({ kind: 'staff-login' }); expect(f.fetcher).toHaveBeenCalledOnce();
  });
});
