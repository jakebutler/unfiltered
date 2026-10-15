import { NATIVE_QUESTIONNAIRE_CANONICAL, NATIVE_QUESTIONNAIRE_VERSION } from '../../../packages/clinic-content/src/native-questionnaire.js';
import { nativeRoutingContextSchema } from '../../../packages/clinical-core/src/questionnaire-response.js';
import { z } from 'zod';
import type { QualifiedClinicConfig } from '../../../packages/clinic-api/src/deployment-qualification.js';

const projectId = '13eaac67-a2c3-4aa1-aa9e-590a083e5fef';
const clientId = '50db76bd-d099-4305-8ec3-7439ffc38ca1';
const membershipId = '6e565de2-837d-4618-9578-f6428fbb0be1';
const scenarios = ['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'] as const;
const reference = (type: string) => z.string().regex(new RegExp(`^${type}/[A-Za-z0-9.-]{1,64}$`));
const nativeBinding = z.object({ canonical: z.literal(NATIVE_QUESTIONNAIRE_CANONICAL), version: z.literal(NATIVE_QUESTIONNAIRE_VERSION), digest: z.string().regex(/^[a-f0-9]{64}$/), reference: z.string().regex(/^Questionnaire\/[A-Za-z0-9.-]{1,64}\/_history\/[A-Za-z0-9.-]{1,64}$/) }).strict();
const patient = z.object({ reference: reference('Patient'), displayName: z.string().min(1).max(200), description: z.string().max(2000), careTeams: z.object({ medical: reference('CareTeam'), nutrition: reference('CareTeam'), administrative: reference('CareTeam') }).strict(), context: z.string().max(8000).optional(), nativeContext: nativeRoutingContextSchema.optional() }).strict();
const schema = z.object({
  nativeQuestionnaire: nativeBinding.optional(),
  origin: z.string().url(), medplumBaseUrl: z.literal('https://api.medplum.com/'), projectId: z.literal(projectId), clientId: z.literal(clientId),
  clientSecret: z.string().min(16).max(4096), cookieSecret: z.string().min(32).max(256),
  patients: z.record(z.enum(scenarios), patient),
  staff: z.array(z.object({ membershipId: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/), profile: reference('Practitioner'), policy: reference('AccessPolicy'), name: z.string().min(1).max(200), role: z.enum(['physician', 'registered-dietitian', 'administrative']), patients: z.array(reference('Patient')).length(1), careTeams: z.array(reference('CareTeam')).max(3) }).strict()).length(4),
  mentalHealth: z.literal('phq4'),
  storageQualification: z.object({ signature: z.string().regex(/^[a-f0-9]{64}$/), payload: z.object({ schema: z.union([z.literal(2), z.literal(3)]), purpose: z.literal('synthetic-clinic-conditional-resumable'), deliveryContract: z.literal('conditional-resumable-v1'), mode: z.literal('live'), origin: z.string().url(), expiresAt: z.string(), nativeQuestionnaire: nativeBinding.optional(), identity: z.object({ endpoint: z.literal('https://api.medplum.com/fhir/R4/'), projectId: z.literal(projectId), clientId: z.literal(clientId), membershipId: z.literal(membershipId) }).passthrough() }).passthrough() }).strict(),
}).strict();

/** Server environment only. This structural check does not replace runtime signature/identity verification. */
export function hostedClinicConfig(environment: Record<string, string | undefined>): QualifiedClinicConfig {
  try {
    const raw = environment.CLINIC_CONFIG_JSON;
    if (!raw || Buffer.byteLength(raw) > 48_000) throw new Error();
    const parsed = schema.parse(JSON.parse(raw));
    const url = new URL(parsed.origin);
    if (url.protocol !== 'https:' || url.origin !== parsed.origin || url.username || url.password || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error();
    if (parsed.storageQualification.payload.origin !== parsed.origin || !Number.isFinite(Date.parse(parsed.storageQualification.payload.expiresAt)) || Date.parse(parsed.storageQualification.payload.expiresAt) <= Date.now()) throw new Error();
    if (scenarios.some(scenario => !parsed.patients[scenario])) throw new Error();
    return parsed as unknown as QualifiedClinicConfig;
  } catch { throw new Error('hosted-clinic-configuration-invalid'); }
}
