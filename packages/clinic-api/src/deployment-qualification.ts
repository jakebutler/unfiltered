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
export interface RuntimeIdentity {
  endpoint: string;
  projectId: string;
  clientId: string;
  membershipId: string;
  effectivePolicyDigest: string;
  serverVersion: string;
}
export interface ProjectFeatureObservation {
  projectId: string;
  projectVersion: string;
  features: string[];
  observedAt: string;
}
export interface DeploymentQualification {
  payload: {
    schema: 2;
    purpose: 'synthetic-clinic-conditional-resumable';
    deliveryContract: 'conditional-resumable-v1';
    identity: RuntimeIdentity;
    mode: 'local' | 'live';
    origin: string;
    qualifiedAt: string;
    expiresAt: string;
    proofDigest: string;
    checks: Record<typeof checks[number], true>;
    projectFeature: ProjectFeatureObservation;
    applicationChecks: ApplicationQualificationChecks;
    namedPolicyDigests: Record<string, string>; staffRosterDigest: string; applicationEvidenceDigest: string;
    nativeQuestionnaire?: ClinicApiConfig['nativeQuestionnaire'];
    featureDriftContract: 'admin-change-requires-requalification-not-runtime-observed';
  };
  signature: string;
}
export type QualifiedClinicConfig = ClinicApiConfig & { storageQualification?: DeploymentQualification };
const failure = () => new ApiFailure('storage-deployment-qualification-invalid', 503);
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
async function key(secret: string) {
  if (secret.length < 32) throw failure();
  return crypto.subtle.importKey('raw', encoder.encode(`corvo-storage-qualification:conditional-v2:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** Read-only authenticated identity and server-version observation. */
export async function observeRuntimeIdentity(config: ClinicApiConfig, medplum: MedplumConfig, fetcher: Fetch): Promise<RuntimeIdentity> {
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
  return { endpoint: medplum.baseUrl, projectId: config.projectId, clientId: config.clientId, membershipId: membership.id, effectivePolicyDigest: await digest(effectivePolicy), serverVersion: software.version };
}

/** Only a deployment operation with completed native evidence may seal a proof. */
export async function sealDeploymentQualification(config: ClinicApiConfig, medplum: MedplumConfig, report: ConditionalQualificationReport, projectFeature: ProjectFeatureObservation, fetcher: Fetch, application: ApplicationQualification, validityMs = maximumAgeMs): Promise<DeploymentQualification> {
  const now = Date.now();
  if (!Number.isInteger(validityMs) || validityMs <= 0 || validityMs > maximumAgeMs || report.mode !== medplum.mode || report.schema !== 2 || report.deliveryContract !== 'conditional-resumable-v1' || report.delivery !== 'qualified-for-tested-credentials' || report.handoff !== 'received' || report.endpoint !== medplum.baseUrl || !report.qualification || report.qualification.credentialFingerprint !== await digest(medplum.accessToken) || report.qualification.baseUrl !== medplum.baseUrl || report.qualification.mode !== medplum.mode || report.qualification.deliveryContract !== 'conditional-resumable-v1' || checks.some(check => report.checks[check] !== true) || projectFeature.projectId !== config.projectId || !projectFeature.projectVersion || !Array.isArray(projectFeature.features) || applicationChecks.some(check => application?.[check] !== true) || !/^[a-f0-9]{64}$/.test(application?.evidenceDigest ?? '') || config.staff.some(staff => !/^[a-f0-9]{64}$/.test(application.namedPolicyDigests?.[staff.membershipId] ?? '')) || !Number.isFinite(Date.parse(projectFeature.observedAt)) || Math.abs(now - Date.parse(projectFeature.observedAt)) > 900000 || !Number.isFinite(Date.parse(report.qualification.qualifiedAt)) || Math.abs(now - Date.parse(report.qualification.qualifiedAt)) > 900000) throw failure();
  const payload: DeploymentQualification['payload'] = {
    schema: 2, purpose: 'synthetic-clinic-conditional-resumable', deliveryContract: 'conditional-resumable-v1', identity: await observeRuntimeIdentity(config, medplum, fetcher), mode: medplum.mode, origin: config.origin,
    qualifiedAt: report.qualification.qualifiedAt, expiresAt: new Date(now + validityMs).toISOString(), proofDigest: await digest(report), checks: Object.fromEntries(checks.map(check => [check, true])) as DeploymentQualification['payload']['checks'],
    ...(config.nativeQuestionnaire ? { nativeQuestionnaire: structuredClone(config.nativeQuestionnaire) } : {}),
    projectFeature: structuredClone(projectFeature), applicationChecks: Object.fromEntries(applicationChecks.map(check => [check, true])) as ApplicationQualificationChecks, namedPolicyDigests: structuredClone(application.namedPolicyDigests), staffRosterDigest: await digest(config.staff), applicationEvidenceDigest: application.evidenceDigest, featureDriftContract: 'admin-change-requires-requalification-not-runtime-observed',
  };
  // Expiry is bounded from the original proof, not the later signing operation.
  payload.expiresAt = new Date(Math.min(Date.parse(payload.expiresAt), Date.parse(payload.qualifiedAt) + maximumAgeMs)).toISOString();
  return { payload, signature: hex(await crypto.subtle.sign('HMAC', await key(config.cookieSecret), encoder.encode(canonicalJson(payload)))) };
}

export async function verifyDeploymentQualification(config: ClinicApiConfig, medplum: MedplumConfig, attestation: DeploymentQualification, fetcher: Fetch): Promise<DeliveryQualification> {
  try {
    const payload = attestation.payload, now = Date.now();
    if (!/^[a-f0-9]{64}$/.test(attestation.signature)) throw failure();
    const signature = Uint8Array.from(attestation.signature.match(/../g)!, value => Number.parseInt(value, 16));
    if (!await crypto.subtle.verify('HMAC', await key(config.cookieSecret), signature, encoder.encode(canonicalJson(payload)))) throw failure();
    if (payload.schema !== 2 || payload.purpose !== 'synthetic-clinic-conditional-resumable' || payload.deliveryContract !== 'conditional-resumable-v1' || applicationChecks.some(check => payload.applicationChecks?.[check] !== true) || canonicalJson(payload.nativeQuestionnaire ?? null) !== canonicalJson(config.nativeQuestionnaire ?? null) || payload.staffRosterDigest !== await digest(config.staff) || !/^[a-f0-9]{64}$/.test(payload.applicationEvidenceDigest) || config.staff.some(staff => !/^[a-f0-9]{64}$/.test(payload.namedPolicyDigests?.[staff.membershipId] ?? '')) || payload.origin !== config.origin || payload.mode !== medplum.mode || payload.identity.endpoint !== medplum.baseUrl || payload.identity.projectId !== config.projectId || payload.identity.clientId !== config.clientId || payload.featureDriftContract !== 'admin-change-requires-requalification-not-runtime-observed' || !/^[a-f0-9]{64}$/.test(payload.proofDigest) || checks.some(check => payload.checks[check] !== true) || payload.projectFeature.projectId !== config.projectId || !payload.projectFeature.projectVersion || !Array.isArray(payload.projectFeature.features) || !Number.isFinite(Date.parse(payload.qualifiedAt)) || !Number.isFinite(Date.parse(payload.expiresAt)) || Date.parse(payload.qualifiedAt) > now + 30000 || Date.parse(payload.expiresAt) <= now || Date.parse(payload.expiresAt) <= Date.parse(payload.qualifiedAt) || Date.parse(payload.expiresAt) - Date.parse(payload.qualifiedAt) > maximumAgeMs) throw failure();
    const current = await observeRuntimeIdentity(config, medplum, fetcher);
    if (canonicalJson(current) !== canonicalJson(payload.identity)) throw failure();
    return { baseUrl: medplum.baseUrl, mode: medplum.mode, credentialFingerprint: await digest(medplum.accessToken), qualifiedAt: payload.qualifiedAt, deliveryContract: 'conditional-resumable-v1', conditionalCreate: true, conditionalConcurrency: true, versionConflict: true, versionHistory: true };
  } catch { throw failure(); }
}
