// Local synthetic storage qualification using the scoped runtime client, never bootstrap admin.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const directory = fileURLToPath(new URL('.', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));

async function main() {
  if (!process.argv.includes('--allow-synthetic-writes')) throw new Error('synthetic-write-flag-required');
  const credentialsPath = directory + '.runtime.env';
  if (statSync(credentialsPath).mode & 0o077) throw new Error('runtime-credentials-must-be-private');
  const values = Object.fromEntries(readFileSync(credentialsPath, 'utf8').split('\n').filter(line => line && !line.startsWith('#')).map(line => {
    const index = line.indexOf('=');
    if (index < 1) throw new Error('invalid-local-runtime-configuration');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  const endpoint = new URL(values.MEDPLUM_BASE_URL);
  if (!['localhost', '127.0.0.1'].includes(endpoint.hostname) || endpoint.port !== '8103' || endpoint.protocol !== 'http:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw new Error('local-medplum-only');
  if (!values.MEDPLUM_CLIENT_ID || !values.MEDPLUM_CLIENT_SECRET || !values.MEDPLUM_PROJECT_ID) throw new Error('scoped-runtime-configuration-required');
  const response = await fetch(new URL('oauth2/token', endpoint), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: values.MEDPLUM_CLIENT_ID, client_secret: values.MEDPLUM_CLIENT_SECRET, scope: 'openid' }),
  });
  if (!response.ok) throw new Error('local-runtime-authentication-failed');
  const token = await response.json();
  if (typeof token.access_token !== 'string' || !token.access_token) throw new Error('invalid-local-token-response');
  const result = spawnSync(process.execPath, ['.qualification-build/scripts/qualification/cli.js', 'medplum', '--allow-synthetic-writes'], {
    cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024,
    env: { ...process.env, QUALIFICATION_MEDPLUM_MODE: 'local', QUALIFICATION_MEDPLUM_URL: new URL('fhir/R4/', endpoint).href, QUALIFICATION_MEDPLUM_TOKEN: token.access_token },
  });
  let report;
  try { report = JSON.parse(result.stdout); } catch { throw new Error('core-qualification-did-not-return-report'); }
  if (!report.runId || report.mode !== 'local' || !report.checks) throw new Error('invalid-core-report');
  report.localProjectId = values.MEDPLUM_PROJECT_ID;
  report.localIdentity = 'scoped-service-client';
  report.generatedAt = new Date().toISOString();
  const receipt = `${directory}core-${report.runId}.receipt.json`;
  writeFileSync(receipt, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ ...report, receipt }, null, 2));
  process.exitCode = result.status === 0 ? 0 : 1;
}

main().catch(error => {
  // Only our bounded error codes are emitted, never provider bodies or credential values.
  const code = error instanceof Error && /^[a-z][a-z-]+$/.test(error.message) ? error.message : 'local-core-qualification-failed';
  console.error(JSON.stringify({ status: 'failed', code }));
  process.exitCode = 1;
});
