import { requireFinalRepresentationAuthority, type FinalRepresentationQualification } from './final-representation.js';
import type { ProvisionalQualification } from './provisional-projection.js';
import { scenarios } from '../../clinic-content/src/scenarios.js';
import { administrativeLogisticsSchema, canonicalJson, digest, recordReview, type ConfirmedSubmission, type OwnWorkReceipt } from '../../clinical-core/src/domain.js';
import { componentKey, DELIVERY_CONTRACT, planHandoff, resourceVersion, verifyComponent, type FhirResource } from '../../clinical-core/src/fhir.js';
import { fhirResource, MedplumClient, type Receipt, type DeliveryQualification } from '../../clinical-core/src/medplum.js';
import type { StaffHandoffView, StaffQueueItem, StaffRecoveryItem, DeliveryView, TopicView, ScenarioId } from '../../clinic-contract/src/index.js';
import { decodeDocument, document, findDocument, object, SNAPSHOT_SYSTEM, DRAFT_SYSTEM, readDraft, scanDocuments, queueOffset } from './store.js';
import { ApiFailure, type Draft, type ClinicApiConfig, type StaffAssignment } from './types.js';
import { scenarioTitles } from './conversation.js';
import { NATIVE_QUESTIONNAIRE_VERSION } from '../../clinic-content/src/native-questionnaire.js';
import { appendAction, signAction, verifiedTaskHistory, type ActionScope } from './task-history.js';

export interface Snapshot { schema: 2; deliveryContract: typeof DELIVERY_CONTRACT; id: string; patient: string; patientName: string; scenario: ScenarioId; confirmation: ConfirmedSubmission; topics: TopicView[]; }
const canAct = (role: StaffAssignment['role'], responsibility: string) => responsibility === 'administrative' ? role === 'administrative' : responsibility === 'nutrition' ? role === 'registered-dietitian' : ['physician', 'physician-assistant', 'nurse-practitioner'].includes(role);
const title = (responsibility: string) => responsibility === 'medical' ? 'Medical review' : responsibility === 'nutrition' ? 'Nutrition review' : 'Administrative assistance';
const canResume = (receipt: Receipt) => ['absent', 'incomplete'].includes(receipt.state);
const deliveryState = (receipt: Receipt): DeliveryView['state'] => receipt.state === 'absent' ? 'pending' : receipt.state;
/** Present only the confirmed strict domain projection; never rehydrate clinical strings. */
export function administrativeTopics(s: Snapshot): TopicView[] {
  const logistics = administrativeLogisticsSchema.parse(s.confirmation.submission.administrativeLogistics ?? { kind: 'other' });
  if (logistics.kind === 'other') return [];
  const id = logistics.kind === 'billing' ? 'W05' : 'W06', definition = scenarios[logistics.kind].additionalTopics.find(topic => topic.id === id)!;
  const details = Object.entries(logistics).filter(([field]) => field !== 'kind').map(([field, value]) => ({ id: field, label: definition.slots.find(slot => slot.id === field)?.label ?? field, state: 'answered' as const, text: value, sourceIds: [], editable: false }));
  return [{ id, title: 'Structured logistics request', status: 'more-detail-needed', required: true, missingDetails: [], details }];
}
/** A handoff captured under an earlier native questionnaire version: it stays in the record but can't be read by this release. */
const earlierQuestionnaire = (submission: unknown) => {
  const version = object(object(object(submission).questionnaireCapture).definition).version;
  return typeof version === 'string' && version !== NATIVE_QUESTIONNAIRE_VERSION;
};
export function handoffs(config: ClinicApiConfig, options: { provisionalQualification?: ProvisionalQualification; finalRepresentationQualification?: FinalRepresentationQualification } = {}) {
  const frozen = (draft: Draft): Snapshot => {
    if (!draft.confirmed) throw new ApiFailure('confirmation-required');
    requireFinalRepresentationAuthority(draft.confirmed.confirmation, options.provisionalQualification, options.finalRepresentationQualification);
    return { schema: 2, deliveryContract: DELIVERY_CONTRACT, id: draft.id, patient: draft.patient, patientName: config.patients[draft.scenario].displayName, scenario: draft.scenario, confirmation: draft.confirmed.confirmation, topics: draft.confirmed.topics };
  };
  async function validateSnapshot(resource: FhirResource, id: string, expected?: Snapshot) {
    const value = decodeDocument<Snapshot>(resource), submission = value.confirmation?.submission;
    if (value.schema !== 2 || value.deliveryContract !== DELIVERY_CONTRACT || !submission || value.id !== submission.submissionId || value.patient !== submission.patient || value.scenario !== submission.scenario || object(resource.subject).reference !== value.patient || `${value.id}.v${submission.version}` !== id || !Object.hasOwn(config.patients, value.scenario) || config.patients[value.scenario].reference !== value.patient || config.patients[value.scenario].displayName !== value.patientName || !Array.isArray(value.topics)) throw new ApiFailure('snapshot-conflict', 409);
    requireFinalRepresentationAuthority(value.confirmation, options.provisionalQualification, options.finalRepresentationQualification);
    await planHandoff(value.confirmation, config.nativeQuestionnaire?.reference);
    const expectedDocument = document(SNAPSHOT_SYSTEM, id, value.patient, value);
    if (!verifyComponent(expectedDocument, resource) || expected && canonicalJson(value) !== canonicalJson(expected)) throw new ApiFailure('snapshot-conflict', 409);
    return value;
  }
  async function snapshot(client: MedplumClient, draft: Draft) {
    const value = frozen(draft), id = `${draft.id}.v${draft.version}`;
    requireFinalRepresentationAuthority(value.confirmation, options.provisionalQualification, options.finalRepresentationQualification);
    await planHandoff(value.confirmation, config.nativeQuestionnaire?.reference);
    const existing = await findDocument(client, SNAPSHOT_SYSTEM, id);
    if (existing) { await validateSnapshot(existing, id, value); return; }
    try {
      const created = await client.request('DocumentReference', 'POST', document(SNAPSHOT_SYSTEM, id, draft.patient, value), { 'If-None-Exist': new URLSearchParams({ identifier: `${SNAPSHOT_SYSTEM}|${id}` }).toString() });
      await validateSnapshot(fhirResource(created.body), id, value);
    } catch (error) {
      const recovered = await findDocument(client, SNAPSHOT_SYSTEM, id);
      if (!recovered) throw new ApiFailure('snapshot-outcome-unknown', 503, true);
      await validateSnapshot(recovered, id, value);
      if (error instanceof ApiFailure && error.code === 'snapshot-conflict') throw error;
    }
    const readable = await findDocument(client, SNAPSHOT_SYSTEM, id);
    if (!readable) throw new ApiFailure('snapshot-outcome-unknown', 503, true);
    await validateSnapshot(readable, id, value);
  }
  async function get(client: MedplumClient, id: string) {
    if (!/^[a-f0-9-]{36}\.v[1-9]\d*$/.test(id)) throw new ApiFailure('handoff-not-found', 404);
    const resource = await findDocument(client, SNAPSHOT_SYSTEM, id);
    if (resource) { const value = await validateSnapshot(resource, id); const history = await client.history(`DocumentReference/${resource.id}`); const original = await client.versionRead(`DocumentReference/${resource.id}`, resourceVersion(history.at(-1)!)!); if (!verifyComponent(document(SNAPSHOT_SYSTEM, id, value.patient, value), original)) throw new ApiFailure('snapshot-conflict', 409); return { snapshot: value, resource, draft: undefined }; }
    // Confirmation survives a crash before snapshot creation. Only the exact active frozen revision is recoverable here.
    const draftId = id.split('.v')[0], intent = await findDocument(client, DRAFT_SYSTEM, draftId);
    const patient = String(object(intent?.subject).reference);
    if (!intent || !Object.values(config.patients).some(fixture => fixture.reference === patient)) throw new ApiFailure('handoff-not-found', 404);
    const stored = await readDraft(client, draftId, patient, { confirmedRecovery: true });
    if (!stored.draft.confirmed || `${draftId}.v${stored.draft.version}` !== id) throw new ApiFailure('handoff-not-found', 404);
    const value = frozen(stored.draft);
    requireFinalRepresentationAuthority(value.confirmation, options.provisionalQualification, options.finalRepresentationQualification);
    await planHandoff(value.confirmation, config.nativeQuestionnaire?.reference);
    return { snapshot: value, resource: undefined, draft: stored.draft };
  }
  const scope = (s: Snapshot, workId: string, reference: string): ActionScope => {
    const work = s.confirmation.submission.work.find(item => item.id === workId)!;
    return { project: config.projectId, task: reference, patient: s.patient, submissionId: s.id, version: s.confirmation.submission.version, digest: s.confirmation.digest, workId, owner: work.owner };
  };
  async function verifyTask(s: Snapshot, workId: string, task: FhirResource, receipt: Receipt) {
    const plan = await planHandoff(s.confirmation, config.nativeQuestionnaire?.reference), component = plan.components.find(item => item.key === componentKey(s.confirmation.submission, `work.${workId}`))!;
    const references = new Map(plan.components.filter(item => item.key.endsWith('.sources') || item.key.endsWith('.response')).map(item => { const anchor = receipt.anchors[item.key.endsWith('.sources') ? 'source' : 'response']; return [item.fullUrl, anchor ? `${anchor.reference}/_history/${anchor.version}` : ''] as const; }));
    if (!verifyComponent(component.resource, task, references)) throw new ApiFailure('work-content-conflict', 409);
  }
  async function work(client: MedplumClient, s: Snapshot, receipt: Receipt): Promise<DeliveryView['work']> {
    const rows: DeliveryView['work'] = [];
    for (const item of s.confirmation.submission.work) {
      const reference = receipt.resources[componentKey(s.confirmation.submission, `work.${item.id}`)];
      if (!reference || !receipt.verifiedWork.includes(item.id)) { rows.push({ id: item.id, title: title(item.responsibility), responsibility: item.responsibility, status: 'pending', revision: '', delivery: receipt.state === 'conflict' ? 'conflict' : receipt.state === 'unknown' ? 'unknown' : 'pending' }); continue; }
      const task = fhirResource((await client.request(reference)).body);
      await verifyTask(s, item.id, task, receipt);
      const history = await verifiedTaskHistory(client, task, scope(s, item.id, reference), config.cookieSecret);
      rows.push({ id: item.id, title: title(item.responsibility), responsibility: item.responsibility, status: history.external ? 'external-change' : history.latest?.outcome ?? 'received', revision: resourceVersion(task)!, delivery: 'verified', history: history.entries.map(action => ({ actionId: action.actionId, fingerprint: action.fingerprint, outcome: action.outcome, author: action.name, at: action.at, note: action.note })), ...(history.latest ? { outcome: history.latest.note, author: history.latest.name, at: history.latest.at } : {}) });
    }
    return rows;
  }
  async function delivery(client: MedplumClient, draft: Draft): Promise<DeliveryView> {
    const s = frozen(draft), receipt = await client.check(s.confirmation);
    return { state: deliveryState(receipt), reference: `${s.id}.v${s.confirmation.submission.version}`, version: s.confirmation.submission.version, canRetryDelivery: canResume(receipt), ...(receipt.state === 'received' && receipt.receivedAt ? { receivedAt: receipt.receivedAt } : {}), work: await work(client, s, receipt) };
  }
  async function previousDelivery(client: MedplumClient, draft: Draft) {
    if (!draft.prior) throw new ApiFailure('prior-handoff-required');
    const { snapshot: s } = await get(client, `${draft.id}.v${draft.prior.version}`);
    if (s.patient !== draft.patient || s.confirmation.digest !== draft.prior.digest) throw new ApiFailure('prior-handoff-conflict', 409);
    return delivery(client, { ...draft, version: draft.prior.version, confirmed: { digest: s.confirmation.digest, confirmation: s.confirmation, topics: s.topics } });
  }
  async function authorized(client: MedplumClient, named: MedplumClient, assignment: StaffAssignment, id: string) {
    const result = await get(client, id), s = result.snapshot;
    const assigned = s.confirmation.submission.work.filter(item => assignment.careTeams.includes(item.owner) && canAct(assignment.role, item.responsibility));
    if (!assignment.patients.includes(s.patient) || !assigned.length) throw new ApiFailure('handoff-not-found', 404);
    const receipt = await client.check(s.confirmation), anchorsVerified = !!receipt.anchors.source && !!receipt.anchors.response && receipt.state !== 'conflict';
    if (assignment.role === 'administrative') {
      for (const own of assigned) { const reference = receipt.resources[componentKey(s.confirmation.submission, `work.${own.id}`)]; if (reference) await named.request(reference); }
    } else if (anchorsVerified) {
      if (result.resource) await named.request(`DocumentReference/${result.resource.id}`);
      const plan = await planHandoff(s.confirmation, config.nativeQuestionnaire?.reference);
      for (const kind of ['source', 'response']) {
        const anchor = receipt.anchors[kind], read = await named.versionRead(anchor.reference, anchor.version), component = plan.components[kind === 'source' ? 0 : 1];
        const references = new Map([[plan.components[0].fullUrl, `${receipt.anchors.source.reference}/_history/${receipt.anchors.source.version}`]]);
        if (!verifyComponent(component.resource, read, references)) throw new ApiFailure('source-access-denied', 403);
      }
    }
    return { ...result, s, receipt, anchorsVerified, assigned };
  }
  async function view(client: MedplumClient, named: MedplumClient, assignment: StaffAssignment, id: string): Promise<StaffHandoffView> {
    const { s, receipt, anchorsVerified } = await authorized(client, named, assignment, id), clinical = assignment.role !== 'administrative';
    const all = await work(client, s, receipt), visible = clinical ? all : all.filter(item => item.responsibility === 'administrative');
    return { id, patientName: s.patientName, title: clinical ? scenarioTitles[s.scenario] : 'Administrative assistance requested', ...(receipt.state === 'received' ? { receivedAt: receipt.receivedAt } : {}), version: s.confirmation.submission.version, ...(clinical ? { completeness: s.confirmation.submission.completeness } : {}), deliveryState: deliveryState(receipt), anchorsVerified, canResume: canResume(receipt), topics: clinical ? anchorsVerified ? s.topics : [] : administrativeTopics(s), sources: clinical && anchorsVerified ? s.confirmation.submission.sources.map(source => ({ id: source.id, text: source.text, at: source.capturedAt, role: 'patient' as const, ...(source.channel ? { channel: source.channel } : {}), ...(source.corrects ? { corrects: source.corrects } : {}) })) : [], work: visible, allowedActions: anchorsVerified ? visible.filter(item => item.delivery === 'verified' && canAct(assignment.role, item.responsibility)).map(item => ({ workId: item.id, outcomes: ['reviewed', 'needs-information', 'declined', 'resolved'] })) : [] };
  }
  async function queue(client: MedplumClient, named: MedplumClient, assignment: StaffAssignment, cursor?: string, recoveryCursor?: string) {
    queueOffset(cursor); queueOffset(recoveryCursor);
    if (!assignment.patients.length || !assignment.careTeams.length) return { items: [], recovery: [] };
    const snapshots = await scanDocuments(client, SNAPSHOT_SYSTEM, assignment.patients, cursor), drafts = await scanDocuments(client, DRAFT_SYSTEM, assignment.patients, recoveryCursor);
    const ids = new Set<string>(), items: StaffQueueItem[] = [], recovery: StaffRecoveryItem[] = [];
    // Counted, not hidden silently and never allowed to fail the whole queue; any other invalid record still fails loudly.
    let earlierVersion = 0;
    for (const row of snapshots.resources) {
      if (!assignment.patients.includes(String(object(row.subject).reference))) continue;
      const id = (row.identifier as Array<{ system: string; value: string }> | undefined)?.find(identifier => identifier.system === SNAPSHOT_SYSTEM)?.value;
      if (!id) throw new ApiFailure('invalid-queue-record', 503);
      if (earlierQuestionnaire(decodeDocument<{ confirmation?: { submission?: unknown } }>(row).confirmation?.submission)) { earlierVersion++; continue; }
      ids.add(id);
    }
    for (const row of drafts.resources) {
      const patient = String(object(row.subject).reference); if (!assignment.patients.includes(patient)) continue;
      const id = (row.identifier as Array<{ system: string; value: string }> | undefined)?.find(identifier => identifier.system === DRAFT_SYSTEM)?.value;
      if (!id) throw new ApiFailure('invalid-queue-record', 503);
      let draft: Draft;
      try { draft = (await readDraft(client, id, patient, { confirmedRecovery: true })).draft; }
      catch (error) { if (error instanceof ApiFailure && error.code === 'session-expired') continue; throw error; }
      if (draft.confirmed && !(await findDocument(client, SNAPSHOT_SYSTEM, `${id}.v${draft.version}`))) {
        if (earlierQuestionnaire(draft.confirmed.confirmation.submission)) earlierVersion++; else ids.add(`${id}.v${draft.version}`);
      }
    }
    for (const id of ids) {
      try {
        const v = await view(client, named, assignment, id);
        if (v.deliveryState !== 'received') recovery.push({ id, patientName: v.patientName, scenarioTitle: v.title, deliveryState: v.deliveryState!, anchorsVerified: !!v.anchorsVerified, canResume: !!v.canResume });
        else for (const item of v.work.filter(item => canAct(assignment.role, item.responsibility))) items.push({ id, patientName: v.patientName, scenarioTitle: v.title, receivedAt: v.receivedAt, ...(v.completeness ? { completeness: v.completeness } : {}), status: item.status as StaffQueueItem['status'], responsibility: item.responsibility });
      } catch (error) { if (!(error instanceof ApiFailure) || error.code !== 'handoff-not-found') throw error; }
    }
    items.sort((a, b) => Date.parse(b.receivedAt ?? '1970-01-01') - Date.parse(a.receivedAt ?? '1970-01-01') || a.id.localeCompare(b.id));
    return { items, recovery, ...(earlierVersion ? { earlierVersion } : {}), ...(snapshots.nextCursor ? { nextCursor: snapshots.nextCursor } : {}), ...(drafts.nextCursor ? { recoveryCursor: drafts.nextCursor } : {}) };
  }
  async function resume(client: MedplumClient, named: MedplumClient, assignment: StaffAssignment, id: string, qualification: DeliveryQualification) {
    const verified = await authorized(client, named, assignment, id);
    if (!canResume(verified.receipt)) throw new ApiFailure('delivery-retry-not-permitted', 409, true);
    if (verified.draft) await snapshot(client, verified.draft);
    await client.deliver(verified.s.confirmation, qualification);
    // No draft save: an older frozen handoff never overwrites an active correction.
    return view(client, named, assignment, id);
  }
  async function action(client: MedplumClient, named: MedplumClient, assignment: StaffAssignment, id: string, input: { actionId: string; workId: string; expectedVersion: number; expectedWorkVersion: string; outcome: 'reviewed' | 'needs-information' | 'declined' | 'resolved'; note: string }) {
    const { s, receipt, anchorsVerified, assigned } = await authorized(client, named, assignment, id);
    const own = assigned.find(item => item.id === input.workId), reference = receipt.resources[componentKey(s.confirmation.submission, `work.${input.workId}`)];
    if (!anchorsVerified || !own || !reference || !receipt.verifiedWork.includes(input.workId)) throw new ApiFailure('own-work-not-received', 409, true);
    if (input.expectedVersion !== s.confirmation.submission.version) throw new ApiFailure('stale-handoff', 409, true);
    if (!/^[a-f0-9-]{36}$/.test(input.actionId) || !input.note.trim() || input.note.length > 4000) throw new ApiFailure('invalid-action-request');
    const ownReceipt: OwnWorkReceipt = { state: 'own-work-verified', digest: s.confirmation.digest, patient: s.patient, workId: own.id, owner: own.owner, task: reference, anchors: { source: `${receipt.anchors.source.reference}/_history/${receipt.anchors.source.version}`, response: `${receipt.anchors.response.reference}/_history/${receipt.anchors.response.version}` } };
    const actionScope = scope(s, own.id, reference), fingerprint = await digest({ scope: actionScope, actor: { profile: assignment.profile, membership: assignment.membershipId, role: assignment.role }, ...input, note: input.note.trim() });
    const task = fhirResource((await client.request(reference)).body);
    await verifyTask(s, own.id, task, receipt);
    const history = await verifiedTaskHistory(client, task, actionScope, config.cookieSecret);
    const prior = history.entries.find(entry => entry.actionId === input.actionId);
    if (prior) { if (prior.fingerprint !== fingerprint) throw new ApiFailure('action-id-conflict', 409); return view(client, named, assignment, id); }
    const version = resourceVersion(task);
    if (!version || version !== input.expectedWorkVersion) throw new ApiFailure('stale-work', 409, true);
    const at = new Date().toISOString(), reviewed = await recordReview(s.confirmation, { member: assignment.profile, role: assignment.role, patient: s.patient, assignedCareTeams: assignment.careTeams }, own.id, input.outcome, at, ownReceipt);
    const entry = await signAction(config.cookieSecret, { ...reviewed, schema: 1, actionId: input.actionId, fingerprint, scope: actionScope, priorTaskVersion: version, previousHistoryDigest: await digest(history.entries), name: assignment.name, membership: assignment.membershipId, note: input.note.trim() });
    let rejected = false;
    try { await client.request(reference, 'PUT', appendAction(task, entry), { 'If-Match': `W/"${version}"` }); }
    catch (error) { rejected = object(error).status === 412; }
    const latest = fhirResource((await client.request(reference)).body), recovered = await verifiedTaskHistory(client, latest, actionScope, config.cookieSecret);
    const accepted = recovered.entries.find(action => action.actionId === input.actionId);
    if (!accepted || accepted.fingerprint !== fingerprint) throw new ApiFailure(rejected || resourceVersion(latest) !== version ? 'stale-work' : 'action-outcome-unknown', rejected ? 409 : 503, true);
    return view(client, named, assignment, id);
  }
  return { snapshot, delivery, previousDelivery, view, queue, action, resume };
}
