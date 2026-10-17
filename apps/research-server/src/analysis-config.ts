import { z } from 'zod';
import { isAbsolute, resolve } from 'node:path';
import { privateJson } from './config';
import { digitalOceanAnalysis, validateRuntime, type AnalysisRuntime } from './analysis';
import { ffmpegFrames } from './frames';
import { DO_ENDPOINT } from '../../../packages/clinical-core/src/digitalocean';
import type { Fetch } from '../../../packages/clinical-core/src/transport';

const disabled = z.object({ enabled: z.literal(false) }).strict();
const enabled = z.object({ enabled: z.literal(true), textOnly: z.boolean().default(false), provider: z.literal('digitalocean'), model: z.literal('qwen3.8-max'), qualificationId: z.literal('DO-V1'), ffmpegExecutable: z.string().max(4096).refine(path => isAbsolute(path) && !path.includes('\0')), timeoutMs: z.number().int().min(100).max(30_000).default(15_000), maxRequestBytes: z.number().int().min(1).max(64_000).default(64_000), reservations: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/), maxInputBytes: z.number().int().min(1).max(64_000), maxOutputTokens: z.number().int().min(1).max(2048), expiresAt: z.number().int().positive() }).strict()).min(1).max(8) }).strict();
const schema = z.discriminatedUnion('enabled', [disabled, enabled]);
export type ResearchAnalysisConfig = z.infer<typeof schema>;
export function parseAnalysisConfig(raw: unknown): ResearchAnalysisConfig {
  const parsed = schema.safeParse(raw);
  // Zod error payloads may echo rejected secret fields. Expose only a fixed startup error.
  if (!parsed.success || parsed.data.enabled && new Set(parsed.data.reservations.map(r => r.id)).size !== parsed.data.reservations.length) throw new Error('Invalid private research analysis configuration');
  return parsed.data;
}
export function assembleAnalysisRuntime(config: ResearchAnalysisConfig, keyFromEnv: () => string | undefined, fetcher?: Fetch): AnalysisRuntime {
  config = parseAnalysisConfig(config);
  if (!config.enabled) return Object.freeze({ reservations: [], visionQualified: false });
  const key = keyFromEnv(); if (!key?.trim() || key.length > 4096) throw new Error('Research analysis key unavailable');
  const reservations = Object.freeze(config.reservations.map(r => Object.freeze({ ...r, model: config.model, live: true })));
  const runtime: AnalysisRuntime = Object.freeze({ reservations, textOnly: config.textOnly, visionQualified: true, maxFrames: 1, maxRequestBytes: config.maxRequestBytes, extractor: ffmpegFrames(config.ffmpegExecutable), provider: digitalOceanAnalysis({ endpoint: DO_ENDPOINT, apiKey: key, model: config.model, timeoutMs: config.timeoutMs, maxOutputTokens: Math.max(...reservations.map(r => r.maxOutputTokens)), maxRequestBytes: config.maxRequestBytes, responseFormat: 'json' }, fetcher) });
  validateRuntime(runtime); return runtime;
}
export async function loadAnalysisRuntime(path?: string, environment: NodeJS.ProcessEnv = process.env): Promise<AnalysisRuntime> {
  if (!path) return assembleAnalysisRuntime({ enabled: false }, () => undefined);
  const config = parseAnalysisConfig(await privateJson(resolve(path)));
  return assembleAnalysisRuntime(config, () => environment.DIGITALOCEAN_MODEL_ACCESS_KEY);
}
