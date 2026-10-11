import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
export const example = (name: 'clinic-a' | 'clinic-b' | 'research') => JSON.parse(readFileSync(resolve('infra/aws/examples', `${name}.json`), 'utf8'));
export function clinicFixture(manifest = example('clinic-a')) {
  const { authority: a, publicOrigin: origin } = manifest, qualifiedAt = new Date(Date.now() - 1000).toISOString();
  return {
    origin, medplumBaseUrl: a.medplumBaseUrl, projectId: a.projectId, clientId: a.clientId,
    clientSecret: 'synthetic-client-secret-no-authority', cookieSecret: 'synthetic-cookie-secret-no-authority-32', mentalHealth: 'phq4',
    patients: Object.fromEntries(['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'].map(s => [s, { reference: 'Patient/synthetic', displayName: 'Synthetic patient', description: 'Offline configuration test', careTeams: { medical: 'CareTeam/medical', nutrition: 'CareTeam/nutrition', administrative: 'CareTeam/administrative' } }])),
    staff: ['physician', 'registered-dietitian', 'administrative', 'physician'].map((role, i) => ({ membershipId: `staff-${i}`, profile: `Practitioner/staff-${i}`, policy: `AccessPolicy/policy-${i}`, name: `Synthetic staff ${i}`, role, patients: ['Patient/synthetic'], careTeams: [] })),
    storageQualification: { signature: '0'.repeat(64), payload: {
      schema: 2, purpose: 'synthetic-clinic-conditional-resumable', deliveryContract: 'conditional-resumable-v1', mode: 'live', origin, qualifiedAt, expiresAt: new Date(Date.now() + 3600000).toISOString(), proofDigest: 'a'.repeat(64),
      checks: { conditionalCreate: true, conditionalConcurrency: true, versionConflict: true, versionHistory: true, lostResponseRecovery: true, partialResume: true, zeroTaskResume: true, sourceVerification: true, payloadConflict: true }, applicationChecks: { sevenWorkflows: true, partialOwnWork: true, zeroTaskRecovery: true, confirmedDraftRecovery: true, actionHistory: true, actionReplay: true, actionUnknownRecovery: true, actionTamperDetection: true, actionCASConcurrency: true, nativeQuestionnaireMapping: true, administrativeIsolation: true, correctionCoexistence: true, readOnlyReceipt: true }, namedPolicyDigests: Object.fromEntries([0, 1, 2, 3].map(index => [`staff-${index}`, 'c'.repeat(64)])), staffRosterDigest: 'd'.repeat(64), applicationEvidenceDigest: 'e'.repeat(64),
      identity: { endpoint: `${a.medplumBaseUrl}fhir/R4/`, projectId: a.projectId, clientId: a.clientId, membershipId: a.membershipId, effectivePolicyDigest: 'b'.repeat(64), serverVersion: 'synthetic-version' },
      projectFeature: { projectId: a.projectId, projectVersion: '1', features: [], observedAt: qualifiedAt }, featureDriftContract: 'admin-change-requires-requalification-not-runtime-observed',
    } },
  };
}
