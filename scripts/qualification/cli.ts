import { DigitalOceanConfig, DO_ENDPOINT, DO_MODELS, digitalOcean } from '../../packages/clinical-core/src/digitalocean.js';
import { ClinicalError } from '../../packages/clinical-core/src/domain.js';
import { IDENTIFIER_SYSTEM, identifierQuery } from '../../packages/clinical-core/src/fhir.js';
import { MedplumClient, fhirResource, type MedplumConfig } from '../../packages/clinical-core/src/medplum.js';
import { qualifyMedplum } from '../../packages/clinical-core/src/qualification.js';
import { fixture } from './fixture.js';
import { mockFhir } from './mock-fhir.js';

const env = process.env;
function medplumConfig(): MedplumConfig | undefined {
  if (!env.QUALIFICATION_MEDPLUM_URL && !env.QUALIFICATION_MEDPLUM_TOKEN && !env.QUALIFICATION_MEDPLUM_MODE) return undefined;
  if (!env.QUALIFICATION_MEDPLUM_URL || !env.QUALIFICATION_MEDPLUM_TOKEN || !['local', 'live'].includes(env.QUALIFICATION_MEDPLUM_MODE ?? '')) throw new ClinicalError('incomplete-medplum-configuration');
  return { baseUrl: env.QUALIFICATION_MEDPLUM_URL, accessToken: env.QUALIFICATION_MEDPLUM_TOKEN, mode: env.QUALIFICATION_MEDPLUM_MODE as 'local' | 'live', timeoutMs: 10000 };
}
function inferenceStatus() {
  const values = [env.QUALIFICATION_DO_ENDPOINT, env.QUALIFICATION_DO_API_KEY, env.QUALIFICATION_DO_MODEL];
  if (values.every(v => !v)) return { status: 'not-configured', qualification: 'pending', calls: 0 };
  if (!values.every(Boolean)) return { status: 'invalid-configuration', qualification: 'pending', calls: 0 };
  try {
    digitalOcean({ endpoint: env.QUALIFICATION_DO_ENDPOINT as typeof DO_ENDPOINT, apiKey: env.QUALIFICATION_DO_API_KEY!, model: env.QUALIFICATION_DO_MODEL as DigitalOceanConfig['model'], timeoutMs: 10000, maxOutputTokens: 256 });
    return { status: 'configured', qualification: 'pending', endpoint: DO_ENDPOINT, model: env.QUALIFICATION_DO_MODEL, calls: 0 };
  } catch { return { status: 'invalid-configuration', qualification: 'pending', calls: 0 }; }
}
async function main() {
  const command = process.argv[2] ?? 'status';
  if (command === 'status') {
    let medplum: unknown;
    try {
      const config = medplumConfig();
      medplum = config ? { status: 'configured', mode: new MedplumClient(config).config.mode, qualification: 'pending' } : { status: 'not-configured', mode: 'none', qualification: 'pending' };
    } catch { medplum = { status: 'invalid-configuration', qualification: 'pending' }; }
    console.log(JSON.stringify({ command, medplum, inference: inferenceStatus(), allowedModels: DO_MODELS, networkCalls: 0 }, null, 2));
    return;
  }
  if (command === 'mock') {
    const config: MedplumConfig = { baseUrl: 'http://127.0.0.1:8103/fhir/R4/', accessToken: 'mock-only', mode: 'local', timeoutMs: 1000 };
    const report = await qualifyMedplum(config, await fixture(), mockFhir({ atomic: !process.argv.includes('--non-atomic') }).fetcher, true);
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (command !== 'medplum') throw new ClinicalError('usage-status-or-mock-or-medplum');
  const config = medplumConfig();
  if (!config) throw new ClinicalError('medplum-not-configured');
  if (!process.argv.includes('--allow-synthetic-writes')) throw new ClinicalError('synthetic-write-flag-required');
  if (config.mode === 'live' && !process.argv.includes('--allow-live')) throw new ClinicalError('live-write-flag-required');
  const client = new MedplumClient(config);
  const fixtureId = `qualification-${crypto.randomUUID()}`;
  // Only newly created fictional identities are used by this CLI. No name/email matching.
  const patient = fhirResource((await client.request('Patient', 'POST', { resourceType: 'Patient', active: true, identifier: [{ system: IDENTIFIER_SYSTEM, value: `${fixtureId}.patient` }], name: [{ text: 'SYNTHETIC QUALIFICATION ONLY' }] }, { 'If-None-Exist': identifierQuery(`${fixtureId}.patient`) })).body);
  const careTeam = fhirResource((await client.request('CareTeam', 'POST', { resourceType: 'CareTeam', status: 'active', name: 'SYNTHETIC QUALIFICATION ONLY', identifier: [{ system: IDENTIFIER_SYSTEM, value: `${fixtureId}.careteam` }], subject: { reference: `Patient/${patient.id}` } }, { 'If-None-Exist': identifierQuery(`${fixtureId}.careteam`) })).body);
  if (!patient.id || !careTeam.id) throw new ClinicalError('synthetic-fixture-not-confirmed');
  const report = await qualifyMedplum(config, await fixture(`Patient/${patient.id}`, `CareTeam/${careTeam.id}`, fixtureId));
  report.retainedSyntheticIdentifiers.push(`${fixtureId}.patient`, `${fixtureId}.careteam`);
  console.log(JSON.stringify(report, null, 2));
  if (report.nativeTransactions === 'not-qualified' || report.handoff !== 'received' || !Object.values(report.checks).every(Boolean)) process.exitCode = 1;
}
main().catch(error => {
  // Do not expose raw HTTP errors, tokens, response bodies, or patient content.
  console.error(JSON.stringify({ status: 'failed', code: error instanceof ClinicalError ? error.code : 'qualification-operation-failed' }));
  process.exitCode = 1;
});
