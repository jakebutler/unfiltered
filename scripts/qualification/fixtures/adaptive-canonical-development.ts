/** Development only: normal API-created sources and contexts over mock FHIR.
 * No expected extraction output is injected, and no hosted/native proof follows. */
import assert from 'node:assert/strict';
import { createClinicHandler } from '../../../packages/clinic-api/src/handler.js';
import { MedplumClient } from '../../../packages/clinical-core/src/medplum.js';
import { mockFhir } from '../mock-fhir.js';
import { decodeDocument } from '../../../packages/clinic-api/src/store.js';
import { createTypedTurnManifest } from '../../../packages/clinic-api/src/adaptive-extraction-typed.js';
import { canonicalJson } from '../../../packages/clinical-core/src/domain.js';
import { createHash } from 'node:crypto';
import { getNativeQuestionnaireDefinition } from '../../../packages/clinic-content/src/native-questionnaire.js';
import { createSparseManifest } from '../../../packages/clinic-api/src/adaptive-extraction-sparse.js';
import type { Draft, ClinicApiConfig } from '../../../packages/clinic-api/src/types.js';
import type { Runtime } from '../../../packages/clinic-api/src/runtime.js';
import type { FhirResource } from '../../../packages/clinical-core/src/fhir.js';
import type { AdaptiveContext } from '../../../packages/clinic-api/src/adaptive-validation.js';
import type { GroupedExtractionProposer } from '../../../packages/clinic-api/src/adaptive-extraction-grouped-session-v2.js';
import type { AdaptiveTurnResult, ClinicSessionView } from '../../../packages/clinic-contract/src/index.js';
const goals = 'I want to have more energy for walks with my family and get help managing my weight.';
export const developmentCases = [
    { id: 'D1', text: goals },
    { id: 'D2', topicId: 'Q11', text: "Yesterday at 8 am I had oatmeal and coffee. I don't remember the oatmeal portion or what was added to the coffee. At noon I had one sandwich and a glass of water. Nothing else that day. That is all the food and drink. It was a usual day." },
    { id: 'D3-SETUP', topicId: 'Q08', text: 'I take Metformin 850 mg. I also take Vitamin D 1000 IU.' },
    { id: 'D4A', topicId: 'Q06', slotPath: 'conditions.prediabetes', text: 'My mother has diabetes. I was told I might have prediabetes, but no diagnosis yet. Can you tell whether I have diabetes?' },
    { id: 'D4B', topicId: 'DM', guidedDiabetesAnchor: true, text: 'My clinician diagnosed me with diabetes. I would like help with meals.' },
    { id: 'D5', scenario: 'pre-visit', text: 'Since my October 8, 2026 update, the nausea stopped. My appointment is October 20, 2026 at 9 am Pacific. I want to discuss meals. I need no transport help.' },
    { id: 'D6A', text: goals, channel: 'confirmed-transcript' },
    { id: 'D6B', text: goals, channel: 'unreviewed-transcript' },
] as const;
export type DevelopmentCaseId = typeof developmentCases[number]['id'] | 'D3-CORRECTION';
export interface DevelopmentSeed { schema: 1; caseId: DevelopmentCaseId; cookie: string; operationId: string; resources: [string, FhirResource][]; }
const origin = 'http://127.0.0.1:5173';
const patient = { reference: 'Patient/canonical-development', displayName: 'Synthetic canonical development', description: 'Synthetic only', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
const config = { origin, cookieSecret: 'offline-canonical-development-only-'.repeat(3), mentalHealth: 'phq4', patients: { 'first-intake': patient, 'pre-visit': patient } } as ClinicApiConfig;
function fixture(extractor: GroupedExtractionProposer, seed?: DevelopmentSeed, operationTimeoutMs?: number) {
    const fhir = mockFhir();
    if (seed) for (const [key, resource] of seed.resources) { fhir.resources.set(key, structuredClone(resource)); fhir.histories.set(key, [structuredClone(resource)]); }
    const client = new MedplumClient({ baseUrl: 'http://127.0.0.1:9999/fhir/R4/', accessToken: 'offline-synthetic-only', timeoutMs: 1000, mode: 'local' }, fhir.fetcher);
    const handler = createClinicHandler(config, { runtime: async () => ({ client } as Runtime), adaptiveGroupedExtractor: extractor, adaptiveFullCapture: true, ...(operationTimeoutMs ? { adaptiveTimeoutMs: operationTimeoutMs } : {}) });
    let cookie = seed?.cookie ?? '';
    async function request<T>(path: string, body?: unknown) {
        const response = await handler(new Request(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { origin, 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
        if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0];
        return { status: response.status, body: await response.json() as T };
    }
    const draft = () => [...fhir.resources.values()].map(r => decodeDocument<Draft>(r)).find(d => d.schema === 1 && d.requests)!;
    const snapshot = (caseId: DevelopmentCaseId, operationId: string): DevelopmentSeed => ({ schema: 1, caseId, cookie, operationId, resources: structuredClone([...fhir.resources]) });
    return { fhir, client, request, draft, snapshot };
}
export async function createDevelopmentSeed(caseId: typeof developmentCases[number]['id']): Promise<DevelopmentSeed> {
    const c = developmentCases.find(c => c.id === caseId)!; assert(c);
    const f = fixture({ async extract() { throw Error('setup never dispatches interpretation'); } });
    assert.equal((await f.request('/api/clinic/sessions', { scenario: 'scenario' in c ? c.scenario : 'first-intake', syntheticAcknowledged: true })).status, 201);
    let session = await f.request<ClinicSessionView>('/api/clinic/confirm-identity', { confirmed: true }); assert.equal(session.status, 200);
    if ('guidedDiabetesAnchor' in c) {
        session = await f.request('/api/clinic/topics', { expectedRevision: session.body.revision, topicId: 'Q06', slotPath: 'conditions.diabetes' }); assert.equal(session.status, 200);
        session = await f.request('/api/clinic/turns', { requestId: crypto.randomUUID(), expectedRevision: session.body.revision, promptId: session.body.currentPrompt!.id, action: 'answer', text: 'true', channel: 'text' }); assert.equal(session.status, 200);
        const anchor = f.draft().topics.Q06.answers['conditions.diabetes']; assert.equal(anchor?.state, 'known'); assert(anchor?.state === 'known'); assert.equal(anchor.value, true);
    }
    if ('topicId' in c) {
        session = await f.request('/api/clinic/topics', { expectedRevision: session.body.revision, topicId: c.topicId, ...('slotPath' in c ? { slotPath: c.slotPath } : {}) }); assert.equal(session.status, 200);
        assert.equal(session.body.currentPrompt!.topicId, c.topicId);
    }
    // Explicit detail selection uses the existing guided path. Return through the
    // public mode action before natural text; retain its actual issued context.
    if (session.body.adaptive?.mode === 'guided') {
        session = await f.request('/api/clinic/conversation-mode', { expectedRevision: session.body.revision, mode: 'adaptive' }); assert.equal(session.status, 200);
    }
    const accepted = await f.request<AdaptiveTurnResult>('/api/clinic/adaptive-turns', { requestId: crypto.randomUUID(), expectedRevision: session.body.revision, text: c.text, channel: 'channel' in c ? c.channel : 'text' }); assert.equal(accepted.status, 202); assert.equal(accepted.body.operation.status, 'accepted');
    return f.snapshot(caseId, accepted.body.operation.id);
}
export async function interpretDevelopmentSeed(seed: DevelopmentSeed, extractor: GroupedExtractionProposer, beforeResumeForTest?: (client: MedplumClient) => void, operationTimeoutMs?: number) {
    assert.equal(seed.schema, 1); const f = fixture(extractor, seed, operationTimeoutMs), before = structuredClone(f.draft()), operation = before.adaptive!.operations[seed.operationId];
    assert.equal(operation.status, 'accepted'); const source = before.turns.find(t => t.id === operation.sourceId)!; assert(source);
    const result = await f.request<AdaptiveTurnResult>(`/api/clinic/adaptive-turns/${seed.operationId}/interpret`, {});
    const savedDraft = structuredClone(f.draft()), resources = structuredClone([...f.fhir.resources]);
    beforeResumeForTest?.(f.client);
    const resumed = await f.request<ClinicSessionView>('/api/clinic/session');
    const identity = resumed.status === 200 ? await f.request<ClinicSessionView>('/api/clinic/confirm-identity', { confirmed: true }) : undefined;
    return { httpStatus: result.status, result: result.body, savedDraft, resources, counters: f.fhir.counters, source, resumeHttpStatus: resumed.status, identityHttpStatus: identity?.status, resumedView: identity?.body, setup: 'real-handler-synthetic-mock-FHIR' as const, hostedAcceptance: false, nativeEndToEndAcceptance: false };
}
/** Reads handler-owned context on a clone. This local probe intentionally settles
 * as failed; it never produces an authored successful extraction or changes seed. */
export async function prepareDevelopmentContext(seed: DevelopmentSeed, operationTimeoutMs?: number) {
    let context!: AdaptiveContext, manifest!: Awaited<ReturnType<typeof createSparseManifest>>;
    await interpretDevelopmentSeed(structuredClone(seed), { async extract(ctx, grouped) { context = structuredClone(ctx); manifest = await createSparseManifest(ctx, grouped); throw Error('offline-context-only'); } }, undefined, operationTimeoutMs);
    assert(context && manifest); assert.equal(context.binding.operationId, seed.operationId);
    return { context, manifest, providerCalls: 0, probe: 'failed-clone-context-only' as const };
}
export const typedContextSha = (context: AdaptiveContext) => createHash('sha256').update(canonicalJson(context)).digest('hex');
/** Same real handler context; typed wire has server source binding, no quote predicates. */
export async function prepareTypedDevelopmentContext(seed: DevelopmentSeed, operationTimeoutMs?: number) {
    let context!: AdaptiveContext, manifest!: ReturnType<typeof createTypedTurnManifest> & { contextSha256: string; nativeDefinition: Awaited<ReturnType<typeof getNativeQuestionnaireDefinition>>['binding'] };
    await interpretDevelopmentSeed(structuredClone(seed), { async extract(ctx) { context = structuredClone(ctx); manifest = { ...createTypedTurnManifest(ctx), contextSha256: typedContextSha(ctx), nativeDefinition: (await getNativeQuestionnaireDefinition()).binding }; throw Error('offline-context-only'); } }, undefined, operationTimeoutMs);
    assert(context && manifest); assert.equal(context.binding.operationId, seed.operationId);
    return { context, manifest, providerCalls: 0, probe: 'failed-clone-context-only' as const };
}
export async function createMedicationCorrectionSeed(setup: DevelopmentSeed, actual: Awaited<ReturnType<typeof interpretDevelopmentSeed>>) {
    assert.equal(setup.caseId, 'D3-SETUP'); assert.equal(actual.savedDraft.adaptive!.operations[setup.operationId].status, 'applied'); assert.equal(actual.savedDraft.adaptive!.operations[setup.operationId].stream!.capture, 'saved');
    const provisional = actual.savedDraft.adaptive!.operations[setup.operationId].stream!.provisional!;
    assert.equal(provisional.gaps.length, 0); if (provisional.interpretationProfile !== 'turn-bound-typed-v1') assert.equal(provisional.accounting.remaining.length, 0);
    const f = fixture({ async extract() { throw Error('correction setup never dispatches interpretation'); } }, { ...setup, resources: actual.resources });
    const selected = await f.request<ClinicSessionView>('/api/clinic/topics', { expectedRevision: f.draft().revision, topicId: 'Q08' }); assert.equal(selected.status, 200);
    const accepted = await f.request<AdaptiveTurnResult>('/api/clinic/adaptive-turns', { requestId: crypto.randomUUID(), expectedRevision: selected.body.revision, text: 'Actually, I meant metformin 500 mg, not 850 mg; vitamin D is still 1000 IU.', channel: 'text' }); assert.equal(accepted.status, 202);
    return f.snapshot('D3-CORRECTION', accepted.body.operation.id);
}
