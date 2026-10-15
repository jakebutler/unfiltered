import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClinicHandler } from '../src/handler.js';
import type { ClinicApiConfig } from '../src/types.js';
import type { Runtime } from '../src/runtime.js';

const origin = 'https://clinic.example';
const patient = { reference: 'Patient/synthetic', displayName: 'Synthetic patient', description: 'Synthetic only', careTeams: { medical: 'CareTeam/medical', nutrition: 'CareTeam/nutrition', administrative: 'CareTeam/administrative' } };
const config = { origin, medplumBaseUrl: 'https://api.medplum.com/', projectId: 'synthetic-project', clientId: 'synthetic-client', clientSecret: 'synthetic-secret', cookieSecret: 'synthetic-cookie-secret-at-least-32-characters', mentalHealth: 'phq4', staff: [], patients: Object.fromEntries(['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'].map(id => [id, patient])) } as ClinicApiConfig;
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
    const echoed = await handler()(new Request(`${origin}/api/clinic/config`, { headers: { origin, 'X-Request-Id': 'client-req.0001' } }));
    expect(echoed.headers.get('X-Request-Id')).toBe('client-req.0001');
    const replaced = await handler()(new Request(`${origin}/api/clinic/config`, { headers: { origin, 'X-Request-Id': 'bad id!' } }));
    expect(replaced.headers.get('X-Request-Id')).not.toBe('bad id!');
    expect(replaced.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports the session phase on a turn route without leaking the submitted words', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const words = 'Synthetic words that must never be logged';
    const response = await handler()(new Request(`${origin}/api/clinic/turns`, {
      method: 'POST', headers: { origin, 'Content-Type': 'application/json', 'X-Request-Id': 'turn-req-000001' },
      body: JSON.stringify({ requestId: crypto.randomUUID(), expectedRevision: 0, promptId: 'first-intake.name', action: 'answer', text: words }),
    }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get('X-Request-Id')).toBe('turn-req-000001');
    expect(response.headers.get('Server-Timing')).toMatch(/^session;dur=\d+(\.\d)?, total;dur=\d+(\.\d)?$/);
    const [entry] = logged(spy);
    expect(entry).toMatchObject({ requestId: 'turn-req-000001', route: 'POST /api/clinic/turns', status: response.status, phases: { session: expect.any(Number) } });
    expect(JSON.stringify(spy.mock.calls)).not.toContain('Synthetic words');
  });
});
