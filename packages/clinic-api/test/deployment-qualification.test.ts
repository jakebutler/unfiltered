import { describe, expect, it, vi } from 'vitest';
import { getNativeQuestionnaireDefinition } from '../../clinic-content/src/native-questionnaire.js';
import { canonicalJson, digest } from '../../clinical-core/src/domain.js';
import type { MedplumConfig } from '../../clinical-core/src/medplum.js';
import { conditionalChecks, type ConditionalQualificationReport } from '../../clinical-core/src/qualification.js';
import { sealDeploymentQualification, verifyDeploymentQualification, observeRuntimeIdentity, authMeProjectFeatureObservation, serverProjectsProjectFeatures, applicationChecks, type ApplicationQualification, type DeploymentQualification, type DeploymentQualificationPayloadV2, type QualifiedClinicConfig } from '../src/deployment-qualification.js';
import { runtimeProvider } from '../src/runtime.js';
import type { ClinicApiConfig } from '../src/types.js';
const config = { origin: 'https://clinic.example', medplumBaseUrl: 'https://api.medplum.com/', projectId: 'project-1', clientId: 'client-1', clientSecret: 'private-runtime-secret', cookieSecret: 'test-cookie-key-at-least-32-characters-long', patients: {}, staff: [], mentalHealth: 'phq4' } as ClinicApiConfig;
const medplum: MedplumConfig = { baseUrl: 'https://api.medplum.com/fhir/R4/', accessToken: 'qualification-token', mode: 'live', timeoutMs: 1000 };
const app = (): ApplicationQualification => ({ ...Object.fromEntries(applicationChecks.map(check => [check, true])), namedPolicyDigests: {}, evidenceDigest: 'e'.repeat(64) } as ApplicationQualification);
async function report(): Promise<ConditionalQualificationReport> {
  return { schema: 2, deliveryContract: 'conditional-resumable-v1', mode: 'live', runId: 'proof-1', endpoint: medplum.baseUrl, delivery: 'qualified-for-tested-credentials', handoff: 'received', authorization: 'not-qualified', providerInference: 'not-called', retainedSyntheticIdentifiers: ['fixture-1'], checks: Object.fromEntries(conditionalChecks.map(check => [check, true])) as ConditionalQualificationReport['checks'], qualification: { deliveryContract: 'conditional-resumable-v1', baseUrl: medplum.baseUrl, mode: medplum.mode, credentialFingerprint: await digest(medplum.accessToken), qualifiedAt: new Date().toISOString(), conditionalCreate: true, conditionalConcurrency: true, versionConflict: true, versionHistory: true } };
}
function fixture(questionnaire?: Record<string, unknown>) {
  const state = { token: 0, project: 'project-1', profile: 'client-1', membership: 'member-1', version: '5.2.4-build', admin: false, features: undefined as string[] | undefined, strictMode: true as boolean | undefined, checkReferencesOnWrite: undefined as boolean | undefined, name: 'Corvo Clinic', description: 'Synthetic demo', policy: [{ resourceType: 'Patient', interaction: ['read', 'create', 'update'] }] as unknown[] };
  const calls: { path: string; method: string }[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname; calls.push({ path, method: init?.method ?? 'GET' });
    if (path === '/oauth2/token') return Response.json({ access_token: `refreshed-token-${++state.token}`, expires_in: 3600 });
    if (path === '/auth/me') return Response.json({ project: { id: state.project, name: state.name, description: state.description, strictMode: state.strictMode, checkReferencesOnWrite: state.checkReferencesOnWrite, ...(state.features ? { features: state.features } : {}) }, profile: { resourceType: 'ClientApplication', id: state.profile }, membership: { id: state.membership, profile: { reference: `ClientApplication/${state.profile}` }, admin: state.admin }, accessPolicy: { resourceType: 'AccessPolicy', id: crypto.randomUUID(), resource: state.policy, basedOn: [{ reference: 'AccessPolicy/runtime-policy-1' }] } });
    if (path === '/fhir/R4/Questionnaire/native/_history/v2' && questionnaire) return Response.json({ ...questionnaire, id: 'native', meta: { versionId: 'v2' } });
    if (path === '/fhir/R4/metadata') return Response.json({ resourceType: 'CapabilityStatement', software: { version: state.version } });
    throw new Error('unexpected-write-or-read');
  });
  return { state, calls, fetcher };
}
describe('deployment storage attestation', () => {
  it('rebinds a completed proof to a refreshed token after read-only identity checks', async () => {
    const f = fixture();
    const proof = await sealDeploymentQualification(config, medplum, await report(), f.fetcher, app());
    const current = { ...medplum, accessToken: 'new-token' };
    const rebound = await verifyDeploymentQualification(config, current, proof, f.fetcher);
    expect(rebound.credentialFingerprint).toBe(await digest('new-token'));
    expect(rebound.qualifiedAt).toBe(proof.payload.qualifiedAt);
    expect(f.calls.every(call => call.method === 'GET')).toBe(true);
    expect(JSON.stringify(proof)).not.toContain('qualification-token');
  });
  it.each(['project', 'profile', 'membership', 'version'] as const)('rejects %s drift', async field => {
    const f = fixture(); const proof = await sealDeploymentQualification(config, medplum, await report(), f.fetcher, app());
    f.state[field] = 'changed';
    await expect(verifyDeploymentQualification(config, medplum, proof, f.fetcher)).rejects.toMatchObject({ code: 'storage-deployment-qualification-invalid' });
  });
  it('rejects effective policy changes and runtime admin elevation', async () => {
    const f = fixture(); const proof = await sealDeploymentQualification(config, medplum, await report(), f.fetcher, app());
    f.state.policy.push({ resourceType: '*' });
    await expect(verifyDeploymentQualification(config, medplum, proof, f.fetcher)).rejects.toThrow();
    f.state.policy.pop(); f.state.admin = true;
    await expect(verifyDeploymentQualification(config, medplum, proof, f.fetcher)).rejects.toThrow();
  });
  it('rejects tampering, wrong deployment key, origin and endpoint before network', async () => {
    const f = fixture(); const proof = await sealDeploymentQualification(config, medplum, await report(), f.fetcher, app());
    const before = f.calls.length;
    const edited = structuredClone(proof); edited.payload.identity.projectId = 'changed';
    await expect(verifyDeploymentQualification(config, medplum, edited, f.fetcher)).rejects.toThrow();
    await expect(verifyDeploymentQualification({ ...config, cookieSecret: 'changed-secret-with-at-least-32-characters' }, medplum, proof, f.fetcher)).rejects.toThrow();
    await expect(verifyDeploymentQualification({ ...config, origin: 'https://other.example' }, medplum, proof, f.fetcher)).rejects.toThrow();
    await expect(verifyDeploymentQualification(config, { ...medplum, baseUrl: 'https://other.example/fhir/R4/' }, proof, f.fetcher)).rejects.toThrow();
    expect(f.calls.length).toBe(before);
  });
  it('rejects expired, old, partial and simulated deployment evidence', async () => {
    const f = fixture(); const r = await report();
    await expect(sealDeploymentQualification(config, medplum, { ...r, handoff: 'not-qualified' }, f.fetcher, app())).rejects.toThrow();
    await expect(sealDeploymentQualification(config, medplum, { ...r, delivery: 'mock-pass' }, f.fetcher, app())).rejects.toThrow();
    await expect(sealDeploymentQualification(config, medplum, { ...r, checks: { ...r.checks, payloadConflict: false } }, f.fetcher, app())).rejects.toThrow();
    await expect(sealDeploymentQualification(config, medplum, { ...r, qualification: { ...r.qualification!, qualifiedAt: '2000-01-01T00:00:00Z' } }, f.fetcher, app())).rejects.toThrow();
    await expect(sealDeploymentQualification(config, medplum, r, f.fetcher, app(), 7 * 86400000 + 1)).rejects.toThrow();
    const proof = await sealDeploymentQualification(config, medplum, r, f.fetcher, app(), 1000);
    vi.useFakeTimers(); vi.advanceTimersByTime(1001);
    try { await expect(verifyDeploymentQualification(config, medplum, proof, f.fetcher)).rejects.toThrow(); } finally { vi.useRealTimers(); }
  });
  it('rejects atomic schema and unqualified Questionnaire/application evidence before network', async () => { const f = fixture(), r = await report(); await expect(sealDeploymentQualification(config, medplum, { ...r, schema: 1 } as never, f.fetcher, app())).rejects.toThrow(); await expect(sealDeploymentQualification(config, medplum, r, f.fetcher, { ...app(), nativeQuestionnaireMapping: false } as never)).rejects.toThrow(); expect(f.calls).toHaveLength(0); });
  it('cold starts and token refresh do not run qualification FHIR writes', async () => {
    const definition = await getNativeQuestionnaireDefinition(), bound = { ...config, nativeQuestionnaire: { ...definition.binding, reference: 'Questionnaire/native/_history/v2' } };
    const f = fixture(definition.questionnaire); const proof = await sealDeploymentQualification(bound, medplum, await report(), f.fetcher, app());
    const c: QualifiedClinicConfig = { ...bound, storageQualification: proof };
    const before = f.calls.length;
    await expect(verifyDeploymentQualification({ ...bound, nativeQuestionnaire: { ...bound.nativeQuestionnaire, digest: '0'.repeat(64) } }, medplum, proof, f.fetcher)).rejects.toThrow();
    expect(f.calls).toHaveLength(before);
    const first = runtimeProvider(c, f.fetcher), restarted = runtimeProvider(c, f.fetcher);
    const a = await first(); const cached = await first(); const b = await restarted();
    expect(cached).toBe(a); expect(b.client.config.accessToken).not.toBe(a.client.config.accessToken);
    vi.useFakeTimers(); vi.advanceTimersByTime(300001);
    try { expect((await first()).client.config.accessToken).not.toBe(a.client.config.accessToken); } finally { vi.useRealTimers(); }
    expect(f.calls.filter(call => call.path === '/fhir/R4/Questionnaire/native/_history/v2')).toHaveLength(3);
    expect(f.calls.filter(call => call.method !== 'GET').map(call => call.path)).toEqual(['/oauth2/token', '/oauth2/token', '/oauth2/token']);
  });
  it('missing cloud proof stops before authentication or FHIR writes', async () => {
    const f = fixture();
    await expect(runtimeProvider(config, f.fetcher)()).rejects.toMatchObject({ code: 'storage-deployment-qualification-required' });
    expect(f.calls).toHaveLength(0);
  });
});

/** Reproduces the schema-2 attestation exactly as the pre-schema-3 sealer wrote it (admin Project file, same HMAC domain). */
async function bound() { const definition = await getNativeQuestionnaireDefinition(); return { definition, config: { ...config, nativeQuestionnaire: { ...definition.binding, reference: 'Questionnaire/native/_history/v2' } } as ClinicApiConfig }; }
async function sealSchema2(f: ReturnType<typeof fixture>, overrides: Partial<DeploymentQualificationPayloadV2> = {}, cfg: ClinicApiConfig = config): Promise<DeploymentQualification> {
  const r = await report(), now = Date.now();
  const payload: DeploymentQualificationPayloadV2 = {
    schema: 2, purpose: 'synthetic-clinic-conditional-resumable', deliveryContract: 'conditional-resumable-v1', identity: await observeRuntimeIdentity(cfg, medplum, f.fetcher), mode: 'live', origin: cfg.origin,
    qualifiedAt: r.qualification!.qualifiedAt, expiresAt: new Date(now + 3600000).toISOString(), proofDigest: await digest(r), checks: Object.fromEntries(conditionalChecks.map(check => [check, true])) as DeploymentQualificationPayloadV2['checks'],
    projectFeature: { projectId: 'project-1', projectVersion: 'project-version-3', features: [], observedAt: new Date(now).toISOString() }, applicationChecks: Object.fromEntries(applicationChecks.map(check => [check, true])) as DeploymentQualificationPayloadV2['applicationChecks'],
    namedPolicyDigests: {}, staffRosterDigest: await digest(cfg.staff), applicationEvidenceDigest: 'e'.repeat(64), ...(cfg.nativeQuestionnaire ? { nativeQuestionnaire: structuredClone(cfg.nativeQuestionnaire) } : {}), featureDriftContract: 'admin-change-requires-requalification-not-runtime-observed', ...overrides,
  };
  return signProof({ payload, signature: '' }, cfg);
}

async function signProof<T extends DeploymentQualification>(proof: T, cfg: ClinicApiConfig = config): Promise<T> {
  const hmac = await crypto.subtle.importKey('raw', new TextEncoder().encode(`corvo-storage-qualification:conditional-v2:${cfg.cookieSecret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  proof.signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(canonicalJson(proof.payload))))].map(value => value.toString(16).padStart(2, '0')).join('');
  return proof;
}

describe('schema-3 /auth/me Project projection', () => {
  it('seals inline from the runtime /auth/me (no admin read) and round-trips', async () => {
    const f = fixture(); f.state.features = ['websocket-subscriptions', 'bots'];
    const proof = await sealDeploymentQualification(config, medplum, await report(), f.fetcher, app());
    expect(proof.payload.schema).toBe(3);
    expect(proof.payload.featureDriftContract).toBe('runtime-observed-auth-me-projection');
    expect(proof.payload.projectFeature).toMatchObject({ source: 'auth-me', projectId: 'project-1', features: ['bots', 'websocket-subscriptions'] });
    expect(proof.payload.projectFeature.projectionDigest).toBe(await digest({ id: 'project-1', name: 'Corvo Clinic', features: ['bots', 'websocket-subscriptions'], strictMode: true }));
    expect(proof.payload.identity.projectionDigest).toBe(proof.payload.projectFeature.projectionDigest);
    expect(proof.payload.projectFeature.projectVersion).toBe(`projection-sha256:${proof.payload.projectFeature.projectionDigest}`);
    expect(f.calls.map(call => call.path)).not.toContain('/fhir/R4/Project/project-1');
    expect(f.calls.every(call => call.method === 'GET')).toBe(true);
    await expect(verifyDeploymentQualification(config, { ...medplum, accessToken: 'refreshed' }, proof, f.fetcher)).resolves.toMatchObject({ qualifiedAt: proof.payload.qualifiedAt });
    // Feature order is not drift; description is outside the projection digest.
    f.state.features = ['bots', 'websocket-subscriptions']; f.state.description = 'edited description';
    await expect(verifyDeploymentQualification(config, medplum, proof, f.fetcher)).resolves.toBeDefined();
  });
  it('treats an absent features key as [] on a >= 5.1.4 server', async () => {
    const f = fixture(); const proof = await sealDeploymentQualification(config, medplum, await report(), f.fetcher, app());
    expect(proof.payload.projectFeature.features).toEqual([]);
    await expect(verifyDeploymentQualification(config, medplum, proof, f.fetcher)).resolves.toBeDefined();
  });
  it('hashes only present approved projection fields and defaults null features to []', async () => {
    const observed = await authMeProjectFeatureObservation({ id: 'project-1', features: null, description: 'excluded', superAdmin: false }, '5.2.0', 'project-1');
    expect(observed.features).toEqual([]);
    expect(observed.projectionDigest).toBe(await digest({ id: 'project-1', features: [] }));
    const checked = await authMeProjectFeatureObservation({ id: 'project-1', name: 'Clinic', strictMode: false, checkReferencesOnWrite: false }, '5.2.0', 'project-1');
    expect(checked.projectionDigest).toBe(await digest({ id: 'project-1', name: 'Clinic', features: [], strictMode: false, checkReferencesOnWrite: false }));
    await expect(authMeProjectFeatureObservation({ id: 'project-1', checkReferencesOnWrite: 'false' }, '5.2.0', 'project-1')).rejects.toThrow();
  });
  it('rejects observations older than fifteen minutes without expiring a valid seven-day proof', async () => {
    await expect(authMeProjectFeatureObservation({ id: 'project-1' }, '5.2.0', 'project-1', new Date(Date.now() - 900001).toISOString())).rejects.toThrow();
    const f = fixture(), proof = await sealDeploymentQualification(config, medplum, await report(), f.fetcher, app());
    const stale = structuredClone(proof);
    stale.payload.projectFeature.observedAt = new Date(Date.parse(stale.payload.qualifiedAt) - 900001).toISOString();
    await signProof(stale);
    const before = f.calls.length;
    await expect(verifyDeploymentQualification(config, medplum, stale, f.fetcher)).rejects.toMatchObject({ code: 'storage-deployment-qualification-invalid' });
    expect(f.calls).toHaveLength(before);
    vi.useFakeTimers(); vi.advanceTimersByTime(900001);
    try { await expect(verifyDeploymentQualification(config, medplum, proof, f.fetcher)).resolves.toBeDefined(); } finally { vi.useRealTimers(); }
  });
  it('rejects an admin membership before sealing any proof', async () => {
    const f = fixture(); f.state.admin = true;
    await expect(sealDeploymentQualification(config, medplum, await report(), f.fetcher, app())).rejects.toMatchObject({ code: 'storage-deployment-qualification-invalid' });
    expect(f.calls).toEqual([{ path: '/auth/me', method: 'GET' }]);
  });
  it.each([
    ['feature added', (s: ReturnType<typeof fixture>['state']) => { s.features = ['transaction-bundles']; }],
    ['feature removed', (s: ReturnType<typeof fixture>['state']) => { s.features = undefined; }, ['transaction-bundles']],
    ['strictMode changed', (s: ReturnType<typeof fixture>['state']) => { s.strictMode = false; }],
    ['strictMode removed', (s: ReturnType<typeof fixture>['state']) => { s.strictMode = undefined; }],
    ['reference checks enabled', (s: ReturnType<typeof fixture>['state']) => { s.checkReferencesOnWrite = true; }],
    ['project renamed', (s: ReturnType<typeof fixture>['state']) => { s.name = 'Other'; }],
  ] as const)('fails closed on runtime projection drift: %s', async (_name, drift, initial?: readonly string[]) => {
    const f = fixture(); if (initial) f.state.features = [...initial];
    const proof = await sealDeploymentQualification(config, medplum, await report(), f.fetcher, app());
    await expect(verifyDeploymentQualification(config, medplum, proof, f.fetcher)).resolves.toBeDefined();
    drift(f.state);
    await expect(verifyDeploymentQualification(config, medplum, proof, f.fetcher)).rejects.toMatchObject({ code: 'project-projection-drift' });
  });
  it('drift is caught by the runtime refresh path, not only direct verification', async () => {
    const { definition, config: cfg } = await bound();
    const f = fixture(definition.questionnaire); const proof = await sealDeploymentQualification(cfg, medplum, await report(), f.fetcher, app());
    const runtime = runtimeProvider({ ...cfg, storageQualification: proof }, f.fetcher);
    await expect(runtime()).resolves.toBeDefined();
    f.state.strictMode = false;
    vi.useFakeTimers(); vi.advanceTimersByTime(300001);
    try { await expect(runtime()).rejects.toMatchObject({ code: 'project-projection-drift' }); } finally { vi.useRealTimers(); }
  });
  it.each(['5.1.3', '4.9.0-abc', 'unknown', ''])('fails closed when server %s may not project features', async version => {
    expect(serverProjectsProjectFeatures(version)).toBe(false);
    const f = fixture(); f.state.version = version;
    await expect(sealDeploymentQualification(config, medplum, await report(), f.fetcher, app())).rejects.toMatchObject({ code: 'storage-deployment-qualification-invalid' });
  });
  it('accepts exactly the projection minimum and later releases', async () => {
    for (const version of ['5.1.4', '5.1.4-0a1b2c', '5.2.0', '6.0.0+build']) expect(serverProjectsProjectFeatures(version)).toBe(true);
    await expect(authMeProjectFeatureObservation({ id: 'project-1' }, '5.1.3', 'project-1')).rejects.toThrow();
    await expect(authMeProjectFeatureObservation({ id: 'project-1', features: 'bots' }, '5.2.0', 'project-1')).rejects.toThrow();
    await expect(authMeProjectFeatureObservation({ id: 'project-1', superAdmin: true }, '5.2.0', 'project-1')).rejects.toThrow();
  });
  it('a server downgrade below the projection minimum fails a sealed v3 proof', async () => {
    const f = fixture(); const proof = await sealDeploymentQualification(config, medplum, await report(), f.fetcher, app());
    f.state.version = '5.1.3';
    await expect(verifyDeploymentQualification(config, medplum, proof, f.fetcher)).rejects.toThrow();
  });
  it('never seals or accepts an administrative or wildcard runtime policy rule', async () => {
    const f = fixture(); f.state.policy.push({ resourceType: 'AccessPolicy', interaction: ['read'] });
    await expect(sealDeploymentQualification(config, medplum, await report(), f.fetcher, app())).rejects.toThrow();
    f.state.policy.pop(); f.state.policy.push({ resourceType: '*' });
    await expect(sealDeploymentQualification(config, medplum, await report(), f.fetcher, app())).rejects.toThrow();
  });
  it.each(['projectVersion', 'identityDigest'] as const)('rejects signed inconsistent %s before network', async field => {
    const f = fixture(), proof = await sealDeploymentQualification(config, medplum, await report(), f.fetcher, app());
    if (field === 'projectVersion') proof.payload.projectFeature.projectVersion = `projection-sha256:${'0'.repeat(64)}`;
    else proof.payload.identity.projectionDigest = '0'.repeat(64);
    await signProof(proof);
    const before = f.calls.length;
    await expect(verifyDeploymentQualification(config, medplum, proof, f.fetcher)).rejects.toMatchObject({ code: 'storage-deployment-qualification-invalid' });
    expect(f.calls).toHaveLength(before);
  });
  it('rejects a signed v3 proof with the wrong drift contract before network', async () => {
    const f = fixture(); const proof = await sealDeploymentQualification(config, medplum, await report(), f.fetcher, app());
    const edited = structuredClone(proof); edited.payload.featureDriftContract = 'admin-change-requires-requalification-not-runtime-observed' as never;
    await signProof(edited);
    const before = f.calls.length;
    await expect(verifyDeploymentQualification(config, medplum, edited, f.fetcher)).rejects.toThrow();
    expect(f.calls).toHaveLength(before);
  });
});

describe('schema-2 backward compatibility (deployed admin-observed attestation)', () => {
  it('still verifies unchanged, with no projection requirement or drift check', async () => {
    const f = fixture(); const proof = await sealSchema2(f);
    expect(proof.payload.identity).not.toHaveProperty('projectionDigest');
    await expect(verifyDeploymentQualification(config, { ...medplum, accessToken: 'refreshed' }, proof, f.fetcher)).resolves.toMatchObject({ qualifiedAt: proof.payload.qualifiedAt });
    // v2 never observed the projection at runtime: feature/strictMode changes and an old server do not affect it.
    f.state.features = ['transaction-bundles']; f.state.strictMode = false; f.state.policy.push({ resourceType: 'Observation', interaction: ['read'] }); f.state.policy.pop();
    await expect(verifyDeploymentQualification(config, medplum, proof, f.fetcher)).resolves.toBeDefined();
    const old = fixture(); old.state.version = '5.0.0'; const oldProof = await sealSchema2(old);
    await expect(verifyDeploymentQualification(config, medplum, oldProof, old.fetcher)).resolves.toBeDefined();
    const { definition, config: cfg } = await bound(), g = fixture(definition.questionnaire);
    await expect(runtimeProvider({ ...cfg, storageQualification: await sealSchema2(g, {}, cfg) }, g.fetcher)()).resolves.toBeDefined();
  });
  it('keeps every schema-2 identity, contract and expiry check', async () => {
    const f = fixture(); const proof = await sealSchema2(f);
    f.state.membership = 'changed';
    await expect(verifyDeploymentQualification(config, medplum, proof, f.fetcher)).rejects.toThrow();
    f.state.membership = 'member-1';
    await expect(verifyDeploymentQualification(config, medplum, await sealSchema2(f, { featureDriftContract: 'runtime-observed-auth-me-projection' as never }), f.fetcher)).rejects.toThrow();
    await expect(verifyDeploymentQualification(config, medplum, await sealSchema2(f, { projectFeature: { projectId: 'project-1', projectVersion: '', features: [], observedAt: new Date().toISOString() } }), f.fetcher)).rejects.toThrow();
    const expiring = await sealSchema2(f, { expiresAt: new Date(Date.now() + 1000).toISOString() });
    vi.useFakeTimers(); vi.advanceTimersByTime(1001);
    try { await expect(verifyDeploymentQualification(config, medplum, expiring, f.fetcher)).rejects.toThrow(); } finally { vi.useRealTimers(); }
  });
  it('a v2 payload relabelled as v3 fails signature verification before network', async () => {
    const f = fixture(); const proof = await sealSchema2(f); const before = f.calls.length;
    const relabelled = structuredClone(proof) as unknown as { payload: { schema: number } }; relabelled.payload.schema = 3;
    await expect(verifyDeploymentQualification(config, medplum, relabelled as never, f.fetcher)).rejects.toThrow();
    expect(f.calls.length).toBe(before);
  });
});

