/** Separate Q4f qualifier successor. No network or credentials read on import/prepare. */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, open, realpath, lstat } from 'node:fs/promises';
import { constants, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { prepareSealingBundle, verifySealingBundle } from './sealing-bundle.mjs';
export { sealingModules } from './sealing-bundle.mjs';
const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const runtime = join(root, '.factory/private/native-questionnaire-integration/runtime-2026-10-10-q4f');
// The frozen q4f runtime only contains the schema-2 (admin-file) sealer. Schema-3 sealing and its
// runtime verifier are bundled with their full dependency closure in the reviewed preparation.
export const sealingBuild = join(root, '.qualification-build');
const sealingHelperPath = fileURLToPath(new URL('./sealing-bundle.mjs', import.meta.url));
export const artifact = join(root, 'infra/cloud/.private/clinic-q4f-continuation-20261010-a2');
const manifestPin = 'e0212437c9f6923e7d4cc2fe3b630a63baa26712c728db763181213840db3996';
const originalQualifierPin = '9f117c7dbec7ff2255cd282d5911b810dbd500b5736df2053e7abc93e1c3648a';
const priorPin = 'f4397fc561be99fd8e978e1a340eb4db1531b81b1f4fa364cca29f07daafe170';
const target = { origin: 'https://api.medplum.com', projectId: '13eaac67-a2c3-4aa1-aa9e-590a083e5fef', clientId: '50db76bd-d099-4305-8ec3-7439ffc38ca1', membershipId: '6e565de2-837d-4618-9578-f6428fbb0be1' };
export const writeBudget = Object.freeze({ freshStorage: 3 * 3 + 4 * 4 + 2, application: 7 + 9 + 3 * 6 + 6 * 6 + 7 + 1 + 1, mappingControls: 2 * 4, total: 114 });
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = message => { throw Error(message); };
async function privateBytes(path) {
  const absolute = resolve(root, path);
  if (!absolute.startsWith(root + '/') || await realpath(dirname(absolute)) !== dirname(absolute)) failure('private-path-invalid');
  const h = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const s = await h.stat(); if (!s.isFile() || s.mode & 0o077 || s.size > 1_000_000) failure('private-file-invalid'); return await h.readFile(); } finally { await h.close(); }
}
async function verifyRuntime() {
  const bytes = await readFile(join(runtime, 'MANIFEST.json'));
  if (sha(bytes) !== manifestPin) failure('frozen-runtime-manifest-diff');
  const manifest = JSON.parse(bytes);
  for (const name of ['SOURCE-MANIFEST.json', 'EMITTED-MANIFEST.json', 'DEPENDENCIES-MANIFEST.json']) {
    const inventoryBytes = await readFile(join(runtime, name));
    if (sha(inventoryBytes) !== manifest.inventories[name].sha256) failure('frozen-inventory-diff');
    const rows = JSON.parse(inventoryBytes).files;
    if (rows.length !== manifest.inventories[name].files) failure('frozen-inventory-count-diff');
    for (const row of rows) { const path = resolve(runtime, row.path); if (!path.startsWith(runtime + '/') || (await lstat(path)).isSymbolicLink() || sha(await readFile(path)) !== row.sha256) failure('frozen-file-diff'); }
  }
}
export function successor(original, mappingPath) {
  const once = (before, after) => { if (original.split(before).length !== 2) failure('qualifier-successor-seam-diff'); original = original.replace(before, after); };
  once('    const retained = [];', '    const retained = [];\n    const mappingConfirmations = [];');
  once("        journal({ scenario, submissionId: id, version: 1, digest: draft.confirmed.digest, phase: 'frozen-intent-before-write' });", "        journal({ scenario, submissionId: id, version: 1, digest: draft.confirmed.digest, phase: 'frozen-intent-before-write', draft: structuredClone(draft) });\n        if (draft.confirmed.confirmation.submission.work.length > 3) throw new Error('qualification-write-budget-work-bound');");
  once('        const receipt = await client.check(draft.confirmed.confirmation);', '        const receipt = await client.check(draft.confirmed.confirmation);\n        mappingConfirmations.push(draft.confirmed.confirmation);');
  once('    checks.nativeQuestionnaireMapping = false;', `    checks.nativeQuestionnaireMapping = await require(${JSON.stringify(mappingPath)}).verify(${JSON.stringify(runtime)}, config, client, qualification, journal, mappingConfirmations);`);
  once('    // Required native Questionnaire mapping is deliberately unqualified until the dedicated mapping author integrates it.', '    // Qualify actual native histories, typed snapshots and bounded correction controls.');
  return original.replace(/require\("(\.\.\/\.\.\/packages\/[^"\n]+)"\)/g, (_whole, relative) => `require(${JSON.stringify(resolve(runtime, '.qualification-build/scripts/qualification', relative))})`);
}
export async function prepare() {
  await verifyRuntime();
  const original = await readFile(join(runtime, '.qualification-build/scripts/qualification/conditional-clinic.js'));
  if (sha(original) !== originalQualifierPin) failure('original-qualifier-diff');
  await mkdir(artifact, { mode: 0o700 });
  const mappingBytes = await readFile(join(root, 'scripts/qualification/clinic-native-mapping.cjs'));
  await writeFile(join(artifact, 'clinic-native-mapping.cjs'), mappingBytes, { flag: 'wx', mode: 0o600 });
  const bytes = Buffer.from(successor(original.toString(), join(artifact, 'clinic-native-mapping.cjs')));
  await writeFile(join(artifact, 'conditional-clinic.cjs'), bytes, { flag: 'wx', mode: 0o600 });
  const sealingBundle = await prepareSealingBundle(sealingBuild, artifact);
  const receipt = { schema: 1, state: 'source-only-successor-awaiting-independent-review', runtimeManifestSha256: manifestPin, originalQualifierSha256: originalQualifierPin, continuationHelperSha256: sha(await readFile(fileURLToPath(import.meta.url))), sealingHelperSha256: sha(await readFile(sealingHelperPath)), sealingBundle, mappingSha256: sha(mappingBytes), qualifierSuccessorSha256: sha(bytes), priorEvidenceSha256: priorPin, frozenFilesChanged: 0, providerCalls: 0, cloudCalls: 0 };
  await writeFile(join(artifact, 'preparation.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return receipt;
}
export function validatePrior(prior) {
  if (prior.state !== 'failed-retain-native-fixtures' || prior.error !== 'try-again-later' || prior.projectId !== target.projectId || prior.providerCalls !== 0 || prior.checks?.length !== 35 || prior.checks.some(row => row.passed !== true) || prior.fixtures?.length !== 3 || prior.fixtures.some(row => row.state !== 'confirmed') || prior.applicationFixtures?.length || prior.storageReport?.delivery !== 'qualified-for-tested-credentials' || Object.values(prior.storageReport.checks).some(value => value !== true)) failure('prior-phase-frontier-diff');
}
export function validatePlan(plan, now = Date.now()) {
  if (plan?.schema !== 1 || plan.allowSyntheticContinuation !== true || !/^[a-f0-9]{64}$/.test(plan.preparationSha256 ?? '') || !Number.isSafeInteger(plan.createdAt) || plan.createdAt > now || !Number.isSafeInteger(plan.expiresAt) || plan.expiresAt <= now || plan.expiresAt - plan.createdAt > 900_000 || plan.loginSpacingMs !== 15_000 || plan.cleanupRequests !== 8 || plan.cleanupDeadlineMs !== 90_000 || !Number.isInteger(plan.maxRequests) || plan.maxRequests < 1600 || plan.maxRequests > 2000 || !Number.isInteger(plan.maxFhirWrites) || plan.maxFhirWrites < writeBudget.total || plan.maxFhirWrites > 300) failure('finite-continuation-plan-invalid');
  for (const name of ['config', 'users', 'priorEvidence']) if (typeof plan.paths?.[name] !== 'string' || !/^[a-f0-9]{64}$/.test(plan.pins?.[name] ?? '')) failure('private-input-pin-required');
  if (plan.pins.priorEvidence !== priorPin || typeof plan.output !== 'string') failure('prior-output-scope-invalid'); return plan;
}
export async function acquireActors(users, authFactory, origin, clock, sleep, save, cleanupOptions = {}) {
  const sessions = [], actors = []; let lastDispatch = clock();
  try {
    for (const user of users) {
      const wait = Math.max(0, 15_000 - (clock() - lastDispatch)); if (wait) await sleep(wait);
      lastDispatch = clock(); const auth = authFactory();
      save({ actor: user.name, phase: 'login-intent', at: lastDispatch });
      const login = await auth.login(user.email, user.password);
      const request = new Request(new URL('api/staff/me', origin), { headers: { cookie: login.cookie.split(';')[0] } });
      sessions.push({ request, auth, actor: user.name });
      await cleanupOptions.capture?.(request, user.name);
      actors.push(await auth.read(request));
      save({ actor: user.name, phase: 'login-confirmed', at: clock() });
    }
    return { actors, cleanup: () => cleanupActors(sessions, save, cleanupOptions) };
  } catch (error) { await cleanupActors(sessions, save, cleanupOptions); throw error; }
}
async function cleanupActors(sessions, save, options) {
  if (options.cleanupAll) return options.cleanupAll();
  options.start?.(); let complete = true;
  for (const { request, auth, actor } of sessions) {
    try {
      await auth.logout(request); save({ actor, phase: 'logout-acknowledged', at: Date.now() });
      if ((await options.verify?.(request))?.state !== 'revoked') throw Error('actor-revocation-unconfirmed');
      save({ actor, phase: 'native-revocation-confirmed', at: Date.now() });
    } catch { complete = false; save({ actor, phase: 'logout-or-revocation-unknown', at: Date.now() }); }
  }
  return complete;
}
/** Runtime-only owned tokens survive cookie/plan expiry; ambiguous issuance never passes cleanup. */
export function ownedActorCleanup(logout, verify, save, start) {
  const tokens = new Map(), uncertain = new Set();
  return {
    tokens,
    intent(actor) { uncertain.add(actor); },
    rejected(actor, status) { if (status >= 400 && status < 500) uncertain.delete(actor); },
    issued(actor, token) { if (typeof token !== 'string' || !token || tokens.has(token)) failure('owned-token-issuance-invalid'); tokens.set(token, { actor, state: 'owned' }); uncertain.delete(actor); },
    capture(actor, token) { if (tokens.get(token)?.actor !== actor) failure('owned-cookie-token-mismatch'); },
    async cleanup() {
      start();
      for (const [token, row] of tokens) {
        if (row.state !== 'owned') continue;
        row.state = 'attempted'; // Unknown logout/revocation is retained, never automatically retried.
        try {
          await logout(token); save({ actor: row.actor, phase: 'logout-acknowledged', at: Date.now() });
          if ((await verify(token))?.state !== 'revoked') throw Error('actor-revocation-unconfirmed');
          row.state = 'revoked'; save({ actor: row.actor, phase: 'native-revocation-confirmed', at: Date.now() });
        } catch { save({ actor: row.actor, phase: 'logout-or-revocation-unknown', at: Date.now() }); }
      }
      for (const actor of uncertain) save({ actor, phase: 'token-issuance-cleanup-unknown', at: Date.now() });
      return uncertain.size === 0 && [...tokens.values()].every(row => row.state === 'revoked');
    },
  };
}
export async function run(planPath) {
  const plan = validatePlan(JSON.parse(await privateBytes(planPath)));
  if (process.versions.node.split('.')[0] !== '22') failure('accepted-node22-required');
  await verifyRuntime();
  const prepBytes = await readFile(join(artifact, 'preparation.json'));
  if (sha(prepBytes) !== plan.preparationSha256) failure('reviewed-preparation-diff');
  const prep = JSON.parse(prepBytes);
  for (const [file, pin] of [['conditional-clinic.cjs', prep.qualifierSuccessorSha256], ['clinic-native-mapping.cjs', prep.mappingSha256]]) if (sha(await readFile(join(artifact, file))) !== pin) failure('reviewed-successor-diff');
  if (sha(await readFile(fileURLToPath(import.meta.url))) !== prep.continuationHelperSha256) failure('reviewed-continuation-helper-diff');
  if (sha(await readFile(sealingHelperPath)) !== prep.sealingHelperSha256) failure('reviewed-sealing-helper-diff');
  const sealingBundlePath = await verifySealingBundle(prep.sealingBundle, artifact);
  const inputs = {};
  for (const name of ['priorEvidence', 'config', 'users']) { const bytes = await privateBytes(plan.paths[name]); if (sha(bytes) !== plan.pins[name]) failure('private-input-diff'); inputs[name] = JSON.parse(bytes); }
  validatePrior(inputs.priorEvidence);
  const { config, users } = inputs;
  if (config.medplumBaseUrl !== target.origin + '/' || config.projectId !== target.projectId || config.clientId !== target.clientId || config.storageQualification || !config.nativeQuestionnaire) failure('exact-native-config-required');
  const emitted = join(runtime, '.qualification-build'), load = path => require(join(emitted, path));
  const { digest } = load('packages/clinical-core/src/domain.js'), { qualifyConditionalMedplum } = load('packages/clinical-core/src/qualification.js'), { MedplumClient } = load('packages/clinical-core/src/medplum.js');
  const { observeRuntimeProjection, sealDeploymentQualification, runtimeProvider } = require(sealingBundlePath);
  const { staffAuthentication } = load('packages/clinic-api/src/auth.js'), { cookies } = load('packages/clinic-api/src/cookies.js');
  load('packages/clinic-api/src/deployment-probes.js').assertDeploymentStaffRoster(config, users);
  const output = resolve(root, plan.output); if (!output.startsWith(artifact + '/') || await realpath(dirname(output)) !== dirname(output)) failure('exclusive-private-output-required');
  try { await lstat(output); failure('qualified-output-already-exists'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const evidence = { schema: 1, state: 'continuation-intent', at: new Date().toISOString(), projectId: config.projectId, priorEvidenceSha256: priorPin, priorChecks: inputs.priorEvidence.checks, priorStorageQualifiedAt: inputs.priorEvidence.storageReport.qualification.qualifiedAt, priorFirstApplicationActorCleanup: 'unknown-token-not-retained', runtimeManifestSha256: manifestPin, calls: [], actorJournal: [], applicationFixtures: [], providerCalls: 0, fhirWrites: 0 };
  await writeFile(output + '.evidence.json', JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  // Persist every application/native fixture intent synchronously before its first write.
  const save = () => writeFileSync(output + '.evidence.json', JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  const queueSave = save;
  let activeLoginActor;
  const record = value => { if (value.phase === 'login-intent') activeLoginActor = value.actor; evidence.actorJournal.push(value); queueSave(); };
  let owned;
  let phase = 'fresh-storage', actors, qualifiedOutput, cleanupAt, cleanupRequests = 0;
  const allowedCleanupTokens = new Set();
  const startCleanup = () => { phase = 'actor-cleanup'; cleanupAt ??= Date.now(); };
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input)), method = init.method ?? 'GET';
    if (url.origin !== target.origin || url.username || url.password) failure('finite-native-request-bound');
    if (phase === 'actor-cleanup') {
      const token = /^Bearer (.+)$/.exec(new Headers(init.headers).get('Authorization') ?? '')?.[1];
      if (!allowedCleanupTokens.has(token) || !((url.pathname === '/oauth2/logout' && method === 'POST') || (url.pathname === '/auth/me' && method === 'GET')) || url.search || ++cleanupRequests > plan.cleanupRequests || Date.now() >= cleanupAt + plan.cleanupDeadlineMs) failure('owned-actor-cleanup-bound');
    } else if (Date.now() >= plan.expiresAt || evidence.calls.filter(c => c.phase !== 'actor-cleanup').length >= plan.maxRequests) failure('finite-native-request-bound');
    if (url.pathname.startsWith('/fhir/') && method !== 'GET' && ++evidence.fhirWrites > plan.maxFhirWrites) failure('finite-native-write-bound');
    const actorTokenExchange = phase === 'application-contract' && url.pathname === '/oauth2/token' && method === 'POST' && new URLSearchParams(String(init.body)).get('grant_type') === 'authorization_code';
    if (actorTokenExchange) { if (!owned || !activeLoginActor) failure('owned-token-exchange-scope-invalid'); owned.intent(activeLoginActor); }
    const row = { phase, method, path: url.pathname, at: Date.now() }; evidence.calls.push(row); save();
    const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.any([init.signal ?? new AbortController().signal, AbortSignal.timeout(10_000)]) }); row.status = response.status; save();
    if (actorTokenExchange) {
      if (response.ok) { const token = (await response.clone().json()).access_token; owned.issued(activeLoginActor, token); record({ actor: activeLoginActor, phase: 'owned-token-captured-runtime-only', at: Date.now() }); }
      else owned.rejected(activeLoginActor, response.status);
    }
    return response;
  };
  try {
    const response = await fetcher(new URL('oauth2/token', config.medplumBaseUrl), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret, scope: 'openid' }) });
    if (!response.ok) failure('fresh-native-token-unavailable'); const accessToken = (await response.json()).access_token; if (typeof accessToken !== 'string') failure('fresh-native-token-unavailable');
    const medplum = { baseUrl: new URL('fhir/R4/', config.medplumBaseUrl).href, accessToken, mode: 'live', timeoutMs: 10_000, nativeQuestionnaire: config.nativeQuestionnaire };
    const { identity, projectFeature: initialProjection } = await observeRuntimeProjection(config, medplum, fetcher); if (identity.membershipId !== target.membershipId) failure('native-membership-diff'); evidence.identity = identity; evidence.initialProjectFeature = initialProjection; await save();
    const client = new MedplumClient(medplum, fetcher); await client.verifyNativeQuestionnaire();
    const patient = config.patients['first-intake'], now = new Date().toISOString();
    const submission = { submissionId: `qualification-continuation-${crypto.randomUUID()}`, version: 1, patient: patient.reference, scenario: 'first-intake', contentVersion: 'technical-deployment-probe', questionnaire: 'https://corvo.example/Questionnaire/technical-deployment-probe', confirmedAt: now, completeness: 'partial', sources: [{ id: 'probe', patient: patient.reference, kind: 'patient-statement', text: 'Synthetic deployment storage qualification. No clinical assessment.', capturedAt: now }], answers: [{ questionId: 'probe', state: 'answered', text: 'Synthetic deployment storage qualification only.', sourceIds: ['probe'] }], work: [{ id: 'probe', kind: 'clinical', responsibility: 'medical', owner: patient.careTeams.medical }] };
    const confirmation = { submission, digest: await digest(submission) }; evidence.storageIntent = confirmation; await save();
    const report = await qualifyConditionalMedplum(medplum, confirmation, fetcher); evidence.storageReport = report; await save(); if (!report.qualification) failure('fresh-storage-not-qualified');
    phase = 'application-contract';
    const portable = load('packages/clinic-api/src/staff-session.js').staffSessionCookies(config.cookieSecret, `${config.origin}|${config.medplumBaseUrl}|${config.projectId}`, true);
    const verifyRevocation = load('packages/clinic-api/src/deployment-probes.js').verifyNativeStaffRevocation;
    owned = ownedActorCleanup(async token => {
      allowedCleanupTokens.add(token);
      const response = await fetcher(new URL('oauth2/logout', config.medplumBaseUrl), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
      const acknowledged = response.ok || response.status === 401; await response.body?.cancel(); if (!acknowledged) failure('owned-logout-unconfirmed');
    }, token => verifyRevocation(config.medplumBaseUrl, token, fetcher), record, startCleanup);
    actors = await acquireActors(users, () => staffAuthentication(config, fetcher, cookies(config.cookieSecret, true)), config.origin, Date.now, ms => new Promise(resolve => setTimeout(resolve, ms)), record, {
      capture: async (request, actor) => owned.capture(actor, (await portable.read(request)).token), cleanupAll: () => owned.cleanup(),
    });
    const application = await require(join(artifact, 'conditional-clinic.cjs')).qualifyConditionalClinic(config, client, report.qualification, actors.actors, fetcher, value => { evidence.applicationFixtures.push(value); queueSave(); }); evidence.application = application; await save();
    const attestation = await sealDeploymentQualification(config, medplum, report, fetcher, application);
    if (attestation.payload.schema !== 3 || attestation.payload.projectFeature.projectionDigest !== initialProjection.projectionDigest) failure('project-projection-changed-during-qualification');
    evidence.projectFeature = attestation.payload.projectFeature; await save();
    const qualifiedConfig = { ...config, storageQualification: attestation };
    const { TransportError } = load('packages/clinical-core/src/transport.js');
    for (const path of [`ProjectMembership/${attestation.payload.identity.membershipId}`, 'AccessPolicy', 'ClientApplication']) { let denied = false; try { await client.request(path); } catch (e) { denied = e instanceof TransportError && [401, 403, 404].includes(e.status); } if (!denied) failure('runtime-admin-read-not-denied'); }
    phase = 'runtime-refresh';
    const refresh = async (input, init) => { const r = await fetcher(input, init); return new URL(String(input)).pathname === '/oauth2/token' && r.ok ? Response.json({ ...await r.json(), expires_in: 1 }) : r; };
    const r = runtimeProvider(qualifiedConfig, refresh); await r(); await r(); await runtimeProvider(qualifiedConfig, fetcher)();
    if (evidence.calls.some(c => c.phase === phase && c.path.startsWith('/fhir/') && c.method !== 'GET')) failure('runtime-refresh-fhir-write');
    qualifiedOutput = qualifiedConfig; evidence.state = 'qualification-passed-awaiting-actor-revocation'; evidence.expiresAt = attestation.payload.expiresAt; await save();
  } catch (error) { evidence.state = 'failed-retain-continuation-fixtures'; evidence.error = typeof error?.message === 'string' && /^[A-Za-z0-9:._,-]{1,250}$/.test(error.message) ? error.message : 'continuation-failed'; await save(); throw Error('Clinic continuation failed; retain native fixtures and original intent; no automatic replay'); }
  finally {
    if (owned) {
      const complete = await owned.cleanup(); evidence.actorCleanupComplete = complete;
      if (qualifiedOutput && !complete) { evidence.state = 'qualification-passed-cleanup-unresolved'; qualifiedOutput = undefined; }
    }
    await save();
  }
  if (!qualifiedOutput) failure('qualified-output-withheld-cleanup-unresolved');
  await writeFile(output, JSON.stringify(qualifiedOutput, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); evidence.state = 'passed'; await save();
  return { state: evidence.state, output, freshStorage: true, originalChecksRetained: 35, providerCalls: 0, expiresAt: evidence.expiresAt };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { if (process.argv.length === 3 && process.argv[2] === 'prepare') console.log(JSON.stringify(await prepare())); else if (process.argv.length === 4 && process.argv[2] === 'run') console.log(JSON.stringify(await run(process.argv[3]))); else failure('explicit-prepare-or-run-required'); }
  catch { console.error('Clinic continuation stopped; inspect original private evidence and do not replay.'); process.exitCode = 1; }
}
