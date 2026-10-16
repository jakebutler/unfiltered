import { canonicalJson, digest } from '../../clinical-core/src/domain.js';
import type { DeliveryQualification, MedplumConfig } from '../../clinical-core/src/medplum.js';
import { conditionalChecks, type ConditionalQualificationReport } from '../../clinical-core/src/qualification.js';
import { requestJson, type Fetch } from '../../clinical-core/src/transport.js';
import { object } from './store.js';
import { ApiFailure, type ClinicApiConfig } from './types.js';

const maximumAgeMs = 7 * 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();
const checks = conditionalChecks;
export const applicationChecks = ['sevenWorkflows', 'partialOwnWork', 'zeroTaskRecovery', 'confirmedDraftRecovery', 'actionHistory', 'actionReplay', 'actionUnknownRecovery', 'actionTamperDetection', 'actionCASConcurrency', 'nativeQuestionnaireMapping', 'administrativeIsolation', 'correctionCoexistence', 'readOnlyReceipt'] as const;
export type ApplicationQualificationChecks = Record<typeof applicationChecks[number], true>;
export type ApplicationQualification = ApplicationQualificationChecks & { namedPolicyDigests: Record<string, string>; evidenceDigest: string };
/** Medplum server release from which `/auth/me` projects Project features/strictMode/superAdmin to every member (medplum PR #8713). */
export const AUTH_ME_PROJECT_PROJECTION_MINIMUM_SERVER = '5.1.4';
export const SCHEMA_2_FEATURE_DRIFT_CONTRACT = 'admin-change-requires-requalification-not-runtime-observed';
export const SCHEMA_3_FEATURE_DRIFT_CONTRACT = 'runtime-observed-auth-me-projection';
export interface RuntimeIdentity {
  endpoint: string;
  projectId: string;
  clientId: string;
  membershipId: string;
  effectivePolicyDigest: string;
  serverVersion: string;
  /** Schema 3 only: digest of the `/auth/me` Project projection, re-observed on every refresh. */
  projectionDigest?: string;
}
/** Schema 2 (historical): a temporary project admin read `Project/{id}` at seal time. */
export interface AdminProjectFeatureObservation {
  projectId: string;
  projectVersion: string;
  features: string[];
  observedAt: string;
}
/** Schema 3: the runtime client's own `/auth/me` Project projection, observed at seal time and on every refresh. */
export interface AuthMeProjectFeatureObservation {
  source: 'auth-me';
  projectId: string;
  features: string[];
  projectionDigest: string;
  projectVersion: `projection-sha256:${string}`;
  observedAt: string;
}
export type ProjectFeatureObservation = AdminProjectFeatureObservation | AuthMeProjectFeatureObservation;
interface DeploymentQualificationPayloadBase {
  purpose: 'synthetic-clinic-conditional-resumable';
  deliveryContract: 'conditional-resumable-v1';
  identity: RuntimeIdentity;
  mode: 'local' | 'live';
  origin: string;
  qualifiedAt: string;
  expiresAt: string;
  proofDigest: string;
  checks: Record<typeof checks[number], true>;
  applicationChecks: ApplicationQualificationChecks;
  namedPolicyDigests: Record<string, string>; staffRosterDigest: string; applicationEvidenceDigest: string;
  nativeQuestionnaire?: ClinicApiConfig['nativeQuestionnaire'];
}
export interface DeploymentQualificationPayloadV2 extends DeploymentQualificationPayloadBase {
  schema: 2;
  projectFeature: AdminProjectFeatureObservation;
  featureDriftContract: typeof SCHEMA_2_FEATURE_DRIFT_CONTRACT;
}
export interface DeploymentQualificationPayloadV3 extends DeploymentQualificationPayloadBase {
  schema: 3;
  identity: RuntimeIdentity & { projectionDigest: string };
  projectFeature: AuthMeProjectFeatureObservation;
  featureDriftContract: typeof SCHEMA_3_FEATURE_DRIFT_CONTRACT;
}
export interface DeploymentQualification<Payload extends DeploymentQualificationPayloadV2 | DeploymentQualificationPayloadV3 = DeploymentQualificationPayloadV2 | DeploymentQualificationPayloadV3> {
  payload: Payload;
  signature: string;
}
export type QualifiedClinicConfig = ClinicApiConfig & { storageQualification?: DeploymentQualification };
const failure = () => new ApiFailure('storage-deployment-qualification-invalid', 503);
const projectionDrift = () => new ApiFailure('project-projection-drift', 503);
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
// The key is shared by schemas 2 and 3; the schema number is inside the signed payload.
async function key(secret: string) {
  if (secret.length < 32) throw failure();
  return crypto.subtle.importKey('raw', encoder.encode(`corvo-storage-qualification:conditional-v2:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** True only for a parseable release at or after the `/auth/me` Project projection change. */
export function serverProjectsProjectFeatures(serverVersion: string): boolean {
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+][0-9A-Za-z.-]*)?$/.exec(serverVersion);
  if (!match) return false;
  const actual = match.slice(1).map(Number), minimum = AUTH_ME_PROJECT_PROJECTION_MINIMUM_SERVER.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  return true;
}

/**
 * Builds the schema-3 Project observation from an `/auth/me` `project` value. An absent `features`
 * key means "no features" only on servers known to project it; anything else fails closed.
 * Only the approved identity/configuration projection is hashed; optional fields remain absent.
 */
export async function authMeProjectFeatureObservation(project: unknown, serverVersion: string, projectId: string, observedAt = new Date().toISOString()): Promise<AuthMeProjectFeatureObservation> {
  const value = object(project);
  if (value.id !== projectId || !serverProjectsProjectFeatures(serverVersion) || !Number.isFinite(Date.parse(observedAt)) || Math.abs(Date.now() - Date.parse(observedAt)) > 900000) throw failure();
  const features = value.features ?? [];
  if (!Array.isArray(features) || features.length > 64 || features.some(feature => typeof feature !== 'string' || !feature || feature.length > 128)) throw failure();
  if ((value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 1024)) || (value.strictMode !== undefined && typeof value.strictMode !== 'boolean') || (value.superAdmin !== undefined && typeof value.superAdmin !== 'boolean') || (value.checkReferencesOnWrite !== undefined && typeof value.checkReferencesOnWrite !== 'boolean') || value.superAdmin === true) throw failure();
  const sorted = [...features as string[]].sort();
  const projection = { id: projectId, ...(value.name !== undefined ? { name: value.name } : {}), features: sorted,
    ...(value.strictMode !== undefined ? { strictMode: value.strictMode } : {}),
    ...(value.checkReferencesOnWrite !== undefined ? { checkReferencesOnWrite: value.checkReferencesOnWrite } : {}) };
  const projectionDigest = await digest(projection);
  return { source: 'auth-me', projectId, features: sorted, projectionDigest, projectVersion: `projection-sha256:${projectionDigest}`, observedAt };
}

async function observeRuntime(config: ClinicApiConfig, medplum: MedplumConfig, fetcher: Fetch) {
  const headers = { Authorization: `Bearer ${medplum.accessToken}`, Accept: 'application/json' };
  const me = object((await requestJson(fetcher, new URL('auth/me', config.medplumBaseUrl).href, { headers }, 10000)).body);
  const project = object(me.project), profile = object(me.profile), membership = object(me.membership), policy = object(me.accessPolicy);
  if (project.id !== config.projectId || profile.resourceType !== 'ClientApplication' || profile.id !== config.clientId || typeof membership.id !== 'string' || !/^[A-Za-z0-9.-]{1,64}$/.test(membership.id) || object(membership.profile).reference !== `ClientApplication/${config.clientId}` || (membership.project !== undefined && object(membership.project).reference !== `Project/${config.projectId}`) || membership.active === false || membership.admin === true || project.superAdmin === true || policy.resourceType !== 'AccessPolicy' || !Array.isArray(policy.resource) || !policy.resource.length) throw failure();
  // Effective policies may receive a new synthetic id/meta while being resolved;
  // every authorization-bearing property, including basedOn, is retained.
  const { id: _id, meta: _meta, ...effectivePolicy } = policy;
  const metadata = object((await requestJson(fetcher, new URL('metadata', medplum.baseUrl).href, { headers }, 10000)).body);
  const software = object(metadata.software);
  if (metadata.resourceType !== 'CapabilityStatement' || typeof software.version !== 'string' || !software.version || software.version.length > 128) throw failure();
  const identity: RuntimeIdentity = { endpoint: medplum.baseUrl, projectId: config.projectId, clientId: config.clientId, membershipId: membership.id, effectivePolicyDigest: await digest(effectivePolicy), serverVersion: software.version };
  return { identity, project, policyRules: policy.resource as unknown[] };
}

/** Read-only authenticated identity and server-version observation (schema-2 identity shape). */
export async function observeRuntimeIdentity(config: ClinicApiConfig, medplum: MedplumConfig, fetcher: Fetch): Promise<RuntimeIdentity> {
  return (await observeRuntime(config, medplum, fetcher)).identity;
}

// Administrative resource types (or a wildcard) in the runtime policy would let a non-admin read
// AccessPolicy (medplum PR #10826) or administer the project; schema 3 never seals or accepts them.
const administrativeTypes = new Set(['*', 'AccessPolicy', 'ProjectMembership', 'ClientApplication', 'Project', 'User', 'Login', 'Bot']);

/** Schema-3 observation: identity plus the `/auth/me` Project projection from the same response. */
export async function observeRuntimeProjection(config: ClinicApiConfig, medplum: MedplumConfig, fetcher: Fetch, observedAt?: string): Promise<{ identity: RuntimeIdentity & { projectionDigest: string }; projectFeature: AuthMeProjectFeatureObservation }> {
  const { identity, project, policyRules } = await observeRuntime(config, medplum, fetcher);
  if (policyRules.some(rule => administrativeTypes.has(String(object(rule).resourceType)))) throw failure();
  const projectFeature = await authMeProjectFeatureObservation(project, identity.serverVersion, config.projectId, observedAt);
  return { identity: { ...identity, projectionDigest: projectFeature.projectionDigest }, projectFeature };
}

/**
 * Only a deployment operation with completed native evidence may seal a proof. The Project feature
 * observation is taken inline from the runtime client's own `/auth/me`; no administrator is needed.
 */
export async function sealDeploymentQualification(config: ClinicApiConfig, medplum: MedplumConfig, report: ConditionalQualificationReport, fetcher: Fetch, application: ApplicationQualification, validityMs = maximumAgeMs): Promise<DeploymentQualification<DeploymentQualificationPayloadV3>> {
  const now = Date.now();
  if (!Number.isInteger(validityMs) || validityMs <= 0 || validityMs > maximumAgeMs || report.mode !== medplum.mode || report.schema !== 2 || report.deliveryContract !== 'conditional-resumable-v1' || report.delivery !== 'qualified-for-tested-credentials' || report.handoff !== 'received' || report.endpoint !== medplum.baseUrl || !report.qualification || report.qualification.credentialFingerprint !== await digest(medplum.accessToken) || report.qualification.baseUrl !== medplum.baseUrl || report.qualification.mode !== medplum.mode || report.qualification.deliveryContract !== 'conditional-resumable-v1' || checks.some(check => report.checks[check] !== true) || applicationChecks.some(check => application?.[check] !== true) || !/^[a-f0-9]{64}$/.test(application?.evidenceDigest ?? '') || config.staff.some(staff => !/^[a-f0-9]{64}$/.test(application.namedPolicyDigests?.[staff.membershipId] ?? '')) || !Number.isFinite(Date.parse(report.qualification.qualifiedAt)) || Math.abs(now - Date.parse(report.qualification.qualifiedAt)) > 900000) throw failure();
  const observed = await observeRuntimeProjection(config, medplum, fetcher, new Date(now).toISOString());
  const payload: DeploymentQualificationPayloadV3 = {
    schema: 3, purpose: 'synthetic-clinic-conditional-resumable', deliveryContract: 'conditional-resumable-v1', identity: observed.identity, mode: medplum.mode, origin: config.origin,
    qualifiedAt: report.qualification.qualifiedAt, expiresAt: new Date(now + validityMs).toISOString(), proofDigest: await digest(report), checks: Object.fromEntries(checks.map(check => [check, true])) as DeploymentQualificationPayloadV3['checks'],
    ...(config.nativeQuestionnaire ? { nativeQuestionnaire: structuredClone(config.nativeQuestionnaire) } : {}),
    projectFeature: observed.projectFeature, applicationChecks: Object.fromEntries(applicationChecks.map(check => [check, true])) as ApplicationQualificationChecks, namedPolicyDigests: structuredClone(application.namedPolicyDigests), staffRosterDigest: await digest(config.staff), applicationEvidenceDigest: application.evidenceDigest, featureDriftContract: SCHEMA_3_FEATURE_DRIFT_CONTRACT,
  };
  // Expiry is bounded from the original proof, not the later signing operation.
  payload.expiresAt = new Date(Math.min(Date.parse(payload.expiresAt), Date.parse(payload.qualifiedAt) + maximumAgeMs)).toISOString();
  return { payload, signature: hex(await crypto.subtle.sign('HMAC', await key(config.cookieSecret), encoder.encode(canonicalJson(payload)))) };
}

/**
 * Schema 3 re-observes the `/auth/me` Project projection on every refresh and fails closed on drift.
 * Schema 2 (admin-observed, sealed before schema 3) keeps its original checks until its own expiry.
 */
export async function verifyDeploymentQualification(config: ClinicApiConfig, medplum: MedplumConfig, attestation: DeploymentQualification, fetcher: Fetch): Promise<DeliveryQualification> {
  try {
    const payload = attestation.payload, now = Date.now();
    if (!/^[a-f0-9]{64}$/.test(attestation.signature)) throw failure();
    const signature = Uint8Array.from(attestation.signature.match(/../g)!, value => Number.parseInt(value, 16));
    if (!await crypto.subtle.verify('HMAC', await key(config.cookieSecret), signature, encoder.encode(canonicalJson(payload)))) throw failure();
    if ((payload.schema !== 2 && payload.schema !== 3) || payload.purpose !== 'synthetic-clinic-conditional-resumable' || payload.deliveryContract !== 'conditional-resumable-v1' || applicationChecks.some(check => payload.applicationChecks?.[check] !== true) || canonicalJson(payload.nativeQuestionnaire ?? null) !== canonicalJson(config.nativeQuestionnaire ?? null) || payload.staffRosterDigest !== await digest(config.staff) || !/^[a-f0-9]{64}$/.test(payload.applicationEvidenceDigest) || config.staff.some(staff => !/^[a-f0-9]{64}$/.test(payload.namedPolicyDigests?.[staff.membershipId] ?? '')) || payload.origin !== config.origin || payload.mode !== medplum.mode || payload.identity.endpoint !== medplum.baseUrl || payload.identity.projectId !== config.projectId || payload.identity.clientId !== config.clientId || !/^[a-f0-9]{64}$/.test(payload.proofDigest) || checks.some(check => payload.checks[check] !== true) || payload.projectFeature.projectId !== config.projectId || !Array.isArray(payload.projectFeature.features) || !Number.isFinite(Date.parse(payload.qualifiedAt)) || !Number.isFinite(Date.parse(payload.expiresAt)) || Date.parse(payload.qualifiedAt) > now + 30000 || Date.parse(payload.expiresAt) <= now || Date.parse(payload.expiresAt) <= Date.parse(payload.qualifiedAt) || Date.parse(payload.expiresAt) - Date.parse(payload.qualifiedAt) > maximumAgeMs) throw failure();
    if (payload.schema === 2) {
      if (payload.featureDriftContract !== SCHEMA_2_FEATURE_DRIFT_CONTRACT || !payload.projectFeature.projectVersion) throw failure();
      const current = await observeRuntimeIdentity(config, medplum, fetcher);
      if (canonicalJson(current) !== canonicalJson(payload.identity)) throw failure();
    } else {
      const sealed = payload.projectFeature;
      if (payload.featureDriftContract !== SCHEMA_3_FEATURE_DRIFT_CONTRACT || sealed.source !== 'auth-me' || !/^[a-f0-9]{64}$/.test(sealed.projectionDigest) || payload.identity.projectionDigest !== sealed.projectionDigest || sealed.projectVersion !== `projection-sha256:${sealed.projectionDigest}` || !Number.isFinite(Date.parse(sealed.observedAt)) || Date.parse(sealed.observedAt) > now + 30000 || Math.abs(Date.parse(sealed.observedAt) - Date.parse(payload.qualifiedAt)) > 900000) throw failure();
      const current = await observeRuntimeProjection(config, medplum, fetcher);
      if (current.projectFeature.projectionDigest !== sealed.projectionDigest || canonicalJson(current.projectFeature.features) !== canonicalJson(sealed.features)) throw projectionDrift();
      // Identity, effective policy and server version must still match independently.
      if (canonicalJson(current.identity) !== canonicalJson(payload.identity)) throw failure();
    }
    return { baseUrl: medplum.baseUrl, mode: medplum.mode, credentialFingerprint: await digest(medplum.accessToken), qualifiedAt: payload.qualifiedAt, deliveryContract: 'conditional-resumable-v1', conditionalCreate: true, conditionalConcurrency: true, versionConflict: true, versionHistory: true };
  } catch (error) {
    if (error instanceof ApiFailure && error.code === 'project-projection-drift') throw error;
    throw failure();
  }
}
