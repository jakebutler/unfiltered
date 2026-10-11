import { describe, expect, it, vi } from 'vitest';
import { getNativeQuestionnaireDefinition } from '../../clinic-content/src/native-questionnaire.js';
import { digest } from '../../clinical-core/src/domain.js';
import type { MedplumConfig } from '../../clinical-core/src/medplum.js';
import { conditionalChecks, type ConditionalQualificationReport } from '../../clinical-core/src/qualification.js';
import { sealDeploymentQualification, verifyDeploymentQualification, applicationChecks, type ApplicationQualification, type QualifiedClinicConfig } from '../src/deployment-qualification.js';
import { runtimeProvider } from '../src/runtime.js';
import type { ClinicApiConfig } from '../src/types.js';
const config = { origin: 'https://clinic.example', medplumBaseUrl: 'https://api.medplum.com/', projectId: 'project-1', clientId: 'client-1', clientSecret: 'private-runtime-secret', cookieSecret: 'test-cookie-key-at-least-32-characters-long', patients: {}, staff: [], mentalHealth: 'phq4' } as ClinicApiConfig;
const medplum: MedplumConfig = { baseUrl: 'https://api.medplum.com/fhir/R4/', accessToken: 'qualification-token', mode: 'live', timeoutMs: 1000 };
const feature = () => ({ projectId: 'project-1', projectVersion: 'project-version-3', features: [], observedAt: new Date().toISOString() });
const app = (): ApplicationQualification => ({ ...Object.fromEntries(applicationChecks.map(check => [check, true])), namedPolicyDigests: {}, evidenceDigest: 'e'.repeat(64) } as ApplicationQualification);
async function report(): Promise<ConditionalQualificationReport> {
  return { schema: 2, deliveryContract: 'conditional-resumable-v1', mode: 'live', runId: 'proof-1', endpoint: medplum.baseUrl, delivery: 'qualified-for-tested-credentials', handoff: 'received', authorization: 'not-qualified', providerInference: 'not-called', retainedSyntheticIdentifiers: ['fixture-1'], checks: Object.fromEntries(conditionalChecks.map(check => [check, true])) as ConditionalQualificationReport['checks'], qualification: { deliveryContract: 'conditional-resumable-v1', baseUrl: medplum.baseUrl, mode: medplum.mode, credentialFingerprint: await digest(medplum.accessToken), qualifiedAt: new Date().toISOString(), conditionalCreate: true, conditionalConcurrency: true, versionConflict: true, versionHistory: true } };
}
function fixture(questionnaire?: Record<string, unknown>) {
  const state = { token: 0, project: 'project-1', profile: 'client-1', membership: 'member-1', version: '5.2.4-build', admin: false, policy: [{ resourceType: 'Patient', interaction: ['read', 'create', 'update'] }] as unknown[] };
  const calls: { path: string; method: string }[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname; calls.push({ path, method: init?.method ?? 'GET' });
    if (path === '/oauth2/token') return Response.json({ access_token: `refreshed-token-${++state.token}`, expires_in: 3600 });
    if (path === '/auth/me') return Response.json({ project: { id: state.project }, profile: { resourceType: 'ClientApplication', id: state.profile }, membership: { id: state.membership, profile: { reference: `ClientApplication/${state.profile}` }, admin: state.admin }, accessPolicy: { resourceType: 'AccessPolicy', id: crypto.randomUUID(), resource: state.policy, basedOn: [{ reference: 'AccessPolicy/runtime-policy-1' }] } });
    if (path === '/fhir/R4/Questionnaire/native/_history/v2' && questionnaire) return Response.json({ ...questionnaire, id: 'native', meta: { versionId: 'v2' } });
    if (path === '/fhir/R4/metadata') return Response.json({ resourceType: 'CapabilityStatement', software: { version: state.version } });
    throw new Error('unexpected-write-or-read');
  });
  return { state, calls, fetcher };
}
describe('deployment storage attestation', () => {
  it('rebinds a completed proof to a refreshed token after read-only identity checks', async () => {
    const f = fixture();
    const proof = await sealDeploymentQualification(config, medplum, await report(), feature(), f.fetcher, app());
    const current = { ...medplum, accessToken: 'new-token' };
    const rebound = await verifyDeploymentQualification(config, current, proof, f.fetcher);
    expect(rebound.credentialFingerprint).toBe(await digest('new-token'));
    expect(rebound.qualifiedAt).toBe(proof.payload.qualifiedAt);
    expect(f.calls.every(call => call.method === 'GET')).toBe(true);
    expect(JSON.stringify(proof)).not.toContain('qualification-token');
  });
  it.each(['project', 'profile', 'membership', 'version'] as const)('rejects %s drift', async field => {
    const f = fixture(); const proof = await sealDeploymentQualification(config, medplum, await report(), feature(), f.fetcher, app());
    f.state[field] = 'changed';
    await expect(verifyDeploymentQualification(config, medplum, proof, f.fetcher)).rejects.toMatchObject({ code: 'storage-deployment-qualification-invalid' });
  });
  it('rejects effective policy changes and runtime admin elevation', async () => {
    const f = fixture(); const proof = await sealDeploymentQualification(config, medplum, await report(), feature(), f.fetcher, app());
    f.state.policy.push({ resourceType: '*' });
    await expect(verifyDeploymentQualification(config, medplum, proof, f.fetcher)).rejects.toThrow();
    f.state.policy.pop(); f.state.admin = true;
    await expect(verifyDeploymentQualification(config, medplum, proof, f.fetcher)).rejects.toThrow();
  });
  it('rejects tampering, wrong deployment key, origin and endpoint before network', async () => {
    const f = fixture(); const proof = await sealDeploymentQualification(config, medplum, await report(), feature(), f.fetcher, app());
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
    await expect(sealDeploymentQualification(config, medplum, { ...r, handoff: 'not-qualified' }, feature(), f.fetcher, app())).rejects.toThrow();
    await expect(sealDeploymentQualification(config, medplum, { ...r, delivery: 'mock-pass' }, feature(), f.fetcher, app())).rejects.toThrow();
    await expect(sealDeploymentQualification(config, medplum, { ...r, checks: { ...r.checks, payloadConflict: false } }, feature(), f.fetcher, app())).rejects.toThrow();
    await expect(sealDeploymentQualification(config, medplum, r, { ...feature(), observedAt: '2000-01-01T00:00:00Z' }, f.fetcher, app())).rejects.toThrow();
    await expect(sealDeploymentQualification(config, medplum, r, feature(), f.fetcher, app(), 7 * 86400000 + 1)).rejects.toThrow();
    const proof = await sealDeploymentQualification(config, medplum, r, feature(), f.fetcher, app(), 1000);
    vi.useFakeTimers(); vi.advanceTimersByTime(1001);
    try { await expect(verifyDeploymentQualification(config, medplum, proof, f.fetcher)).rejects.toThrow(); } finally { vi.useRealTimers(); }
  });
  it('rejects atomic schema and unqualified Questionnaire/application evidence before network', async () => { const f = fixture(), r = await report(); await expect(sealDeploymentQualification(config, medplum, { ...r, schema: 1 } as never, feature(), f.fetcher, app())).rejects.toThrow(); await expect(sealDeploymentQualification(config, medplum, r, feature(), f.fetcher, { ...app(), nativeQuestionnaireMapping: false } as never)).rejects.toThrow(); expect(f.calls).toHaveLength(0); });
  it('cold starts and token refresh do not run qualification FHIR writes', async () => {
    const definition = await getNativeQuestionnaireDefinition(), bound = { ...config, nativeQuestionnaire: { ...definition.binding, reference: 'Questionnaire/native/_history/v2' } };
    const f = fixture(definition.questionnaire); const proof = await sealDeploymentQualification(bound, medplum, await report(), feature(), f.fetcher, app());
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
