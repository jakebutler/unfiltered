import { z } from 'zod';

const name = z.string().regex(/^[a-z][a-z0-9-]{2,62}$/);
const nativeId = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/);
const secretReference = z.string().regex(/^unfiltered\/[a-z][a-z0-9-]{2,62}\/[a-z][a-z0-9-]{2,62}$/);
const origin = z.string().max(253).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password &&
      /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(url.hostname) && url.hostname.includes('.') &&
      !/^\d+(?:\.\d+){3}$/.test(url.hostname) && !url.hostname.endsWith('.localhost');
  } catch { return false; }
}, 'An exact HTTPS origin is required');
const baseUrl = z.string().refine(value => value.endsWith('/') && origin.safeParse(value.slice(0, -1)).success);
const topology = z.object({ compute: z.literal('single-private-node'), replicas: z.literal(1), tlsEdge: z.literal(true), privateDataServices: z.literal(true), encryptedDurableVolumes: z.literal(true) }).strict();
const gates = z.object({ phiEnabled: z.literal(false), liveProvidersEnabled: z.literal(false), complianceClaim: z.literal('none'), productionReview: z.literal('required') }).strict();
const common = { schema: z.literal(1), stackId: name, publicOrigin: origin, topology, gates };
const clinic = z.object({ ...common, product: z.literal('clinic'), authority: z.object({ medplumBaseUrl: baseUrl, projectId: nativeId, clientId: nativeId, membershipId: nativeId, runtimeSecretRef: secretReference, databaseNamespace: name, binaryNamespace: name }).strict() }).strict();
const research = z.object({ ...common, product: z.literal('research'), authority: z.object({ convexOrigin: origin, convexSiteOrigin: origin, authSecretRef: secretReference, gatewaySecretRef: secretReference, metadataNamespace: name, objectNamespace: name }).strict() }).strict();
export const deploymentManifestSchema = z.discriminatedUnion('product', [clinic, research]).superRefine((manifest, ctx) => {
  const refs = manifest.product === 'clinic' ? [manifest.authority.runtimeSecretRef] : [manifest.authority.authSecretRef, manifest.authority.gatewaySecretRef];
  if (refs.some(ref => !ref.startsWith(`unfiltered/${manifest.stackId}/`)) || new Set(refs).size !== refs.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Secret references must belong to this independent stack' });
  const namespaces = manifest.product === 'clinic' ? [manifest.authority.databaseNamespace, manifest.authority.binaryNamespace] : [manifest.authority.metadataNamespace, manifest.authority.objectNamespace];
  if (new Set(namespaces).size !== namespaces.length || namespaces.some(value => !value.startsWith(`${manifest.stackId}-`))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Storage namespaces must belong to this independent stack' });
  if (manifest.product === 'research' && new Set([manifest.publicOrigin, manifest.authority.convexOrigin, manifest.authority.convexSiteOrigin]).size !== 3) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Research ingress endpoints must be explicitly distinct' });
});
export type DeploymentManifest = z.infer<typeof deploymentManifestSchema>;
export type ClinicDeploymentManifest = Extract<DeploymentManifest, { product: 'clinic' }>;

/** Secret-free input only. Structural acceptance does not establish deployment readiness. */
export function parseDeploymentManifest(value: unknown): DeploymentManifest {
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > 16_384) throw new Error();
    return deploymentManifestSchema.parse(value);
  } catch { throw new Error('aws-deployment-manifest-invalid'); }
}
