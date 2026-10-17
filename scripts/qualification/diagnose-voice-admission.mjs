/** Bounded loopback-only diagnostic. New fake-provider ledger; no patient or existing-ledger mutation. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { MedplumClient } from '../../.qualification-build/packages/clinical-core/src/medplum.js';
import { requestJson } from '../../.qualification-build/packages/clinical-core/src/transport.js';
import { createProviderAdmission, noUnits } from '../../.qualification-build/packages/clinic-api/src/provider-admission.js';
import { fixtureFetchDiagnostics, fixtureAdmissionDiagnostics } from './voice-fixture-diagnostics.mjs';

const configPath = 'infra/local/.clinic-config.json';
assert(!(statSync(configPath).mode & 0o077), 'private config required');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
assert(['localhost', '127.0.0.1'].includes(new URL(config.medplumBaseUrl).hostname));
const id = 'SP-F2-admission-' + randomUUID();
const report = { id, syntheticOnly: true, externalProviderRequests: 0, startedAt: new Date().toISOString(), state: 'running', checks: [] };
const path = `docs/implementation/evidence/${id}.json`;
const save = () => writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
const localFetch = fixtureFetchDiagnostics(config.medplumBaseUrl, report, save);
try {
  const token = (await requestJson(localFetch, new URL('oauth2/token', config.medplumBaseUrl).href, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret, scope: 'openid' }) }, 10000)).body;
  assert.equal(typeof token.access_token, 'string');
  const identity = (await requestJson(localFetch, new URL('auth/me', config.medplumBaseUrl).href, { headers: { Authorization: `Bearer ${token.access_token}` } }, 10000)).body;
  assert.equal(identity.project.id, config.projectId);
  const client = new MedplumClient({ baseUrl: new URL('fhir/R4/', config.medplumBaseUrl).href, accessToken: token.access_token, timeoutMs: 10000, mode: 'local' }, localFetch);
  const units = provider => ({ ...noUnits(), requests: 1, ...(provider === 'digitalocean' ? { inputBytes: 1000, outputTokens: 1024 } : provider === 'deepgram' ? { audioSeconds: 60 } : { characters: 1200 }) });
  const limits = Object.fromEntries(['digitalocean', 'deepgram', 'elevenlabs'].map(provider => {
    const total = Object.fromEntries(Object.entries(units(provider)).map(([key, value]) => [key, value * 3]));
    return [provider, { account: total, session: total, concurrency: 1, leaseMs: provider === 'digitalocean' ? 20000 : provider === 'deepgram' ? 70000 : 35000 }];
  }));
  const admission = fixtureAdmissionDiagnostics(createProviderAdmission(async () => client, { id, limits }), report, save);
  // Consecutive pairs exercise the shared-ledger CAS used by overlapping capture/output or settlement.
  for (const pair of [['deepgram', 'elevenlabs'], ['digitalocean', 'deepgram'], ['elevenlabs', 'digitalocean']]) {
    const leases = await Promise.all(pair.map(provider => admission.reserve({ provider, sessionId: id, requestId: randomUUID(), units: units(provider) })));
    await Promise.all(leases.map(lease => lease.settle('completed')));
    report.checks.push(`reserved and settled ${pair.join(' + ')} concurrently without external dispatch`); save();
  }
  report.state = 'passed';
} catch (error) {
  report.state = 'failed'; report.error = typeof error?.code === 'string' && /^[a-z-]{1,70}$/.test(error.code) ? error.code : 'diagnostic-assertion';
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ id, path, state: report.state, dependencyCalls: report.dependencies?.length, admissions: report.admissions?.map(({ provider, reservedMs, settledMs, failedMs, error }) => ({ provider, reservedMs, settledMs, failedMs, error })) }));
}
