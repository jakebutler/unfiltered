import { describe, expect, it, vi } from 'vitest';
import { parseDeploymentManifest } from '../manifest.schema.js';
import { awsClinicConfig } from '../clinic/config.js';
import { verifyDeploymentQualification } from '../../../packages/clinic-api/src/deployment-qualification.js';
import { example, clinicFixture } from './fixtures.js';

describe('independent secret-free manifests', () => {
  it('accepts two distinct clinic boundaries and one separate research authority', () => {
    const a = parseDeploymentManifest(example('clinic-a')), b = parseDeploymentManifest(example('clinic-b')), r = parseDeploymentManifest(example('research'));
    expect(a.product).toBe('clinic'); expect(r.product).toBe('research'); expect(a.publicOrigin).not.toBe(b.publicOrigin);
    if (a.product !== 'clinic' || b.product !== 'clinic') throw new Error('Fixture kind');
    for (const key of ['medplumBaseUrl', 'projectId', 'clientId', 'membershipId', 'runtimeSecretRef', 'databaseNamespace', 'binaryNamespace'] as const) expect(a.authority[key]).not.toBe(b.authority[key]);
  });
  it.each(['secret', 'shared-storage', 'foreign-secret', 'phi', 'providers', 'replicas', 'http', 'loopback', 'userinfo'])('rejects %s before runtime', change => {
    const m = example('clinic-a');
    if (change === 'secret') m.authority.clientSecret = 'must-never-be-a-manifest';
    if (change === 'shared-storage') m.authority.binaryNamespace = 'clinic-b-binary';
    if (change === 'foreign-secret') m.authority.runtimeSecretRef = 'unfiltered/clinic-b/runtime';
    if (change === 'phi') m.gates.phiEnabled = true;
    if (change === 'providers') m.gates.liveProvidersEnabled = true;
    if (change === 'replicas') m.topology.replicas = 2;
    if (change === 'http') m.publicOrigin = 'http://clinic-a.example.invalid';
    if (change === 'loopback') m.publicOrigin = 'https://127.0.0.2';
    if (change === 'userinfo') m.publicOrigin = 'https://user:password@clinic-a.example.invalid';
    expect(() => parseDeploymentManifest(m)).toThrow(/^aws-deployment-manifest-invalid$/);
  });
});
describe('clinic profile identity and native proof gate', () => {
  const load = (m = example('clinic-a'), c = clinicFixture(m)) => awsClinicConfig({ AWS_DEPLOYMENT_MANIFEST_JSON: JSON.stringify(m), CLINIC_CONFIG_JSON: JSON.stringify(c) });
  it('accepts structurally matched clinic profiles without claiming cryptographic verification', () => {
    for (const name of ['clinic-a', 'clinic-b'] as const) expect(load(example(name)).manifest.stackId).toBe(name);
  });
  it.each(['tenant', 'endpoint', 'member', 'origin', 'contract', 'questionnaire', 'expiry', 'proof-window', 'check', 'scenario', 'staff', 'extra'])('rejects %s drift', change => {
    const m = example('clinic-a'), c = clinicFixture(m), p = c.storageQualification.payload;
    if (change === 'tenant') c.projectId = 'another-project';
    if (change === 'endpoint') c.medplumBaseUrl = 'https://medplum-b.example.invalid/';
    if (change === 'member') p.identity.membershipId = 'another-member';
    if (change === 'origin') p.origin = 'https://clinic-b.example.invalid';
    if (change === 'contract') (p as unknown as { schema: number }).schema = 1;
    if (change === 'questionnaire') p.applicationChecks.nativeQuestionnaireMapping = false;
    if (change === 'expiry') p.expiresAt = new Date(0).toISOString();
    if (change === 'proof-window') p.expiresAt = new Date(Date.now() + 8 * 86400000).toISOString();
    if (change === 'check') (p.checks as Record<string, boolean>).conditionalConcurrency = false;
    if (change === 'scenario') delete c.patients.refill;
    if (change === 'staff') c.staff[1].membershipId = c.staff[0].membershipId;
    if (change === 'extra') Object.assign(c, { providerKey: 'must-not-activate' });
    expect(() => load(m, c)).toThrow(/^aws-clinic-configuration-invalid$/);
  });
  it('keeps accepting the historical schema-2 admin observation until expiry', () => {
    expect(load(example('clinic-a'), clinicFixture(example('clinic-a'), 2)).config.storageQualification!.payload.schema).toBe(2);
  });
  it.each(['projection-split', 'v3-admin-shape', 'v2-auth-me-contract', 'missing-projection'])('rejects schema-3 projection %s', change => {
    const m = example('clinic-a'), c = clinicFixture(m), p = c.storageQualification.payload;
    if (change === 'projection-split') p.identity.projectionDigest = '0'.repeat(64);
    if (change === 'v3-admin-shape') p.projectFeature = { projectId: m.authority.projectId, projectVersion: '1', features: [], observedAt: p.qualifiedAt };
    if (change === 'v2-auth-me-contract') { const v2 = clinicFixture(m, 2); v2.storageQualification.payload.featureDriftContract = 'runtime-observed-auth-me-projection'; expect(() => load(m, v2)).toThrow(/^aws-clinic-configuration-invalid$/); return; }
    if (change === 'missing-projection') delete p.identity.projectionDigest;
    expect(() => load(m, c)).toThrow(/^aws-clinic-configuration-invalid$/);
  });
  it('does not accept research, local config paths, oversize secrets, or echo malformed secret text', () => {
    expect(() => load(example('research'), clinicFixture())).toThrow(/^aws-clinic-configuration-invalid$/);
    expect(() => awsClinicConfig({ CLINIC_CONFIG_PATH: '/private/credentials' })).toThrow(/^aws-clinic-configuration-invalid$/);
    expect(() => awsClinicConfig({ AWS_DEPLOYMENT_MANIFEST_JSON: JSON.stringify(example('clinic-a')), CLINIC_CONFIG_JSON: 'secret-marker'.repeat(5000) })).toThrow(/^aws-clinic-configuration-invalid$/);
  });
  it('still rejects a forged proof before any native identity request', async () => {
    const { config } = load(), fetcher = vi.fn();
    await expect(verifyDeploymentQualification(config, { baseUrl: `${config.medplumBaseUrl}fhir/R4/`, mode: 'live', timeoutMs: 1000, accessToken: 'synthetic-token' }, config.storageQualification!, fetcher)).rejects.toMatchObject({ code: 'storage-deployment-qualification-invalid' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
