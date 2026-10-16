import { base64Json, type FhirResource } from '../../clinical-core/src/fhir.js';
import { canonicalJson } from '../../clinical-core/src/domain.js';
import { fhirResource, MedplumClient } from '../../clinical-core/src/medplum.js';
import { TransportError } from '../../clinical-core/src/transport.js';
import { ApiFailure, type Draft, type StoredDraft } from './types.js';
import { z } from 'zod';
import { sourceChannels } from '../../clinic-contract/src/index.js';
import { accountForSource, allowsProvisionalOtherOwner, typedCaptureBound } from './provisional-draft.js';
import { createHash } from 'node:crypto';
import { frozenPriorContextSchema } from './prior-context.js';
export const DRAFT_SYSTEM = 'urn:corvo:clinic:draft';
export const SNAPSHOT_SYSTEM = 'urn:corvo:clinic:handoff';
export const APP_EXTENSION = 'https://corvo.example/fhir/StructureDefinition/clinic-view';
export const ADMIN_TAG = 'urn:corvo:clinic:visibility';
export const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const generationsSchema = z.record(z.number().int().nonnegative().max(1000)).refine(value => Object.keys(value).length <= 512);
const evidenceSchema = z.object({ sourceId: z.string().uuid(), start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict();
const policySchema = z.enum(['provisional-context-v1', 'provisional-intake-v2']);
const captureSchema = z.object({ sourceId: z.string().uuid(), policy: policySchema, interpretationProfile:z.literal('turn-bound-typed-v1').optional(), sourceBinding:z.object({digest:z.string().regex(/^[a-f0-9]{64}$/),bindingDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict().optional(), diagnostics:z.array(z.object({recordId:z.string().max(300),reason:z.literal('invalid-highlight')}).strict()).max(80).optional(),
    claims: z.array(z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), topicId: z.string().min(1).max(40), path: z.string().min(1).max(300), sourceId: z.string().uuid(),
        state: z.enum(['known', 'negative', 'unknown', 'declined', 'uncertain', 'not-applicable']),
        value: z.union([z.string().max(8000), z.number().finite(), z.boolean(), z.object({ feet: z.number().int().nonnegative(), inches: z.number().nonnegative().lt(12) }).strict(), z.null()]),
        highlight:evidenceSchema.optional(), evidence: z.array(evidenceSchema).min(1).max(4), valueEvidence: evidenceSchema.nullable(),
        scope: z.object({ subject: z.enum(['patient', 'other', 'unclear']), entity: z.string().min(1).max(300).nullable(), period: z.string().min(1).max(300).nullable(), predicate: evidenceSchema.nullable() }).strict(),
        correctsSourceIds: z.array(z.string().uuid()).max(8), attribution: z.literal('proposed-patient-report'), policy: policySchema,
        status: z.enum(['proposed', 'superseded', 'conflicting']), fidelity: z.enum(['literal-supported', 'model-interpreted']),
    }).strict()).max(64),
    items: z.array(z.object({ topicId: z.string().min(1).max(40), collection: z.string().min(1).max(300), id: z.string().regex(/^p[a-f0-9]{24}$/), entity: z.string().min(1).max(300), evidence: z.array(evidenceSchema).min(1).max(4) }).strict()).max(16).optional(),
    closures: z.array(z.object({ topicId: z.string().min(1).max(40), collection: z.string().min(1).max(300), evidence: z.array(evidenceSchema).min(1).max(4) }).strict()).max(16).optional(),
    acts: z.array(z.object({ kind: z.enum(['move-on', 'topic-switch', 'question']), attribution: z.enum(['direct-patient-command', 'reported-content', 'unclear']).optional(), topicId: z.string().min(1).max(40), evidence: z.array(evidenceSchema).min(1).max(4) }).strict()).max(4).optional(),
    gaps: z.array(z.object({ targetId: z.string().max(80).optional(), topicId:z.string().max(40).optional(), path:z.string().max(300).optional(), recordId:z.string().max(300).optional(), detail:z.string().max(8000).optional(), evidence: z.array(evidenceSchema).min(1).max(256),
        reason: z.enum(['invalid-type', 'unsupported-state', 'ownership', 'unsupported-unknown', 'value-not-in-source', 'temporal-crop', 'unsupported-target', 'ambiguous', 'capacity', 'conflict', 'recognition-unreviewed', 'unaddressed-source']) }).strict()).max(80),
    accounting: z.object({ addressed: z.array(evidenceSchema).max(256), remaining: z.array(evidenceSchema).max(256), structural: z.array(evidenceSchema).max(256).optional(), semanticReview: z.literal('qualification-required') }).strict(),
}).strict();
const sourceInterpretationSchema = z.object({ protocol: z.literal('source-first-focused-v1'), sourceId: z.string().min(1).max(64), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), sourceManifestSha256: z.string().regex(/^[a-f0-9]{64}$/), mappingManifestSha256: z.union([z.literal(''),z.string().regex(/^[a-f0-9]{64}$/)]), sourceRaw: z.string().max(32768), mappingRaw: z.string().max(32768), stageExecutions: z.array(z.enum(['not-dispatched','complete','unknown'])).length(2), rawAudit:z.object({source:z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().nonnegative()}).strict(),mapping:z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().nonnegative()}).strict(),retention:z.enum(['complete','operation-audit'])}).strict().optional(), reports: z.array(z.object({ quote:z.string().min(1).max(8000), meaning:z.string().min(1).max(1600), suggestedTopics:z.array(z.string().min(1).max(3000)).max(8) }).strict()).max(32), unresolved:z.array(z.object({quote:z.string().min(1).max(8000),reason:z.string().min(1).max(400)}).strict()).max(8), focusedTopicIds:z.array(z.string().min(1).max(40)).max(40), heldTopicIds:z.array(z.string().min(1).max(40)).max(40), unadmitted:z.array(z.unknown()).max(64), admission:z.object({coreManifestSha256:z.string().regex(/^[a-f0-9]{64}$/),dependentManifestSha256:z.string().regex(/^[a-f0-9]{64}$/),navigationAuthoritySha256:z.string().regex(/^[a-f0-9]{64}$/),qualificationSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().optional(), receipts:z.array(z.unknown()).max(2) }).strict().refine(value => Buffer.byteLength(canonicalJson(value)) <= 32768);
const streamSchema = z.object({ protocol: z.literal('durable-provisional-stream-v1'), reply: z.enum(['pending', 'saved', 'withheld']), capture: z.enum(['pending', 'saved', 'partial', 'discarded']),
    targetGenerations: generationsSchema, replyId: z.string().min(1).max(160).optional(), replyScope: z.object({ revision: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(), navigation: captureSchema.refine(capture => capture.claims.length <= 4 && canonicalJson(capture).length <= 8192).optional(), provisional: captureSchema.optional(), receipt: z.unknown().optional(), sourceInterpretation:sourceInterpretationSchema.optional() }).strict();
const savedOperationSchema = z.object({
    id: z.string().uuid(), requestId: z.string().uuid(), sourceId: z.string().uuid(), fingerprint: z.string().min(1).max(60000),
    status: z.enum(['accepted', 'processing', 'applied', 'failed', 'unresolved', 'discarded']),
    acceptedAt: z.string().datetime(), updatedAt: z.string().datetime(),
    binding: z.object({ operationId: z.string().uuid(), sessionId: z.string().uuid(), patient: z.string().min(1), scenario: z.string().min(1), revision: z.number().int().positive(), contentVersion: z.string().min(1), snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/) }),
    attemptId: z.string().uuid().optional(), processingRevision: z.number().int().positive().optional(), deadlineAt: z.string().datetime().optional(),
    resultDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    stream: streamSchema.optional(),
    queuedAfter: z.string().uuid().optional(), queuedWaiting: z.boolean().optional(),
}).passthrough();
const savedAdaptiveSchema = z.object({ mode: z.enum(['adaptive', 'guided']), operations: z.record(savedOperationSchema).refine(ops => Object.keys(ops).length <= 550), activeOperationId: z.string().uuid().optional(), targetGenerations: generationsSchema.optional() }).passthrough();
/** Legacy guided drafts have no adaptive state. Present adaptive claims must be recognizable and internally bound. */
function validateSavedAdaptive(draft: Draft) {
    if (draft.adaptive === undefined) return;
    const parsed = savedAdaptiveSchema.safeParse(draft.adaptive);
    if (!parsed.success) throw new ApiFailure('invalid-stored-operation', 503);
    const fail = () => { throw new ApiFailure('invalid-stored-operation', 503); };
    const state = parsed.data;
    if (state.activeOperationId && !state.operations[state.activeOperationId]) fail();
    let pending = 0;
    for (const [key, op] of Object.entries(state.operations)) {
        const source = Array.isArray(draft.turns) && draft.turns.find(turn => turn.id === op.sourceId && turn.role === 'patient');
        const request = draft.requests?.[op.requestId];
        if (key !== op.id || op.binding.operationId !== op.id || op.binding.sessionId !== draft.id || op.binding.patient !== draft.patient || op.binding.scenario !== draft.scenario || op.binding.revision > draft.revision || !source || source.at !== op.acceptedAt || typeof source.text !== 'string' || source.text.length > 8000 || request?.operationId !== op.id || request.revision !== op.binding.revision || request.fingerprint !== op.fingerprint) fail();
        if (['accepted', 'processing'].includes(op.status)) {
            pending++;
            const active = state.activeOperationId && state.operations[state.activeOperationId];
            if (state.activeOperationId !== op.id && !(op.status === 'processing' && op.stream?.reply === 'saved' && active && active.status === 'accepted' && active.queuedAfter === op.id && active.queuedWaiting)) fail();
        }
        if (op.queuedAfter && (!state.operations[op.queuedAfter] || op.queuedAfter === op.id || op.binding.revision <= state.operations[op.queuedAfter].binding.revision)) fail();
        if (!op.queuedAfter && op.queuedWaiting !== undefined || op.queuedWaiting && op.status !== 'accepted') fail();
        if (op.status === 'accepted' && op.attemptId) fail();
        if (['processing', 'applied', 'unresolved'].includes(op.status) && !op.attemptId) fail();
        if (op.attemptId && (!op.deadlineAt || op.processingRevision === undefined || (op.queuedAfter ? op.processingRevision < op.binding.revision + 1 : op.processingRevision !== op.binding.revision + 1) || op.processingRevision > draft.revision)) fail();
        if (!op.attemptId && (op.processingRevision !== undefined || op.deadlineAt !== undefined)) fail();
        if (op.status === 'applied' && !op.resultDigest) fail();
        if (op.stream) {
            if (!op.attemptId || op.stream.reply === 'saved' !== !!op.stream.replyId
                || op.stream.reply === 'saved' !== !!op.stream.replyScope || op.stream.replyScope && op.stream.replyScope.revision > draft.revision
                || op.stream.capture === 'saved' && !op.stream.provisional
                || op.stream.provisional && !['saved', 'partial'].includes(op.stream.capture)
                || op.stream.provisional?.sourceId && op.stream.provisional.sourceId !== op.sourceId
                || op.stream.navigation?.sourceId && op.stream.navigation.sourceId !== op.sourceId) fail();
            if (op.stream.sourceInterpretation && (op.stream.sourceInterpretation.sourceId !== op.sourceId || op.stream.sourceInterpretation.sourceSha256 !== createHash('sha256').update(canonicalJson(source)).digest('hex'))) fail();
            for (const capture of [op.stream.provisional, op.stream.navigation].filter((capture): capture is NonNullable<typeof capture> => !!capture)) {
            if (capture) for (const span of [...capture.claims.flatMap(claim => [...claim.evidence, ...(claim.scope.predicate?[claim.scope.predicate]:[]), ...(claim.highlight?[claim.highlight]:[]), ...(claim.valueEvidence ? [claim.valueEvidence] : [])]), ...(capture.items ?? []).flatMap(item => item.evidence), ...(capture.closures ?? []).flatMap(closure => closure.evidence), ...(capture.acts ?? []).flatMap(act => act.evidence), ...capture.gaps.flatMap(gap => gap.evidence), ...capture.accounting.addressed, ...capture.accounting.remaining, ...(capture.accounting.structural ?? [])]) {
                if (!source || span.sourceId !== op.sourceId || span.end <= span.start || span.end > source.text.length) fail();
            }
            if (source && capture.accounting.structural && canonicalJson(capture.accounting.structural) !== canonicalJson(accountForSource({ source: { id: op.sourceId, text: source.text } }, capture.accounting.addressed, capture.claims).structural)) fail();
            if(capture.interpretationProfile==='turn-bound-typed-v1') {
                if(!typedCaptureBound(draft,draft.adaptive!.operations[op.id]) || capture.claims.some(c=>c.scope.subject!=='patient' && !(c.scope.subject==='other' && /^familyHistory\[[^\]]+\]\.(condition|relationship)$/.test(c.path) && Object.values(draft.adaptive!.operations).some(o=>o.stream?.provisional?.items?.some(i=>c.path.startsWith(`${i.collection}[${i.id}].`)&&i.entity===c.scope.entity))))) fail();
            } else if (capture.claims.some(claim => !claim.scope.predicate || claim.sourceId !== op.sourceId || claim.scope.subject !== 'patient' && !(claim.scope.subject === 'other' && source && typeof source.text === 'string' && allowsProvisionalOtherOwner(claim.path,claim.scope.entity,source.text.slice(claim.scope.predicate.start,claim.scope.predicate.end))) || claim.policy !== capture.policy)) fail();
            }
        }
    }
    if (pending > 2 || pending === 2 && !Object.values(state.operations).some(op => op.status === 'accepted' && op.queuedWaiting && state.operations[op.queuedAfter!]?.status === 'processing')) fail();
}
export function decodeDocument<T>(resource: FhirResource): T {
    try {
        const content = resource.content as {
            attachment: {
                contentType: string;
                data: string;
            };
        }[];
        if (content.length !== 1 || content[0].attachment.contentType !== 'application/json' || typeof content[0].attachment.data !== 'string' || content[0].attachment.data.length > 1000000)
            throw new Error();
        return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(content[0].attachment.data), c => c.charCodeAt(0)))) as T;
    }
    catch {
        throw new ApiFailure('invalid-stored-document', 503);
    }
}
export async function findDocument(client: MedplumClient, system: string, value: string) {
    const result = object((await client.request(`DocumentReference?${new URLSearchParams({ identifier: `${system}|${value}`, _count: '2' })}`)).body);
    if (result.resourceType !== 'Bundle' || result.type !== 'searchset' || result.entry !== undefined && !Array.isArray(result.entry) || result.total !== undefined && (!Number.isSafeInteger(result.total) || Number(result.total) < 0) || result.link !== undefined && !Array.isArray(result.link)) throw new ApiFailure('stored-read-unknown', 503, true);
    const entries = (result.entry ?? []) as Array<{ resource: FhirResource }>;
    if (entries.length > 1 || Number(result.total ?? 0) > 1 || (result.link as Array<{ relation: string }> | undefined)?.some(link => link.relation === 'next')) throw new ApiFailure('stored-identity-conflict', 409);
    if (result.total !== undefined && result.total !== entries.length) throw new ApiFailure('stored-read-unknown', 503, true);
    if (!entries.length) return undefined;
    const resource = entries[0]?.resource;
    if (!resource || resource.resourceType !== 'DocumentReference' || !resource.id || !Array.isArray(resource.identifier) || !(resource.identifier as Array<{ system: string; value: string }>).some(identifier => identifier.system === system && identifier.value === value)) throw new ApiFailure('stored-read-unknown', 503, true);
    return resource;
}
export function document(system: string, value: string, patient: string, data: unknown): FhirResource {
    if (new TextEncoder().encode(canonicalJson(data)).byteLength > 500000)
        throw new ApiFailure('session-size-limit', 413);
    return { resourceType: 'DocumentReference', status: 'current', subject: { reference: patient }, identifier: [{ system, value }], content: [{ attachment: { contentType: 'application/json', data: base64Json(data) } }] };
}
function stored(resource: FhirResource, patient: string, id: string, confirmedRecovery = false): StoredDraft {
    const draft = decodeDocument<Draft>(resource);
    const versionId = object(resource.meta).versionId;
    if (object(resource.subject).reference !== patient || draft.patient !== patient || draft.id !== id || draft.schema !== 1 || typeof versionId !== 'string' || !resource.id)
        throw new ApiFailure('session-scope-denied', 403);
    if (!Array.isArray(draft.turns) || draft.turns.some(turn => turn.channel !== undefined && !sourceChannels.includes(turn.channel)))
        throw new ApiFailure('invalid-stored-source', 503);
    validateSavedAdaptive(draft);
    if (draft.priorContext !== undefined && !frozenPriorContextSchema.safeParse(draft.priorContext).success)
        throw new ApiFailure('invalid-stored-context', 503);
    if (Date.parse(draft.createdAt) + 30 * 86400000 < Date.now() && !(confirmedRecovery && draft.confirmed))
        throw new ApiFailure('session-expired', 404);
    return { resource, draft, versionId };
}
export async function readDraft(client: MedplumClient, id: string, patient: string, options: { confirmedRecovery?: boolean } = {}) {
    const resource = await findDocument(client, DRAFT_SYSTEM, id);
    if (!resource)
        throw new ApiFailure('session-not-found', 404);
    return stored(resource, patient, id, options.confirmedRecovery);
}
export async function createDraft(client: MedplumClient, draft: Draft) {
    try {
        const response = await client.request('DocumentReference', 'POST', document(DRAFT_SYSTEM, draft.id, draft.patient, draft), { 'If-None-Exist': new URLSearchParams({ identifier: `${DRAFT_SYSTEM}|${draft.id}` }).toString() });
        const result = stored(fhirResource(response.body), draft.patient, draft.id);
        if (canonicalJson(result.draft) !== canonicalJson(draft))
            throw new ApiFailure('session-id-conflict', 409);
        return result;
    }
    catch (error) {
        if (error instanceof ApiFailure)
            throw error;
        try {
            const recovered = await readDraft(client, draft.id, draft.patient);
            if (canonicalJson(recovered.draft) === canonicalJson(draft))
                return recovered;
        }
        catch { /* Preserve ambiguous write. */ }
        throw new ApiFailure('save-outcome-unknown', 503, true);
    }
}
export async function saveDraft(client: MedplumClient, previous: StoredDraft, draft: Draft) {
    // Corrections append a new source. Neither interpretation nor final summary confirmation
    // may rewrite recognized words, their provenance, or the earlier correction chain.
    const priorTurns = decodeDocument<Draft>(previous.resource).turns;
    if (!Array.isArray(priorTurns) || !Array.isArray(draft.turns) || priorTurns.some((turn, index) => canonicalJson(turn) !== canonicalJson(draft.turns[index])))
        throw new ApiFailure('immutable-source-conflict', 409);
    for (const [key, generation] of Object.entries(previous.draft.adaptive?.targetGenerations ?? {})) {
        if ((draft.adaptive?.targetGenerations?.[key] ?? -1) < generation) throw new ApiFailure('immutable-edit-generation-conflict', 409);
    }
    const resource = { ...document(DRAFT_SYSTEM, draft.id, draft.patient, draft), id: previous.resource.id };
    const isExactSave = (saved: StoredDraft) => saved.resource.id === previous.resource.id && saved.versionId !== previous.versionId && canonicalJson(saved.draft) === canonicalJson(draft);
    try {
        const saved = stored(fhirResource((await client.request(`DocumentReference/${resource.id}`, 'PUT', resource, { 'If-Match': `W/"${previous.versionId}"` })).body), draft.patient, draft.id);
        // Scope alone is not an acknowledgement of this CAS. In particular, a
        // stale HTTP 200 must never authorize dispatch of an inference attempt.
        if (!isExactSave(saved)) throw new ApiFailure('save-response-mismatch', 503);
        return saved;
    }
    catch (error) {
        try {
            const recovered = await readDraft(client, draft.id, draft.patient);
            if (isExactSave(recovered))
                return recovered;
            if (recovered.versionId !== previous.versionId)
                throw new ApiFailure('stale-session', 409, true);
        }
        catch (readError) {
            if (readError instanceof ApiFailure && readError.code === 'stale-session')
                throw readError;
        }
        if (error instanceof TransportError && error.status === 412)
            throw new ApiFailure('stale-session', 409, true);
        throw new ApiFailure('save-outcome-unknown', 503, true);
    }
}

/** Scope is rebuilt from verified assignment; cursors never contain a FHIR URL. */
export function queueOffset(cursor?: string) {
    if (cursor !== undefined && (!/^(0|[1-9]\d{0,5})$/.test(cursor) || Number(cursor) > 100000 || Number(cursor) % 5 !== 0)) throw new ApiFailure('invalid-queue-cursor');
    return Number(cursor ?? 0);
}
export async function scanDocuments(client: MedplumClient, system: string, patients: string[], cursor?: string) {
    const count = 5, maximumOffset = 100000;
    const offset = queueOffset(cursor);
    if (patients.length > 50 || patients.some(patient => !/^Patient\/[A-Za-z0-9.-]{1,64}$/.test(patient))) throw new ApiFailure('invalid-queue-assignment', 403);
    const query = new URLSearchParams({ identifier: `${system}|`, subject: [...new Set(patients)].join(','), _count: String(count), _offset: String(offset), _sort: '-_lastUpdated', _elements: 'id,identifier,subject' });
    const result = object((await client.request(`DocumentReference?${query}`)).body);
    if (result.resourceType !== 'Bundle' || result.type !== 'searchset' || result.entry !== undefined && !Array.isArray(result.entry) || result.total !== undefined && (!Number.isSafeInteger(result.total) || Number(result.total) < 0) || result.link !== undefined && !Array.isArray(result.link)) throw new ApiFailure('queue-unavailable', 503);
    const resources = ((result.entry as Array<{ resource: FhirResource }> | undefined) ?? []).map(entry => entry?.resource);
    if (resources.length > count) throw new ApiFailure('queue-page-too-large', 503);
    if (resources.some(resource => !resource || resource.resourceType !== 'DocumentReference' || !resource.id || typeof object(resource.subject).reference !== 'string' || !Array.isArray(resource.identifier)) || result.total !== undefined && (Number(result.total) < resources.length || !resources.length && Number(result.total) > offset)) throw new ApiFailure('queue-unavailable', 503);
    const links = result.link as Array<{ relation: string; url: string }> | undefined;
    if (links?.some(link => !link || typeof link.relation !== 'string' || typeof link.url !== 'string') || (links?.filter(link => link.relation === 'next').length ?? 0) > 1) throw new ApiFailure('invalid-queue-pagination', 503);
    const next = links?.find(link => link.relation === 'next');
    if (next) {
        const nextUrl = new URL(next.url, client.config.baseUrl), base = new URL(client.config.baseUrl);
        if (nextUrl.origin !== base.origin || nextUrl.pathname !== `${base.pathname}DocumentReference` || nextUrl.searchParams.get('_offset') !== String(offset + count)) throw new ApiFailure('invalid-queue-pagination', 503);
    }
    const hasMore = !!next || Number.isSafeInteger(result.total) && Number(result.total) > offset + resources.length;
    if (hasMore && offset + count > maximumOffset) throw new ApiFailure('queue-cursor-limit', 503);
    return { resources, ...(hasMore ? { nextCursor: String(offset + count) } : {}) };
}
