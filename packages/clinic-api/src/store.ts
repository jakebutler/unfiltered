import { base64Json, type FhirResource } from '../../clinical-core/src/fhir.js';
import { canonicalJson } from '../../clinical-core/src/domain.js';
import { fhirResource, MedplumClient } from '../../clinical-core/src/medplum.js';
import { TransportError } from '../../clinical-core/src/transport.js';
import { ApiFailure, type Draft, type StoredDraft } from './types.js';
export const DRAFT_SYSTEM = 'urn:corvo:clinic:draft';
export const SNAPSHOT_SYSTEM = 'urn:corvo:clinic:handoff';
export const APP_EXTENSION = 'https://corvo.example/fhir/StructureDefinition/clinic-view';
export const ADMIN_TAG = 'urn:corvo:clinic:visibility';
export const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
    const entries = result.entry as {
        resource: FhirResource;
    }[] | undefined;
    if (result.resourceType !== 'Bundle' || result.type !== 'searchset' || (entries?.length ?? 0) > 1 || Number(result.total ?? 0) > 1 || (result.link as {
        relation: string;
    }[] | undefined)?.some(l => l.relation === 'next'))
        throw new ApiFailure('stored-identity-conflict', 409);
    return entries?.[0]?.resource;
}
export function document(system: string, value: string, patient: string, data: unknown): FhirResource {
    if (new TextEncoder().encode(canonicalJson(data)).byteLength > 500000)
        throw new ApiFailure('session-size-limit', 413);
    return { resourceType: 'DocumentReference', status: 'current', subject: { reference: patient }, identifier: [{ system, value }], content: [{ attachment: { contentType: 'application/json', data: base64Json(data) } }] };
}
function stored(resource: FhirResource, patient: string, id: string): StoredDraft {
    const draft = decodeDocument<Draft>(resource);
    const versionId = object(resource.meta).versionId;
    if (object(resource.subject).reference !== patient || draft.patient !== patient || draft.id !== id || draft.schema !== 1 || typeof versionId !== 'string' || !resource.id)
        throw new ApiFailure('session-scope-denied', 403);
    if (Date.parse(draft.createdAt) + 30 * 86400000 < Date.now())
        throw new ApiFailure('session-expired', 404);
    return { resource, draft, versionId };
}
export async function readDraft(client: MedplumClient, id: string, patient: string) {
    const resource = await findDocument(client, DRAFT_SYSTEM, id);
    if (!resource)
        throw new ApiFailure('session-not-found', 404);
    return stored(resource, patient, id);
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
    const resource = { ...document(DRAFT_SYSTEM, draft.id, draft.patient, draft), id: previous.resource.id };
    try {
        return stored(fhirResource((await client.request(`DocumentReference/${resource.id}`, 'PUT', resource, { 'If-Match': `W/"${previous.versionId}"` })).body), draft.patient, draft.id);
    }
    catch (error) {
        try {
            const recovered = await readDraft(client, draft.id, draft.patient);
            if (canonicalJson(recovered.draft) === canonicalJson(draft))
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
