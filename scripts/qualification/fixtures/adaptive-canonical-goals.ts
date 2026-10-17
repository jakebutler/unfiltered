/** Real clinic API flow over the existing synthetic FHIR test double.
 * Never hosted/native end-to-end qualification or a production storage fallback. */
import assert from 'node:assert/strict';
import { createClinicHandler } from '../../../packages/clinic-api/src/handler.js';
import { MedplumClient } from '../../../packages/clinical-core/src/medplum.js';
import { mockFhir } from '../mock-fhir.js';
import { decodeDocument } from '../../../packages/clinic-api/src/store.js';
import type { Draft, ClinicApiConfig } from '../../../packages/clinic-api/src/types.js';
import type { Runtime } from '../../../packages/clinic-api/src/runtime.js';
import type { FhirResource } from '../../../packages/clinical-core/src/fhir.js';
import type { GroupedExtractionProposer } from '../../../packages/clinic-api/src/adaptive-extraction-grouped-session-v2.js';
import type { AdaptiveContext } from '../../../packages/clinic-api/src/adaptive-validation.js';
import { createSparseManifest, decodeSparseExtraction } from '../../../packages/clinic-api/src/adaptive-extraction-sparse.js';
import { createFullReplyManifest } from '../../../packages/clinic-api/src/adaptive-reply-full.js';
import type { AdaptiveTurnResult, ClinicSessionView } from '../../../packages/clinic-contract/src/index.js';
export const canonicalCaseId = 'CANONICAL-GOALS';
export const canonicalText = 'I want to have more energy for walks with my family and get help managing my weight.';
const origin = 'http://127.0.0.1:5173';
const patient = { reference: 'Patient/canonical-goals', displayName: 'Synthetic canonical development', description: 'Synthetic only', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
const config = { origin, cookieSecret: 'offline-canonical-synthetic-only-'.repeat(3), mentalHealth: 'phq4', patients: { 'first-intake': patient } } as ClinicApiConfig;
export interface CanonicalSeed { schema: 1; caseId: typeof canonicalCaseId; cookie: string; operationId: string; resources: [string, FhirResource][]; }
function fixture(extractor: GroupedExtractionProposer, seed?: CanonicalSeed) {
    const fhir = mockFhir();
    if (seed) for (const [key, resource] of seed.resources) { fhir.resources.set(key, structuredClone(resource)); fhir.histories.set(key, [structuredClone(resource)]); }
    const client = new MedplumClient({ baseUrl: 'http://127.0.0.1:9999/fhir/R4/', accessToken: 'offline-synthetic-only', timeoutMs: 1000, mode: 'local' }, fhir.fetcher);
    const handler = createClinicHandler(config, { runtime: async () => ({ client } as Runtime), adaptiveGroupedExtractor: extractor, adaptiveFullCapture: true });
    let cookie = seed?.cookie ?? '';
    async function request<T>(path: string, body: unknown) {
        const response = await handler(new Request(origin + path, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }));
        if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0];
        return { status: response.status, body: await response.json() as T };
    }
    const draft = () => [...fhir.resources.values()].map(r => decodeDocument<Draft>(r)).find(d => d.schema === 1 && d.requests)!;
    return { fhir, request, cookie: () => cookie, draft };
}
export async function createCanonicalSeed(): Promise<CanonicalSeed> {
    const f = fixture({ async extract() { throw Error('seed creation never dispatches interpretation'); } });
    assert.equal((await f.request('/api/clinic/sessions', { scenario: 'first-intake', syntheticAcknowledged: true })).status, 201);
    const identity = await f.request<ClinicSessionView>('/api/clinic/confirm-identity', { confirmed: true }); assert.equal(identity.status, 200);
    assert.equal(f.draft().adaptive!.exchange!.prompt!.topicId, 'Q01');
    const accepted = await f.request<AdaptiveTurnResult>('/api/clinic/adaptive-turns', { requestId: crypto.randomUUID(), expectedRevision: identity.body.revision, text: canonicalText, channel: 'text' }); assert.equal(accepted.status, 202);
    assert.equal(accepted.body.operation.status, 'accepted');
    return { schema: 1, caseId: canonicalCaseId, cookie: f.cookie(), operationId: accepted.body.operation.id, resources: structuredClone([...f.fhir.resources]) };
}
export async function interpretCanonicalSeed(seed: CanonicalSeed, extractor: GroupedExtractionProposer) {
    assert.equal(seed.schema, 1); assert.equal(seed.caseId, canonicalCaseId);
    const f = fixture(extractor, seed), before = structuredClone(f.draft());
    const source = before.turns.find(t => t.id === before.adaptive!.operations[seed.operationId].sourceId)!;
    assert.equal(source.text, canonicalText); assert.equal(source.channel, 'text'); assert.equal(before.adaptive!.operations[seed.operationId].status, 'accepted');
    const result = await f.request<AdaptiveTurnResult>(`/api/clinic/adaptive-turns/${seed.operationId}/interpret`, {});
    return { httpStatus: result.status, result: result.body, savedDraft: structuredClone(f.draft()), counters: f.fhir.counters, source, setup: 'real-handler-synthetic-mock-FHIR' as const, hostedAcceptance: false, nativeEndToEndAcceptance: false };
}
/** Human-authored expected facts for offline route comparison only. Never put
 * these answers in inference instructions/schema or feed them to the provider. */
export async function prepareCanonicalContext(seed: CanonicalSeed) {
    let context!: AdaptiveContext, manifest!: Awaited<ReturnType<typeof createSparseManifest>>;
    const readback = await interpretCanonicalSeed(seed, { async extract(ctx, grouped) {
        context = structuredClone(ctx); manifest = await createSparseManifest(ctx, grouped);
        assert.equal(ctx.displayed?.topicId, 'Q01'); assert.equal(ctx.source.channel, 'text'); assert(ctx.nativeRouting);
        const targets = createFullReplyManifest(ctx).targets, source = JSON.parse(String(manifest.messages[1].content)).bank[0].id;
        const raw = { m: manifest.id, f: [['reason', 'managing my weight'], ['priority', 'more energy for walks with my family']].map(([path, value]) => ({ f: targets.find(t => t.topicId === 'Q01' && t.path === path)!.id, o: 'patient', k: 'k', s: source, v: value })), i: [], c: [], e: [], r: [], d: 'represented' };
        return { raw: decodeSparseExtraction(raw, manifest).groupedWire };
    } });
    assert.equal(readback.httpStatus, 200); assert.equal(readback.savedDraft.adaptive!.exchange!.prompt!.topicId, 'Q02');
    return { context, manifest, expectedNextTopicId: 'Q02', offlineReadback: { status: readback.result.operation.status, nextQuestion: readback.savedDraft.adaptive!.exchange!.prompt, capture: readback.savedDraft.adaptive!.operations[seed.operationId].stream!.provisional }, providerCalls: 0 };
}
