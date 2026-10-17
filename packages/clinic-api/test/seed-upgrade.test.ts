import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The provisioning tool deliberately remains an executable Node ESM module.
// @ts-expect-error Provisioning module has no TypeScript declaration.
import { seedClinic } from '../../../infra/cloud/seed-clinic.mjs';

const projectId = '13eaac67-a2c3-4aa1-aa9e-590a083e5fef';
const clientId = '50db76bd-d099-4305-8ec3-7439ffc38ca1';
const membershipId = '6e565de2-837d-4618-9578-f6428fbb0be1';
const baseUrl = 'http://localhost:8103/';
const origin = 'http://localhost:8103';
const accessToken = 'synthetic-test-token';
const supportedSearch = new Set(['url', 'version', 'name:exact', 'identifier', 'user-name', 'profile-type']);

type Resource = { resourceType: string; id: string; meta: { project: string; versionId: string; lastUpdated: string }; [key: string]: any };
type Call = { method: string; path: string; query: string };

const json = (body: unknown, status = 200) => Response.json(body, { status });
const outcome = (code: string) => ({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code }] });
const bundle = (entries: Resource[]) => ({ resourceType: 'Bundle', type: 'searchset', total: entries.length, entry: entries.map(resource => ({ resource })) });

function matches(resource: Resource, key: string, value: string): boolean {
  switch (key) {
    case 'url':
    case 'version': return resource[key] === value;
    case 'name:exact': return resource.name === value;
    case 'identifier': return (resource.identifier ?? []).some((item: { system: string; value: string }) => `${item.system}|${item.value}` === value);
    case 'user-name': return resource.userName === value;
    case 'profile-type': return resource.profile?.reference?.startsWith(`${value}/`) === true;
    default: return false;
  }
}

/** In-memory synthetic Medplum project covering exactly the surface seedClinic uses. */
class FakeMedplum {
  readonly calls: Call[] = [];
  readonly #resources = new Map<string, Resource>();
  readonly #history = new Map<string, Resource>();
  #versions = 0;
  #clientRestricted = false;

  constructor(admin: boolean) {
    this.#store({ resourceType: 'Project', id: projectId, name: 'Corvo Clinic (synthetic fake)' });
    this.#store({ resourceType: 'ProjectMembership', id: membershipId, project: { reference: `Project/${projectId}` }, profile: { reference: `ClientApplication/${clientId}` }, admin });
  }

  get clientMembership(): Resource { return this.#resources.get(`ProjectMembership/${membershipId}`)!; }

  resourcesOf(type: string): Resource[] { return [...this.#resources.values()].filter(resource => resource.resourceType === type); }

  setAdmin(admin: boolean) { this.#store({ ...this.clientMembership, admin }); this.#clientRestricted = false; }
  /** What the operator does in the Medplum console: tick Admin and clear the custom access policy. */
  grantTemporaryAdmin() { const { accessPolicy: _policy, ...rest } = this.clientMembership; this.#store({ ...rest, admin: true }); this.#clientRestricted = false; }

  /** Simulates a superseded questionnaire version: url+version no longer matches the current definition. */
  supersedeQuestionnaire(version: string) {
    const questionnaires = this.resourcesOf('Questionnaire');
    if (questionnaires.length !== 1) throw new Error('expected exactly one Questionnaire to supersede');
    this.#store({ ...questionnaires[0], version });
  }

  writes(from: number): Call[] { return this.calls.slice(from).filter(call => call.method !== 'GET' && call.path !== '/oauth2/token'); }

  readonly fetcher = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? init.body : undefined;
    this.calls.push({ method, path: url.pathname, query: url.search });
    if (url.pathname === '/oauth2/token') {
      const form = new URLSearchParams(body);
      return method === 'POST' && form.get('grant_type') === 'client_credentials' && form.get('client_id') === clientId
        ? json({ access_token: accessToken })
        : json(outcome('login'), 401);
    }
    if (url.pathname === '/oauth2/logout') return json({});
    if (headers.get('authorization') !== `Bearer ${accessToken}`) return json(outcome('login'), 401);
    if (method === 'GET' && url.pathname === '/auth/me') return json(this.#me());
    if (method === 'POST' && url.pathname === `/admin/projects/${projectId}/invite`) return this.#invite(JSON.parse(body ?? 'null'));
    const member = new RegExp(`^/admin/projects/${projectId}/members/([^/]+)$`).exec(url.pathname);
    if (method === 'POST' && member) return this.#updateMembership(member[1], JSON.parse(body ?? 'null'));
    if (url.pathname.startsWith('/fhir/R4/')) return this.#fhir(method, url, headers, body);
    return json(outcome('not-found'), 404);
  };

  #store(resource: Record<string, any>): Resource {
    const versionId = String(++this.#versions);
    const stored = { ...structuredClone(resource), meta: { project: projectId, versionId, lastUpdated: new Date().toISOString() } } as Resource;
    this.#resources.set(`${stored.resourceType}/${stored.id}`, stored);
    this.#history.set(`${stored.resourceType}/${stored.id}/_history/${versionId}`, structuredClone(stored));
    return stored;
  }

  #query(type: string, params: URLSearchParams): Resource[] | undefined {
    const criteria = [...params].filter(([key]) => key !== '_count');
    if (criteria.some(([key]) => !supportedSearch.has(key))) return undefined;
    return this.resourcesOf(type).filter(resource => criteria.every(([key, value]) => matches(resource, key, value)));
  }

  #me() {
    const membership = this.clientMembership;
    const policy = membership.accessPolicy?.reference as string | undefined;
    return {
      project: { id: projectId },
      profile: { resourceType: 'ClientApplication', id: clientId },
      membership,
      ...(policy ? { accessPolicy: { id: policy.split('/')[1] } } : {}),
    };
  }

  #invite(body: any) {
    if (body?.resourceType !== 'Practitioner' || typeof body.email !== 'string' || !body.membership) return json(outcome('invalid'), 400);
    if (this.resourcesOf('ProjectMembership').some(member => member.userName === body.email)) return json(outcome('conflict'), 409);
    const practitioner = this.#store({ resourceType: 'Practitioner', id: randomUUID(), firstName: body.firstName, lastName: body.lastName, email: body.email });
    const membership = this.#store({
      resourceType: 'ProjectMembership',
      id: randomUUID(),
      project: { reference: `Project/${projectId}` },
      profile: { reference: `Practitioner/${practitioner.id}` },
      userName: body.email,
      admin: body.membership.admin === true,
      ...(body.membership.accessPolicy ? { accessPolicy: body.membership.accessPolicy } : {}),
    });
    return json(membership, 201);
  }

  #updateMembership(id: string, body: any) {
    const existing = this.#resources.get(`ProjectMembership/${id}`);
    if (!existing || !body) return json(outcome('not-found'), 404);
    const updated = this.#store({ ...existing, admin: body.admin === true, ...(body.accessPolicy ? { accessPolicy: body.accessPolicy } : {}) });
    if (id === membershipId) this.#clientRestricted = updated.admin !== true;
    return json(updated);
  }

  #fhir(method: string, url: URL, headers: Headers, body?: string) {
    const parts = url.pathname.slice('/fhir/R4/'.length).split('/').map(part => decodeURIComponent(part));
    if (method === 'GET' && parts.length === 1) {
      const found = this.#query(parts[0], url.searchParams);
      return found ? json(bundle(found)) : json(outcome('not-supported'), 400);
    }
    if (method === 'GET' && parts.length === 2) {
      // Once demoted, the client can no longer read its own authority record.
      if (parts[0] === 'ProjectMembership' && parts[1] === membershipId && this.#clientRestricted) return json(outcome('forbidden'), 403);
      const resource = this.#resources.get(parts.join('/'));
      return resource ? json(resource) : json(outcome('not-found'), 404);
    }
    if (method === 'GET' && parts.length === 4 && parts[2] === '_history') {
      const version = this.#history.get(parts.join('/'));
      return version ? json(version) : json(outcome('not-found'), 404);
    }
    if (method === 'POST' && parts.length === 1) return this.#create(parts[0], headers.get('if-none-exist'), body);
    if (method === 'PUT' && parts.length === 2) return this.#replace(parts.join('/'), headers.get('if-match'), body);
    return json(outcome('not-supported'), 405);
  }

  #create(type: string, ifNoneExist: string | null, body?: string) {
    const resource = JSON.parse(body ?? 'null');
    if (resource?.resourceType !== type) return json(outcome('invalid'), 400);
    if (ifNoneExist) {
      const existing = this.#query(type, new URLSearchParams(ifNoneExist));
      if (!existing) return json(outcome('not-supported'), 400);
      if (existing.length > 1) return json(outcome('ambiguous'), 412);
      if (existing.length === 1) return json(existing[0]);
    }
    return json(this.#store({ ...resource, id: randomUUID() }), 201);
  }

  #replace(key: string, ifMatch: string | null, body?: string) {
    const existing = this.#resources.get(key);
    if (!existing) return json(outcome('not-found'), 404);
    if (ifMatch !== `W/"${existing.meta.versionId}"`) return json(outcome('conflict'), 412);
    const resource = JSON.parse(body ?? 'null');
    if (resource?.resourceType !== existing.resourceType || resource.id !== existing.id) return json(outcome('invalid'), 400);
    return json(this.#store(resource));
  }
}

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function privateDirectory(name: string) {
  const directory = mkdtempSync(join(tmpdir(), `corvo-seed-upgrade-${name}-`));
  chmodSync(directory, 0o700);
  directories.push(directory);
  return directory;
}

function seedOptions(fake: FakeMedplum, directory: string) {
  return { baseUrl, projectId, clientId, clientSecret: 'synthetic-test-secret', origin, privateDirectory: directory, fetcher: fake.fetcher, localQualification: true };
}

function copySecrets(from: string, to: string) {
  const file = 'seed-secrets.json';
  copyFileSync(join(from, file), join(to, file));
  chmodSync(join(to, file), 0o600);
}

const readJson = (directory: string, file: string) => JSON.parse(readFileSync(join(directory, file), 'utf8'));

function snapshot(fake: FakeMedplum) {
  return {
    policies: fake.resourcesOf('AccessPolicy').map(policy => ({ id: policy.id, name: policy.name as string, versionId: policy.meta.versionId })),
    staff: fake.resourcesOf('ProjectMembership').filter(member => member.userName).map(member => ({ id: member.id, userName: member.userName as string, versionId: member.meta.versionId, accessPolicy: member.accessPolicy })),
  };
}

const findByPrefix = <T extends { name: string }>(items: T[], prefix: string): T => {
  const found = items.filter(item => item.name.startsWith(prefix));
  if (found.length !== 1) throw new Error(`expected one policy starting with ${prefix}`);
  return found[0];
};

/** Completes a fresh seed, supersedes the stored questionnaire version, and re-promotes the client for the upgrade run. */
async function completeThenSupersede(fake: FakeMedplum) {
  const first = privateDirectory('first');
  await expect(seedClinic(seedOptions(fake, first))).resolves.toMatchObject({ status: 'seed-complete-awaiting-qualification', cleanup: 'demotion-verified' });
  const firstConfig = readJson(first, 'clinic-config.json');
  fake.supersedeQuestionnaire(`${firstConfig.nativeQuestionnaire.version}-superseded`);
  return { first, firstConfig };
}

describe('seed upgrade across a questionnaire version change', () => {
  it('updates policies in place, keeps staff, and demotes after a new questionnaire is created', async () => {
    const fake = new FakeMedplum(true);
    const { first, firstConfig } = await completeThenSupersede(fake);
    const oldQuestionnaire = fake.resourcesOf('Questionnaire')[0];
    const before = snapshot(fake);
    expect(before.policies).toHaveLength(4);
    expect(before.staff).toHaveLength(4);

    fake.grantTemporaryAdmin();
    const second = privateDirectory('upgrade');
    copySecrets(first, second);
    const callsBefore = fake.calls.length;
    await expect(seedClinic(seedOptions(fake, second))).resolves.toMatchObject({ status: 'seed-complete-awaiting-qualification', cleanup: 'demotion-verified', staff: 4, patients: 2 });
    const upgrade = fake.calls.slice(callsBefore);

    // A second Questionnaire exists, carrying the current definition version.
    const questionnaires = fake.resourcesOf('Questionnaire');
    expect(questionnaires).toHaveLength(2);
    const newQuestionnaire = questionnaires.find(item => item.id !== oldQuestionnaire.id)!;
    expect(newQuestionnaire.version).toBe(firstConfig.nativeQuestionnaire.version);

    // Policies are updated in place: same ids, higher versions, rules point at the new Questionnaire.
    const after = snapshot(fake);
    expect(after.policies).toHaveLength(4);
    for (const prefix of ['Corvo demo runtime', 'Corvo demo assigned clinical', 'Corvo demo unrelated patient']) {
      const prior = findByPrefix(before.policies, prefix);
      const policy = findByPrefix(after.policies, prefix);
      expect(policy.id).toBe(prior.id);
      expect(Number(policy.versionId)).toBeGreaterThan(Number(prior.versionId));
      const resource = fake.resourcesOf('AccessPolicy').find(item => item.id === policy.id)!.resource as Array<Record<string, unknown>>;
      expect(resource).toContainEqual(expect.objectContaining({ resourceType: 'Questionnaire', criteria: `Questionnaire?_id=${newQuestionnaire.id}` }));
      expect(JSON.stringify(resource)).not.toContain(oldQuestionnaire.id);
    }
    // Administrative rules never referenced the questionnaire, so the policy is left untouched.
    expect(findByPrefix(after.policies, 'Corvo demo administrative')).toEqual(findByPrefix(before.policies, 'Corvo demo administrative'));

    // Staff memberships are untouched: no invites, same ids, versions and policy references.
    expect(upgrade.some(call => call.path === `/admin/projects/${projectId}/invite`)).toBe(false);
    expect(after.staff).toEqual(before.staff);

    // Exactly the three questionnaire-dependent policies are PUT, and only one Questionnaire is POSTed.
    const runtime = findByPrefix(after.policies, 'Corvo demo runtime');
    const clinical = findByPrefix(after.policies, 'Corvo demo assigned clinical');
    const unassigned = findByPrefix(after.policies, 'Corvo demo unrelated patient');
    expect(upgrade.filter(call => call.method === 'PUT').map(call => call.path).sort())
      .toEqual([runtime, clinical, unassigned].map(policy => `/fhir/R4/AccessPolicy/${policy.id}`).sort());
    expect(upgrade.filter(call => call.method === 'POST' && call.path === '/fhir/R4/AccessPolicy')).toEqual([]);
    expect(upgrade.filter(call => call.method === 'POST' && call.path === '/fhir/R4/Questionnaire')).toHaveLength(1);

    // The client ends demoted to the runtime policy.
    expect(fake.clientMembership.admin).toBe(false);
    expect(fake.clientMembership.accessPolicy).toEqual({ reference: `AccessPolicy/${runtime.id}` });

    const journal = readJson(second, 'seed-journal.json');
    expect(journal).toMatchObject({ state: 'complete', cleanup: 'demotion-verified' });
    for (const key of ['policy-runtime-rules', 'policy-clinical-rules', 'policy-unassigned-rules']) {
      expect(journal.operations[key]).toMatchObject({ state: 'confirmed' });
    }
    expect(journal.operations['policy-administrative-rules']).toBeUndefined();
    expect(journal.operations['questionnaire-native']).toMatchObject({ state: 'confirmed', reference: `Questionnaire/${newQuestionnaire.id}` });

    const config = readJson(second, 'clinic-config.json');
    expect(config.nativeQuestionnaire.reference).toBe(`Questionnaire/${newQuestionnaire.id}/_history/${newQuestionnaire.meta.versionId}`);
    expect(config.nativeQuestionnaire.reference).not.toBe(firstConfig.nativeQuestionnaire.reference);
  });

  it('returns already-complete without any network call when the upgraded directory is re-run', async () => {
    const fake = new FakeMedplum(true);
    const { first } = await completeThenSupersede(fake);
    fake.grantTemporaryAdmin();
    const second = privateDirectory('upgrade');
    copySecrets(first, second);
    await seedClinic(seedOptions(fake, second));

    const before = fake.calls.length;
    await expect(seedClinic(seedOptions(fake, second))).resolves.toMatchObject({ status: 'already-complete', projectId });
    expect(fake.calls.length).toBe(before);
    expect(fake.writes(before)).toEqual([]);
  });

  it('fails closed without writes when the upgrade run lacks temporary project admin', async () => {
    const fake = new FakeMedplum(true);
    const { first } = await completeThenSupersede(fake);
    fake.setAdmin(false);
    const second = privateDirectory('upgrade');
    copySecrets(first, second);

    const before = fake.calls.length;
    await expect(seedClinic(seedOptions(fake, second))).rejects.toThrow('temporary-project-admin-required');
    expect(fake.writes(before)).toEqual([]);
    expect(fake.calls.slice(before).map(call => call.path)).toEqual(['/oauth2/token', '/auth/me', `/fhir/R4/ProjectMembership/${membershipId}`]);
    expect(fake.resourcesOf('Questionnaire')).toHaveLength(1);
    expect(readJson(second, 'seed-journal.json').state).toBe('incomplete');
  });
});

describe('temporary admin precondition', () => {
  it('refuses to write when admin is granted but the custom access policy is still attached', async () => {
    const fake = new FakeMedplum(true);
    const { first } = await completeThenSupersede(fake);
    fake.setAdmin(true);
    const second = privateDirectory('policy-left');
    copySecrets(first, second);
    const callsBefore = fake.calls.length;
    await expect(seedClinic(seedOptions(fake, second))).rejects.toThrow('temporary-admin-access-policy-must-be-cleared');
    const writes = fake.calls.slice(callsBefore).filter(call => ['POST', 'PUT'].includes(call.method) && !/oauth2|admin\/projects/.test(call.path));
    expect(writes).toEqual([]);
    // The admin it was given is still taken back, with the existing policy kept.
    expect(fake.clientMembership.admin).toBe(false);
    expect(fake.clientMembership.accessPolicy).toBeDefined();
  });
});
