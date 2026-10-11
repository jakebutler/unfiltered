/** Root-only explicit phases. Import/default preflight performs zero cloud calls. */
import { readFile, writeFile, mkdir, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ConvexHttpClient } from 'convex/browser';
import dotenv from 'dotenv';
import { makeFunctionReference } from 'convex/server';
import { privateJson } from '../../apps/research-server/src/private-json.mjs';
import { TARGET, plan, phase, sha, freshSecrets, secretsValid, PHASES } from './cloud-bootstrap.mjs';
const directory = fileURLToPath(new URL('./.env.cloud-bootstrap/', import.meta.url));
const privatePath = join(directory, 'bootstrap.cloud.private.json');
const MANAGEMENT = 'https://api.convex.dev';
const allowedAPI = new Set(['/api/query', '/api/mutation', '/api/action', '/api/update_environment_variables']);
export async function boundedFetch(fetcher, origin, input, init = {}) {
  const url = new URL(String(input));
  if (url.origin !== origin || url.search || url.hash || url.username || url.password || (origin === TARGET.deployment ? !allowedAPI.has(url.pathname) || init.method !== 'POST' : !((url.pathname === `/api/deployment/${TARGET.deploymentName}/team_and_project` && init.method === 'GET') || (['/api/deployment/authorize_within_current_project', '/api/deployment/url_for_key', '/api/deployment/team_and_project_for_key'].includes(url.pathname) && init.method === 'POST')))) throw new Error('Unapproved cloud bootstrap request');
  const controller = new AbortController(); let timer, reader;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Cloud acknowledgement unknown')); }, 10_000); });
  try {
    const response = await Promise.race([fetcher(url.href, { ...init, redirect: 'error', signal: controller.signal }), deadline]);
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 65_536)) throw new Error('Cloud response exceeds bound');
    reader = response.body?.getReader(); const chunks = []; let size = 0;
    while (reader) {
      const part = await Promise.race([reader.read(), deadline]); if (part.done) break;
      size += part.value.byteLength; if (size > 65_536) throw new Error('Cloud response exceeds bound'); chunks.push(part.value);
    }
    const bytes = Buffer.concat(chunks);
    return new Response(bytes.length ? bytes : null, { status: response.status, statusText: '', headers: { 'Content-Type': 'application/json' } });
  } catch {
    controller.abort(); if (reader) await Promise.race([reader.cancel().catch(() => {}), deadline]).catch(() => {});
    throw new Error('Cloud request failed or acknowledgement unknown');
  } finally { clearTimeout(timer); }
}
export function pushEnvironment(key) {
  // Strict subset of installed CLI deployment.ts parsing: explicit dev prefix,
  // exact name before pipe, one nonempty token, no dotenv escapes/newlines.
  if (typeof key !== 'string' || key.length > 8192 || !/^dev:elegant-crane-662\|[A-Za-z0-9_=.-]+$/.test(key)) throw new Error('Exact development deployment key required');
  return `CONVEX_DEPLOY_KEY=${key}\n`;
}
export function exactPushEnvironment(key) {
  // Opaque admin credential, never prefix-reformatted. Single quotes preserve
  // $, #, double quotes and backslashes. Deny multiline/quote ambiguity.
  if (typeof key !== 'string' || !key || key.length > 8192 || /[\x00-\x1f\x7f']/.test(key) || key.endsWith('\\')) throw new Error('One-line opaque admin credential required');
  const text = `CONVEX_SELF_HOSTED_URL=${TARGET.deployment}\nCONVEX_SELF_HOSTED_ADMIN_KEY='${key}'\n`, parsed = dotenv.parse(text);
  if (Object.keys(parsed).length !== 2 || parsed.CONVEX_SELF_HOSTED_URL !== TARGET.deployment || parsed.CONVEX_SELF_HOSTED_ADMIN_KEY !== key) throw new Error('Exact credential encoding unconfirmed');
  return text;
}
async function readPrivateText(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await handle.stat(); if (!stat.isFile() || stat.mode & 0o077 || stat.size > 8500) throw new Error('Private push credential required'); return await handle.readFile('utf8'); } finally { await handle.close(); }
}
export function cloudAdapter(accessToken, fetcher = fetch, { pushEnvPath, exactPushEnvPath } = {}) {
  if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 8192) throw new Error('Existing private CLI authentication required');
  let admin, adminKey;
  const management = async (path, method, body) => {
    const response = await boundedFetch(fetcher, MANAGEMENT, MANAGEMENT + path, { method, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error('Existing deployment authorization unconfirmed');
    return response.json();
  };
  const client = () => { if (!admin) throw new Error('Exact target verification required'); return admin; };
  const fn = (kind, name, args) => client()[kind](makeFunctionReference(name), args);
  return {
    async verifyTarget() {
      const identity = await management(`/api/deployment/${TARGET.deploymentName}/team_and_project`, 'GET');
      if (identity.team !== TARGET.team || identity.project !== TARGET.project) throw new Error('Cloud project identity differs');
      // Existing-name authorization only. Never provision_and_authorize or
      // environment-selected dev/prod convenience paths; no fetch retries.
      const credentials = await management('/api/deployment/authorize_within_current_project', 'POST', { selectedDeploymentName: TARGET.deploymentName, projectSelection: { kind: 'teamAndProjectSlugs', teamSlug: TARGET.team, projectSlug: TARGET.project } });
      if (credentials.url !== TARGET.deployment || credentials.deploymentName !== TARGET.deploymentName || credentials.deploymentType !== 'dev' || typeof credentials.adminKey !== 'string' || !credentials.adminKey || credentials.adminKey.length > 8192) throw new Error('Existing deployment credentials differ');
      admin = new ConvexHttpClient(TARGET.deployment, { logger: false, fetch: (input, init) => boundedFetch(fetcher, TARGET.deployment, input, init) });
      adminKey = credentials.adminKey;
      admin.setAdminAuth(credentials.adminKey);
    },
    async environment(name) { const result = await fn('query', '_system/cli/queryEnvironmentVariables:get', { name }); if (result === null) return null; if (result?.name !== name || typeof result.value !== 'string') throw new Error('Environment readback unconfirmed'); return result.value; },
    async updateEnvironment(changes) { client(); const response = await boundedFetch(fetcher, TARGET.deployment, TARGET.deployment + '/api/update_environment_variables', { method: 'POST', headers: { Authorization: `Convex ${adminKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ changes }) }); if (!response.ok) throw new Error('Environment acknowledgement unconfirmed'); },
    async exportPushCredential({ readback }) {
      client(); if (!pushEnvPath || !isAbsolute(pushEnvPath)) throw new Error('Explicit private push credential path required');
      pushEnvironment(adminKey);
      const resolved = await management('/api/deployment/url_for_key', 'POST', { deployKey: adminKey });
      const project = await management('/api/deployment/team_and_project_for_key', 'POST', { deployKey: adminKey });
      if (resolved !== TARGET.deployment || project.team !== TARGET.team || project.project !== TARGET.project) throw new Error('Push credential target differs');
      if (!readback) await writeFile(pushEnvPath, pushEnvironment(adminKey), { mode: 0o600, flag: 'wx' });
      const handle = await open(pushEnvPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let text;
      try { const stat = await handle.stat(); if (!stat.isFile() || stat.mode & 0o077 || stat.size > 8250) throw new Error('Private push credential required'); text = await handle.readFile('utf8'); } finally { await handle.close(); }
      const key = text.startsWith('CONVEX_DEPLOY_KEY=') ? text.slice('CONVEX_DEPLOY_KEY='.length, -1) : null;
      if (pushEnvironment(key) !== text) throw new Error('Private push target differs');
      return { state: 'confirmed', writes: readback ? 0 : 1, path: pushEnvPath, fileSha256: sha(text), credentialSource: 'existing-name-authorization' };
    },
    async exportExactCredential({ readback }) {
      client(); if (!exactPushEnvPath || !isAbsolute(exactPushEnvPath)) throw new Error('Explicit private exact credential path required');
      if (!readback) await writeFile(exactPushEnvPath, exactPushEnvironment(adminKey), { mode: 0o600, flag: 'wx' });
      const text = await readPrivateText(exactPushEnvPath), parsed = dotenv.parse(text);
      if (exactPushEnvironment(parsed.CONVEX_SELF_HOSTED_ADMIN_KEY) !== text) throw new Error('Private exact push target differs');
      // Readback confirms the immutable local export/target; a newly authorized
      // key need not be identical to an older still-valid credential. Root CLI
      // acceptance checks actual authorization separately before mutation.
      return { state: 'confirmed', writes: readback ? 0 : 1, path: exactPushEnvPath, fileSha256: sha(text), credentialSource: 'existing-name-authorization', transportSelector: 'explicit-url-admin', deployment: TARGET.deployment };
    },
    query: (name, args) => fn('query', name, args), mutation: (name, args) => fn('mutation', name, args), action: (name, args) => fn('action', name, args),
  };
}
async function privateDirectory() {
  await mkdir(directory, { mode: 0o700 });
}
async function ensureDirectory() {
  try { await privateDirectory(); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077) throw new Error('Private cloud directory required');
}
export async function main(argv = process.argv.slice(2)) {
  const flags = new Set(['--prepare-private', '--execute']); const options = {};
  for (let i = 0; i < argv.length; i++) { const key = argv[i]; if (!['--manifest', '--allocation-id', '--expires-at', '--phase', '--request-id', '--cli-auth-file', '--readback-of', ...flags].includes(key) || key in options) throw new Error('Invalid explicit bootstrap arguments'); options[key] = flags.has(key) ? true : argv[++i]; }
  if (!isAbsolute(options['--manifest'] ?? '')) throw new Error('Explicit absolute cloud target manifest required');
  const manifest = JSON.parse(await readFile(options['--manifest'], 'utf8'));
  const prepared = plan(manifest, { allocationId: options['--allocation-id'], expiresAt: Date.parse(options['--expires-at']) });
  const paths = ['infra/research/cloud-bootstrap.mjs', 'infra/research/setup-cloud.mjs', 'infra/research/cloud-target.json', 'convex/bootstrap.ts', 'convex/schema.ts', 'convex/researchGatewayLeases.ts', 'convex/captureGateway.ts', 'convex/cleanupDue.ts'];
  const sourceHashes = {};
  for (const path of paths) sourceHashes[path] = sha(await readFile(new URL('../../' + path, import.meta.url), 'utf8'));
  const publicPlan = { ...prepared, sourceHashes };
  if (!options['--execute'] && !options['--prepare-private']) { if (options['--readback-of']) throw new Error('Readback requires explicit execution'); return publicPlan; }
  if (options['--execute'] && options['--prepare-private']) throw new Error('Private preparation is a separate phase');
  await ensureDirectory();
  if (options['--prepare-private']) {
    await writeFile(privatePath, JSON.stringify(freshSecrets(manifest)) + '\n', { mode: 0o600, flag: 'wx' });
    return { state: 'private-prepared', cloudCalls: 0, path: privatePath, providersActivated: false };
  }
  const phaseName = options['--phase'], requestId = options['--request-id'];
  if (!PHASES.includes(phaseName) || !/^[a-f0-9]{32}$/.test(requestId ?? '') || !isAbsolute(options['--cli-auth-file'] ?? '')) throw new Error('Explicit phase, unique request and private CLI authentication file required');
  const secrets = secretsValid(await privateJson(privatePath), manifest), prefix = phaseName === 'append-allocation' ? `${phaseName}.${prepared.allocation.allocationId}` : phaseName;
  const intentPath = join(directory, `${prefix}.intent.json`), resultPath = join(directory, `${requestId}.result.json`);
  const binding = { phase: phaseName, credentialId: secrets.credentialId, planHash: sha(prepared), sourceHashes };
  const readbackId = options['--readback-of'];
  if (readbackId) {
    if (!/^[a-f0-9]{32}$/.test(readbackId) || readbackId === requestId) throw new Error('Exact original request required');
    const original = await privateJson(intentPath);
    if (original.requestId !== readbackId || sha(original.binding) !== sha(binding)) throw new Error('Original phase binding differs');
  }
  // Exclusive intent BEFORE authorization or any cloud request. An existing
  // phase intent allows only separately receipted read-only reconciliation.
  await writeFile(readbackId ? join(directory, `${requestId}.readback.intent.json`) : intentPath, JSON.stringify({ requestId, binding, readbackOf: readbackId ?? null, at: new Date().toISOString() }) + '\n', { mode: 0o600, flag: 'wx' });
  let receipt;
  try {
    const auth = await privateJson(resolve(options['--cli-auth-file']));
    const result = await phase(phaseName, prepared, secrets, cloudAdapter(auth.accessToken, fetch, { pushEnvPath: join(directory, 'push.cloud.env'), exactPushEnvPath: join(directory, 'push-exact.cloud.env') }), { readback: Boolean(readbackId) });
    receipt = { requestId, binding, readbackOf: readbackId ?? null, ...result, deploymentType: 'dev', providersActivated: false, schedulerActivated: false };
  } catch { receipt = { requestId, binding, readbackOf: readbackId ?? null, state: 'failed-or-unknown', retryAllowed: false, providersActivated: false, schedulerActivated: false }; }
  await writeFile(resultPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(result => { console.log(JSON.stringify(result, null, 2)); if (result.state === 'failed-or-unknown' || result.state === 'unconfirmed') process.exitCode = 1; }).catch(() => { console.error('Cloud bootstrap refused or unconfirmed. No automatic retry; retain intent and private credentials.'); process.exitCode = 1; });
}
