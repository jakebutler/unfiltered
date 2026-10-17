import { z } from 'zod';
import { createPrivateKey } from 'node:crypto';
import { parseDeploymentManifest, type ClinicDeploymentManifest } from '../manifest.schema.ts';

export type MedplumProfile = {
  schema: 1; product: 'medplum'; clinic: ClinicDeploymentManifest;
  platform: 'linux/arm64'; backendSecretRef: string;
  storage: { mount: '/srv/unfiltered-medplum'; rootGiB: 16; dataGiB: 40; maxBackupBytes: 67108864 };
  recovery: { traffic: 'sealed'; automaticReopen: false; postCheckpointReconciliation: 'required' };
};

/** Derived from the existing independent clinic identity; no second clinical domain. */
export function medplumProfile(input: unknown): MedplumProfile {
  const clinic = parseDeploymentManifest(input);
  if (clinic.product !== 'clinic' || new URL(clinic.authority.medplumBaseUrl).port) throw new Error('medplum-profile-invalid');
  return { schema: 1, product: 'medplum', clinic, platform: 'linux/arm64', backendSecretRef: `unfiltered/${clinic.stackId}/medplum`,
    storage: { mount: '/srv/unfiltered-medplum', rootGiB: 16, dataGiB: 40, maxBackupBytes: 67108864 },
    recovery: { traffic: 'sealed', automaticReopen: false, postCheckpointReconciliation: 'required' } };
}

const password = z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/);
const admin = z.object({ email: z.string().email().max(254), password,
  clientId: z.string().uuid(), clientSecret: password }).strict();
const secretSchema = z.object({ schema: z.literal(1), stackId: z.string(), databasePassword: password,
  redisPassword: password, signingKeyId: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
  signingKey: z.string().max(8192), bootstrapAdmin: admin.optional() }).strict();

/** Backend-only secret. No clinic cookie/provider/client credential fields are accepted. */
export function parseBackendSecret(input: unknown, profile: MedplumProfile) {
  try {
    if (Buffer.byteLength(JSON.stringify(input)) > 16384) throw new Error();
    const value = secretSchema.parse(input);
    if (value.stackId !== profile.clinic.stackId || profile.backendSecretRef === profile.clinic.authority.runtimeSecretRef) throw new Error();
    const key = createPrivateKey(value.signingKey);
    if (key.asymmetricKeyType !== 'rsa' || !key.asymmetricKeyDetails?.modulusLength || key.asymmetricKeyDetails.modulusLength < 2048 || key.asymmetricKeyDetails.modulusLength > 4096) throw new Error();
    return value;
  } catch { throw new Error('medplum-backend-secret-invalid'); }
}

export function serverConfig(profile: MedplumProfile, input: unknown, phase: 'initialize' | 'resume' | 'restore') {
  const secret = parseBackendSecret(input, profile);
  if (!['initialize', 'resume', 'restore'].includes(phase) || (phase === 'initialize') !== !!secret.bootstrapAdmin) throw new Error('medplum-secret-phase-invalid');
  return { port: 8103, baseUrl: profile.clinic.authority.medplumBaseUrl,
    appBaseUrl: `${profile.clinic.publicOrigin}/`, storageBaseUrl: `${profile.clinic.authority.medplumBaseUrl}storage/`,
    binaryStorage: 'file:/var/medplum/binary/',
    database: { host: 'postgres', port: 5432, dbname: 'medplum', username: 'medplum', password: secret.databasePassword },
    redis: { host: 'redis', port: 6379, password: secret.redisPassword },
    allowedOrigins: profile.clinic.publicOrigin, emailProvider: 'none', allowProjectSmtp: false,
    vmContextBotsEnabled: false, botCustomFunctionsEnabled: false, storeBotInput: false,
    workers: { enabled: [] }, autoDownloadEnabled: false,
    signingKeyId: secret.signingKeyId, signingKey: secret.signingKey,
    maxJsonSize: '1mb', maxBatchSize: '10mb', shutdownTimeoutMilliseconds: 30000,
    logLevel: 'error',
    ...(secret.bootstrapAdmin ? { defaultSuperAdminEmail: secret.bootstrapAdmin.email,
      defaultSuperAdminPassword: secret.bootstrapAdmin.password, defaultSuperAdminClientId: secret.bootstrapAdmin.clientId,
      defaultSuperAdminClientSecret: secret.bootstrapAdmin.clientSecret } : {}) };
}
