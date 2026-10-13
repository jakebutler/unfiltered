/**
 * Local browser testing without the shared Medplum project: the real clinic handler over an in-memory FHIR store,
 * with the real DigitalOcean interpreter and safety reviewer. Synthetic data only; everything is lost on exit.
 * No speech transcription. DigitalOcean calls are hard-capped (LOCAL_DO_CALL_CAP, default 80) because this path
 * bypasses the hosted budget ledger.
 *
 *   npx tsx scripts/dev/local-mock-clinic.mts   then   npm run clinic:dev   and open http://127.0.0.1:5173
 *
 * Reads DIGITALOCEAN_MODEL_ACCESS_KEY from LOCAL_ENV_FILE (default: the main checkout's .env.local) without printing it.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createClinicHandler } from '../../packages/clinic-api/src/handler.ts';
import type { Runtime } from '../../packages/clinic-api/src/runtime.ts';
import type { ClinicApiConfig } from '../../packages/clinic-api/src/types.ts';
import { createIntakeInterpreter } from '../../packages/clinic-api/src/intake-interpreter.ts';
import { createSafetyReviewer } from '../../packages/clinic-api/src/safety-review.ts';
import { DO_ENDPOINT } from '../../packages/clinical-core/src/digitalocean.ts';
import { MedplumClient } from '../../packages/clinical-core/src/medplum.ts';
import { defaultInterpreterModel } from '../../apps/clinic-server/src/providers.ts';
import { nodeHttpHandler } from '../../apps/clinic-server/src/http.ts';
import { mockFhir } from '../qualification/mock-fhir.ts';

const envFile = process.env.LOCAL_ENV_FILE ?? '/Volumes/rexy/GitHub/unfiltered/.env.local';
const apiKey = readFileSync(envFile, 'utf8').split('\n').map(line => /^\s*DIGITALOCEAN_MODEL_ACCESS_KEY\s*=\s*"?([^"\s]+)"?/.exec(line)?.[1]).find(Boolean);
if (!apiKey) throw new Error('DIGITALOCEAN_MODEL_ACCESS_KEY missing');
const cap = Number(process.env.LOCAL_DO_CALL_CAP ?? 80);
let calls = 0;
const capped: typeof fetch = async (input, init) => {
  if (++calls > cap) throw new Error(`local DigitalOcean call cap (${cap}) reached`);
  console.log(`[do] call ${calls}/${cap}`);
  return fetch(input, init);
};

const origin = 'http://127.0.0.1:5173';
const patient = { reference: 'Patient/local-synthetic', displayName: 'Alex (synthetic)', description: 'Fictional local test patient', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
const config = { origin, cookieSecret: randomBytes(32).toString('hex'), mentalHealth: 'phq4', patients: Object.fromEntries(['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'].map(id => [id, patient])) } as ClinicApiConfig;
const client = new MedplumClient({ baseUrl: 'http://localhost:8103/fhir/R4/', accessToken: 'synthetic', mode: 'local', timeoutMs: 5000 }, mockFhir({ atomic: false }).fetcher);
const model = { endpoint: DO_ENDPOINT, model: defaultInterpreterModel, apiKey } as const;
const interpreter = createIntakeInterpreter({ ...model, maxOutputTokens: 1500, timeoutMs: 20000 }, capped);
// LOCAL_LOG_INTERPRETER=1 prints each turn's raw model output and what was kept (synthetic data only).
const logged: typeof interpreter = { interpret: async (context, signal) => {
  const result = await interpreter.interpret(context, signal), outcome = result.outcome;
  console.log(JSON.stringify({ text: context.source.text, displayed: context.displayed, raw: result.rawProposal, unresolved: outcome?.hasUnresolvedInterpretation,
    updates: outcome?.updates.map(update => `${update.topicId}.${update.path}=${update.answer.state}`), rejected: outcome?.rejectedCandidates?.map(entry => `${entry.topicId}.${entry.path}:${entry.reason}`) }));
  return result;
} };
const handler = createClinicHandler(config, {
  runtime: async () => ({ client, qualification: {} } as unknown as Runtime),
  adaptiveInterpreter: process.env.LOCAL_LOG_INTERPRETER ? logged : interpreter,
  safetyReviewer: createSafetyReviewer({ ...model, maxOutputTokens: 800, timeoutMs: 15000 }, capped),
  adaptiveTimeoutMs: 25000,
});
createServer(nodeHttpHandler(handler)).listen(8787, '127.0.0.1', () => console.log(`Local mock clinic API on http://127.0.0.1:8787 (in-memory FHIR, ${defaultInterpreterModel}, cap ${cap} calls)`));
