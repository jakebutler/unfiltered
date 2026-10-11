import { describe, expect, it } from 'vitest';
import { MedplumClient } from '../../clinical-core/src/medplum.js';
import { deploymentFixtures, type FixtureIntent } from '../../../scripts/qualification/deployment-fixtures.js';

const config = { baseUrl: 'http://localhost:8103/fhir/R4/', accessToken: 'synthetic-token', mode: 'local' as const, timeoutMs: 1000 };

describe('qualification fixture intent evidence', () => {
  it('persists a stable conditional intent before POST and native identity before readback', async () => {
    const journal: FixtureIntent[] = [], saved: FixtureIntent[][] = [];
    let native: Record<string, unknown>;
    const fetcher: typeof fetch = async (_input, init) => {
      if (init?.method === 'POST') {
        expect(saved.at(-1)?.[0].state).toBe('intent');
        expect(new Headers(init.headers).get('if-none-exist')).toBe('identifier=urn%3Acorvo%3Adeployment%3Aqualification%7Cunique-fixture');
        native = { ...JSON.parse(String(init.body)), id: 'native-source', meta: { versionId: 'v1' } };
      } else expect(saved.at(-1)?.[0]).toMatchObject({ state: 'acknowledged', reference: 'DocumentReference/native-source', versionId: 'v1' });
      return Response.json(native);
    };
    const fixtures = deploymentFixtures(new MedplumClient(config, fetcher), fetcher, journal, () => saved.push(structuredClone(journal)));
    await expect(fixtures.resource('unique-fixture', { resourceType: 'DocumentReference', status: 'current', subject: { reference: 'Patient/unrelated' } })).resolves.toEqual({ id: 'native-source', reference: 'DocumentReference/native-source' });
    expect(journal[0]).toMatchObject({ state: 'confirmed', identifier: { value: 'unique-fixture' } });
  });

  it('retains a lost acknowledgement and refuses replay of an existing intent', async () => {
    const journal: FixtureIntent[] = []; let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; throw new Error('synthetic lost response'); };
    const fixtures = deploymentFixtures(new MedplumClient(config, fetcher), fetcher, journal, () => undefined);
    const create = () => fixtures.resource('uncertain-fixture', { resourceType: 'Task', status: 'ready' });
    await expect(create()).rejects.toThrow();
    expect(journal[0]).toMatchObject({ state: 'outcome-unknown', identifier: { value: 'uncertain-fixture' } });
    await expect(create()).rejects.toThrow('fixture-intent-already-exists-reconcile-without-replay');
    expect(calls).toBe(1);
  });

  it('records an unknown Binary acknowledgement as a manual hold with its unique marker and context', async () => {
    const journal: FixtureIntent[] = []; let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; throw new Error('synthetic lost response'); };
    const fixtures = deploymentFixtures(new MedplumClient(config, fetcher), fetcher, journal, () => undefined);
    const create = () => fixtures.binary('unique-binary-marker', 'DocumentReference/source', 'Synthetic unique-binary-marker');
    await expect(create()).rejects.toThrow();
    expect(journal[0]).toMatchObject({ key: 'unique-binary-marker', state: 'outcome-unknown', securityContext: 'DocumentReference/source' });
    expect(journal[0].requestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(journal[0].reconciliation).toMatch(/operator inspection; do not replay/);
    await expect(create()).rejects.toThrow('fixture-intent-already-exists-reconcile-without-replay');
    expect(calls).toBe(1);
  });

  it('retains an acknowledged Binary native ID when readback fails', async () => {
    const journal: FixtureIntent[] = [], saved: FixtureIntent[][] = [];
    const fetcher: typeof fetch = async (_input, init) => init?.method === 'POST'
      ? Response.json({ resourceType: 'Binary', id: 'native-binary', meta: { versionId: 'v1' } })
      : new Response('unavailable', { status: 503 });
    const fixtures = deploymentFixtures(new MedplumClient(config, fetcher), fetcher, journal, () => saved.push(structuredClone(journal)));
    await expect(fixtures.binary('binary-fixture', 'DocumentReference/source', 'Synthetic binary-fixture')).rejects.toThrow('binary-control-readback-mismatch');
    expect(saved[1]?.[0]).toMatchObject({ state: 'acknowledged', reference: 'Binary/native-binary' });
    expect(journal[0]).toMatchObject({ state: 'readback-unconfirmed', reference: 'Binary/native-binary', versionId: 'v1' });
  });
});
