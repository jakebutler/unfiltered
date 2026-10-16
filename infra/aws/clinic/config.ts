import { NATIVE_QUESTIONNAIRE_CANONICAL, NATIVE_QUESTIONNAIRE_VERSION } from '../../../packages/clinic-content/src/native-questionnaire.js';
import { nativeRoutingContextSchema } from '../../../packages/clinical-core/src/questionnaire-response.js';
import { z } from 'zod';
import { applicationChecks, type QualifiedClinicConfig } from '../../../packages/clinic-api/src/deployment-qualification.js';
import { parseDeploymentManifest, type ClinicDeploymentManifest } from '../manifest.schema.js';

const id = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/);
const reference = (type: string) => z.string().regex(new RegExp(`^${type}/[A-Za-z0-9.-]{1,64}$`));
const scenarios = ['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'] as const;
const checks = z.object({ conditionalCreate: z.literal(true), conditionalConcurrency: z.literal(true), versionConflict: z.literal(true), versionHistory: z.literal(true), lostResponseRecovery: z.literal(true), partialResume: z.literal(true), zeroTaskResume: z.literal(true), sourceVerification: z.literal(true), payloadConflict: z.literal(true) }).strict();
const application = z.object(Object.fromEntries(applicationChecks.map(check => [check, z.literal(true)])) as Record<typeof applicationChecks[number], z.ZodLiteral<true>>).strict();
const patient = z.object({ reference: reference('Patient'), displayName: z.string().min(1).max(200), description: z.string().max(2000), careTeams: z.object({ medical: reference('CareTeam'), nutrition: reference('CareTeam'), administrative: reference('CareTeam') }).strict(), context: z.string().max(8000).optional(), nativeContext: nativeRoutingContextSchema.optional() }).strict();
const identityBase = { endpoint: z.string(), projectId: id, clientId: id, membershipId: id, effectivePolicyDigest: z.string().regex(/^[a-f0-9]{64}$/), serverVersion: z.string().min(1).max(128) };
const features = z.array(z.string().min(1).max(128)).max(64);
const payloadBase = {
  purpose: z.literal('synthetic-clinic-conditional-resumable'), deliveryContract: z.literal('conditional-resumable-v1'), mode: z.literal('live'), origin: z.string(),
  qualifiedAt: z.string().datetime({ offset: true }), expiresAt: z.string().datetime({ offset: true }), proofDigest: z.string().regex(/^[a-f0-9]{64}$/), checks, applicationChecks: application, namedPolicyDigests: z.record(z.string().regex(/^[a-f0-9]{64}$/)), staffRosterDigest: z.string().regex(/^[a-f0-9]{64}$/), applicationEvidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  nativeQuestionnaire: z.object({ canonical: z.literal(NATIVE_QUESTIONNAIRE_CANONICAL), version: z.literal(NATIVE_QUESTIONNAIRE_VERSION), digest: z.string().regex(/^[a-f0-9]{64}$/), reference: z.string().regex(/^Questionnaire\/[A-Za-z0-9.-]{1,64}\/_history\/[A-Za-z0-9.-]{1,64}$/) }).strict().optional(),
};
// Schema 2: historical admin-observed Project feature file. Accepted until its own expiry.
const payloadV2 = z.object({ ...payloadBase, schema: z.literal(2), identity: z.object(identityBase).strict(),
  projectFeature: z.object({ projectId: id, projectVersion: id, features, observedAt: z.string().datetime({ offset: true }) }).strict(),
  featureDriftContract: z.literal('admin-change-requires-requalification-not-runtime-observed') }).strict();
// Schema 3: runtime /auth/me Project projection, re-observed and digest-compared on every refresh.
const payloadV3 = z.object({ ...payloadBase, schema: z.literal(3), identity: z.object({ ...identityBase, projectionDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  projectFeature: z.object({ source: z.literal('auth-me'), projectId: id, features, projectVersion: z.string().regex(/^projection-sha256:[a-f0-9]{64}$/), projectionDigest: z.string().regex(/^[a-f0-9]{64}$/), observedAt: z.string().datetime({ offset: true }) }).strict(),
  featureDriftContract: z.literal('runtime-observed-auth-me-projection') }).strict()
  .refine(payload => payload.identity.projectionDigest === payload.projectFeature.projectionDigest && payload.projectFeature.projectVersion === `projection-sha256:${payload.projectFeature.projectionDigest}`);
const schema = z.object({
  origin: z.string(), medplumBaseUrl: z.string(), projectId: id, clientId: id,
  nativeQuestionnaire: z.object({ canonical: z.literal(NATIVE_QUESTIONNAIRE_CANONICAL), version: z.literal(NATIVE_QUESTIONNAIRE_VERSION), digest: z.string().regex(/^[a-f0-9]{64}$/), reference: z.string().regex(/^Questionnaire\/[A-Za-z0-9.-]{1,64}\/_history\/[A-Za-z0-9.-]{1,64}$/) }).strict().optional(),
  clientSecret: z.string().min(16).max(4096), cookieSecret: z.string().min(32).max(256), mentalHealth: z.literal('phq4'),
  patients: z.object({ 'first-intake': patient, 'pre-visit': patient, 'non-visit': patient, 'post-visit': patient, billing: patient, scheduling: patient, refill: patient }).strict(),
  staff: z.array(z.object({ membershipId: id, profile: reference('Practitioner'), policy: reference('AccessPolicy'), name: z.string().min(1).max(200), role: z.enum(['physician', 'registered-dietitian', 'administrative']), patients: z.array(reference('Patient')).length(1), careTeams: z.array(reference('CareTeam')).max(3) }).strict()).length(4),
  storageQualification: z.object({ signature: z.string().regex(/^[a-f0-9]{64}$/), payload: z.union([payloadV2, payloadV3]) }).strict(),
}).strict();

export function awsClinicConfig(environment: Record<string, string | undefined>): { manifest: ClinicDeploymentManifest; config: QualifiedClinicConfig } {
  try {
    const manifestRaw = environment.AWS_DEPLOYMENT_MANIFEST_JSON, configRaw = environment.CLINIC_CONFIG_JSON;
    if (!manifestRaw || Buffer.byteLength(manifestRaw) > 16_384 || !configRaw || Buffer.byteLength(configRaw) > 48_000) throw new Error();
    const manifest = parseDeploymentManifest(JSON.parse(manifestRaw));
    if (manifest.product !== 'clinic') throw new Error();
    const config = schema.parse(JSON.parse(configRaw)), expected = manifest.authority, proof = config.storageQualification.payload;
    const qualified = Date.parse(proof.qualifiedAt), expires = Date.parse(proof.expiresAt), now = Date.now();
    if (config.origin !== manifest.publicOrigin || config.medplumBaseUrl !== expected.medplumBaseUrl || config.projectId !== expected.projectId || config.clientId !== expected.clientId ||
      proof.origin !== config.origin || proof.identity.endpoint !== new URL('fhir/R4/', expected.medplumBaseUrl).href || proof.identity.projectId !== expected.projectId || proof.identity.clientId !== expected.clientId || proof.identity.membershipId !== expected.membershipId ||
      proof.projectFeature.projectId !== expected.projectId || qualified > now + 30_000 || expires <= now || expires <= qualified || expires - qualified > 7 * 86_400_000 ||
      scenarios.some(scenario => !config.patients[scenario]) || new Set(config.staff.map(s => s.membershipId)).size !== config.staff.length || !['physician', 'registered-dietitian', 'administrative'].every(role => config.staff.some(s => s.role === role))) throw new Error();
    // Runtime still verifies signature, effective native identity/policy/version and selected conditional contract proof.
    return { manifest, config };
  } catch { throw new Error('aws-clinic-configuration-invalid'); }
}
