import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertDeploymentStaffRoster, verifyNativeStaffRevocation } from '../src/deployment-probes.js';
import type { ClinicApiConfig } from '../src/types.js';
import { deploymentFixtures, type FixtureIntent } from '../../../scripts/qualification/deployment-fixtures.js';
import { MedplumClient } from '../../clinical-core/src/medplum.js';
// The provisioning tool deliberately remains an executable Node ESM module.
// @ts-expect-error Provisioning module has no TypeScript declaration.
import { seedClinic } from '../../../infra/cloud/seed-clinic.mjs';

const projectId = '13eaac67-a2c3-4aa1-aa9e-590a083e5fef';
const clientId = '50db76bd-d099-4305-8ec3-7439ffc38ca1';
const membershipId = '6e565de2-837d-4618-9578-f6428fbb0be1';
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function options() {
  const privateDirectory = mkdtempSync(join(tmpdir(), 'corvo-independent-cloud-'));
  directories.push(privateDirectory);
  return { projectId, clientId, clientSecret: 'synthetic-test-secret', origin: 'https://clinic.example', privateDirectory };
}
function authenticatedMembership(id = membershipId) {
  return { project: { id: projectId }, profile: { resourceType: 'ClientApplication', id: clientId }, membership: { resourceType: 'ProjectMembership', id, admin: true, profile: { reference: `ClientApplication/${clientId}` }, project: { reference: `Project/${projectId}` } } };
}

describe('independent cloud provisioning boundary', () => {
  it('rejects a different client in the same approved project before authentication', async () => {
    const calls: string[] = [];
    const result = seedClinic({ ...options(), clientId: 'another-project-admin', fetcher: async (url: string) => { calls.push(url); return Response.json({}, { status: 401 }); } });
    await expect(result).rejects.toThrow(/target|client/);
    expect(calls).toEqual([]);
  });

  it('rejects a different membership before FHIR reads or administrative mutations', async () => {
    const calls: string[] = [];
    await expect(seedClinic({ ...options(), fetcher: async (url: string) => {
      const path = new URL(url).pathname; calls.push(path);
      if (path === '/oauth2/token') return Response.json({ access_token: 'synthetic-test-token' });
      if (path === '/auth/me') return Response.json(authenticatedMembership('another-membership'));
      return Response.json({}, { status: 403 });
    } })).rejects.toThrow(/membership|identity|target/);
    expect(calls).toEqual(['/oauth2/token', '/auth/me']);
  });

  it('records manual cleanup when admin identity is known but its membership read is unavailable', async () => {
    const config = options();
    const writes: string[] = [];
    await expect(seedClinic({ ...config, fetcher: async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === '/oauth2/token') return Response.json({ access_token: 'synthetic-test-token' });
      if (path === '/auth/me') return Response.json(authenticatedMembership());
      if (init.method !== 'GET') writes.push(path);
      throw new Error('synthetic connection loss');
    } })).rejects.toThrow();
    const journal = JSON.parse(readFileSync(join(config.privateDirectory, 'seed-journal.json'), 'utf8'));
    expect(journal.state).toBe('incomplete');
    expect(journal.cleanup).toBe('cleanup-required');
    expect(journal.cleanupEndpoint).toBe(`admin/projects/${projectId}/members/${membershipId}`);
    // No guessed membership body or blind administrative write on an unknown read.
    expect(writes).toEqual([]);
  });
});

describe('independent native revocation evidence', () => {
  const outcome = { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'login', details: { text: 'Invalid login' } }] };
  it('requires a native invalid-login outcome and sends only the expected bearer probe', async () => {
    const calls: { url: string; method: string; bearer: string | null; redirect: RequestRedirect | undefined }[] = [];
    const proof = await verifyNativeStaffRevocation('https://api.medplum.com/', 'synthetic-token', async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', bearer: new Headers(init?.headers).get('authorization'), redirect: init?.redirect });
      return Response.json(outcome, { status: 401 });
    });
    expect(proof).toEqual({ state: 'revoked', status: 401, code: 'login' });
    expect(calls).toEqual([{ url: 'https://api.medplum.com/auth/me', method: 'GET', bearer: 'Bearer synthetic-token', redirect: 'error' }]);
  });
  it.each([200, 403, 429, 500, 503])('does not interpret HTTP %s as revocation', async status => {
    await expect(verifyNativeStaffRevocation('https://api.medplum.com/', 'synthetic-token', async () => Response.json(outcome, { status }))).rejects.toThrow('staff-native-revocation-unconfirmed');
  });
  it.each([
    { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'forbidden' }] },
    { resourceType: 'OperationOutcome', issue: [{ severity: 'warning', code: 'login' }] },
    { error: 'unauthorized' },
  ])('does not interpret an unrelated 401 body as native revocation', async body => {
    await expect(verifyNativeStaffRevocation('https://api.medplum.com/', 'synthetic-token', async () => Response.json(body, { status: 401 }))).rejects.toThrow('staff-native-revocation-unconfirmed');
  });
  it('keeps a network failure inconclusive', async () => {
    await expect(verifyNativeStaffRevocation('https://api.medplum.com/', 'synthetic-token', async () => { throw new Error('synthetic network failure'); })).rejects.toThrow('staff-native-revocation-unconfirmed');
  });
  it('keeps an abort caused by timeout inconclusive', async () => {
    await expect(verifyNativeStaffRevocation('https://api.medplum.com/', 'synthetic-token', (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('synthetic abort')), { once: true });
    }), 5)).rejects.toThrow('staff-native-revocation-unconfirmed');
  });
  it('rejects malformed or oversized native error bodies', async () => {
    for (const body of ['{', JSON.stringify({ ...outcome, diagnostic: 'x'.repeat(17000) })]) {
      await expect(verifyNativeStaffRevocation('https://api.medplum.com/', 'synthetic-token', async () => new Response(body, { status: 401, headers: { 'Content-Type': 'application/fhir+json' } }))).rejects.toThrow('staff-native-revocation-unconfirmed');
    }
  });
});

function roster() {
  const specs = [
    { key: 'medical', name: 'Dr. Morgan Lee', role: 'physician' },
    { key: 'dietitian', name: 'Sam Patel, RD', role: 'registered-dietitian' },
    { key: 'administrative', name: 'Taylor Brooks', role: 'administrative' },
    { key: 'unassigned', name: 'Dr. Quinn Parker', role: 'physician' },
  ];
  const config = {
    projectId,
    patients: { 'first-intake': { reference: 'Patient/primary' } },
    staff: specs.map((s, index) => ({ name: s.name, role: s.role, profile: `Practitioner/staff-${index}`, membershipId: `membership-${index}`, policy: `AccessPolicy/policy-${index}`, patients: [`Patient/${index === 3 ? 'unrelated' : 'primary'}`], careTeams: [] })),
  } as unknown as ClinicApiConfig;
  const users = specs.map(s => ({ name: s.name, role: s.role, email: `${s.key}.${projectId.slice(0, 8)}@example.invalid`, password: 'synthetic-test-password-at-least-32-characters' }));
  return { config, users };
}

describe('independent deployment role completeness', () => {
  it('accepts a complete synthetic roster in any order', () => {
    const { config, users } = roster();
    expect(() => assertDeploymentStaffRoster(config, users.reverse())).not.toThrow();
  });
  it('rejects an empty roster or an omitted RD before qualification', () => {
    const { config, users } = roster();
    expect(() => assertDeploymentStaffRoster(config, [])).toThrow();
    expect(() => assertDeploymentStaffRoster(config, users.filter(user => user.role !== 'registered-dietitian'))).toThrow();
  });
  it('rejects duplicated users even when the total length is four', () => {
    const { config, users } = roster(); users[1] = users[0];
    expect(() => assertDeploymentStaffRoster(config, users)).toThrow();
  });
  it('rejects repeated native identities and a mismatched unrelated-patient control', () => {
    for (const field of ['profile', 'membershipId', 'patients'] as const) {
      const { config, users } = roster();
      if (field === 'patients') config.staff[3].patients = config.staff[0].patients;
      else config.staff[3][field] = config.staff[0][field];
      expect(() => assertDeploymentStaffRoster(config, users)).toThrow();
    }
  });
  it('rejects unexpected real-email destinations in the synthetic credential fixture', () => {
    const { config, users } = roster(); users[0].email = 'someone@example.org';
    expect(() => assertDeploymentStaffRoster(config, users)).toThrow();
  });
});

describe('independent qualification fixture reconciliation', () => {
  const medplum = { baseUrl: 'https://api.medplum.com/fhir/R4/', accessToken: 'synthetic-token', mode: 'live' as const, timeoutMs: 1000 };
  it('persists a stable resource intent before dispatch and never replays a lost acknowledgement', async () => {
    const journal: FixtureIntent[] = [], saved: FixtureIntent[][] = [];
    let writes = 0;
    const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') writes++;
      expect(saved[0][0]).toMatchObject({ key: 'qualification-independent.logistics', state: 'intent', identifier: { system: 'urn:corvo:deployment:qualification', value: 'qualification-independent.logistics' } });
      throw new Error('synthetic lost acknowledgement');
    };
    const fixtures = deploymentFixtures(new MedplumClient(medplum, fetcher), fetcher, journal, () => saved.push(structuredClone(journal)));
    const resource = { resourceType: 'Task' as const, status: 'ready', intent: 'order' };
    await expect(fixtures.resource('qualification-independent.logistics', resource)).rejects.toThrow();
    expect(journal[0]).toMatchObject({ state: 'outcome-unknown' });
    expect(journal[0].requestDigest).toMatch(/^[a-f0-9]{64}$/);
    await expect(fixtures.resource('qualification-independent.logistics', resource)).rejects.toThrow('reconcile-without-replay');
    expect(writes).toBe(1);
  });
  it('retains a native reference when resource acknowledgement succeeds but readback is inconsistent', async () => {
    const journal: FixtureIntent[] = [];
    const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
      const resource = { resourceType: 'DocumentReference', id: 'source-1', meta: { versionId: 'version-1' } };
      return Response.json(init?.method === 'POST' ? resource : { ...resource, status: 'entered-in-error' });
    };
    const fixtures = deploymentFixtures(new MedplumClient(medplum, fetcher), fetcher, journal, () => undefined);
    await expect(fixtures.resource('qualification-independent.source', { resourceType: 'DocumentReference', status: 'current' })).rejects.toThrow('fixture-readback-mismatch');
    expect(journal[0]).toMatchObject({ state: 'readback-unconfirmed', reference: 'DocumentReference/source-1', versionId: 'version-1' });
  });
  it('retains the Binary inspection context and blocks replay after an unknown acknowledgement', async () => {
    const journal: FixtureIntent[] = []; let saved = false, writes = 0;
    const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
      expect(saved).toBe(true);
      expect(journal[0]).toMatchObject({ state: 'intent', securityContext: 'DocumentReference/source-1' });
      if (init?.method === 'POST') writes++;
      throw new Error('synthetic lost acknowledgement');
    };
    const fixtures = deploymentFixtures(new MedplumClient(medplum, fetcher), fetcher, journal, () => { saved = true; });
    await expect(fixtures.binary('qualification-independent.binary', 'DocumentReference/source-1', 'Synthetic qualification marker')).rejects.toThrow();
    expect(journal[0]).toMatchObject({ state: 'outcome-unknown' });
    expect(journal[0].reconciliation).toContain('do not replay');
    await expect(fixtures.binary('qualification-independent.binary', 'DocumentReference/source-1', 'Synthetic qualification marker')).rejects.toThrow('reconcile-without-replay');
    expect(writes).toBe(1);
  });
});
