import { afterEach, expect, it, vi } from 'vitest';
import { createOfflinePhq4Clinic, requireOfflineArguments, runOfflinePhq4Smoke } from '../../../scripts/dev/phq4-local-smoke.mts';

afterEach(() => vi.unstubAllGlobals());

it('runs native PHQ button submissions through review, mock delivery, and the assigned staff projection without network', async () => {
  const externalFetch = vi.fn(() => { throw new Error('External network is forbidden in the offline smoke'); });
  vi.stubGlobal('fetch', externalFetch);
  expect(await runOfflinePhq4Smoke()).toEqual({
    mode: 'offline', coverage: 'native-handler-and-staff-projection',
    cases: [
      { answered: 3, screeningStatus: 'incomplete', scores: null, intakeCompleteness: 'partial', delivery: 'received' },
      { answered: 4, screeningStatus: 'complete', scores: { gad2: 3, phq2: 3, phq4: 6 }, intakeCompleteness: 'partial', delivery: 'received' },
    ],
  });
  expect(externalFetch).not.toHaveBeenCalled();
});

it('defaults to offline and rejects target URLs or live switches', () => {
  expect(() => requireOfflineArguments([])).not.toThrow();
  expect(() => requireOfflineArguments(['--local'])).not.toThrow();
  expect(() => requireOfflineArguments(['--serve-local'])).not.toThrow();
  for (const args of [['--live'], ['https://corvo-clinic-demo.vercel.app'], ['--local', '--live']]) {
    expect(() => requireOfflineArguments(args)).toThrow('Offline smoke accepts only --local or --serve-local');
  }
});

it('supports the real local staff routes using synthetic auth and in-memory FHIR only', async () => {
  const externalFetch = vi.fn(() => { throw new Error('External network forbidden'); });
  vi.stubGlobal('fetch', externalFetch);
  const { handler, origin } = await createOfflinePhq4Clinic();
  const login = await handler(new Request(origin + '/api/staff/login', {
    method: 'POST', headers: { origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'synthetic-md@example.invalid', password: 'local-smoke-only' }),
  }));
  expect(login.status).toBe(200);
  expect(await login.json()).toMatchObject({ name: 'Synthetic physician', role: 'physician' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const queue = await handler(new Request(origin + '/api/staff/queue', { headers: { cookie } }));
  expect(queue.status).toBe(200);
  expect(await queue.json()).toMatchObject({ items: [], recovery: [] });
  expect(externalFetch).not.toHaveBeenCalled();
});
