/** Bounded synthetic application qualification. Invoked only by explicit deployment scripts. */
import { canonicalJson, digest, type ConfirmedSubmission } from '../../packages/clinical-core/src/domain.js';
import { ACTION_HISTORY_EXTENSION, resourceVersion } from '../../packages/clinical-core/src/fhir.js';
import { MedplumClient, fhirResource, type DeliveryQualification } from '../../packages/clinical-core/src/medplum.js';
import { TransportError, type Fetch } from '../../packages/clinical-core/src/transport.js';
import { conversation } from '../../packages/clinic-api/src/conversation.js';
import { createClinicHandler } from '../../packages/clinic-api/src/handler.js';
import { handoffs } from '../../packages/clinic-api/src/handoffs.js';
import { createDraft, readDraft, saveDraft, object } from '../../packages/clinic-api/src/store.js';
import { cookies } from '../../packages/clinic-api/src/cookies.js';
import { type ApplicationQualificationChecks, type ApplicationQualification, applicationChecks } from '../../packages/clinic-api/src/deployment-qualification.js';
import type { ClinicApiConfig, Draft, StaffAssignment } from '../../packages/clinic-api/src/types.js';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
export interface QualifiedActor { assignment: StaffAssignment; client: MedplumClient; }
export async function qualifyConditionalClinic(config: ClinicApiConfig, client: MedplumClient, qualification: DeliveryQualification, actors: QualifiedActor[], fetcher: Fetch, retain: (value: unknown) => void) {
  const retained: unknown[] = []; const journal = (value: unknown) => { retained.push(value); retain(value); };
  const checks = Object.fromEntries(applicationChecks.map(check => [check, false])) as Record<keyof ApplicationQualificationChecks, boolean>;
  const content = conversation(config), h = handoffs(config);
  const clinical = actors.find(actor => actor.assignment.role === 'physician' && actor.assignment.patients.includes(config.patients['first-intake'].reference));
  const nutrition = actors.find(actor => actor.assignment.role === 'registered-dietitian'), admin = actors.find(actor => actor.assignment.role === 'administrative');
  if (!clinical || !nutrition || !admin) throw new Error('qualification-named-actors-required');
  const fixture = async (scenario: Draft['scenario']) => {
    const now = new Date().toISOString(), id = crypto.randomUUID();
    let draft: Draft = { schema: 1, id, patient: config.patients[scenario].reference, scenario, revision: 1, savedAt: now, createdAt: now, phase: 'conversation', turns: [{ id: 'synthetic-confirmed-source', role: 'patient', text: `Synthetic qualification of ${scenario} confirmation. No clinical assessment.`, at: now, channel: 'text' }], topics: {}, requests: {}, version: 1 };
    if (scenario === 'billing' || scenario === 'scheduling') {
      draft = content.select(draft, scenario === 'billing' ? 'W05' : 'W06', scenario === 'billing' ? 'issueType' : 'intent');
      const prompt = content.view(draft).currentPrompt!;
      draft = content.turn(draft, { requestId: crypto.randomUUID(), expectedRevision: draft.revision, promptId: prompt.id, action: 'answer', text: scenario === 'billing' ? 'bill-question' : 'request' });
      draft.revision++;
    }
    draft.preview = await content.preview(draft); draft.phase = 'review';
    draft.confirmed = await content.finalize(draft); draft.preview = undefined; draft.phase = 'confirmed';
    journal({ scenario, submissionId: id, version: 1, digest: draft.confirmed.digest, phase: 'frozen-intent-before-write' });
    await createDraft(client, draft);
    return draft;
  };
  const d = await fixture('first-intake'), id = `${d.id}.v1`;
  const pending = await h.view(client, clinical.client, clinical.assignment, id), initialQueue = await h.queue(client, clinical.client, clinical.assignment);
  checks.confirmedDraftRecovery = pending.deliveryState === 'pending' && pending.sources.length === 0 && pending.topics.length === 0 && initialQueue.recovery.some(item => item.id === id && !item.anchorsVerified);
  let taskFailed = false;
  const failTask: Fetch = async (input, init) => {
    if (!taskFailed && init?.method === 'POST' && String(input) === `${client.config.baseUrl}Task`) { taskFailed = true; return new Response('{}', { status: 503 }); }
    return fetcher(input, init);
  };
  const stopped = new MedplumClient(client.config, failTask);
  const zero = await h.resume(stopped, clinical.client, clinical.assignment, id, qualification);
  const rdZero = await h.view(client, nutrition.client, nutrition.assignment, id);
  checks.zeroTaskRecovery = zero.deliveryState === 'incomplete' && zero.anchorsVerified === true && !!zero.sources.length && !zero.allowedActions.length && rdZero.sources.length === zero.sources.length && zero.work.every(work => work.status === 'pending');
  let rdFailed = false;
  const failNutrition: Fetch = async (input, init) => {
    const body = init?.body ? object(JSON.parse(String(init.body))) : {};
    if (init?.method === 'POST' && String(input) === `${client.config.baseUrl}Task` && object(body.owner).reference === config.patients['first-intake'].careTeams.nutrition) { rdFailed = true; return new Response('{}', { status: 503 }); }
    return fetcher(input, init);
  };
  const partial = await h.resume(new MedplumClient(client.config, failNutrition), clinical.client, clinical.assignment, id, qualification);
  const own = partial.work.find(work => work.responsibility === 'medical')!;
  const input = { actionId: crypto.randomUUID(), workId: own.id, expectedVersion: 1, expectedWorkVersion: own.revision, outcome: 'reviewed' as const, note: 'Synthetic named medical review; no clinical assessment.' };
  const acted = await h.action(client, clinical.client, clinical.assignment, id, input);
  checks.partialOwnWork = rdFailed && partial.deliveryState === 'incomplete' && acted.work.find(work => work.id === own.id)?.status === 'reviewed';
  checks.actionHistory = acted.work.find(work => work.id === own.id)?.history?.[0]?.actionId === input.actionId;
  const replay = await h.action(client, clinical.client, clinical.assignment, id, input);
  let changedRejected = false;
  try { await h.action(client, clinical.client, clinical.assignment, id, { ...input, note: 'Changed content must conflict.' }); } catch (error) { changedRejected = object(error).code === 'action-id-conflict'; }
  checks.actionReplay = replay.work.find(work => work.id === own.id)?.history?.length === 1 && changedRejected;
  let lost = false;
  const losePut: Fetch = async (url, init) => { const response = await fetcher(url, init); if (!lost && init?.method === 'PUT' && String(url).includes('/Task/') && response.ok) { lost = true; await response.arrayBuffer(); throw new Error('qualification-lost-action-response'); } return response; };
  const later = { ...input, actionId: crypto.randomUUID(), expectedWorkVersion: acted.work.find(work => work.id === own.id)!.revision, outcome: 'needs-information' as const, note: 'Synthetic second action retained in authenticated history.' };
  const recovered = await h.action(new MedplumClient(client.config, losePut), clinical.client, clinical.assignment, id, later);
  const historicalReplay = await h.action(client, clinical.client, clinical.assignment, id, input);
  checks.actionUnknownRecovery = lost && recovered.work.find(work => work.id === own.id)?.history?.length === 2 && historicalReplay.work.find(work => work.id === own.id)?.history?.length === 2;
  const current = await h.view(client, clinical.client, clinical.assignment, id);
  const currentOwn = current.work.find(work => work.id === own.id)!;
  const concurrent = await Promise.allSettled([h.action(client, clinical.client, clinical.assignment, id, { ...input, actionId: crypto.randomUUID(), expectedWorkVersion: currentOwn.revision, note: 'Synthetic concurrent action A.' }), h.action(client, clinical.client, clinical.assignment, id, { ...input, actionId: crypto.randomUUID(), expectedWorkVersion: currentOwn.revision, note: 'Synthetic concurrent action B.' })]);
  checks.actionCASConcurrency = concurrent.filter(result => result.status === 'fulfilled').length === 1 && concurrent.some(result => result.status === 'rejected' && object(result.reason).code === 'stale-work');
  const receipt = await client.check(d.confirmed!.confirmation), reference = receipt.resources[`${d.id}.v1.work.${own.id}`], task = fhirResource((await client.request(reference)).body);
  await client.request(reference, 'PUT', { ...task, status: 'completed' }, { 'If-Match': `W/"${resourceVersion(task)}"` });
  const external = await h.view(client, clinical.client, clinical.assignment, id);
  const nativeCurrent = fhirResource((await client.request(reference)).body);
  // Read-fault overlays keep native synthetic history intact while challenging copied old signed prefixes.
  const truncate = (resource: unknown) => {
    const value = object(resource);
    if (value.resourceType === 'Task' && value.id === nativeCurrent.id && resourceVersion(value as never) === resourceVersion(nativeCurrent)) {
      const clone = structuredClone(value), extensions = clone.extension as Array<Record<string, unknown>>;
      clone.extension = extensions.map(extension => extension.url === ACTION_HISTORY_EXTENSION ? { ...extension, valueString: canonicalJson(JSON.parse(String(extension.valueString)).slice(0, 1)) } : extension);
      return clone;
    }
    return value;
  };
  const corruptReads: Fetch = async (url, init) => { const response = await fetcher(url, init); if ((init?.method ?? 'GET') !== 'GET' || !String(url).includes(`/${reference}`) || !response.ok) return response; const value = await response.json(); if (value.resourceType === 'Bundle') value.entry = value.entry.map((entry: { resource: unknown }) => ({ ...entry, resource: truncate(entry.resource) })); return Response.json(value.resourceType === 'Bundle' ? value : truncate(value)); };
  let prefixRejected = false;
  try { await h.view(new MedplumClient(client.config, corruptReads), clinical.client, clinical.assignment, id); } catch (error) { prefixRejected = object(error).code === 'work-history-integrity-unavailable'; }
  checks.actionTamperDetection = external.work.find(work => work.id === own.id)?.status === 'external-change' && external.work.find(work => work.id === own.id)?.history?.length === 3 && prefixRejected;
  // A pending amendment keeps v1 intent immutable. Resuming v1 never saves over the v2 draft.
  const stored = await readDraft(client, d.id, d.patient), corrected = content.select(stored.draft, 'Q01', 'reason');
  corrected.savedAt = new Date().toISOString(); corrected.revision = stored.draft.revision + 1;
  await saveDraft(client, stored, corrected);
  await h.resume(client, clinical.client, clinical.assignment, id, qualification);
  const after = await readDraft(client, d.id, d.patient);
  checks.correctionCoexistence = after.draft.version === 2 && !after.draft.confirmed && canonicalJson(after.draft) === canonicalJson(corrected) && (await client.check(d.confirmed!.confirmation)).state === 'received';
  const handler = createClinicHandler(config, { fetcher, runtime: async () => ({ client, qualification }) });
  const cookie = (await cookies(config.cookieSecret, config.origin.startsWith('https:')).issue('clinic_patient', { kind: 'patient', sessionId: d.id, patient: d.patient, scenario: d.scenario, identityConfirmed: true, expires: Date.now() + 600000 })).split(';')[0];
  const beforeRead = (await readDraft(client, d.id, d.patient)).versionId;
  const read = await handler(new Request(new URL('/api/clinic/receipt', config.origin), { headers: { cookie } }));
  checks.readOnlyReceipt = read.ok && (await readDraft(client, d.id, d.patient)).versionId === beforeRead;
  let workflows = true, isolation = true;
  const mappingConfirmations: ConfirmedSubmission[] = [];
  for (const scenario of ['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'] as const) {
    const draft = scenario === 'first-intake' ? d : await fixture(scenario);
    if (scenario !== 'first-intake') { await h.snapshot(client, draft); await client.deliver(draft.confirmed!.confirmation, qualification); }
    const receipt = await client.check(draft.confirmed!.confirmation);
    mappingConfirmations.push(draft.confirmed!.confirmation);
    journal({ scenario, submissionId: draft.id, resources: receipt.resources, anchors: receipt.anchors, delivery: receipt.state });
    workflows &&= receipt.state === 'received' && !!receipt.anchors.source && !!receipt.anchors.response && receipt.verifiedWork.length === draft.confirmed!.confirmation.submission.work.length;
    if (draft.confirmed!.confirmation.submission.work.some(work => work.responsibility === 'administrative')) {
      const view = await h.view(client, admin.client, admin.assignment, `${draft.id}.v1`);
      isolation &&= !view.sources.length && !view.work.some(work => work.responsibility !== 'administrative') && !canonicalJson(view.topics).includes('Synthetic qualification');
      for (const path of [receipt.anchors.source.reference, receipt.anchors.response.reference, ...Object.values(receipt.resources).filter(value => value.startsWith('DocumentReference/'))]) {
        try { await admin.client.request(path); isolation = false; } catch (error) { isolation &&= error instanceof TransportError && [401, 403, 404].includes(error.status ?? 0); }
        const resource = receipt.anchors.source.reference === path ? receipt.anchors.source : receipt.anchors.response.reference === path ? receipt.anchors.response : undefined;
        if (resource) { try { await admin.client.versionRead(path, resource.version); isolation = false; } catch (error) { isolation &&= error instanceof TransportError && [401, 403, 404].includes(error.status ?? 0); } }
      }
    }
  }
  // Native mapping: the seven actual workflows and two correction controls round-trip through the delivered
  // QuestionnaireResponse (clinic-native-mapping-v2), against the compiled .qualification-build of this checkout.
  const root = process.cwd();
  if (config.nativeQuestionnaire && !existsSync(resolve(root, 'scripts/qualification/clinic-native-mapping-v2.cjs'))) throw new Error('qualification-must-run-from-repository-root');
  checks.nativeQuestionnaireMapping = config.nativeQuestionnaire
    ? await createRequire(resolve(root, 'package.json'))('./scripts/qualification/clinic-native-mapping-v2.cjs').verify(root, config, client, qualification, journal, mappingConfirmations) === true
    : false;
  checks.sevenWorkflows = workflows; checks.administrativeIsolation = isolation;
  journal({ applicationChecks: checks, nativeActionFaults: ['lost-response', 'direct-status-edit'], injectedReadFaults: ['signed-prefix-truncation'] });
  if (applicationChecks.some(check => checks[check] !== true)) throw new Error(`conditional-application-qualification-failed:${applicationChecks.filter(check => !checks[check]).join(',')}`);
  const namedPolicyDigests: Record<string, string> = {};
  for (const actor of actors) { const response = await fetcher(new URL('auth/me', config.medplumBaseUrl), { headers: { Authorization: `Bearer ${actor.client.config.accessToken}` } }); if (!response.ok) throw new Error('named-policy-qualification-read-failed'); const me = object(await response.json()), policy = object(me.accessPolicy); if (object(me.project).id !== config.projectId || object(me.membership).id !== actor.assignment.membershipId || policy.resourceType !== 'AccessPolicy') throw new Error('named-policy-qualification-identity-mismatch'); const { id: _, meta: __, ...effective } = policy; namedPolicyDigests[actor.assignment.membershipId] = await digest(effective); }
  return { ...checks, namedPolicyDigests, evidenceDigest: await digest(retained) } as ApplicationQualification;
}
