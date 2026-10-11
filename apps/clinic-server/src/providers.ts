import { readFileSync, statSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { isAbsolute } from 'node:path';
import { DO_ENDPOINT, DO_MODELS } from '../../../packages/clinical-core/src/digitalocean.js';
import { createProviderAdmission, type ProviderBudgetPolicy } from '../../../packages/clinic-api/src/provider-admission.js';
import { boundedAdaptiveProposer, boundedIntakeInterpreter, speechAdmission } from '../../../packages/clinic-api/src/bounded-providers.js';
import { createIntakeInterpreter } from '../../../packages/clinic-api/src/intake-interpreter.js';
import type { Runtime } from '../../../packages/clinic-api/src/runtime.js';

export interface ClinicProviderWiring {
  adaptiveProposer?: import('../../../packages/clinic-api/src/adaptive.js').AdaptiveProposer;
  /** Simple single-call interpreter (intake-interpreter-v1). When present it is used instead of adaptiveProposer. */
  adaptiveInterpreter?: import('../../../packages/clinic-api/src/intake-interpreter.js').IntakeInterpreter;
  adaptiveGroupedExtractor?: import('../../../packages/clinic-api/src/adaptive-extraction-grouped-session-v2.js').GroupedExtractionProposer;
  adaptiveFullCapture?: boolean;
  adaptiveTimeoutMs?: number;
  provisionalQualification?: import('../../../packages/clinic-api/src/provisional-projection.js').ProvisionalQualification;
  finalRepresentationQualification?: import('../../../packages/clinic-api/src/final-representation.js').FinalRepresentationQualification;
  speech?: Omit<import('./speech.js').NodeSpeechOptions, 'access' | 'ingress'>;
}

/** Default chosen from the bounded live eval (scripts/dev/intake-interpreter-eval.mts). */
export const defaultInterpreterModel = 'qwen3.8-max' satisfies typeof DO_MODELS[number];
function interpreterConfig(apiKey: string) {
  const model = (process.env.CLINIC_ADAPTIVE_MODEL || defaultInterpreterModel) as typeof DO_MODELS[number];
  if (!DO_MODELS.includes(model)) throw new Error('unsupported-adaptive-model');
  return { endpoint: DO_ENDPOINT, model, apiKey, maxOutputTokens: 1500, timeoutMs: 14000 } as const;
}
function interpreterMode(): 'intake-v1' | undefined {
  const mode = process.env.CLINIC_ADAPTIVE_INTERPRETER;
  if (!mode) return;
  if (mode !== 'intake-v1') throw new Error('unknown-adaptive-interpreter');
  return mode;
}
function loadPrivateEnvFile() {
  const envPath = process.env.CLINIC_PROVIDER_ENV_FILE;
  if (!envPath) return;
  if (!isAbsolute(envPath) || (statSync(envPath).mode & 0o077)) throw new Error('provider-env-must-be-private');
  loadEnvFile(envPath);
}
const doApiKey = () => process.env.DIGITALOCEAN_MODEL_ACCESS_KEY || process.env.DIGITALOCEAN_MODEL_ACESS_KEY;

/** Opt-in local/demo wiring. No implicit enablement merely because a key exists. */
export function configuredProviders(runtime: () => Promise<Runtime>): ClinicProviderWiring {
  const settingsPath = process.env.CLINIC_PROVIDER_SETTINGS;
  const envInterpreter = interpreterMode();
  if (!settingsPath) {
    // Explicit env opt-in for the simple interpreter only (no private budget policy file).
    if (envInterpreter !== 'intake-v1') return {};
    loadPrivateEnvFile();
    const apiKey = doApiKey();
    if (!apiKey?.trim()) throw new Error('digitalocean-model-access-key-required');
    return { adaptiveInterpreter: createIntakeInterpreter(interpreterConfig(apiKey)) };
  }
  if (!isAbsolute(settingsPath) || (statSync(settingsPath).mode & 0o077)) throw new Error('provider-settings-must-be-private');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { canonicalEnabled?: boolean; adaptiveEnabled?: boolean; adaptiveInterpreter?: 'intake-v1'; qualification?: string; speechEnabled?: boolean; speechQualification?: string; policy: ProviderBudgetPolicy };
  // Canonical candidate has no qualified settings loader yet. Never silently use legacy instead.
  if (settings.canonicalEnabled === true) throw new Error('canonical-qualification-required');
  if (settings.adaptiveInterpreter !== undefined && settings.adaptiveInterpreter !== 'intake-v1') throw new Error('unknown-adaptive-interpreter');
  if (settings.adaptiveEnabled !== true && settings.speechEnabled !== true) return {};
  if (settings.adaptiveEnabled === true && settings.qualification !== 'root-reviewed-synthetic-adaptive') throw new Error('adaptive-qualification-required');
  if (settings.speechEnabled === true && settings.speechQualification !== 'root-reviewed-synthetic-speech') throw new Error('speech-qualification-required');
  loadPrivateEnvFile();
  const apiKey = doApiKey();
  if (settings.adaptiveEnabled === true && !apiKey?.trim()) throw new Error('digitalocean-model-access-key-required');
  const admission = createProviderAdmission(async () => (await runtime()).client, settings.policy);
  const deepgramApiKey = process.env.DEEPGRAM_API_KEY, elevenlabsApiKey = process.env.ELEVENLABS_API_KEY;
  if (settings.speechEnabled === true && (!deepgramApiKey?.trim() || !elevenlabsApiKey?.trim())) throw new Error('speech-credentials-required');
  const useInterpreter = settings.adaptiveInterpreter === 'intake-v1' || envInterpreter === 'intake-v1';
  return {
    ...(settings.adaptiveEnabled === true ? useInterpreter
      ? { adaptiveInterpreter: boundedIntakeInterpreter(interpreterConfig(apiKey!), admission) }
      : { adaptiveProposer: boundedAdaptiveProposer({ endpoint: DO_ENDPOINT, model: 'qwen3.8-max', apiKey: apiKey!, maxOutputTokens: 4096, timeoutMs: 12000 }, admission) } : {}),
    ...(settings.speechEnabled === true ? { speech: { admission: speechAdmission(admission), deepgramApiKey: deepgramApiKey!, elevenlabsApiKey: elevenlabsApiKey! } } : {}),
  };
}

/** Hosted wiring: the interpreter only, always behind the shared Medplum budget ledger. */
export function hostedInterpreterProviders(runtime: () => Promise<Runtime>, env: Record<string, string | undefined> = process.env): ClinicProviderWiring {
  if (!env.CLINIC_ADAPTIVE_INTERPRETER) return {};
  if (env.CLINIC_ADAPTIVE_INTERPRETER !== 'intake-v1') throw new Error('unknown-adaptive-interpreter');
  const apiKey = env.DIGITALOCEAN_MODEL_ACCESS_KEY;
  if (!apiKey?.trim()) throw new Error('digitalocean-model-access-key-required');
  if (!env.CLINIC_PROVIDER_POLICY_JSON) throw new Error('provider-budget-policy-required');
  const admission = createProviderAdmission(async () => (await runtime()).client, JSON.parse(env.CLINIC_PROVIDER_POLICY_JSON) as ProviderBudgetPolicy);
  return { adaptiveInterpreter: boundedIntakeInterpreter(interpreterConfig(apiKey), admission) };
}
