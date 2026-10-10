import { scenarios } from '../../clinic-content/src/scenarios.js';
import { recordReview, type ConfirmedSubmission } from '../../clinical-core/src/domain.js';
import { componentKey, identifierQuery, type FhirResource } from '../../clinical-core/src/fhir.js';
import { fhirResource, MedplumClient, type Receipt } from '../../clinical-core/src/medplum.js';
import type { StaffHandoffView, StaffQueueItem, DeliveryView, TopicView, ScenarioId } from '../../clinic-contract/src/index.js';
import { decodeDocument, document, findDocument, object, SNAPSHOT_SYSTEM, APP_EXTENSION } from './store.js';
import { ApiFailure, type Draft, type ClinicApiConfig, type StaffAssignment } from './types.js';
import { scenarioTitles } from './conversation.js';
export interface Snapshot {
    schema: 1;
    id: string;
    patient: string;
    patientName: string;
    scenario: ScenarioId;
    confirmation: ConfirmedSubmission;
    topics: TopicView[];
}
const actionExtension = 'https://corvo.example/fhir/StructureDefinition/clinic-review';
const canAct = (role: StaffAssignment['role'], responsibility: string) => responsibility === 'administrative' ? role === 'administrative' : responsibility === 'nutrition' ? role === 'registered-dietitian' : ['physician', 'physician-assistant', 'nurse-practitioner'].includes(role);
const ref = (r: FhirResource) => `${r.resourceType}/${r.id}`;
function actionOf(r: FhirResource) { const ext = (r.extension as {
    url: string;
    valueString?: string;
}[] | undefined)?.find(x => x.url === actionExtension); try {
    return ext?.valueString ? object(JSON.parse(ext.valueString)) : {};
}
catch {
    throw new ApiFailure('invalid-work-record', 503);
} }
const safeLogistics: Record<string, readonly string[]> = { W05: ['issueType', 'serviceDate', 'requestedResolution'], W06: ['intent', 'visitCategory', 'preferredDay', 'preferredWindow', 'requestedDate', 'timezone'] };
export function administrativeTopics(s: Snapshot): TopicView[] { if (!['billing', 'scheduling'].includes(s.scenario))
    return []; const definitions = scenarios[s.scenario].additionalTopics; return s.topics.filter(t => safeLogistics[t.id]).map(t => { const definition = definitions.find(d => d.id === t.id)!; const details = (t.details ?? []).filter(d => safeLogistics[t.id].includes(d.id)).map(d => { const slot = definition.slots.find(x => x.id === d.id)!; const choice = slot.kind === 'choice' && slot.choices?.some(x => String(x) === d.text); const date = ['serviceDate', 'requestedDate'].includes(d.id) && typeof d.text === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.text) && Number.isFinite(Date.parse(d.text)) && new Date(d.text).toISOString().slice(0, 10) === d.text; const valid = d.state === 'answered' && (choice || date); return { id: d.id, label: slot.label, state: valid ? 'answered' as const : d.state === 'declined' ? 'declined' as const : 'unknown' as const, text: valid ? d.text : d.state === 'declined' ? 'Not shared' : 'Needs clarification', sourceIds: [], editable: false }; }); return { id: t.id, title: 'Structured logistics request', status: t.status, required: true, missingDetails: details.filter(d => d.state !== 'answered').map(d => d.label), details }; }); }
export function handoffs(config: ClinicApiConfig) {
    async function snapshot(client: MedplumClient, d: Draft) {
        if (!d.confirmed)
            throw new ApiFailure('confirmation-required');
        const value: Snapshot = { schema: 1, id: d.id, patient: d.patient, patientName: config.patients[d.scenario].displayName, scenario: d.scenario, confirmation: d.confirmed.confirmation, topics: d.confirmed.topics };
        const key = `${d.id}.v${d.version}`;
        const existing = await findDocument(client, SNAPSHOT_SYSTEM, key);
        if (existing) {
            if (decodeDocument<Snapshot>(existing).confirmation.digest !== value.confirmation.digest)
                throw new ApiFailure('snapshot-conflict', 409);
            return;
        }
        await client.request('DocumentReference', 'POST', document(SNAPSHOT_SYSTEM, key, d.patient, value), { 'If-None-Exist': new URLSearchParams({ identifier: `${SNAPSHOT_SYSTEM}|${key}` }).toString() });
    }
    async function get(client: MedplumClient, id: string) { if (!/^[a-f0-9-]{36}\.v[1-9]\d*$/.test(id))
        throw new ApiFailure('handoff-not-found', 404); const r = await findDocument(client, SNAPSHOT_SYSTEM, id); if (!r)
        throw new ApiFailure('handoff-not-found', 404); const s = decodeDocument<Snapshot>(r); if (s.schema !== 1 || s.patient !== s.confirmation.submission.patient || object(r.subject).reference !== s.patient || `${s.id}.v${s.confirmation.submission.version}` !== id)
        throw new ApiFailure('handoff-not-found', 404); return { snapshot: s, resource: r }; }
    async function work(client: MedplumClient, s: Snapshot, receipt: Receipt): Promise<DeliveryView['work']> { if (receipt.state !== 'received')
        return []; return Promise.all(s.confirmation.submission.work.map(async (w) => { const reference = receipt.resources[componentKey(s.confirmation.submission, `work.${w.id}`)]; const r = fhirResource((await client.request(reference)).body); const a = actionOf(r); return { id: w.id, title: w.responsibility === 'medical' ? 'Medical review' : w.responsibility === 'nutrition' ? 'Nutrition review' : 'Administrative assistance', responsibility: w.responsibility, status: typeof a.outcome === 'string' ? a.outcome as DeliveryView['work'][number]['status'] : 'received', revision: String(object(r.meta).versionId ?? ''), ...(typeof a.note === 'string' ? { outcome: a.note, author: String(a.name), at: String(a.at) } : {}) }; })); }
    async function delivery(client: MedplumClient, d: Draft): Promise<DeliveryView> { if (!d.confirmed)
        throw new ApiFailure('confirmation-required'); const receipt = await client.check(d.confirmed.confirmation); const s: Snapshot = { schema: 1, id: d.id, patient: d.patient, patientName: config.patients[d.scenario].displayName, scenario: d.scenario, confirmation: d.confirmed.confirmation, topics: d.confirmed.topics }; return { state: receipt.state === 'absent' ? 'pending' : receipt.state, reference: `${d.id}.v${d.version}`, version: d.version, canRetryDelivery: receipt.state === 'absent', ...(receipt.state === 'received' && receipt.receivedAt ? { receivedAt: receipt.receivedAt } : {}), work: await work(client, s, receipt) }; }
    async function previousDelivery(client: MedplumClient, d: Draft) { if (!d.prior)
        throw new ApiFailure('prior-handoff-required'); const { snapshot: s } = await get(client, `${d.id}.v${d.prior.version}`); if (s.patient !== d.patient || s.confirmation.digest !== d.prior.digest)
        throw new ApiFailure('prior-handoff-conflict', 409); return delivery(client, { ...d, version: d.prior.version, confirmed: { digest: s.confirmation.digest, confirmation: s.confirmation, topics: s.topics, receivedAt: d.previousDelivery?.receivedAt } }); }
    async function authorized(client: MedplumClient, named: MedplumClient, assignment: StaffAssignment, id: string) {
        const { snapshot: s, resource } = await get(client, id);
        if (!assignment.patients.includes(s.patient) || !s.confirmation.submission.work.some(w => assignment.careTeams.includes(w.owner)))
            throw new ApiFailure('handoff-not-found', 404);
        const receipt = await client.check(s.confirmation);
        if (receipt.state !== 'received')
            throw new ApiFailure('handoff-not-received', 409, true);
        if (assignment.role === 'administrative') {
            const admin = s.confirmation.submission.work.find(w => w.responsibility === 'administrative' && assignment.careTeams.includes(w.owner));
            if (!admin)
                throw new ApiFailure('handoff-not-found', 404);
            await named.request(receipt.resources[componentKey(s.confirmation.submission, `work.${admin.id}`)]);
        }
        else {
            await named.request(ref(resource));
            const ownReceipt = await named.check(s.confirmation);
            if (ownReceipt.state !== 'received')
                throw new ApiFailure('source-access-denied', 403);
        }
        return { s, receipt };
    }
    async function view(client: MedplumClient, named: MedplumClient, assignment: StaffAssignment, id: string): Promise<StaffHandoffView> { const { s, receipt } = await authorized(client, named, assignment, id); const clinical = assignment.role !== 'administrative'; const all = await work(client, s, receipt), visible = clinical ? all : all.filter(w => w.responsibility === 'administrative'); const topics = clinical ? s.topics : administrativeTopics(s); const sourceIds = new Set(topics.flatMap(t => t.answer?.sourceIds ?? [])); return { id, patientName: s.patientName, title: clinical ? scenarioTitles[s.scenario] : s.scenario === 'billing' ? 'Billing assistance requested' : s.scenario === 'scheduling' ? 'Scheduling assistance requested' : 'Administrative assistance requested', receivedAt: receipt.state === 'received' ? receipt.receivedAt : undefined, version: s.confirmation.submission.version, completeness: s.confirmation.submission.completeness, topics, sources: clinical ? s.confirmation.submission.sources.map(x => ({ id: x.id, text: x.text, at: x.capturedAt, role: 'patient' as const, ...(x.corrects ? { corrects: x.corrects } : {}) })) : s.confirmation.submission.sources.filter(x => sourceIds.has(x.id)).map(x => ({ id: x.id, text: x.text, at: x.capturedAt, role: 'patient' as const })), work: visible, allowedActions: visible.filter(w => canAct(assignment.role, w.responsibility)).map(w => ({ workId: w.id, outcomes: ['reviewed', 'needs-information', 'declined', 'resolved'] })) }; }
    async function queue(client: MedplumClient, named: MedplumClient, assignment: StaffAssignment, cursor?: string): Promise<{ items: StaffQueueItem[]; nextCursor?: string }> {
        const pageSize = 5, maximumOffset = 100000;
        if (cursor !== undefined && (!/^(0|[1-9]\d{0,5})$/.test(cursor) || Number(cursor) > maximumOffset || Number(cursor) % pageSize !== 0))
            throw new ApiFailure('invalid-queue-cursor');
        const offset = cursor === undefined ? 0 : Number(cursor);
        if (!assignment.patients.length || !assignment.careTeams.length)
            return { items: [] };
        if (assignment.patients.length > 50 || assignment.patients.some(patient => !/^Patient\/[A-Za-z0-9.-]{1,64}$/.test(patient)))
            throw new ApiFailure('invalid-queue-assignment', 403);
        // Cursor changes position only. Subject scope is rebuilt from verified
        // assignment for every request; no caller-supplied FHIR URL is followed.
        const query = new URLSearchParams({ identifier: `${SNAPSHOT_SYSTEM}|`, subject: [...new Set(assignment.patients)].join(','), _count: String(pageSize), _offset: String(offset), _sort: '-_lastUpdated', _elements: 'id,identifier,subject' });
        const result = object((await client.request(`DocumentReference?${query}`)).body);
        if (result.resourceType !== 'Bundle' || result.type !== 'searchset' || (result.entry !== undefined && !Array.isArray(result.entry)))
            throw new ApiFailure('queue-unavailable', 503);
        const resources = ((result.entry as { resource: FhirResource }[] | undefined) ?? []).map(entry => entry.resource);
        if (resources.length > pageSize)
            throw new ApiFailure('queue-page-too-large', 503);
        const next = (result.link as { relation: string; url: string }[] | undefined)?.find(link => link.relation === 'next');
        if (next) {
            const nextUrl = new URL(next.url, client.config.baseUrl), baseUrl = new URL(client.config.baseUrl);
            if (nextUrl.origin !== baseUrl.origin || nextUrl.pathname !== `${baseUrl.pathname}DocumentReference` || nextUrl.searchParams.get('_offset') !== String(offset + pageSize))
                throw new ApiFailure('invalid-queue-pagination', 503);
        }
        const hasMore = !!next || (Number.isSafeInteger(result.total) && Number(result.total) > offset + resources.length);
        if (hasMore && offset + pageSize > maximumOffset)
            throw new ApiFailure('queue-cursor-limit', 503, false);
        const items: StaffQueueItem[] = [];
        for (const resource of resources) {
            // Defense in depth against an unexpected search response. Never
            // fetch the full document or its sources for another patient.
            if (!assignment.patients.includes(String(object(resource.subject).reference)))
                continue;
            const identifiers = resource.identifier as { system: string; value: string }[] | undefined;
            const id = identifiers?.find(identifier => identifier.system === SNAPSHOT_SYSTEM)?.value;
            if (!id)
                throw new ApiFailure('invalid-queue-record', 503);
            try {
                const v = await view(client, named, assignment, id);
                for (const w of v.work.filter(work => canAct(assignment.role, work.responsibility)))
                    items.push({ id, patientName: v.patientName, scenarioTitle: v.title, receivedAt: v.receivedAt, completeness: v.completeness, status: w.status, responsibility: w.responsibility });
            }
            catch (error) {
                if (error instanceof ApiFailure && ['handoff-not-received', 'handoff-not-found'].includes(error.code))
                    continue;
                throw error;
            }
        }
        items.sort((a, b) => Date.parse(b.receivedAt ?? '1970-01-01') - Date.parse(a.receivedAt ?? '1970-01-01') || a.id.localeCompare(b.id));
        return { items, ...(hasMore ? { nextCursor: String(offset + pageSize) } : {}) };
    }
    async function action(client: MedplumClient, named: MedplumClient, assignment: StaffAssignment, id: string, input: {
        workId: string;
        expectedVersion: number;
        expectedWorkVersion: string;
        outcome: 'reviewed' | 'needs-information' | 'declined' | 'resolved';
        note: string;
    }) {
        const { s, receipt } = await authorized(client, named, assignment, id);
        if (input.expectedVersion !== s.confirmation.submission.version)
            throw new ApiFailure('stale-handoff', 409, true);
        if (!input.note.trim() || input.note.length > 4000)
            throw new ApiFailure('outcome-note-required');
        const at = new Date().toISOString();
        const a = await recordReview(s.confirmation, { member: assignment.profile, role: assignment.role, patient: s.patient, assignedCareTeams: assignment.careTeams }, input.workId, input.outcome, at, receipt);
        const key = componentKey(s.confirmation.submission, `work.${input.workId}`), reference = receipt.resources[key];
        const task = fhirResource((await client.request(reference)).body);
        const version = String(object(task.meta).versionId ?? '');
        if (!version || version !== input.expectedWorkVersion)
            throw new ApiFailure('stale-work', 409, true);
        const actionValue = { ...a, note: input.note.trim(), name: assignment.name, membership: assignment.membershipId };
        const updated = { ...task, status: input.outcome === 'resolved' ? 'completed' : input.outcome === 'declined' ? 'rejected' : input.outcome === 'needs-information' ? 'on-hold' : 'in-progress', businessStatus: { text: input.outcome }, extension: [...((task.extension as {
                    url: string;
                }[] | undefined) ?? []).filter(x => x.url !== actionExtension), { url: actionExtension, valueString: JSON.stringify(actionValue) }] };
        const audit: FhirResource = { resourceType: 'Provenance', target: [{ reference }], recorded: at, activity: { text: input.outcome }, agent: [{ type: { text: 'Verified clinical application staff action' }, role: [{ text: assignment.role }], who: { reference: assignment.profile } }], entity: [{ role: 'source', what: { reference: `ProjectMembership/${assignment.membershipId}` } }], extension: [{ url: APP_EXTENSION, valueString: JSON.stringify({ submissionId: s.id, version: s.confirmation.submission.version, digest: s.confirmation.digest, workId: input.workId, note: input.note.trim() }) }] };
        try {
            await client.request('', 'POST', { resourceType: 'Bundle', type: 'transaction', entry: [{ resource: updated, request: { method: 'PUT', url: reference, ifMatch: `W/"${version}"` } }, { resource: audit, request: { method: 'POST', url: 'Provenance' } }] });
        }
        catch {
            const recovered = fhirResource((await client.request(reference)).body);
            const saved = actionOf(recovered);
            if (saved.at !== at || saved.member !== assignment.profile || saved.outcome !== input.outcome)
                throw new ApiFailure('action-outcome-unknown', 503, true);
        }
        const result = await view(client, named, assignment, id);
        if (result.work.find(w => w.id === input.workId)?.at !== at)
            throw new ApiFailure('action-outcome-unknown', 503, true);
        return result;
    }
    return { snapshot, delivery, previousDelivery, view, queue, action };
}
