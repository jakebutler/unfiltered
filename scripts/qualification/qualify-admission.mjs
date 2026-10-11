/** Native CAS qualification only; never contacts inference or speech providers. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { runtimeProvider } from '../../.qualification-build/packages/clinic-api/src/runtime.js';
import { createProviderAdmission, noUnits } from '../../.qualification-build/packages/clinic-api/src/provider-admission.js';
const config = JSON.parse(readFileSync('infra/local/.clinic-config.json', 'utf8'));
const runtime = runtimeProvider(config, fetch);
const runId = `admission-${crypto.randomUUID()}`;
const policy = { id: runId, limits: Object.fromEntries(['digitalocean', 'deepgram', 'elevenlabs'].map(provider => [provider, { account: { requests: 2, inputBytes: 120000, outputTokens: 8192, characters: 2400, audioSeconds: 120 }, session: { requests: 2, inputBytes: 120000, outputTokens: 8192, characters: 2400, audioSeconds: 120 }, concurrency: 1, leaseMs: provider === 'digitalocean' ? 20000 : provider === 'deepgram' ? 70000 : 35000 }])) };
const admission = () => createProviderAdmission(async () => (await runtime()).client, policy);
const input = (id = crypto.randomUUID()) => ({ provider: 'digitalocean', sessionId: 'synthetic-admission-test', requestId: id, units: { ...noUnits(), requests: 1, inputBytes: 60000, outputTokens: 4096 } });
const report = { runId, startedAt: new Date().toISOString(), providerCalls: 0, creditsConsumed: 0, cashUsd: 0, checks: [] };
const path = `docs/implementation/evidence/${runId}.json`;
writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
try {
  const left = input(), right = input();
  const results = await Promise.allSettled([admission().reserve(left), admission().reserve(right)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.find(x => x.status === 'rejected')?.reason.code, 'provider-busy');
  report.checks.push('simultaneous native claims admit exactly one provider lease');
  const accepted = results[0].status === 'fulfilled' ? left : right;
  await results.find(x => x.status === 'fulfilled').value.settle('completed');
  await assert.rejects(admission().reserve(accepted), error => error.code === 'provider-attempt-already-reserved');
  report.checks.push('duplicate remains denied after settlement and admission recreation');
  await (await admission().reserve(input())).settle('completed');
  await assert.rejects(admission().reserve(input()), error => error.code === 'provider-budget-exhausted');
  report.checks.push('native durable budget remains exhausted after admission recreation');
  report.state = 'passed';
} catch (error) { report.state = 'failed'; report.errorCode = error?.code ?? 'assertion-or-native-error'; process.exitCode = 1; }
report.finishedAt = new Date().toISOString();
writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
