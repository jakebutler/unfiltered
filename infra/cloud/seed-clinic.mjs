/** Explicit project-scoped synthetic provisioning. No deletion or email delivery. */
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLOUD_API_BASE, CLOUD_PROJECT_ID, CLOUD_CLIENT_ID, CLOUD_MEMBERSHIP_ID, DEMO_NAMESPACE, SCENARIOS, clinicalRules, seedPlan } from './clinic-manifest.mjs';
import { credentialsFromFile } from './medplum-preflight.mjs';

const ref = resource => `${resource.resourceType}/${resource.id}`;
const secret = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const subset = (expected, actual) => Array.isArray(expected) ? Array.isArray(actual) && expected.length === actual.length && expected.every((value, index) => subset(value, actual[index])) : expected && typeof expected === 'object' ? actual && typeof actual === 'object' && Object.entries(expected).every(([key, value]) => subset(value, actual[key])) : expected === actual;
const runtimeRules = seedPlan().policies.find(policy => policy.key === 'runtime').resource.resource;

export async function seedClinic({ baseUrl = CLOUD_API_BASE, projectId = CLOUD_PROJECT_ID, clientId, clientSecret, origin, privateDirectory, fetcher = fetch, localQualification = false, failAfterStep }) {
  if (localQualification ? baseUrl !== 'http://localhost:8103/' : baseUrl !== CLOUD_API_BASE || projectId !== CLOUD_PROJECT_ID) throw new Error('seed-target-not-authorized');
  if (!localQualification && clientId !== CLOUD_CLIENT_ID) throw new Error('seed-client-not-authorized');
  const originUrl = new URL(origin);
  if (originUrl.origin !== origin || (!localQualification && originUrl.protocol !== 'https:')) throw new Error('seed-exact-origin-required');
  const directory = resolve(privateDirectory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (statSync(directory).mode & 0o077) throw new Error('seed-directory-must-be-private');
  const journalPath = `${directory}/seed-journal.json`, secretsPath = `${directory}/seed-secrets.json`, lockPath = `${directory}/seed.lock`;
  writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
  const save = (path, value) => { const temp = `${path}.tmp`; writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); renameSync(temp, path); };
  const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : { schema: 1, projectId, clientId, baseUrl, origin, state: 'started', operations: {}, cleanup: 'not-attempted' };
  if (journal.schema !== 1 || journal.projectId !== projectId || journal.clientId !== clientId || journal.baseUrl !== baseUrl || journal.origin !== origin) { unlinkSync(lockPath); throw new Error('seed-journal-target-mismatch'); }
  if (journal.state === 'complete') { unlinkSync(lockPath); return { status: 'already-complete', projectId, configuration: `${directory}/clinic-config.json`, cleanup: journal.cleanup }; }
  let token, membership, runtimePolicy, error, completed = false;
  const secrets = existsSync(secretsPath) ? JSON.parse(readFileSync(secretsPath, 'utf8')) : { cookieSecret: secret(), staffPasswords: Object.fromEntries(['medical', 'dietitian', 'administrative', 'unassigned'].map(key => [key, secret()])) };
  save(secretsPath, secrets);
  async function request(path, body, method = body === undefined ? 'GET' : 'POST', headers = {}) {
    const url = new URL(path, baseUrl);
    if (url.origin !== new URL(baseUrl).origin || url.username || url.password || url.hash || !['GET', 'POST', 'PUT'].includes(method)) throw new Error('seed-unsafe-request');
    let response;
    try { response = await fetcher(url.href, { method, redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Accept: 'application/fhir+json', 'Content-Type': 'application/fhir+json', 'X-Medplum': 'extended', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }); }
    catch { throw new Error('seed-network-outcome-unknown'); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`seed-http-${response.status}`); }
    if (response.status === 204) return undefined;
    const raw = await response.text();
    if (!raw) return undefined;
    try { return JSON.parse(raw); } catch { throw new Error('seed-invalid-json-outcome-unknown'); }
  }
  const persist = () => save(journalPath, journal);
  const guard = resource => { if (!resource?.id || resource.meta?.project !== projectId) throw new Error('seed-resource-project-mismatch'); return resource; };
  async function search(type, query) {
    const result = await request(`fhir/R4/${type}?${query}&_count=2`);
    if (result?.resourceType !== 'Bundle' || result.type !== 'searchset' || (result.entry?.length ?? 0) > 1 || result.total > 1 || result.link?.some(link => link.relation === 'next')) throw new Error('seed-ambiguous-resource');
    return result.entry?.length ? guard(result.entry[0].resource) : undefined;
  }
  async function ensure(key, resource, query) {
    const existing = journal.operations[key];
    const fingerprint = hash(resource);
    if (existing && existing.fingerprint !== fingerprint) throw new Error('seed-intent-content-changed');
    let found = existing?.reference ? guard(await request(`fhir/R4/${existing.reference}`)) : await search(resource.resourceType, query);
    if (!found) {
      if (existing?.state === 'intent') throw new Error(`seed-unresolved-intent-${key}`);
      journal.operations[key] = { state: 'intent', fingerprint, at: new Date().toISOString() }; persist();
      found = guard(await request(`fhir/R4/${resource.resourceType}`, resource, 'POST', { 'If-None-Exist': query }));
    }
    if (!subset(resource, found)) throw new Error(`seed-existing-content-mismatch-${key}`);
    journal.operations[key] = { state: 'confirmed', fingerprint, reference: ref(found), version: found.meta.versionId }; persist();
    if (failAfterStep === key) throw new Error('injected-local-seed-failure');
    return found;
  }
  async function update(key, resource, changes) {
    const desired = { ...resource, ...changes }, fingerprint = hash(changes);
    const existing = journal.operations[key];
    if (existing && existing.fingerprint !== fingerprint) throw new Error('seed-update-intent-changed');
    let current = guard(await request(`fhir/R4/${ref(resource)}`));
    if (!subset(changes, current)) {
      if (existing?.state === 'intent') throw new Error(`seed-unresolved-intent-${key}`);
      journal.operations[key] = { state: 'intent', reference: ref(resource), fingerprint, at: new Date().toISOString() }; persist();
      current = guard(await request(`fhir/R4/${ref(resource)}`, { ...desired, meta: current.meta }, 'PUT', { 'If-Match': `W/"${current.meta.versionId}"` }));
    }
    if (!subset(changes, current)) throw new Error('seed-update-not-confirmed');
    journal.operations[key] = { state: 'confirmed', reference: ref(current), fingerprint, version: current.meta.versionId }; persist();
    return current;
  }
  async function createPolicy(key, name, rules) {
    return ensure(`policy-${key}`, { resourceType: 'AccessPolicy', name: `${name} [${DEMO_NAMESPACE}]`, resource: rules }, `name:exact=${encodeURIComponent(`${name} [${DEMO_NAMESPACE}]`)}`);
  }
  try {
    const auth = await request('oauth2/token', new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'openid' }).toString(), 'POST', { 'Content-Type': 'application/x-www-form-urlencoded' });
    if (!auth?.access_token) throw new Error('seed-authentication-failed'); token = auth.access_token;
    const me = await request('auth/me');
    if (me?.project?.id !== projectId || me?.profile?.resourceType !== 'ClientApplication' || me.profile.id !== clientId || me.membership?.profile?.reference !== `ClientApplication/${clientId}` || !me.membership.id) throw new Error('seed-identity-mismatch');
    if (!localQualification && me.membership.id !== CLOUD_MEMBERSHIP_ID) throw new Error('seed-membership-not-authorized');
    journal.membershipId = me.membership.id;
    journal.cleanup = 'temporary-admin-status-unconfirmed';
    journal.cleanupEndpoint = `admin/projects/${projectId}/members/${me.membership.id}`;
    persist();
    const observedMembership = guard(await request(`fhir/R4/ProjectMembership/${me.membership.id}`));
    if (observedMembership.id !== me.membership.id || observedMembership.project?.reference !== `Project/${projectId}` || observedMembership.profile?.reference !== `ClientApplication/${clientId}`) throw new Error('seed-membership-identity-mismatch');
    membership = observedMembership;
    if (membership.admin !== true) throw new Error('temporary-project-admin-required');
    journal.cleanup = 'temporary-admin-needs-demotion'; persist();
    const project = await request(`fhir/R4/Project/${projectId}`);
    if (project.id !== projectId || !project.meta?.versionId) throw new Error('native-project-identity-required-before-seeding');
    const projectFeatures = project.features === undefined ? [] : project.features;
    if (!Array.isArray(projectFeatures) || projectFeatures.some(feature => typeof feature !== 'string')) throw new Error('seed-project-features-invalid');
    save(`${directory}/project-feature-observation.json`, { projectId, projectVersion: project.meta.versionId, features: projectFeatures, observedAt: new Date().toISOString() });
    // The fixed authored definition is compiled locally; no model, Bot or server rule engine is involved.
    const { getNativeQuestionnaireDefinition } = await import('../../.qualification-build/packages/clinic-content/src/native-questionnaire.js');
    const { verifyComponent } = await import('../../.qualification-build/packages/clinical-core/src/fhir.js');
    const definition = await getNativeQuestionnaireDefinition();
    const questionnaire = await ensure('questionnaire-native', definition.questionnaire, `url=${encodeURIComponent(definition.binding.canonical)}&version=${encodeURIComponent(definition.binding.version)}`);
    if (!questionnaire.meta?.versionId || !verifyComponent(definition.questionnaire, questionnaire)) throw new Error('seed-questionnaire-content-mismatch');
    const questionnaireReference = `${ref(questionnaire)}/_history/${questionnaire.meta.versionId}`;
    const questionnaireReadback = guard(await request(`fhir/R4/${questionnaireReference}`));
    if (!verifyComponent(definition.questionnaire, questionnaireReadback) || questionnaireReadback.id !== questionnaire.id || questionnaireReadback.meta.versionId !== questionnaire.meta.versionId) throw new Error('seed-questionnaire-history-mismatch');
    runtimePolicy = await createPolicy('runtime', 'Corvo demo runtime persistence only', [...runtimeRules, { resourceType: 'Questionnaire', criteria: `Questionnaire?_id=${questionnaire.id}`, interaction: ['read', 'search', 'history', 'vread'] }]);
    const makePatient = async (key, given, family) => ensure(`patient-${key}`, { resourceType: 'Patient', identifier: [{ system: DEMO_NAMESPACE, value: `patient-${key}` }], active: true, name: [{ given: [given], family: `${family} (synthetic)` }] }, `identifier=${encodeURIComponent(`${DEMO_NAMESPACE}|patient-${key}`)}`);
    const patient = await makePatient('primary', 'Alex', 'Rivera'), unrelated = await makePatient('unrelated', 'Jordan', 'Chen');
    const clinical = await createPolicy('clinical', 'Corvo demo assigned clinical read only', clinicalRules(ref(patient), ref(questionnaire)));
    const other = await createPolicy('unassigned', 'Corvo demo unrelated patient read only', clinicalRules(ref(unrelated), ref(questionnaire)));
    const administrative = await createPolicy('administrative', 'Corvo demo administrative logistics only', [{ resourceType: 'Practitioner', criteria: 'Practitioner?_id=%profile.id', readonly: true }, { resourceType: 'Task', criteria: `Task?_compartment=${ref(patient)}&code=urn:corvo:clinical:work-kind|administrative`, readonly: true }]);
    const careTeams = {};
    for (const responsibility of ['medical', 'nutrition', 'administrative']) careTeams[responsibility] = await ensure(`team-${responsibility}`, { resourceType: 'CareTeam', identifier: [{ system: DEMO_NAMESPACE, value: `care-team-${responsibility}` }], status: 'active', name: `Corvo ${responsibility} care team`, subject: { reference: ref(patient) } }, `identifier=${encodeURIComponent(`${DEMO_NAMESPACE}|care-team-${responsibility}`)}`);
    const specs = [{ key: 'medical', name: 'Dr. Morgan Lee', role: 'physician', policy: clinical, responsibility: 'medical' }, { key: 'dietitian', name: 'Sam Patel, RD', role: 'registered-dietitian', policy: clinical, responsibility: 'nutrition' }, { key: 'administrative', name: 'Taylor Brooks', role: 'administrative', policy: administrative, responsibility: 'administrative' }, { key: 'unassigned', name: 'Dr. Quinn Parker', role: 'physician', policy: other }];
    const staff = [], users = [];
    for (const spec of specs) {
      const email = `${spec.key}.${projectId.slice(0, 8)}@example.invalid`, key = `staff-${spec.key}`;
      const expected = { admin: false, accessPolicy: { reference: ref(spec.policy) } };
      const body = { resourceType: 'Practitioner', firstName: spec.name, lastName: 'Synthetic', email, password: secrets.staffPasswords[spec.key], scope: 'project', sendEmail: false, membership: expected };
      const fingerprint = hash(body), previous = journal.operations[key];
      if (previous && previous.fingerprint !== fingerprint) throw new Error('seed-invite-intent-changed');
      let member = previous?.reference ? guard(await request(`fhir/R4/${previous.reference}`)) : await search('ProjectMembership', `user-name=${encodeURIComponent(email)}&profile-type=Practitioner`);
      if (!member) {
        if (previous?.state === 'intent') throw new Error(`seed-unresolved-intent-${key}`);
        journal.operations[key] = { state: 'intent', fingerprint, at: new Date().toISOString() }; persist();
        member = guard(await request(`admin/projects/${projectId}/invite`, body));
      }
      if (member.project?.reference !== `Project/${projectId}` || !member.profile?.reference?.startsWith('Practitioner/') || !subset(expected, member)) throw new Error('seed-staff-membership-mismatch');
      journal.operations[key] = { state: 'confirmed', fingerprint, reference: ref(member), version: member.meta.versionId }; persist();
      staff.push({ membershipId: member.id, profile: member.profile.reference, policy: ref(spec.policy), name: spec.name, role: spec.role, patients: [ref(spec.key === 'unassigned' ? unrelated : patient)], careTeams: spec.responsibility ? [ref(careTeams[spec.responsibility])] : [] });
      users.push({ name: spec.name, role: spec.role, email, password: secrets.staffPasswords[spec.key] });
    }
    for (const responsibility of ['medical', 'nutrition', 'administrative']) await update(`team-participants-${responsibility}`, careTeams[responsibility], { participant: staff.filter(member => member.careTeams.includes(ref(careTeams[responsibility]))).map(member => ({ member: { reference: member.profile }, role: [{ text: member.role }] })) });
    const references = Object.fromEntries(Object.entries(careTeams).map(([key, value]) => [key, ref(value)]));
    const patients = Object.fromEntries(SCENARIOS.map(scenario => [scenario, { reference: ref(patient), displayName: 'Alex Rivera', description: 'Fictional adult patient for Corvo Clinic testing. Use synthetic information only.', careTeams: references, ...(scenario === 'post-visit' ? { context: 'No clinician-authored plan is available in this fixture. Collect updates and questions without inferring treatment directions.' } : {}) }]));
    save(`${directory}/clinic-config.json`, { origin, medplumBaseUrl: baseUrl, projectId, clientId, clientSecret, cookieSecret: secrets.cookieSecret, nativeQuestionnaire: { ...definition.binding, reference: questionnaireReference }, patients, staff, mentalHealth: 'phq4' });
    save(`${directory}/clinic-users.json`, users);
    completed = true;
  } catch (caught) { error = caught; }
  finally {
    if (token && membership?.admin === true) {
      try {
        journal.cleanup = 'demotion-intent'; persist();
        const changed = { ...membership, admin: false, ...(runtimePolicy ? { accessPolicy: { reference: ref(runtimePolicy) }, access: undefined } : {}) };
        await request(`admin/projects/${projectId}/members/${membership.id}`, changed);
        const me = await request('auth/me');
        if (me.project?.id !== projectId || me.profile?.id !== clientId || me.membership?.id !== membership.id || me.membership?.admin === true || (runtimePolicy && !me.accessPolicy?.basedOn?.some(item => item.reference === ref(runtimePolicy)) && me.accessPolicy?.id !== runtimePolicy.id)) throw new Error('demotion-identity-or-policy-unconfirmed');
        let denied = false;
        try { await request(`fhir/R4/ProjectMembership/${membership.id}`); } catch (caught) { denied = caught.message === 'seed-http-403'; }
        if (!denied) throw new Error('demotion-authority-still-readable');
        journal.cleanup = 'demotion-verified'; persist();
        await request('oauth2/logout', {}, 'POST', { 'Content-Type': 'application/json' });
        journal.bootstrapSession = 'revoked';
      } catch (cleanupError) {
        journal.cleanup = 'cleanup-required'; journal.cleanupError = cleanupError.message;
        journal.cleanupEndpoint = `admin/projects/${projectId}/members/${membership.id}`;
        error ??= cleanupError;
      }
    }
    if (journal.cleanup === 'temporary-admin-status-unconfirmed') {
      // The authenticated target may have temporary admin authority, but the
      // full membership is unavailable. Never guess an administrative update.
      journal.cleanup = 'cleanup-required';
      journal.cleanupError = 'membership-read-unconfirmed';
    }
    journal.state = completed && journal.cleanup === 'demotion-verified' ? 'complete' : 'incomplete';
    journal.updatedAt = new Date().toISOString();
    if (error) journal.lastError = error.message;
    persist(); unlinkSync(lockPath);
  }
  if (error) throw new Error(`${error.message}; cleanup=${journal.cleanup}; inspect-private-seed-journal`);
  return { status: 'seed-complete-awaiting-qualification', projectId, cleanup: journal.cleanup, configuration: `${directory}/clinic-config.json`, staff: 4, patients: 2, cloudWrites: !localQualification, deletion: false, emailsSent: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const arg = key => { const index = process.argv.indexOf(key); return index >= 0 ? process.argv[index + 1] : undefined; };
  if (!process.argv.includes('--allow-synthetic-project-writes') || !arg('--credentials') || !arg('--origin') || !arg('--private-directory')) throw new Error('required-flags-credentials-origin-private-directory-allow-synthetic-project-writes');
  seedClinic({ ...credentialsFromFile(arg('--credentials')), origin: arg('--origin'), privateDirectory: arg('--private-directory') }).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
