import { readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLOUD_API_BASE, CLOUD_PROJECT_ID, INVENTORY_TYPES, seedPlan } from './clinic-manifest.mjs';

const idPattern = /^[A-Za-z0-9.-]{1,64}$/;
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
function fail(code) { throw new Error(code); }

export function credentialsFromFile(path) {
  const stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o077)) fail('credentials-file-must-be-private');
  const values = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(MEDPLUM_CLIENT_ID|MEDPLUM_CLIENT_SECRET)\s*=\s*(.*?)\s*$/);
    if (match) {
      if (values[match[1]] !== undefined) fail('duplicate-medplum-credential-setting');
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      values[match[1]] = value;
    }
  }
  if (!idPattern.test(values.MEDPLUM_CLIENT_ID ?? '') || !values.MEDPLUM_CLIENT_SECRET?.trim()) fail('medplum-client-credentials-required');
  return { clientId: values.MEDPLUM_CLIENT_ID, clientSecret: values.MEDPLUM_CLIENT_SECRET };
}

/** OAuth authentication plus GET-only FHIR inventory. Does not qualify writes. */
export async function inventory({ clientId, clientSecret, fetcher = fetch, maxPages = 5 }) {
  if (!idPattern.test(clientId ?? '') || !clientSecret?.trim() || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10) fail('invalid-preflight-configuration');
  let requestCount = 0;
  const request = async (path, init = {}) => {
    const url = new URL(path, CLOUD_API_BASE);
    if (url.origin !== new URL(CLOUD_API_BASE).origin || url.username || url.password || url.hash) fail('preflight-origin-mismatch');
    requestCount++;
    let response;
    try { response = await fetcher(url.href, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) }); }
    catch { fail('preflight-network-failed-no-retry'); }
    if (!response.ok) { await response.body?.cancel(); return { status: response.status }; }
    let body;
    try { body = await response.json(); } catch { fail('preflight-invalid-json'); }
    return { status: response.status, body };
  };
  const tokenResult = await request('oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'openid' }) });
  if (typeof tokenResult.body?.access_token !== 'string') fail(`preflight-authentication-failed-${tokenResult.status}`);
  const headers = { Authorization: `Bearer ${tokenResult.body.access_token}`, Accept: 'application/fhir+json', 'X-Medplum': 'extended' };
  const meResult = await request('auth/me', { headers });
  const me = record(meResult.body), project = record(me.project), profile = record(me.profile), membership = record(me.membership);
  if (project.id !== CLOUD_PROJECT_ID || project.superAdmin === true || (membership.project !== undefined && membership.project?.reference !== `Project/${CLOUD_PROJECT_ID}`) || !idPattern.test(membership.id ?? '') || profile.resourceType !== 'ClientApplication' || profile.id !== clientId || membership.profile?.reference !== `ClientApplication/${clientId}`) fail('preflight-identity-project-mismatch');
  // auth/me deliberately projects only a subset of Project. Read the exact
  // authenticated project to establish feature flags, if this identity may.
  const projectResult = await request(`fhir/R4/Project/${CLOUD_PROJECT_ID}`, { headers });
  if (projectResult.status === 200 && (projectResult.body?.resourceType !== 'Project' || projectResult.body?.id !== CLOUD_PROJECT_ID)) fail('preflight-project-read-mismatch');
  const projectDetails = projectResult.status === 200 ? projectResult.body : undefined;
  const expectedPolicy = record(me.accessPolicy);
  const output = {
    schema: 1, kind: 'read-only-project-inventory', capturedAt: new Date().toISOString(),
    endpoint: CLOUD_API_BASE, projectId: CLOUD_PROJECT_ID,
    identity: { clientId, membershipId: membership.id, admin: membership.admin === true, policyId: typeof expectedPolicy.id === 'string' ? expectedPolicy.id : null },
    projectDetailHttpStatus: projectResult.status,
    features: Array.isArray(projectDetails?.features) ? projectDetails.features.filter(x => typeof x === 'string') : [],
    projectHasTransactionFeature: projectDetails ? projectDetails.features?.includes('transaction-bundles') === true : null,
    bounds: { types: INVENTORY_TYPES.length, maxPagesPerType: maxPages, pageSize: 100 },
    coverage: 'listed-resource-types-only-not-an-account-wide-or-deletion-inventory',
    nativeAtomicity: 'not-tested', directRoleAuthorization: 'not-tested', hostedPlan: 'not-verified',
    resources: {}, requests: 0,
  };
  for (const type of INVENTORY_TYPES) {
    let path = `fhir/R4/${type}?_elements=id,meta&_count=100&_total=accurate`;
    const rows = [], seenPaths = new Set();
    let total, complete = false, unavailable;
    for (let page = 0; page < maxPages; page++) {
      if (seenPaths.has(path)) fail('preflight-pagination-cycle');
      seenPaths.add(path);
      const result = await request(path, { headers });
      if (result.status !== 200) { unavailable = result.status; break; }
      const bundle = record(result.body);
      if (bundle.resourceType !== 'Bundle' || bundle.type !== 'searchset' || (bundle.entry !== undefined && !Array.isArray(bundle.entry)) || (bundle.link !== undefined && !Array.isArray(bundle.link))) fail('preflight-invalid-search');
      if (Number.isInteger(bundle.total) && bundle.total >= 0) total = bundle.total;
      for (const entry of bundle.entry ?? []) {
        const resource = record(entry.resource), meta = record(resource.meta);
        if (resource.resourceType !== type || !idPattern.test(resource.id ?? '') || meta.project !== CLOUD_PROJECT_ID) fail('preflight-resource-project-mismatch');
        if (rows.some(row => row.id === resource.id)) fail('preflight-duplicate-resource');
        rows.push({ id: resource.id, ...(typeof meta.versionId === 'string' ? { versionId: meta.versionId } : {}) });
      }
      if ((bundle.entry?.length ?? 0) > 100) fail('preflight-page-limit-exceeded');
      const nextLinks = (bundle.link ?? []).filter(link => link.relation === 'next');
      if (nextLinks.length > 1) fail('preflight-ambiguous-continuation');
      if (!nextLinks.length) { complete = true; break; }
      const next = new URL(nextLinks[0].url, CLOUD_API_BASE);
      if (next.origin !== new URL(CLOUD_API_BASE).origin || next.pathname !== `/fhir/R4/${type}` || next.username || next.password || next.hash) fail('preflight-unsafe-continuation');
      path = next.href;
    }
    output.resources[type] = { observed: rows.length, ...(total !== undefined ? { reportedTotal: total } : {}), complete, ...(unavailable ? { unavailableHttpStatus: unavailable } : {}), references: rows };
  }
  output.requests = requestCount;
  output.completeForListedTypes = Object.values(output.resources).every(item => item.complete);
  return output;
}

// Mirrors packages/clinic-api/src/deployment-qualification.ts: absent /auth/me features mean
// "none" only from Medplum 5.1.4 (medplum PR #8713); anything else fails closed.
export function serverProjectsProjectFeatures(serverVersion) {
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+][0-9A-Za-z.-]*)?$/.exec(typeof serverVersion === 'string' ? serverVersion : '');
  if (!match) return false;
  const actual = match.slice(1).map(Number), minimum = [5, 1, 4];
  for (let index = 0; index < 3; index++) if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  return true;
}
const featureList = (value, code) => {
  const features = value ?? [];
  if (!Array.isArray(features) || features.length > 64 || features.some(feature => typeof feature !== 'string' || !feature || feature.length > 128)) fail(code);
  return [...features].sort();
};
/** Pure comparison: the admin-read Project resource and the runtime /auth/me projection must report the same features. */
export function projectFeatureCalibration({ meProject, adminProject, serverVersion }) {
  const me = record(meProject), admin = record(adminProject);
  if (me.id !== CLOUD_PROJECT_ID || admin.resourceType !== 'Project' || admin.id !== CLOUD_PROJECT_ID) fail('calibration-project-identity-mismatch');
  if (!serverProjectsProjectFeatures(serverVersion)) fail('calibration-server-does-not-project-features');
  const authMeFeatures = featureList(me.features, 'calibration-auth-me-features-invalid'), adminFeatures = featureList(admin.features, 'calibration-admin-features-invalid');
  if (JSON.stringify(authMeFeatures) !== JSON.stringify(adminFeatures)) fail('calibration-project-features-mismatch');
  const field = name => ({ authMe: me[name] ?? null, admin: admin[name] ?? null, match: (me[name] ?? null) === (admin[name] ?? null) });
  return { features: authMeFeatures, featuresMatch: true, otherProjectedFields: { name: field('name'), strictMode: field('strictMode'), superAdmin: field('superAdmin') } };
}

/**
 * GET-only observation of the runtime client's /auth/me Project projection. With `calibrate`, the
 * operator has temporarily granted project admin; the exact Project resource is also read and its
 * features must equal the /auth/me features. The record contains no token or secret.
 */
export async function observeProjectFeatures({ clientId, clientSecret, fetcher = fetch, calibrate = false }) {
  if (!idPattern.test(clientId ?? '') || !clientSecret?.trim()) fail('invalid-preflight-configuration');
  let requestCount = 0;
  const request = async (path, init = {}) => {
    const url = new URL(path, CLOUD_API_BASE);
    if (url.origin !== new URL(CLOUD_API_BASE).origin || url.username || url.password || url.hash) fail('preflight-origin-mismatch');
    requestCount++;
    let response;
    try { response = await fetcher(url.href, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) }); }
    catch { fail('preflight-network-failed-no-retry'); }
    if (!response.ok) { await response.body?.cancel(); return { status: response.status }; }
    try { return { status: response.status, body: await response.json() }; } catch { fail('preflight-invalid-json'); }
  };
  const tokenResult = await request('oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'openid' }) });
  if (typeof tokenResult.body?.access_token !== 'string') fail(`preflight-authentication-failed-${tokenResult.status}`);
  const headers = { Authorization: `Bearer ${tokenResult.body.access_token}`, Accept: 'application/fhir+json', 'X-Medplum': 'extended' };
  const me = record((await request('auth/me', { headers })).body), project = record(me.project), profile = record(me.profile), membership = record(me.membership);
  if (project.id !== CLOUD_PROJECT_ID || project.superAdmin === true || profile.resourceType !== 'ClientApplication' || profile.id !== clientId || membership.profile?.reference !== `ClientApplication/${clientId}` || !idPattern.test(membership.id ?? '')) fail('preflight-identity-project-mismatch');
  const metadata = record((await request('fhir/R4/metadata', { headers })).body), serverVersion = record(metadata.software).version;
  if (metadata.resourceType !== 'CapabilityStatement' || typeof serverVersion !== 'string' || !serverVersion) fail('preflight-server-version-unavailable');
  if (!serverProjectsProjectFeatures(serverVersion)) fail('preflight-server-does-not-project-features');
  const output = { schema: 1, kind: calibrate ? 'auth-me-project-feature-calibration' : 'auth-me-project-feature-observation', capturedAt: new Date().toISOString(), endpoint: CLOUD_API_BASE, projectId: CLOUD_PROJECT_ID, clientId, membershipId: membership.id, membershipAdmin: membership.admin === true, serverVersion, authMeFeatures: featureList(project.features, 'preflight-auth-me-features-invalid'), requests: 0, fhirWrites: 0 };
  if (calibrate) {
    if (membership.admin !== true) fail('calibration-requires-temporary-project-admin');
    const projectResult = await request(`fhir/R4/Project/${CLOUD_PROJECT_ID}`, { headers });
    if (projectResult.status !== 200) fail(`calibration-admin-project-read-${projectResult.status}`);
    output.calibration = projectFeatureCalibration({ meProject: project, adminProject: projectResult.body, serverVersion });
    output.adminProjectVersion = typeof projectResult.body?.meta?.versionId === 'string' ? projectResult.body.meta.versionId : null;
    output.nextStep = 'demote-membership-to-runtime-policy-and-confirm-demotion-verified-before-qualifying';
  }
  output.requests = requestCount;
  return output;
}

function writePrivate(path, data) {
  const directory = dirname(resolve(path));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
export async function main(args = process.argv.slice(2)) {
  const command = args[0], flags = args.slice(1), allowed = ['--output', '--credentials', '--allow-cloud-read', ...(command === 'observe-features' ? ['--calibrate'] : [])];
  if (!['plan', 'inventory', 'observe-features'].includes(command) || flags.some((flag, index) => flag.startsWith('--') && !allowed.includes(flag))) fail('usage-plan-inventory-or-observe-features-output-credentials-allow-cloud-read');
  const option = flag => { const index = flags.indexOf(flag); if (index < 0) return undefined; const value = flags[index + 1]; if (!value || value.startsWith('--') || flags.lastIndexOf(flag) !== index) fail('invalid-cli-option'); return value; };
  const output = option('--output');
  if (!output) fail('output-file-required');
  if (command === 'plan') { writePrivate(output, seedPlan()); console.log(JSON.stringify({ status: 'plan-written', networkRequests: 0 })); return; }
  if (!flags.includes('--allow-cloud-read') || !option('--credentials')) fail('explicit-cloud-read-and-private-credentials-required');
  if (command === 'observe-features') {
    const observed = await observeProjectFeatures({ ...credentialsFromFile(option('--credentials')), calibrate: flags.includes('--calibrate') });
    writePrivate(output, observed);
    console.log(JSON.stringify({ status: observed.calibration ? 'calibration-written' : 'observation-written', projectId: observed.projectId, featuresMatch: observed.calibration?.featuresMatch ?? null, requests: observed.requests, fhirWrites: 0 }));
    return;
  }
  const result = await inventory(credentialsFromFile(option('--credentials')));
  writePrivate(output, result);
  console.log(JSON.stringify({ status: 'inventory-written', projectId: result.projectId, requests: result.requests, completeForListedTypes: result.completeForListedTypes, fhirWrites: 0 }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
