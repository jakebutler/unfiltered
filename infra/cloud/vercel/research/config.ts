import { z } from 'zod';
import { HOSTED_DEPLOYMENT, HOSTED_CONVEX_SITE, parseHostedConfig } from '../../../../apps/research-server/src/hosted-runtime';
import { parseAnalysisConfig } from '../../../../apps/research-server/src/analysis-config';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema = z.object({ schema: z.literal(1), mode: z.enum(['deployable-candidate', 'offline-fixture']), canonicalOrigin: z.string(), deployment: z.literal(HOSTED_DEPLOYMENT), convexSite: z.literal(HOSTED_CONVEX_SITE), r2: z.object({ accountId: z.literal('728ae4b71b42dfcef062336c06bd8595'), bucket: z.literal('unfiltered-recordings'), namespace: z.string().regex(/^[a-z][a-z0-9-]{2,62}$/), deadlineMs: z.number().int().min(1).max(15000) }).strict(), maxSegmentBytes: z.number().int().min(1).max(4000000), maxResponseBytes: z.number().int().min(1).max(4000000), ffmpeg: z.object({ sha256: digest, bytes: z.number().int().min(64).max(150000000), architecture: z.literal('linux-x64'), version: z.string().min(1).max(100), source: z.string().url().startsWith('https://'), license: z.enum(['LGPL-2.1-or-later', 'LGPL-3.0-or-later', 'GPL-2.0-or-later', 'GPL-3.0-or-later']), licenseSha256: digest }).strict() }).strict();
export type ResearchPackageManifest = z.infer<typeof manifestSchema>;
export function parsePackageManifest(raw: unknown): ResearchPackageManifest {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid research package manifest');
  const value = parsed.data;
  let url: URL; try { url = new URL(value.canonicalOrigin); } catch { throw new Error('Invalid research package origin'); }
  if (url.protocol !== 'https:' || url.origin !== value.canonicalOrigin || url.port || url.username || url.password || value.mode === 'deployable-candidate' && /(?:^|\.)(?:invalid|test|localhost)$/.test(url.hostname) || value.mode === 'offline-fixture' && !/\.(?:invalid|test)$/.test(url.hostname)) throw new Error('Invalid research package origin');
  return Object.freeze(value);
}
const runtimeSchema = z.object({ gatewaySecret: z.string().regex(/^[a-f0-9]{64,128}$/), allocationId: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/), cleanupAllocationId: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/).optional(), speechEnabled: z.boolean().default(false), readinessQualifications: z.object({ interview: z.boolean().default(false), voice: z.boolean().default(false), capture: z.boolean().default(false), screenBaseline: z.boolean().default(false), analysis: z.boolean().default(false), expectedConfigurationDigest: digest.optional() }).strict().default({ interview: false, voice: false, capture: false, screenBaseline: false, analysis: false }), analysis: z.unknown().default({ enabled: false }), interview: z.object({ enabled: z.boolean(), model: z.enum(['qwen3.8-max', 'glm-5.3-flash']).optional(), timeoutMs: z.number().int().min(100).max(15000).default(15000), maxRequestBytes: z.number().int().min(1).max(64000).default(64000), maxOutputTokens: z.number().int().min(1).max(512).default(512) }).strict().default({ enabled: false }) }).strict();
export function hostedResearchConfig(environment: NodeJS.ProcessEnv, rawManifest: unknown, ffmpegExecutable: string) {
  const manifest = parsePackageManifest(rawManifest);
  if (manifest.mode !== 'deployable-candidate') throw new Error('Offline package cannot activate hosted runtime');
  let raw: unknown; try { raw = JSON.parse(environment.RESEARCH_RUNTIME_JSON ?? ''); } catch { throw new Error('Explicit private research runtime configuration required'); }
  const parsed = runtimeSchema.safeParse(raw); if (!parsed.success) throw new Error('Invalid private research runtime configuration');
  const runtime = parsed.data;
  const config = parseHostedConfig({ mode: 'hosted', deployment: manifest.deployment, convexSite: manifest.convexSite, publicOrigin: manifest.canonicalOrigin, gatewaySecret: runtime.gatewaySecret, allocationId: runtime.allocationId, ...(runtime.cleanupAllocationId ? { cleanupAllocationId: runtime.cleanupAllocationId } : {}), maxSegmentBytes: manifest.maxSegmentBytes, maxResponseBytes: manifest.maxResponseBytes, cleanupMode: 'durable' }, manifest);
  const analysis = parseAnalysisConfig((runtime.analysis as { enabled?: boolean })?.enabled === true ? { ...(runtime.analysis as object), ffmpegExecutable } : runtime.analysis);
  const secret = (name: string) => { const value = environment[name]; if (!value || value.length > 4096) throw new Error('Required research runtime credential unavailable'); return value; };
  if (runtime.interview.enabled && !runtime.interview.model) throw new Error('Explicit interview model required');
  return { manifest, config, analysis, interview: runtime.interview, speechEnabled: runtime.speechEnabled, readinessQualifications: runtime.readinessQualifications, r2Credentials: { accessKeyId: secret('RESEARCH_R2_ACCESS_KEY_ID'), secretAccessKey: secret('RESEARCH_R2_SECRET_ACCESS_KEY') }, modelKey: analysis.enabled || runtime.interview.enabled ? secret('DIGITALOCEAN_MODEL_ACCESS_KEY') : undefined, deepgramKey: runtime.speechEnabled ? secret('DEEPGRAM_API_KEY') : undefined, elevenlabsKey: runtime.speechEnabled ? secret('ELEVENLABS_API_KEY') : undefined };
}
