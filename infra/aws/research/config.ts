import { z } from 'zod';
import { parseDeploymentManifest } from '../manifest.schema';
import { parseAnalysisConfig } from '../../../apps/research-server/src/analysis-config';
import { parseHostedConfig } from '../../../apps/research-server/src/hosted-runtime';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const binarySchema = z.object({ sha256: digest, bytes: z.number().int().min(64).max(150000000), architecture: z.literal('linux-x64'), version: z.string().min(1).max(100), source: z.string().url().startsWith('https://'), license: z.enum(['GPL-3.0-or-later','GPL-2.0-or-later','LGPL-3.0-or-later','LGPL-2.1-or-later']), licenseSha256: digest }).strict();
const credential=z.string().min(16).max(4096);
const off=z.object({enabled:z.literal(false)}).strict();
const interview=z.discriminatedUnion('enabled',[off,z.object({enabled:z.literal(true),qualification:z.literal('root-reviewed-research-interview'),model:z.enum(['qwen3.8-max','glm-5.3-flash']),timeoutMs:z.number().int().min(100).max(15000),maxRequestBytes:z.number().int().min(1).max(64000),maxOutputTokens:z.number().int().min(1).max(512)}).strict()]);
const speech=z.discriminatedUnion('enabled',[off,z.object({enabled:z.literal(true),qualification:z.literal('root-reviewed-continuous-research-speech')}).strict()]);
const providers=z.object({interview:interview.default({enabled:false}),speech:speech.default({enabled:false}),analysis:z.unknown().default({enabled:false}),credentials:z.object({digitalOceanKey:credential.optional(),deepgramKey:credential.optional(),elevenlabsKey:credential.optional()}).strict().default({})}).strict();
const runtimeSchema = z.object({ gatewaySecret: z.string().regex(/^[a-f0-9]{64,128}$/), allocationId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/), cleanupAllocationId: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/).optional(), credentialSource: z.literal('ec2-imdsv2'), s3: z.object({ bucket: z.string(), region: z.string(), accountId: z.string(), namespace: z.string(), kmsKeyArn: z.string(), deadlineMs: z.number().int().min(1).max(15000).default(15000) }).strict(), recovery: z.object({ state: z.literal('fresh-or-reconciled'), identity: z.string().regex(/^[a-f0-9]{64}$/) }).strict(), maxSegmentBytes: z.number().int().min(1).max(4000000), maxResponseBytes: z.number().int().min(1).max(4000000), liveProvidersEnabled: z.boolean().default(false), providers:providers.default({interview:{enabled:false},speech:{enabled:false},analysis:{enabled:false},credentials:{}}) }).strict();
export function awsResearchConfig(rawManifest: unknown, rawRuntime: unknown, rawBinary: unknown, ffmpegExecutable='/app/bin/ffmpeg') {
  const manifest = parseDeploymentManifest(rawManifest);
  if (manifest.product !== 'research') throw new Error('Research deployment profile required');
  const parsed=runtimeSchema.safeParse(rawRuntime);if(!parsed.success)throw new Error('Invalid private AWS research configuration');
  const runtime=parsed.data,binary=binarySchema.parse(rawBinary);
  const analysisInput=runtime.providers.analysis as {enabled?:boolean;ffmpegExecutable?:unknown};
  if(!analysisInput||Object.hasOwn(analysisInput,'ffmpegExecutable'))throw new Error('Packaged FFmpeg path required');
  const analysis=parseAnalysisConfig(analysisInput.enabled===true?{...analysisInput,ffmpegExecutable}:analysisInput);
  const anyEnabled=runtime.providers.interview.enabled||runtime.providers.speech.enabled||analysis.enabled;
  if(anyEnabled&&!runtime.liveProvidersEnabled||!anyEnabled&&runtime.liveProvidersEnabled)throw new Error('Explicit qualified provider activation required');
  if((runtime.providers.interview.enabled||analysis.enabled)&&!runtime.providers.credentials.digitalOceanKey||runtime.providers.speech.enabled&&(!runtime.providers.credentials.deepgramKey||!runtime.providers.credentials.elevenlabsKey))throw new Error('Explicit private provider credentials required');
  if (runtime.s3.namespace !== manifest.authority.objectNamespace || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(runtime.s3.bucket) || !/^[a-z]{2}-[a-z]+-[1-9]$/.test(runtime.s3.region) || !/^\d{12}$/.test(runtime.s3.accountId) || !new RegExp(`^arn:aws:kms:${runtime.s3.region}:${runtime.s3.accountId}:key/[a-f0-9-]{36}$`).test(runtime.s3.kmsKeyArn)) throw new Error('Research S3 profile mismatch');
  const binding = { canonicalOrigin: manifest.publicOrigin, deployment: manifest.authority.convexOrigin, convexSite: manifest.authority.convexSiteOrigin };
  const config = parseHostedConfig({ mode:'hosted', deployment:binding.deployment, convexSite:binding.convexSite, publicOrigin:manifest.publicOrigin, gatewaySecret:runtime.gatewaySecret, allocationId:runtime.allocationId, ...(runtime.cleanupAllocationId ? {cleanupAllocationId:runtime.cleanupAllocationId}:{}), maxSegmentBytes:runtime.maxSegmentBytes, maxResponseBytes:runtime.maxResponseBytes, cleanupMode:'durable' }, binding);
  return { manifest, runtime, binary, binding, config, analysis };
}
