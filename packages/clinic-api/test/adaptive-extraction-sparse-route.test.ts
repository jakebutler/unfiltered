import { hasValidEvidence } from '../../clinic-content/src/readiness.js';
import { eligibleAdaptiveProbes } from '../src/dialogue.js';
import { requireFinalRepresentationAuthority } from '../src/final-representation.js';
import { nativeSourceFactValid } from '../../clinic-content/src/native-questionnaire.js';
import { buildNativeQuestionnaireCapture } from '../../clinical-core/src/questionnaire-response.js';
import { REPRESENTATION_POLICY, nativeRepresentationAuthority, validateRepresentationDigests } from '../../clinical-core/src/representation-review.js';
import { validateSubmissionIntegrity } from '../../clinical-core/src/domain.js';
import { planHandoff } from '../../clinical-core/src/fhir.js';
import { fromNativeQuestionnaireResponse, toNativeQuestionnaireResponse } from '../../clinical-core/src/questionnaire-response.js';
import { describe, expect, it, vi } from 'vitest';
import { createClinicHandler } from '../src/handler.js';
import { conversation } from '../src/conversation.js';
import { GroupedExtractionOutputFailure, type GroupedExtractionProposer } from '../src/adaptive-extraction-grouped-session-v2.js';
import { createSparseManifest, decodeSparseExtraction as decodeReadable, type SparseManifest, type SparseWire } from '../src/adaptive-extraction-sparse.js';
import { sparseExtractionProposer } from '../src/adaptive-extraction-sparse-provider.js';
import { createDomainManifest } from '../src/adaptive-reply-domain.js';
import { createGroupedExtractionManifest, encodeGroupedExtraction } from '../src/adaptive-extraction-grouped-v2.js';
import { groupedRepresentativeDraft, groupedCaseContext } from '../../../scripts/qualification/fixtures/adaptive-extraction-grouped-v2-cases.js';
import { encodeSparseExtraction } from '../src/adaptive-extraction-sparse.js';
import { createFullReplyManifest } from '../src/adaptive-reply-full.js';
import type { AdaptiveContext } from '../src/adaptive-validation.js';
import { document, decodeDocument, SNAPSHOT_SYSTEM } from '../src/store.js';
import type { Draft, ClinicApiConfig } from '../src/types.js';
import type { Runtime } from '../src/runtime.js';
import type { FhirResource } from '../../clinical-core/src/fhir.js';
import { TransportError } from '../../clinical-core/src/transport.js';
import { digitalOceanStream } from '../../clinical-core/src/digitalocean-stream.js';
import type { AdaptiveTurnResult, ClinicSessionView, ReviewPreview } from '../../clinic-contract/src/index.js';
import { fullPolicyRevision, focusedPolicyRevision, typedPolicyRevision, projectProvisional } from '../src/provisional-projection.js';
import { readableFixture, type AuthoredWire } from './readable-sparse-fixture.js';
const fixtureContexts = new WeakMap<SparseManifest, AdaptiveContext>();
const decodeSparseExtraction = (raw: AuthoredWire | SparseWire, manifest: SparseManifest) => decodeReadable(readableFixture(raw, fixtureContexts.get(manifest)!), manifest);
const origin = 'http://127.0.0.1:5173';
const patient = { reference: 'Patient/test', displayName: 'Synthetic Patient', description: 'Synthetic only', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
const config = { origin, cookieSecret: 'test-secret-'.repeat(5), mentalHealth: 'phq4', patients: Object.fromEntries(['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'].map(id => [id, patient])) } as ClinicApiConfig;
function fixture(extractor: GroupedExtractionProposer, options: { available?: boolean; snapshotRace?: (resource: FhirResource) => FhirResource; finalReview?: boolean; extractionQualified?: boolean; focusedQualified?: boolean; typedQualified?: boolean; adaptiveTimeoutMs?: number } = {}) {
    const records = new Map<string, FhirResource>();
    let sequence = 0;
    let failPut: 'before' | 'after' | 'after-read-loss' | 'stale-200' | undefined;
    let failedReads = 0;
    const writes: Draft[] = [];
    const client = {
        async request(path: string, method = 'GET', body?: FhirResource, headers?: Record<string, string>) {
            if (method === 'GET') {
                if (failedReads > 0) { failedReads--; throw new TransportError('network'); }
                const u = new URL(path, 'http://local/fhir/R4/'), key = u.searchParams.get('identifier');
                const resources = key ? [...records.values()].filter(r => (r.identifier as { system: string; value: string }[]).some(i => `${i.system}|${i.value}` === key)) : records.has(path.split('/')[1]) ? [records.get(path.split('/')[1])!] : [];
                return { body: { resourceType: 'Bundle', type: 'searchset', total: resources.length, entry: structuredClone(resources.map(resource => ({ resource }))) } };
            }
            if (method === 'POST') {
                const isSnapshot = (body?.identifier as { system: string }[] | undefined)?.some(item => item.system === SNAPSHOT_SYSTEM);
                const returned = isSnapshot && options.snapshotRace ? options.snapshotRace(body!) : body!;
                const resource = { ...structuredClone(returned), id: String(++sequence), meta: { versionId: '1' } };
                records.set(resource.id, resource);
                return { body: structuredClone(resource) };
            }
            const id = path.split('/')[1], previous = records.get(id)!;
            if (headers?.['If-Match'] !== `W/"${(previous.meta as { versionId: string }).versionId}"`) throw new TransportError('http', 412);
            const failure = failPut; failPut = undefined;
            if (failure === 'before') throw new TransportError('network');
            if (failure === 'stale-200') return { body: structuredClone(previous) };
            const resource = { ...structuredClone(body!), meta: { versionId: String(Number((previous.meta as { versionId: string }).versionId) + 1) } };
            records.set(id, resource);
            writes.push(decodeDocument<Draft>(resource));
            if (failure) { if (failure === 'after-read-loss') failedReads = 1; throw new TransportError('network'); }
            return { body: structuredClone(resource) };
        },
        async check() { return { state: 'unknown', present: 0, resources: {}, anchors: {}, verifiedWork: [] }; },
        deliver: vi.fn(async () => ({ receipt: { state: 'unknown', present: 0 }, write: 'outcome-unknown' })),
    };
    const runtime = async () => ({ client, qualification: {} } as unknown as Runtime);
    const makeHandler = () => createClinicHandler(config, { runtime, ...(options.adaptiveTimeoutMs ? { adaptiveTimeoutMs: options.adaptiveTimeoutMs } : {}), ...(options.finalReview || options.extractionQualified || options.focusedQualified || options.typedQualified ? { provisionalQualification: { ...(options.typedQualified ? typedPolicyRevision : options.focusedQualified ? focusedPolicyRevision : fullPolicyRevision), status: 'qualified' as const, evidenceDigest: 'a'.repeat(64) } } : {}), ...(options.finalReview ? { finalRepresentationQualification: { policy: REPRESENTATION_POLICY, status: 'qualified' as const, evidenceDigest: 'b'.repeat(64), ...(options.typedQualified ? { extractionSchema: 'turn-bound-typed-v1' as const } : {}) } } : {}), ...(options.available === false ? {} : { adaptiveGroupedExtractor: extractor, adaptiveFullCapture: true }) });
    let handler = makeHandler(), cookie = '';
    async function request<T = ClinicSessionView>(path: string, data?: unknown, requestCookie = cookie) {
        const response = await handler(new Request(`${origin}${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { ...(requestCookie ? { cookie: requestCookie } : {}), ...(data === undefined ? {} : { origin, 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }));
        const setCookie = response.headers.get('set-cookie'); if (setCookie && requestCookie === cookie) cookie = setCookie.split(';')[0];
        return { status: response.status, body: await response.json() as T };
    }
    const boot = async (scenario = 'first-intake') => {
        await request('/api/clinic/sessions', { scenario, syntheticAcknowledged: true });
        return (await request('/api/clinic/confirm-identity', { confirmed: true })).body;
    };
    const accept = (revision: number, text = 'Improve energy for family activities.', requestId = crypto.randomUUID(), channel: 'text' | 'confirmed-transcript' | 'unreviewed-transcript' = 'text') => request<AdaptiveTurnResult>('/api/clinic/adaptive-turns', { requestId, expectedRevision: revision, text, channel });
    const interpret = (id: string) => request<AdaptiveTurnResult>(`/api/clinic/adaptive-turns/${id}/interpret`, {});
    const status = (id: string) => request<AdaptiveTurnResult>(`/api/clinic/adaptive-turns/${id}`);
    const draft = () => [...records.values()].map(r => decodeDocument<Draft>(r)).find(d => d.schema === 1 && d.requests)!;
    return { records, writes, deliver: client.deliver, raw: (request: Request) => handler(request), request, boot, accept, interpret, status, draft, extractor, cookie: () => cookie, restart: () => { handler = makeHandler(); }, failNextPut: (failure: typeof failPut) => { failPut = failure; } };
}

const goals = 'I want to have more energy for walks with my family and get help managing my weight.';
type Author = (context: AdaptiveContext, manifest: SparseManifest) => AuthoredWire | SparseWire;
function authorTools(context: AdaptiveContext, manifest: SparseManifest) {
    fixtureContexts.set(manifest, context);
    const full = createFullReplyManifest(context), payload = JSON.parse(String(createGroupedExtractionManifest(context).messages[1].content));
    const slot = (topic: string, path: string) => { const t = full.targets.find(t => t.topicId === topic && t.path === path)!; return t.collection ? t.definition.id : t.id; };
    const source = (quote: string) => { const bank = payload.bank.find((b: { quote: string }) => b.quote.includes(quote)); return { s: bank.id, q: quote }; };
    const wire: AuthoredWire = { m: manifest.id, f: [], i: [], c: [], e: [], r: [], d: 'represented' };
    const fact = (topic: string, path: string, value: string, quote = context.source.text) => ({ f: slot(topic, path), o: 'patient' as const, k: 'k' as const, s: source(quote), v: value });
    return { full, payload, slot, source, wire, fact };
}
const authoredGoals = (context: AdaptiveContext, manifest: SparseManifest) => {
    const { wire, fact } = authorTools(context, manifest);
    wire.f.push(fact('Q01', 'reason', 'managing my weight', goals), fact('Q01', 'priority', 'more energy for walks with my family', goals));
    return wire;
};
/** Actual stable serializer/SSE parser beneath the handler-owned context and CAS. */
function provider(author: Author) {
    const contexts: AdaptiveContext[] = [], requests: Record<string, any>[] = [];
    let current!: AdaptiveContext;
    const proposer = sparseExtractionProposer({ endpoint: 'https://inference.do-ai.run', apiKey: 'offline-synthetic-only', model: 'qwen3.8-max', timeoutMs: 2000, maxOutputTokens: 2048, maxRequestBytes: 131072 }, c => digitalOceanStream(c, async (_url, init) => {
        const body = JSON.parse(String(init?.body)); requests.push(body);
        expect(body.response_format.type).toBe('json_schema'); expect(body.response_format.json_schema.strict).toBe(true);
        expect(body.response_format.json_schema.schema).toHaveProperty('properties.reports');
        expect(JSON.stringify(body)).not.toContain('offline-synthetic-only');
        const manifest = await createSparseManifest(current); fixtureContexts.set(manifest, current); const raw = readableFixture(author(current, manifest), current);
        expect(body.response_format.json_schema.schema).toEqual(manifest.jsonSchema);
        expect(JSON.parse(body.messages[1].content).sourceAdmission.channel).toBe(current.source.channel);
        const event = (choices: unknown[], usage?: unknown) => `data: ${JSON.stringify({ id: 'offline-route', model: c.model, choices, ...(usage ? { usage } : {}) })}\n\n`;
        return new Response(event([{ index: 0, delta: { content: JSON.stringify(raw) }, finish_reason: null }]) + event([{ index: 0, delta: {}, finish_reason: 'stop' }]) + event([], { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }));
    const extract = vi.fn(async (...args: Parameters<GroupedExtractionProposer['extract']>) => { current = structuredClone(args[0]); contexts.push(current); return proposer.extract(...args); });
    return { extract, contexts, requests };
}
async function run(f: ReturnType<typeof fixture>, session: ClinicSessionView, text: string, channel: 'text' | 'confirmed-transcript' | 'unreviewed-transcript' = 'text') {
    const accepted = await f.accept(session.revision, text, crypto.randomUUID(), channel);
    expect(accepted.status).toBe(202);
    const result = await f.interpret(accepted.body.operation.id);
    expect(result.status).toBe(200);
    return { accepted, result };
}

describe('optional sparse extraction on the canonical durable handler route', () => {
    it.each(['text', 'confirmed-transcript'] as const)('%s saves supplied goals and daily impact once, then asks only the next unsupplied topic', async channel => {
        const p = provider(authoredGoals), f = fixture(p), session = await f.boot();
        const { accepted, result } = await run(f, session, goals, channel);
        expect(result.body.operation.status).toBe('applied');
        expect(f.draft().adaptive!.exchange?.prompt?.topicId).toBe('Q02');
        expect(result.body.session.currentPrompt?.text).not.toContain('different in daily life');
        const context = p.contexts[0]; expect(context.nativeRouting).toBeDefined(); expect(context.binding.patient).toBe(patient.reference);
        expect(context.source.channel).toBe(channel); expect(context.sources.find(s => s.id === context.source.id)?.text).toBe(goals);
        const capture = f.draft().adaptive!.operations[accepted.body.operation.id].stream!.provisional!;
        expect(capture.claims.map(c => c.path)).toEqual(['reason', 'priority']); expect(capture.gaps).toEqual([]);
        expect(f.draft().topics.Q01?.answers ?? {}).toEqual({}); // Proposals never overwrite direct patient answers.
        await f.interpret(accepted.body.operation.id); expect(p.extract).toHaveBeenCalledOnce(); expect(p.requests).toHaveLength(1);
    });
    it('automatic voice continues from supported goals while retaining raw recognition gap and partial uncredited review', async () => {
        const p = provider(authoredGoals), f = fixture(p), session = await f.boot();
        const { accepted, result } = await run(f, session, goals, 'unreviewed-transcript');
        expect(f.draft().adaptive!.exchange?.prompt?.topicId).toBe('Q02');
        const projection = projectProvisional(f.draft(), p.contexts[0].topics);
        expect(projection.gaps.some(g => g.reason === 'recognition-unreviewed')).toBe(true); expect(projection.creditedSourceIds.size).toBe(0);
        const raw = f.draft().turns.find(t => t.id === accepted.body.operation.sourceId)!; expect(raw.channel).toBe('unreviewed-transcript'); expect(raw.text).toBe(goals);
        const review = await f.request<ReviewPreview>('/api/clinic/review', { expectedRevision: result.body.session.revision });
        expect(review.status).toBe(200); expect(review.body.session.completeness).toBe('partial');
        expect(review.body.session.topics.find(t => t.id === 'interpretation')?.interpretationGaps?.some(g => g.reason === 'recognition-unreviewed')).toBe(true);
    });
    it('a substantive ambiguity still withholds continuation, even when automatic voice recognition is tolerated for navigation', async () => {
        const p = provider((ctx, m) => { const w = authoredGoals(ctx, m); w.r.push({ s: ['s1'], r: 'ambiguous' }); w.d = 'partially-represented'; return w; });
        const f = fixture(p), session = await f.boot(), { result } = await run(f, session, `${goals} Some other concern I cannot describe.`, 'unreviewed-transcript');
        expect(f.draft().adaptive!.exchange?.status).toBe('interpretation-review'); expect(result.body.operation.stream?.reply).toBe('withheld');
    });
    it('lost processing CAS prevents any provider dispatch and source replay cannot change voice trust', async () => {
        const p = provider(authoredGoals), f = fixture(p), session = await f.boot(), id = crypto.randomUUID();
        const accepted = await f.accept(session.revision, goals, id, 'unreviewed-transcript'); f.failNextPut('before');
        const result = await f.interpret(accepted.body.operation.id); expect(result.status).not.toBe(200); expect(p.extract).not.toHaveBeenCalled(); expect(p.requests).toEqual([]);
        const changed = await f.accept(session.revision, goals, id, 'confirmed-transcript'); expect(changed.status).toBe(409);
        expect(f.draft().turns.find(t => t.id === accepted.body.operation.sourceId)?.channel).toBe('unreviewed-transcript');
    });
    it('no extractor injection leaves the normal factory unavailable for adaptive interpretation', async () => {
        const p = provider(authoredGoals), f = fixture(p, { available: false }), session = await f.boot();
        const result = await f.accept(session.revision, goals); expect(result.status).toBe(409); expect(p.extract).not.toHaveBeenCalled();
    });
});
const medicineText = 'I take Metformin 850 mg. I also take Vitamin D 1000 IU.';
const medicines = (ctx: AdaptiveContext, m: SparseManifest) => {
    const a = authorTools(ctx, m), { wire, slot, source, fact } = a;
    if (ctx.source.text.startsWith(goals)) wire.f.push(...authoredGoals(ctx, m).f);
    for (const [name, strength, quote] of [['Metformin', '850 mg', 'I take Metformin 850 mg.'], ['Vitamin D', '1000 IU', 'I also take Vitamin D 1000 IU.']]) {
        wire.i.push({ c: slot('Q08', 'medicines'), n: { s: 'patient', e: name, r: source(quote) }, x: null, f: ['name', 'strength'].map((path, n) => { const f = fact('Q08', `medicines[new].${path}`, n ? strength : name, quote); const { o, ...child } = f; return child; }) });
    }
    return wire;
};
it('AF79 medication output keeps its native followup visible immediately and after identity resume without readiness credit', async () => {
    // Retained AF79 facts re-encoded with the current readable child fields; historical raw output stays frozen.
    const p = provider((_ctx, m) => ({ m: m.id, c: [], d: 'represented', e: [], f: [], r: [], i: [
        { c: 't66', n: { e: 'Metformin', r: 's0', s: 'patient' }, x: null, f: [{ f: 'name', k: 'k', s: 's0', v: 'Metformin' }, { f: 'strength', k: 'k', s: 's0', v: '850 mg' }] },
        { c: 't66', n: { e: 'Vitamin D', r: 's1', s: 'patient' }, x: null, f: [{ f: 'name', k: 'k', s: 's1', v: 'Vitamin D' }, { f: 'strength', k: 'k', s: 's1', v: '1000 IU' }] },
    ] }));
    const f = fixture(p), session = await f.boot();
    const selected = await f.request('/api/clinic/topics', { expectedRevision: session.revision, topicId: 'Q08' });
    const { accepted, result } = await run(f, selected.body, medicineText);
    const followup = { id: 'Q08:B02', topicId: 'Q08', mode: 'adaptive', text: "What directions are written on your Metformin label? Please don't guess if you aren't sure." };
    expect(result.body.session.currentPrompt).toMatchObject(followup);
    const saved = structuredClone(f.draft()), capture = saved.adaptive!.operations[accepted.body.operation.id].stream!.provisional!;
    expect(capture.items).toHaveLength(2); expect(capture.claims).toHaveLength(4); expect(capture.closures).toEqual([]); expect(capture.gaps).toEqual([]);
    expect(saved.topics.Q08?.answers ?? {}).toEqual({});
    f.restart();
    const resumed = await f.request('/api/clinic/session');
    expect(resumed.status).toBe(200);
    const identity = await f.request('/api/clinic/confirm-identity', { confirmed: true });
    expect(identity.body.currentPrompt).toMatchObject(followup);
    expect(f.draft()).toEqual(saved); expect(p.extract).toHaveBeenCalledOnce();
    const content = conversation(config);
    expect(content.effective(saved, true).responses.Q08?.answers ?? {}).toEqual({});
    expect(content.view(saved, true, true).topics.find(t => t.id === 'Q08')?.status).not.toBe('ready-for-review');
    const foreignItem = structuredClone(saved);
    foreignItem.adaptive!.exchange!.prompt!.targetPaths = ['medicines[foreign].labelDirections'];
    expect(content.view(foreignItem, true, true).currentPrompt?.id).toBe('Q01:reason');
    const review = await f.request<ReviewPreview>('/api/clinic/review', { expectedRevision: saved.revision });
    expect(review.body.session.completeness).toBe('partial');
});
it('proposed repeat navigation cannot authorize a diabetes branch from an unqualified proposed diagnosis', async () => {
    const text = 'My clinician diagnosed me with diabetes.';
    const p = provider((ctx, m) => { const a = authorTools(ctx, m); a.wire.f.push({ ...a.fact('Q06', 'conditions.diabetes', 'true'), v: true }); return a.wire; });
    const f = fixture(p), session = await f.boot(), selected = await f.request('/api/clinic/topics', { expectedRevision: session.revision, topicId: 'Q06' });
    await run(f, selected.body, text);
    const saved = structuredClone(f.draft()), content = conversation(config);
    expect(saved.adaptive!.exchange?.prompt?.topicId).not.toBe('DM');
    expect(content.effective(saved).responses.Q06?.answers['conditions.diabetes']).toMatchObject({ state: 'known', value: true });
    expect(content.effective(saved, true).responses.Q06?.answers['conditions.diabetes']).toBeUndefined();
    expect(content.effective(saved, true).responses.DM?.applicability).not.toBe('applicable');
    saved.adaptive!.exchange = { status: 'question', state: { activeTopicId: 'DM' }, prompt: { kind: 'question', topicId: 'DM', promptId: 'DM01', labels: ['Reported type/status', 'Approximate diagnosis timing'], targetPaths: ['typeStatus', 'when'], optional: false, text: 'What type were you told you have, and roughly when were you told?' } };
    expect(content.view(saved, true, true).currentPrompt?.id).toBe('Q01:reason');
});
it('trusted current extraction qualification opens a newly volunteered diabetes branch atomically and after resume', async () => {
    const text = 'My clinician diagnosed me with diabetes.';
    const p = provider((ctx, m) => { const a = authorTools(ctx, m); a.wire.f.push({ ...a.fact('Q06', 'conditions.diabetes', 'true'), v: true }); return a.wire; });
    const f = fixture(p, { extractionQualified: true }), session = await f.boot(), selected = await f.request('/api/clinic/topics', { expectedRevision: session.revision, topicId: 'Q06' });
    expect(f.draft().topics.Q06?.answers ?? {}).toEqual({});
    const { accepted, result } = await run(f, selected.body, text);
    expect(result.body.operation.status).toBe('applied');
    expect(result.body.session.currentPrompt).toMatchObject({ id: 'DM:DM01', topicId: 'DM' });
    const saved = structuredClone(f.draft());
    expect(saved.topics.Q06?.answers ?? {}).toEqual({});
    expect(saved.adaptive!.operations[accepted.body.operation.id].stream!.provisional!.claims).toHaveLength(1);
    expect(saved.adaptive!.exchange!.prompt).toMatchObject({ topicId: 'DM', promptId: 'DM01' });
    expect(saved.confirmed).toBeUndefined(); expect(saved.preview).toBeUndefined();
    f.restart(); await f.request('/api/clinic/session');
    const identity = await f.request('/api/clinic/confirm-identity', { confirmed: true });
    expect(identity.body.currentPrompt).toEqual(result.body.session.currentPrompt);
    expect(f.draft()).toEqual(saved); expect(p.extract).toHaveBeenCalledOnce();
});
it('a non-conditional-topic sleep prompt cannot use an unqualified display diagnosis as branch authority', async () => {
    let issuedContext: AdaptiveContext | undefined;
    const p = provider((ctx, m) => { issuedContext = ctx; const a = authorTools(ctx, m); a.wire.f.push({ ...a.fact('Q06', 'conditions.sleepApnea', 'true'), v: true }); return a.wire; });
    const f = fixture(p), session = await f.boot(), selected = await f.request('/api/clinic/topics', { expectedRevision: session.revision, topicId: 'Q06' });
    await run(f, selected.body, 'My clinician diagnosed me with sleep apnea.');
    const saved = structuredClone(f.draft()), content = conversation(config);
    const navigation = { ...issuedContext!, responses: content.effective(saved).responses, nativeRouting: content.nativeNavigation(saved) };
    expect(navigation.responses.Q06.answers['conditions.sleepApnea']).toMatchObject({ state: 'known', value: true });
    expect(eligibleAdaptiveProbes(navigation).some(probe => probe.promptId === 'SLEEP01')).toBe(false);
    saved.adaptive!.exchange = { status: 'question', state: { activeTopicId: 'Q15' }, prompt: { kind: 'question', topicId: 'Q15', promptId: 'SLEEP01', labels: [], targetPaths: ['treatment'], optional: false, text: 'Do you use any treatment for sleep apnea?' } };
    expect(content.view(saved, true, true).currentPrompt?.id).toBe('Q01:reason');
});
it('real context captures volunteered medicines and a later known correction with stable repeat identity and exact prior-source lineage', async () => {
    const p = provider((ctx, m) => {
        if (!ctx.source.text.startsWith('Actually')) return medicines(ctx, m);
        const { wire, payload, slot, source } = authorTools(ctx, m), existing = payload.existingItems[0];
        const prior = payload.priorSourceBank.find((b: { sourceId: string }) => b.sourceId === ctx.sources[0].id);
        expect(existing).toBeDefined(); expect(prior).toBeDefined();
        const whole = source('Actually my Metformin strength is 500 mg, not 850 mg.');
        wire.i.push({ c: slot('Q08', 'medicines'), n: null, x: existing.alias, f: [{ f: slot('Q08', `medicines[${existing.id}].strength`), k: 'k', v: '500 mg', s: { e: [whole], p: whole, v: source('500 mg'), t: null, c: [prior.id] } }] });
        const vitamin = payload.existingItems.find((item: { entity: string }) => item.entity === 'Vitamin D');
        wire.i.push({ c: slot('Q08', 'medicines'), n: null, x: vitamin.alias, f: [{ f: 'strength', k: 'k', v: '1000 IU', s: { e: [source('Vitamin D is still 1000 IU')], p: source('Vitamin D is still 1000 IU'), v: source('1000 IU'), t: null, c: [prior.id] } }] });
        const decoded = decodeSparseExtraction(wire, m);
        expect(decoded.capture.claims.filter(c => c.path.endsWith('.strength')).map(c => c.path)).toEqual([`medicines[${existing.id}].strength`, `medicines[${vitamin.id}].strength`]);
        for (const field of ['relationship', 'medicines', createFullReplyManifest(ctx).targets.find(t => t.path === `medicines[${existing.id}].strength`)!.id]) {
            const bad = structuredClone(wire); bad.i[0].f[0].f = field;
            expect(() => decodeSparseExtraction(bad, m)).toThrow();
        }
        const duplicate = structuredClone(wire); duplicate.i[0].f.push({ ...duplicate.i[0].f[0] });
        expect(() => decodeSparseExtraction(duplicate, m)).toThrow('duplicate-sparse-slot');
        const invalidState = structuredClone(wire); invalidState.i[0].f[0] = { f: 'strength', k: 'n', v: null, s: source('not 850 mg') };
        expect(() => decodeSparseExtraction(invalidState, m)).toThrow();
        const foreign = structuredClone(wire); foreign.i[0].c = slot('Q10', 'familyHistory');
        expect(() => decodeSparseExtraction(foreign, m)).toThrow();
        return wire;
    });
    const f = fixture(p), session = await f.boot(), first = await run(f, session, `${goals} ${medicineText}`);
    const firstCapture = f.draft().adaptive!.operations[first.accepted.body.operation.id].stream!.provisional!;
    expect(firstCapture.items).toHaveLength(2); expect(firstCapture.claims.filter(c => c.topicId === 'Q08')).toHaveLength(4);
    expect(f.draft().adaptive!.exchange?.prompt?.topicId).not.toBe('Q01');
    const second = await run(f, first.result.body.session, 'Actually my Metformin strength is 500 mg, not 850 mg. Vitamin D is still 1000 IU.');
    expect(second.result.body.operation.status).toBe('applied');
    const projection = projectProvisional(f.draft(), p.contexts[1].topics);
    const strengths = projection.claims.filter(c => c.path.endsWith('.strength'));
    expect(strengths.find(c => c.value === '850 mg')?.status).toBe('superseded');
    expect(strengths.find(c => c.value === '500 mg')?.status).toBe('proposed');
    expect(strengths.filter(c => c.value === '1000 IU')).toHaveLength(2);
    expect(strengths.filter(c => c.value === '1000 IU').every(c => c.status === 'proposed')).toBe(true);
    expect(strengths.filter(c => c.value === '1000 IU').flatMap(c => c.correctsSourceIds)).toEqual([]);
    expect(f.draft().adaptive!.operations[second.accepted.body.operation.id].stream!.provisional!.claims.find(c => c.value === '1000 IU')!.correctsSourceIds).toEqual([first.accepted.body.operation.sourceId]);
    expect(projection.gaps).toEqual([]); expect(p.requests).toHaveLength(2);
    expect(f.draft().turns.find(t => t.id === first.accepted.body.operation.sourceId)?.text).toBe(`${goals} ${medicineText}`);
});
it('clear recognized medicine details guide navigation without clinical credit or repeating supplied strength', async () => {
    const p = provider(medicines), f = fixture(p), session = await f.boot();
    const selected = await f.request('/api/clinic/topics', { expectedRevision: session.revision, topicId: 'Q08' }); expect(selected.status).toBe(200);
    const { accepted } = await run(f, selected.body, medicineText, 'unreviewed-transcript');
    expect(f.draft().adaptive!.exchange?.prompt?.topicId).toBe('Q08');
    expect(f.draft().adaptive!.exchange?.prompt?.targetPaths.some(path => path.endsWith('.strength') || path.endsWith('.name'))).toBe(false);
    expect(f.draft().adaptive!.operations[accepted.body.operation.id].stream!.provisional!.claims).toHaveLength(4);
    expect(f.draft().adaptive!.operations[accepted.body.operation.id].stream!.provisional!.gaps.some(g => g.reason === 'recognition-unreviewed')).toBe(true);
});
it('clear recognized height avoids re-asking height while preserving missing measurement followups', async () => {
    const text = 'My height is 170 cm.';
    const p = provider((ctx, m) => { const a = authorTools(ctx, m); a.wire.f.push({ ...a.fact('Q04', 'height.value', '170'), v: 170 }, a.fact('Q04', 'height.unit', 'cm')); return a.wire; });
    const f = fixture(p), session = await f.boot(), selected = await f.request('/api/clinic/topics', { expectedRevision: session.revision, topicId: 'Q04' });
    const { accepted } = await run(f, selected.body, text, 'unreviewed-transcript');
    expect(f.draft().adaptive!.exchange?.prompt?.topicId).toBe('Q04');
    expect(f.draft().adaptive!.exchange?.prompt?.targetPaths.some(path => path.startsWith('height.'))).toBe(false);
    expect(f.draft().adaptive!.exchange?.prompt?.targetPaths.some(path => path.startsWith('lastMeasuredWeight.'))).toBe(true);
    expect(f.draft().adaptive!.operations[accepted.body.operation.id].stream!.provisional!.claims).toHaveLength(2);
});
it('wrong cross-topic stop event and invented recognition on typed source reject without narrowing volunteered fact scope', async () => {
    const p = provider(() => { throw Error('unused'); });
    const f = fixture(p), session = await f.boot();
    const accepted = await f.accept(session.revision, `${goals} ${medicineText}`);
    // Capture the handler-issued canonical context without applying an output.
    p.extract.mockImplementationOnce(async (ctx, grouped) => {
        const m = await createSparseManifest(ctx, grouped), good = medicines(ctx, m);
        const wrongStop = structuredClone(good); wrongStop.e.push({ k: 'move-on', t: 'Q08', s: 's1', o: 'medical' });
        expect(() => decodeSparseExtraction(wrongStop, m)).toThrow();
        const falseRecognition = structuredClone(good); falseRecognition.r.push({ s: ['s0'], r: 'recognition-unreviewed' });
        expect(() => decodeSparseExtraction(falseRecognition, m)).toThrow();
        expect(decodeSparseExtraction(good, m).capture.claims.some(c => c.topicId === 'Q08')).toBe(true);
        return { raw: decodeSparseExtraction(good, m).groupedWire };
    });
    const result = await f.interpret(accepted.body.operation.id); expect(result.body.operation.status).toBe('applied');
});

it('canonical G3 preserves quantities, missing details and explicit full-list closure, then asks only the missing coffee amount', async () => {
    const p = provider((ctx, m) => { const full = createFullReplyManifest(ctx), grouped = createGroupedExtractionManifest(ctx); return encodeSparseExtraction(encodeGroupedExtraction(groupedRepresentativeDraft('G3', full, createDomainManifest(full)), grouped), m); });
    const f = fixture(p), session = await f.boot(), selected = await f.request('/api/clinic/topics', { expectedRevision: session.revision, topicId: 'Q11' });
    const { accepted, result } = await run(f, selected.body, groupedCaseContext('G3').source.text);
    expect(result.body.operation.status).toBe('applied');
    const capture = f.draft().adaptive!.operations[accepted.body.operation.id].stream!.provisional!;
    expect(capture.claims).toHaveLength(13); expect(capture.closures).toHaveLength(1); expect(capture.gaps).toEqual([]);
    expect(capture.claims.some(c => c.path.endsWith('.foodAmounts') && c.value === 'one sandwich')).toBe(true);
    expect(f.draft().adaptive!.exchange?.prompt?.targetPaths).toHaveLength(1);
    expect(f.draft().adaptive!.exchange?.prompt?.text).toBe('At 8 am, about how much coffee did you have? A cup or glass is fine.');
});

it('complete but rejected sparse output keeps exact provider receipt and raw evidence, gives no capture/question credit and never retries', async () => {
    let rejected!: string;
    const p = provider((ctx, m) => { const wire = authoredGoals(ctx, m); wire.f.push(structuredClone(wire.f[0])); rejected = JSON.stringify(readableFixture(wire, ctx)); return wire; });
    const f = fixture(p), session = await f.boot(), { accepted } = await run(f, session, goals);
    const op = f.draft().adaptive!.operations[accepted.body.operation.id];
    expect(op.status).toBe('failed'); expect(op.errorCode).toBe('invalid-sparse-extraction');
    expect(op.stream!.receipt!.outcome).toBe('complete'); expect(op.stream!.receipt!.providerExecution).toBe('completed');
    expect(op.stream!.receipt!.usage).toEqual({ prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 });
    expect(op.rawProposalAudit).toMatchObject({ representation: 'raw-proposal-string-v1', retention: 'retained', content: rejected });
    expect(op.stream!.provisional).toBeUndefined(); expect(op.stream!.reply).toBe('withheld'); expect(op.stream!.capture).toBe('partial');
    await f.interpret(op.id); expect(p.requests).toHaveLength(1); expect(p.extract).toHaveBeenCalledOnce();
});
it('spoken PHQ narrative stays behind the existing exact screening-choice boundary and never invokes sparse extraction', async () => {
    const p = provider(authoredGoals), f = fixture(p), session = await f.boot();
    const selected = await f.request('/api/clinic/topics', { expectedRevision: session.revision, topicId: 'Q16', slotPath: 'MH01' });
    const result = await f.request<{ error: { code: string } }>('/api/clinic/turns', { requestId: crypto.randomUUID(), expectedRevision: selected.body.revision, promptId: selected.body.currentPrompt!.id, action: 'answer', text: 'I have been anxious most days.', channel: 'unreviewed-transcript' });
    expect(result.status).toBe(409); expect((result.body as unknown as { error: { code: string } }).error.code).toBe('explicit-screening-choice-required');
    expect(p.extract).not.toHaveBeenCalled(); expect(f.draft().topics.Q16?.answers.MH01?.state).not.toBe('known');
});

it('a completed rejected output arriving after discard and frozen review retains raw audit only without changing reviewed content', async () => {
    let release!: () => void, started!: () => void;
    const ready = new Promise<void>(r => { started = r; }), wait = new Promise<void>(r => { release = r; });
    const raw = '{"rejected":"synthetic exact completed output"}';
    const extractor: GroupedExtractionProposer = { extract: vi.fn(async () => { started(); await wait; throw new GroupedExtractionOutputFailure('invalid-sparse-extraction', { model: 'qwen3.8-max', requestBytes: 42, outcome: 'complete', providerExecution: 'completed', usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }, timings: { dispatchMs: 0, terminalMs: 1 }, contentBytes: Buffer.byteLength(raw), finishReason: 'stop' }, raw); }) };
    const f = fixture(extractor), session = await f.boot(), accepted = await f.accept(session.revision, goals);
    const pending = f.interpret(accepted.body.operation.id); await ready;
    const discarded = await f.request<AdaptiveTurnResult>(`/api/clinic/adaptive-turns/${accepted.body.operation.id}/discard`, { expectedRevision: f.draft().revision }); expect(discarded.status).toBe(200);
    const review = await f.request<ReviewPreview>('/api/clinic/review', { expectedRevision: f.draft().revision }); expect(review.status).toBe(200);
    const before = structuredClone(f.draft()); release(); await pending;
    const after = f.draft(), op = after.adaptive!.operations[accepted.body.operation.id];
    expect(after.revision).toBe(before.revision); expect(after.preview).toEqual(before.preview); expect(after.phase).toBe('review');
    expect(after.turns).toEqual(before.turns); expect(after.topics).toEqual(before.topics); expect(after.adaptive!.exchange).toEqual(before.adaptive!.exchange);
    expect(op.status).toBe('discarded'); expect(op.stream!.provisional).toEqual(before.adaptive!.operations[op.id].stream!.provisional);
    expect(op.stream!.receipt).toMatchObject({ outcome: 'complete', providerExecution: 'completed', usage: { total_tokens: 5 } });
    expect(op.rawProposalAudit).toMatchObject({ retention: 'retained', content: raw });
    await f.interpret(op.id); expect(extractor.extract).toHaveBeenCalledOnce();
});


it('qualified final review binds exact recognized facts without changing raw speech or granting consent on preview', async () => {
    const p = provider(authoredGoals), f = fixture(p, { finalReview: true }), session = await f.boot();
    const { result } = await run(f, session, goals, 'unreviewed-transcript');
    expect(result.body.session.completeness).toBe('partial');
    const preview = await f.request<ReviewPreview>('/api/clinic/review', { expectedRevision: result.body.session.revision });
    expect(preview.status).toBe(200);
    const prepared = f.draft().preview!.confirmation;
    expect(prepared.submission.representationReview!.facts).toHaveLength(2);
    expect(prepared.submission.questionnaireCapture!.topics.Q01.answers.reason.state).toBe('known');
    expect(prepared.submission.sources[0].channel).toBe('unreviewed-transcript');
    expect(prepared.submission.questionnaireCapture!.unreviewedSourceIds).toEqual([prepared.submission.sources[0].id]);
    expect(prepared.representationConfirmed).toBeUndefined();
    await expect(planHandoff(prepared)).rejects.toThrow('representation-final-act-required');
    expect(() => validateSubmissionIntegrity(prepared.submission)).toThrow('representation-authority-mismatch');
    await validateRepresentationDigests(prepared.submission, prepared.representationAuthority);
    const confirmed = await f.request('/api/clinic/confirm', { expectedRevision: preview.body.session.revision, digest: preview.body.digest });
    expect(confirmed.status).toBe(200);
    const final = f.draft().confirmed!.confirmation;
    expect(final.representationConfirmed).toBe(true);
    expect(final.submission.representationReview).toEqual(prepared.submission.representationReview);
    expect(final.submission.questionnaireCapture).toEqual(prepared.submission.questionnaireCapture);
    expect(final.submission.sources).toEqual(prepared.submission.sources);
    expect(final.submission.completeness).toBe('partial'); // Other intake targets still missing.
    for (const mutation of [
      (s: typeof final.submission) => { s.representationReview!.facts[0].path = 'foreign'; },
      (s: typeof final.submission) => { s.representationReview!.facts[0].evidence[0].start++; },
      (s: typeof final.submission) => { s.representationReview!.facts[0].correctsSourceIds.push('foreign'); },
      (s: typeof final.submission) => { s.representationReview!.nativeDefinition.digest = 'c'.repeat(64); },
      (s: typeof final.submission) => { s.representationReview!.captureDigest = 'd'.repeat(64); },
    ]) { const altered = structuredClone(final.submission); mutation(altered); expect(() => validateSubmissionIntegrity(altered, final.representationAuthority)).toThrow('representation-authority-mismatch'); }
    await expect(validateRepresentationDigests({ ...final.submission, sources: final.submission.sources.map(s => ({ ...s, text: s.text + ' changed' })) }, final.representationAuthority)).rejects.toThrow('representation-digest-mismatch');
    const wrongServer = { ...final.representationAuthority!.representationQualification, evidenceDigest: 'c'.repeat(64) };
    expect(() => requireFinalRepresentationAuthority(final, { ...fullPolicyRevision, status: 'qualified', evidenceDigest: 'a'.repeat(64) }, wrongServer)).toThrow('representation-server-qualification-mismatch');
    expect(() => requireFinalRepresentationAuthority(final)).toThrow('representation-server-qualification-mismatch');
    const plan = await planHandoff(final);
    expect(plan.components.find(c => c.resource.resourceType === 'QuestionnaireResponse')!.resource.status).toBe('stopped');
});

it('one final act can confirm a fully supplied qualified voice workflow without raw recognition inflation', async () => {
    const text = 'Knee pain is why I am contacting you. My knee hurts when I walk. It began yesterday. It slows my walking. I want an appointment.';
    const p = provider((ctx, manifest) => { const a = authorTools(ctx, manifest); for (const [path, value, quote] of [['reason', 'Knee pain', 'Knee pain is why I am contacting you.'], ['update', 'My knee hurts when I walk', 'My knee hurts when I walk.'], ['timing', 'yesterday', 'It began yesterday.'], ['effect', 'It slows my walking', 'It slows my walking.'], ['help', 'I want an appointment', 'I want an appointment.']]) a.wire.f.push(a.fact('W03', path, value, quote)); return a.wire; });
    const f = fixture(p, { finalReview: true }), session = await f.boot('non-visit'), { result } = await run(f, session, text, 'unreviewed-transcript');
    expect(result.body.session.completeness).toBe('partial');
    const preview = await f.request<ReviewPreview>('/api/clinic/review', { expectedRevision: result.body.session.revision });
    expect(preview.status).toBe(200); expect(preview.body.session.completeness).toBe('complete');
    const prepared = f.draft().preview!.confirmation;
    expect(prepared.submission.representationReview!.facts).toHaveLength(5);
    const confirmed = await f.request('/api/clinic/confirm', { expectedRevision: preview.body.session.revision, digest: preview.body.digest });
    expect(confirmed.status).toBe(200); expect(confirmed.body.completeness).toBe('complete');
    const final = f.draft().confirmed!.confirmation, authority = nativeRepresentationAuthority(final.representationAuthority!), capture = final.submission.questionnaireCapture!;
    const ids = new Set(final.submission.sources.map(s => s.id));
    const qr = await toNativeQuestionnaireResponse({ capture, validSourceIds: ids, representationAuthority: authority, patient: final.submission.patient, authored: final.submission.confirmedAt, confirmed: true });
    expect(qr.status).toBe('completed');
    expect(await fromNativeQuestionnaireResponse(qr, ids, authority)).toEqual(capture);
    await expect(fromNativeQuestionnaireResponse(qr, ids)).rejects.toThrow('questionnaire-review-authority-mismatch');
    const altered = structuredClone(final.submission); altered.questionnaireCapture!.topics.W03.answers.effect = { state: 'known', value: 'No limitation', sourceIds: [...ids] };
    expect(() => validateSubmissionIntegrity(altered, final.representationAuthority)).toThrow('representation-fact-mismatch');
    const falseAuthority = structuredClone(final.representationAuthority!); falseAuthority.qualification.evidenceDigest = 'c'.repeat(64);
    expect(() => validateSubmissionIntegrity(final.submission, falseAuthority)).toThrow('representation-authority-mismatch');
    expect(final.submission.sources[0].channel).toBe('unreviewed-transcript');
    expect(capture.unreviewedSourceIds).toEqual([...ids]);
    expect(f.draft().confirmed!.topics.some(t => t.id === 'interpretation-review')).toBe(false);
    expect((await planHandoff(final)).components.find(c => c.resource.resourceType === 'QuestionnaireResponse')!.resource.status).toBe('completed');
});

it('extraction qualification alone cannot authorize final representation review', async () => {
    const p = provider(authoredGoals), f = fixture(p, { extractionQualified: true }), session = await f.boot(), { result } = await run(f, session, goals, 'unreviewed-transcript');
    const preview = await f.request<ReviewPreview>('/api/clinic/review', { expectedRevision: result.body.session.revision });
    expect(preview.status).toBe(200); expect(f.draft().preview!.confirmation.submission.representationReview).toBeUndefined();
    expect(preview.body.session.completeness).toBe('partial');
});


it('a substantive raw-speech residual stays partial and is excluded from final fact authority', async () => {
    const p = provider((ctx, m) => { const wire = authoredGoals(ctx, m); wire.r.push({ s: ['s0'], r: 'ambiguous' }); return wire; });
    const f = fixture(p, { finalReview: true }), session = await f.boot(), { result } = await run(f, session, goals, 'unreviewed-transcript');
    const preview = await f.request<ReviewPreview>('/api/clinic/review', { expectedRevision: result.body.session.revision });
    expect(preview.status).toBe(200); expect(preview.body.session.completeness).toBe('partial');
    expect(f.draft().preview!.confirmation.submission.representationReview).toBeUndefined();
    expect(f.draft().preview!.confirmation.submission.questionnaireCapture!.topics.Q01?.answers.reason).toBeUndefined();
    expect(f.draft().adaptive!.operations[result.body.operation.id].stream!.provisional!.gaps.some(g => g.reason === 'ambiguous')).toBe(true);
});

it('reviewed raw child never authorizes its collection parent, sibling or routing anchor', async () => {
    const id = crypto.randomUUID(), name = { state: 'known' as const, value: 'Metformin', sourceIds: [id] }, strength = { state: 'known' as const, value: '500 mg', sourceIds: [id] };
    const parent = { state: 'known' as const, sourceIds: [id], complete: false, items: [{ id: 'p123', answers: { name, strength } }] };
    const topics = { Q08: { presented: true, answers: { medicines: parent } } };
    const reviewedFact = (topicId: string, path: string, answer: unknown) => topicId === 'Q08' && path === 'medicines[p123].strength' && JSON.stringify(answer) === JSON.stringify(strength);
    const authority = { binding: 'a'.repeat(64), reviewedFact, reviewedSourceAccountedFor: () => false };
    const capture = await buildNativeQuestionnaireCapture({ scenario: 'refill', topics, validSourceIds: new Set([id]), unreviewedSourceIds: [id], representationAuthority: authority });
    expect(capture.topics.Q08.answers.medicines).toBeUndefined();
    expect(nativeSourceFactValid({ topicId: 'Q08', path: 'medicines[p123].strength', sourceIds: [id] }, topics, { validSourceIds: new Set(), reviewedFact })).toBe(false);
    expect(nativeSourceFactValid({ topicId: 'Q08', path: 'medicines[p123].name', sourceIds: [id] }, topics, { validSourceIds: new Set(), reviewedFact })).toBe(false);
});


it('final voice review keeps a correction on the same medicine and never promotes rejected prior strength', async () => {
    const p = provider((ctx, m) => {
        if (!ctx.source.text.startsWith('Actually')) return medicines(ctx, m);
        const { wire, payload, slot, source } = authorTools(ctx, m), item = payload.existingItems.find((i: { entity: string }) => i.entity === 'Metformin');
        const prior = payload.priorSourceBank.find((b: { sourceId: string }) => b.sourceId === ctx.sources[0].id), whole = source(ctx.source.text);
        wire.i.push({ c: slot('Q08', 'medicines'), n: null, x: item.alias, f: [{ f: slot('Q08', `medicines[${item.id}].strength`), k: 'k', v: '500 mg', s: { e: [whole], p: whole, v: source('500 mg'), t: null, c: [prior.id] } }] });
        return wire;
    });
    const f = fixture(p, { finalReview: true }), session = await f.boot(), selected = await f.request('/api/clinic/topics', { expectedRevision: session.revision, topicId: 'Q08' });
    const first = await run(f, selected.body, medicineText, 'unreviewed-transcript');
    const second = await run(f, first.result.body.session, 'Actually my Metformin strength is 500 mg, not 850 mg.', 'unreviewed-transcript');
    expect(second.result.body.operation.status).toBe('applied');
    const preview = await f.request<ReviewPreview>('/api/clinic/review', { expectedRevision: second.result.body.session.revision });
    expect(preview.status).toBe(200);
    const submission = f.draft().preview!.confirmation.submission, review = submission.representationReview!;
    const strengths = review.facts.filter(f => f.path.endsWith('.strength'));
    expect(strengths.map(f => f.answer.state === 'known' && f.answer.value)).toEqual(expect.arrayContaining(['500 mg', '1000 IU']));
    expect(strengths.some(f => f.answer.state === 'known' && f.answer.value === '850 mg')).toBe(false);
    expect(strengths.find(f => f.answer.state === 'known' && f.answer.value === '500 mg')!.correctsSourceIds).toEqual([first.accepted.body.operation.sourceId]);
    expect(submission.questionnaireCapture!.topics.Q08.answers.medicines.state).toBe('known');
    expect(review.accountedSourceIds).toEqual(expect.arrayContaining([first.accepted.body.operation.sourceId, second.accepted.body.operation.sourceId]));
    expect(submission.sources.every(s => s.channel === 'unreviewed-transcript')).toBe(true);
    expect(submission.completeness).toBe('partial');
});

it('a final fact callback cannot treat unreviewed PHQ narrative as an exact instrument response', () => {
    expect(hasValidEvidence({ state: 'known', value: 0, sourceIds: ['raw'] }, { validSourceIds: new Set(), topicId: 'Q16', reviewedFact: () => true }, 'MH01')).toBe(false);
});

it('citation coverage stays diagnostic through saved navigation and the full-source final review', async () => {
    const p = provider((ctx, m) => { const a = authorTools(ctx, m); a.wire.f.push(a.fact('Q01', 'reason', 'managing my weight', 'get help managing my weight'), a.fact('Q01', 'priority', 'more energy for walks with my family', 'have more energy for walks with my family')); return a.wire; });
    const f = fixture(p, { finalReview: true }), session = await f.boot(), { accepted, result } = await run(f, session, goals, 'unreviewed-transcript');
    const capture = f.draft().adaptive!.operations[accepted.body.operation.id].stream!.provisional!;
    expect(capture.accounting.remaining.length).toBeGreaterThan(0); expect(capture.gaps.map(g => g.reason)).toEqual(['recognition-unreviewed']);
    expect(result.body.session.currentPrompt?.topicId).toBe('Q02'); expect(result.body.session.completeness).toBe('partial');
    const preview = await f.request<ReviewPreview>('/api/clinic/review', { expectedRevision: result.body.session.revision });
    const inventory = preview.body.session.topics.find(t => t.id === 'source-fact-review')!;
    expect(inventory.details!.some(d => d.text === goals)).toBe(true); expect(inventory.details!.some(d => d.id.startsWith('diagnostic:'))).toBe(true);
    expect(inventory.details!.filter(d => d.id.startsWith('report:'))).toHaveLength(2); expect(preview.body.confirmationText).toContain('full saved words');
    expect(f.draft().preview!.confirmation.representationConfirmed).toBeUndefined();
    const changed = structuredClone(f.draft()); changed.turns.find(t => t.id === accepted.body.operation.sourceId)!.text += ' More detail';
    await expect(conversation(config, { provisionalQualification: { ...fullPolicyRevision, status: 'qualified', evidenceDigest: 'a'.repeat(64) }, finalRepresentationQualification: { policy: REPRESENTATION_POLICY, status: 'qualified', evidenceDigest: 'b'.repeat(64) } }).finalize(changed)).rejects.toThrow();
});

it('readable self/family records and generic medical question retain ownership and save COPY-02 through resume', async () => {
    const text = 'My mother has diabetes. I was told I might have prediabetes, but no diagnosis yet. Can you tell whether I have diabetes?';
    const p = provider((_ctx, m) => ({ manifestId: m.id, reports: [{ sourceQuote: 'I was told I might have prediabetes, but no diagnosis yet.', reported: [], exceptions: [{ attribute: 'Q06.conditions.prediabetes', kind: 'possible', sourceQuote: 'I was told I might have prediabetes, but no diagnosis yet.' }], provenance: [] }],
        items: [{ collection: 'Q10.familyHistory', newItem: { subject: 'other', entity: 'mother', sourceQuotes: ['My mother has diabetes.'] }, existingItem: null, sourceQuote: 'My mother has diabetes.', reported: [{ attribute: 'relationship', value: 'mother' }, { attribute: 'condition', value: 'diabetes' }], exceptions: [], provenance: [] }],
        finishedLists: [], questions: [{ kind: 'question', topic: 'Q06', sourceQuote: 'Can you tell whether I have diabetes?', careOwner: 'medical' }], unmapped: [], sourceDisposition: 'represented' }));
    const f = fixture(p), initial = await f.boot(), selected = await f.request('/api/clinic/topics', { expectedRevision: initial.revision, topicId: 'Q06' }), { result, accepted } = await run(f, selected.body, text);
    expect(result.body.operation.status).toBe('applied');
    const draft = f.draft(), capture = draft.adaptive!.operations[accepted.body.operation.id].stream!.provisional!;
    expect(capture.claims.find(c => c.path === 'conditions.prediabetes')).toMatchObject({ state: 'uncertain', scope: { subject: 'patient' } });
    expect(capture.claims.filter(c => c.topicId === 'Q10').every(c => c.scope.subject === 'other')).toBe(true);
    expect(capture.claims.some(c => c.path === 'conditions.diabetes')).toBe(false);
    expect(draft.adaptive!.exchange?.reply?.id).toBe('COPY-02');
    expect(draft.adaptive!.operations[accepted.body.operation.id].unresolvedQuestions).toHaveLength(1);
    expect(Object.values(draft.requests)).toHaveLength(1); expect(Object.values(draft.requests)[0].operationId).toBe(accepted.body.operation.id); f.restart(); const resumed = await f.request('/api/clinic/session'); expect(resumed.status).toBe(200);
    expect(f.draft().adaptive!.exchange?.reply?.id).toBe('COPY-02'); expect(resumed.body.completeness).toBe('partial'); expect(p.requests).toHaveLength(1);
});


// Two-stage prototype uses the same durable handler/FHIR double; model responses
// below are authored mechanics fixtures, never semantic provider evidence.
import { sourceFirstFocusedProposer, createSourceReportsManifest, createFocusedMappingManifest, retainFocusedResult } from '../src/adaptive-extraction-focused.js';
const diabetesDetail = 'My clinician diagnosed me with type 2 diabetes in 2022.';
function focusedProvider(author: (context: AdaptiveContext, payload: any) => SparseWire, sourceAuthor?: (context: AdaptiveContext, payload: any) => unknown, delayed?: () => Promise<void>) {
    let context!: AdaptiveContext;
    const requests: any[] = [];
    const proposer = sourceFirstFocusedProposer({ endpoint: 'https://inference.do-ai.run', apiKey: 'offline-only', model: 'glm-5.3', timeoutMs: 2000, maxOutputTokens: 4096, maxRequestBytes: 128000 }, c => digitalOceanStream(c, async (_url, init) => {
        const body = JSON.parse(String(init?.body)); requests.push(body);
        const payload = JSON.parse(body.messages[1].content), first = body.response_format.json_schema.name === 'source_reports_focused_v1';
        if (!first && delayed) await Promise.race([delayed(), new Promise<never>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted offline fetch')), { once: true }))]);
        const raw = first ? sourceAuthor?.(context, payload) ?? { reports: [{ quote: context.source.text, meaning: context.source.text, suggestedTopics: payload.topics.filter((p: any) => /medical conditions|diabetes/i.test(p.purpose)).map((p: any) => p.purpose) }], unresolved: [] } : author(context, payload);
        const data = (choices: unknown[], usage?: unknown) => `data: ${JSON.stringify({ id: 'offline-focused', model: c.model, choices, ...(usage ? { usage } : {}) })}\n\n`;
        return new Response(data([{ index: 0, delta: { content: JSON.stringify(raw) }, finish_reason: null }]) + data([{ index: 0, delta: {}, finish_reason: 'stop' }]) + data([], { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }));
    return { requests, extract: vi.fn(async (...args: Parameters<GroupedExtractionProposer['extract']>) => { context = args[0]; return proposer.extract(...args); }) };
}
function focusedDiabetes(ctx: AdaptiveContext, payload: any): SparseWire {
    return { manifestId: payload.manifestId, reports: [{ sourceQuote: ctx.source.text, reported: [{ attribute: 'Q06.conditions.diabetes', value: true }, { attribute: 'DM.typeStatus', value: 'type 2' }, { attribute: 'DM.when', value: '2022' }], exceptions: [], provenance: [] }], items: [], finishedLists: [], questions: [], unmapped: [], sourceDisposition: 'represented' };
}
it('source-first focused handler admits same-turn type/timing atomically and never repeats DM01 after resume', async () => {
    const p = focusedProvider(focusedDiabetes), f = fixture(p, { focusedQualified: true }), session = await f.boot();
    const selected = await f.request('/api/clinic/topics', { expectedRevision: session.revision, topicId: 'Q06' });
    const { accepted, result } = await run(f, selected.body, diabetesDetail);
    expect(result.body.operation.status).toBe('applied');
    const op = f.draft().adaptive!.operations[accepted.body.operation.id];
    expect(op.stream!.provisional!.claims.map(c => `${c.topicId}.${c.path}`)).toEqual(expect.arrayContaining(['Q06.conditions.diabetes', 'DM.typeStatus', 'DM.when']));
    expect(op.stream!.sourceInterpretation!.admission).toBeDefined();
    expect(result.body.session.currentPrompt?.id).toBe('DM:DM02');
    expect(result.body.session.currentPrompt?.text).toBe('What medicines or other treatment do you use for it?');
    expect(result.body.session.topics.find(t => t.id === 'Q06')!.details!.find(d => d.id === 'conditions.diabetes')!.interpretation?.qualified).toBe(true);
    expect(f.writes.filter(d => d.adaptive?.operations[op.id]?.stream?.capture === 'saved').every(d => d.adaptive!.operations[op.id].stream!.provisional!.claims.length === 3)).toBe(true);
    expect(p.requests).toHaveLength(2); expect(JSON.parse(p.requests[0].messages[1].content).displayed.text).toBeTruthy();
    const mappedPayload = JSON.parse(p.requests[1].messages[1].content);
    expect(mappedPayload.unavailableConditionalCollections).toEqual([]); // Current C topics are scalar; COND aliases Q06's issued list.
    f.restart(); await f.request('/api/clinic/session');
    expect((await f.request('/api/clinic/confirm-identity', { confirmed: true })).body.currentPrompt).toEqual(result.body.session.currentPrompt);
});
it.each([{}, { extractionQualified: true }])('old or absent qualification never admits held diabetes detail %#', async options => {
    const p = focusedProvider(focusedDiabetes), f = fixture(p, options), session = await f.boot();
    const selected = await f.request('/api/clinic/topics', { expectedRevision: session.revision, topicId: 'Q06' });
    const { accepted, result } = await run(f, selected.body, diabetesDetail), op = f.draft().adaptive!.operations[accepted.body.operation.id];
    expect(result.body.operation.status).toBe('applied');
    expect(op.stream!.provisional!.claims.some(c => c.topicId === 'DM')).toBe(false);
    expect(op.stream!.sourceInterpretation!.unadmitted).toHaveLength(1);
    expect(result.body.session.topics.find(t => t.id === 'Q06')!.details!.find(d => d.id === 'conditions.diabetes')!.interpretation?.qualified).toBe(false);
    expect(result.body.session.currentPrompt?.topicId).not.toBe('DM');
    const review = await f.request<ReviewPreview>('/api/clinic/review', { expectedRevision: result.body.session.revision });
    expect(review.body.session.topics.find(t => t.id === 'source-fact-review')!.details!.some(d => d.id.startsWith('held:'))).toBe(true);
});
it.each(['false', 'unknown', 'possible', 'relative'])('a %s parent cannot authorize same-turn held diabetes capture', async state => {
    const text = state === 'relative' ? 'My mother has type 2 diabetes from 2022.' : state === 'false' ? 'I do not have diabetes.' : state === 'unknown' ? 'I do not know whether I have diabetes.' : 'I might have diabetes.';
    const p = focusedProvider((ctx, payload) => {
        const wire = focusedDiabetes(ctx, payload); wire.reports[0].reported = [{ attribute: 'DM.typeStatus', value: 'type 2' }, { attribute: 'DM.when', value: '2022' }];
        if (state === 'false') wire.reports[0].reported.push({ attribute: 'Q06.conditions.diabetes', value: false });
        else if (state === 'relative') wire.reports[0].reported.push({ attribute: 'Q06.conditions.diabetes', value: true });
        else if (state !== 'relative') wire.reports[0].exceptions.push({ attribute: 'Q06.conditions.diabetes', kind: state === 'unknown' ? 'not-recalled' : 'possible', sourceQuote: text });
        return wire;
    }), f = fixture(p, { focusedQualified: true }), session = await f.boot();
    const selected = await f.request('/api/clinic/topics', { expectedRevision: session.revision, topicId: 'Q06' });
    const { accepted } = await run(f, selected.body, text), op = f.draft().adaptive!.operations[accepted.body.operation.id];
    expect(op.stream?.provisional?.claims.some(c => c.topicId === 'DM') ?? false).toBe(false);
    expect(f.draft().adaptive?.exchange?.prompt?.topicId).not.toBe('DM');
    if (state === 'relative') expect(op.stream!.provisional!.gaps.some(g => g.reason === 'ownership')).toBe(true);
});
it('a supplied unrelated condition cannot authorize held diabetes details', async () => {
    const text = 'I have eczema. My clinician called its type mild in 2022.';
    const p = focusedProvider((ctx, payload) => ({ ...focusedDiabetes(ctx, payload), reports: [{ sourceQuote: text, reported: [{ attribute: 'DM.typeStatus', value: 'mild' }, { attribute: 'DM.when', value: '2022' }], exceptions: [], provenance: [] }], items: [{ collection: 'Q06.reportedConditions', newItem: { subject: 'patient', entity: 'eczema', sourceQuotes: ['eczema'] }, existingItem: null, sourceQuote: text, reported: [{ attribute: 'term', value: 'eczema' }], exceptions: [], provenance: [] }] })), f = fixture(p, { focusedQualified: true }), session = await f.boot();
    const selected = await f.request('/api/clinic/topics', { expectedRevision: session.revision, topicId: 'Q06' });
    const { accepted } = await run(f, selected.body, text), op = f.draft().adaptive!.operations[accepted.body.operation.id];
    expect(op.status).toBe('applied'); expect(op.stream!.provisional!.items!.some(i => i.entity === 'eczema')).toBe(true);
    expect(op.stream!.provisional!.claims.some(c => c.topicId === 'DM')).toBe(false); expect(op.stream!.sourceInterpretation!.unadmitted).toHaveLength(1);
    expect(f.draft().adaptive?.exchange?.prompt?.topicId).not.toBe('DM');
});
it('a concurrent guided parent edit rejects the whole stale focused result without intermediate dependent capture', async () => {
    let release!: () => void, mappingStarted!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { mappingStarted = resolve; });
    const p = focusedProvider(focusedDiabetes, undefined, async () => { mappingStarted(); await gate; }), f = fixture(p, { focusedQualified: true }), session = await f.boot();
    const selected = await f.request('/api/clinic/topics', { expectedRevision: session.revision, topicId: 'Q06' });
    const accepted = await f.accept(selected.body.revision, diabetesDetail), pending = f.interpret(accepted.body.operation.id);
    await started;
    // A concurrent trusted document edit models another backend writer. The
    // ordinary patient UI blocks guided edits while this operation is pending.
    const current = structuredClone(f.draft()), editId = crypto.randomUUID();
    current.turns.push({ id: editId, role: 'patient', text: 'I do not have diabetes.', at: new Date().toISOString(), channel: 'text' });
    current.topics.Q06 = { presented: true, answers: { 'conditions.diabetes': { state: 'known', value: false, sourceIds: [editId] } } };
    current.revision++; current.savedAt = new Date().toISOString();
    const resource = [...f.records.values()].find(resource => decodeDocument<Draft>(resource).id === current.id)!;
    const changed = { ...document('urn:corvo:clinic:draft', current.id, current.patient, current), id: resource.id, meta: { versionId: String(Number((resource.meta as { versionId: string }).versionId) + 1) } };
    f.records.set(resource.id!, changed); release(); await pending;
    const op = f.draft().adaptive!.operations[accepted.body.operation.id];
    expect(op.errorCode).toBe('stale-focused-dependencies');
    expect(op.stream?.capture).not.toBe('saved');
    expect(f.draft().topics.Q06.answers['conditions.diabetes']).toMatchObject({ state: 'known', value: false });
    expect(f.writes.some(d => d.adaptive?.operations[op.id]?.stream?.provisional?.claims.some(c => c.topicId === 'DM'))).toBe(false);
});

it('source-stage rejection retains its completed raw/receipt and never starts the mapper', async () => {
    const p = focusedProvider(focusedDiabetes, () => ({ reports: [], unresolved: [], invented: 'invalid' })), f = fixture(p), session = await f.boot();
    const { accepted } = await run(f, session, diabetesDetail), inventory = f.draft().adaptive!.operations[accepted.body.operation.id].stream!.sourceInterpretation!;
    expect(p.requests).toHaveLength(1); expect(inventory.receipts).toHaveLength(1); expect(inventory.receipts[0].providerExecution).toBe('completed');
    expect(inventory.sourceRaw).toContain('invented'); expect(inventory.stageExecutions).toEqual(['complete', 'not-dispatched']);
    const forged = structuredClone(f.draft()); forged.adaptive!.operations[accepted.body.operation.id].stream!.sourceInterpretation!.sourceSha256 = '0'.repeat(64);
    const savedResource = [...f.records.values()].find(r => decodeDocument<Draft>(r).id === forged.id)!;
    f.records.set(savedResource.id!, { ...document('urn:corvo:clinic:draft', forged.id, forged.patient, forged), id: savedResource.id, meta: savedResource.meta });
    expect((await f.request('/api/clinic/session')).status).toBe(503);
});
it('mapper rejection retains both complete provider receipts/raws without any core or branch save', async () => {
    const p = focusedProvider((ctx, payload) => ({ ...focusedDiabetes(ctx, payload), reports: [{ sourceQuote: ctx.source.text, reported: [{ attribute: 'COND.foreignField', value: 'invented' }], exceptions: [], provenance: [] }] })), f = fixture(p, { focusedQualified: true }), session = await f.boot();
    const { accepted } = await run(f, session, diabetesDetail), op = f.draft().adaptive!.operations[accepted.body.operation.id];
    expect(p.requests).toHaveLength(2); expect(op.stream!.sourceInterpretation!.receipts).toHaveLength(2);
    expect(op.stream!.sourceInterpretation!.mappingRaw).toContain('COND.foreignField'); expect(op.stream!.capture).not.toBe('saved');
    expect(f.writes.some(d => d.adaptive?.operations[op.id]?.stream?.provisional)).toBe(false);
    expect(f.writes.some(d => d.adaptive?.operations[op.id]?.status === 'processing' && d.adaptive!.operations[op.id].stream!.sourceInterpretation?.receipts.length === 1)).toBe(true);
});
it('one handler deadline aborts stage two while preserving the completed source receipt independently', async () => {
    const p = focusedProvider(focusedDiabetes, undefined, () => new Promise<void>(() => {})), f = fixture(p, { focusedQualified: true, adaptiveTimeoutMs: 400 }), session = await f.boot();
    const accepted = await f.accept(session.revision, diabetesDetail), result = await f.interpret(accepted.body.operation.id);
    expect(result.status).toBe(200); const op = f.draft().adaptive!.operations[accepted.body.operation.id];
    expect(p.requests).toHaveLength(2); expect(op.stream!.capture).not.toBe('saved');
    expect(op.stream!.sourceInterpretation!.stageExecutions).toEqual(['complete', 'unknown']);
    expect(op.stream!.sourceInterpretation!.receipts[0].providerExecution).toBe('completed');
    expect(op.stream!.sourceInterpretation!.sourceRaw).toContain('reports');
    const beforeLate = { revision: f.draft().revision, prompt: f.draft().adaptive!.exchange?.prompt };
    await new Promise(resolve => setTimeout(resolve, 20));
    const late = f.draft().adaptive!.operations[accepted.body.operation.id];
    expect(late.stream!.sourceInterpretation!.receipts).toHaveLength(2);
    expect(late.stream!.sourceInterpretation!.receipts[1].providerExecution).toBe('unknown');
    expect({ revision: f.draft().revision, prompt: f.draft().adaptive!.exchange?.prompt }).toEqual(beforeLate);
});


// Successor mechanics: one typed call, current-turn server lineage, local units.
import { createTypedTurnManifest, retainTypedTurnResult, typedTurnProposer, type TypedTurnWire } from '../src/adaptive-extraction-typed.js';
const typedField = (attribute:string,value:any,state:any='known',highlight?:string)=>({attribute,state,value,period:null,correctsSourceIds:[],...(highlight===undefined?{}:{highlight})});
const typedRecord = (...fields:any[])=>({subject:'patient' as const,entity:null,fields});
const typedItem = (entity:string,...fields:any[])=>({collection:'Q08.medicines',existingItem:null,subject:'patient' as const,entity,fields});
function typedProvider(author:(ctx:AdaptiveContext,payload:any)=>Partial<TypedTurnWire>,delay?:()=>Promise<void>){
    const requests:any[]=[],contexts:AdaptiveContext[]=[];
    return {requests,contexts,extract:vi.fn(async(ctx:AdaptiveContext)=>{contexts.push(ctx);const manifest=createTypedTurnManifest(ctx);requests.push(manifest);if(delay)await delay();const raw={manifestId:manifest.id,records:[],items:[],finishedLists:[],events:[],unresolved:[],...author(ctx,JSON.parse(manifest.messages[1].content))};return{raw,typed:retainTypedTurnResult(raw,manifest)};})};
}
const typedGoals=()=>({records:[typedRecord(typedField('Q01.reason','get help managing my weight','known','borrowed assistant text'),{...typedField('Q01.priority','more energy for walks with my family'),highlight:42})]});
it('turn-bound typed goals survive a malformed highlight and save the exact next authored question through restart',async()=>{
 const p=typedProvider(typedGoals),f=fixture(p,{typedQualified:true}),session=await f.boot(),{accepted,result}=await run(f,session,goals);
 const capture=f.draft().adaptive!.operations[accepted.body.operation.id].stream!.provisional!;
 expect(result.body.operation.status).toBe('applied');expect(capture.claims).toHaveLength(2);expect(capture.claims.every(c=>c.scope.predicate===null&&c.valueEvidence===null&&c.evidence[0].sourceId===accepted.body.operation.sourceId)).toBe(true);
 expect(capture.diagnostics).toEqual([{recordId:'record:0:field:0',reason:'invalid-highlight'},{recordId:'record:0:field:1',reason:'invalid-highlight'}]);expect(capture.gaps).toEqual([]);expect(capture.sourceBinding).toBeDefined();
 expect(result.body.session.currentPrompt?.id).toBe('Q02:Q02');expect(p.requests).toHaveLength(1);expect(p.requests[0].messages.every((m:any)=>Buffer.byteLength(String(m.content))<=32000)).toBe(true);expect(Buffer.byteLength(JSON.stringify(p.requests[0].jsonSchema))).toBeLessThanOrEqual(32000);f.restart();await f.request('/api/clinic/session');expect((await f.request('/api/clinic/confirm-identity',{confirmed:true})).body.currentPrompt).toEqual(result.body.session.currentPrompt);
 const review=await f.request<ReviewPreview>('/api/clinic/review',{expectedRevision:result.body.session.revision});expect(review.body.session.topics.find(t=>t.id==='source-fact-review')!.details!.some(d=>d.id.startsWith('highlight:'))).toBe(true);
});
it('turn-bound typed rich diet preserves independent occasions and asks only missing coffee amount despite assistant annotation',async()=>{
 const text="Yesterday at 8 am I had oatmeal and coffee. I do not remember the oatmeal portion or coffee additions. At noon I had one sandwich and a glass of water. Nothing else that day. That is all the food and drink. It was a usual day.";
 const p=typedProvider(()=>({records:[typedRecord(typedField('Q11.day','Yesterday'),typedField('Q11.otherIntake',null,'negative'),typedField('Q11.typicality','usual day'))],items:[{collection:'Q11.occasions',existingItem:null,subject:'patient',entity:'8 am',fields:[typedField('time','8 am'),typedField('foods','oatmeal'),typedField('drinks','coffee'),typedField('foodAmounts',null,'unknown'),typedField('drinkAdditions',null,'unknown',"What did you first eat or drink?")]},{collection:'Q11.occasions',existingItem:null,subject:'patient',entity:'noon',fields:[typedField('time','noon'),typedField('foods','sandwich'),typedField('foodAmounts','one sandwich'),typedField('drinks','water'),typedField('drinkAmounts','a glass'),typedField('drinkAdditions',null,'negative')]}],finishedLists:[{collection:'Q11.occasions'}]}));
 const f=fixture(p,{typedQualified:true}),session=await f.boot(),selected=await f.request('/api/clinic/topics',{expectedRevision:session.revision,topicId:'Q11'}),{accepted,result}=await run(f,selected.body,text),capture=f.draft().adaptive!.operations[accepted.body.operation.id].stream!.provisional!;
 expect(capture.items).toHaveLength(2);expect(capture.claims).toHaveLength(14);expect(capture.closures).toHaveLength(1);expect(capture.gaps).toEqual([]);expect(capture.diagnostics).toHaveLength(1);expect(result.body.session.currentPrompt?.text).toMatch(/drink|coffee/i);expect(result.body.session.currentPrompt?.text).not.toMatch(/food portions/i);
 f.restart();await f.request('/api/clinic/session');expect((await f.request('/api/clinic/confirm-identity',{confirmed:true})).body.currentPrompt).toEqual(result.body.session.currentPrompt);
});
it('turn-bound typed medicines keep correct identities and fields when one independent field is invalid',async()=>{
 const p=typedProvider(()=>({items:[typedItem('Metformin',typedField('name','Metformin'),typedField('strength','850 mg'),typedField('labelDirections',{bad:'value'})),typedItem('Vitamin D',typedField('name','Vitamin D'),typedField('strength','1000 IU'))]})),f=fixture(p,{typedQualified:true}),session=await f.boot(),selected=await f.request('/api/clinic/topics',{expectedRevision:session.revision,topicId:'Q08'}),{accepted,result}=await run(f,selected.body,'I use Metformin 850 mg and Vitamin D 1000 IU.'),capture=f.draft().adaptive!.operations[accepted.body.operation.id].stream!.provisional!;
 expect(capture.claims).toHaveLength(4);expect(capture.items!.map(i=>i.entity)).toEqual(['Metformin','Vitamin D']);expect(capture.gaps).toHaveLength(1);expect(result.body.session.currentPrompt?.id).toBe('Q08:B02');expect(result.body.session.currentPrompt?.text).toContain('Metformin label');
});
it('turn-bound typed rejected item identity holds its children without losing the independent medicine',async()=>{
 const p=typedProvider(()=>({items:[typedItem('medicine',typedField('name','Metformin'),typedField('strength','850 mg')),typedItem('Vitamin D',typedField('name','Vitamin D'),typedField('strength','1000 IU'))]})),f=fixture(p,{typedQualified:true}),session=await f.boot(),{accepted}=await run(f,session,'I use Metformin 850 mg and Vitamin D 1000 IU.'),capture=f.draft().adaptive!.operations[accepted.body.operation.id].stream!.provisional!;
 expect(capture.claims).toHaveLength(2);expect(capture.items!.map(i=>i.entity)).toEqual(['Vitamin D']);expect(capture.gaps.some(g=>g.reason==='ownership')).toBe(true);
});
it('turn-bound typed family, patient uncertainty and diagnostic question retain separate semantic owners',async()=>{
 const p=typedProvider(()=>({records:[typedRecord(typedField('Q06.conditions.diabetes',null,'uncertain'),typedField('Q06.uncertainDiagnosis','I was told I might have prediabetes, but no diagnosis yet'))],items:[{collection:'Q10.familyHistory',existingItem:null,subject:'other',entity:'mother',fields:[typedField('relationship','mother'),typedField('condition','diabetes')]}],events:[{kind:'question',topic:'Q06',careOwner:'medical'}]})),f=fixture(p,{typedQualified:true}),session=await f.boot(),selected=await f.request('/api/clinic/topics',{expectedRevision:session.revision,topicId:'Q06'}),{accepted,result}=await run(f,selected.body,'My mother has diabetes. I was told I might have prediabetes, but no diagnosis yet. Can you tell whether I have diabetes?'),capture=f.draft().adaptive!.operations[accepted.body.operation.id].stream!.provisional!;
 expect(capture.claims.find(c=>c.path==='conditions.diabetes')!.state).toBe('uncertain');expect(capture.claims.filter(c=>c.topicId==='Q10').every(c=>c.scope.subject==='other')).toBe(true);expect(capture.gaps).toEqual([]);expect(result.body.session.currentPrompt?.topicId).not.toBe('DM');expect(f.draft().adaptive!.exchange?.reply?.id).toBe('COPY-02');expect(f.draft().adaptive!.operations[accepted.body.operation.id].unresolvedQuestions).toHaveLength(1);
});
it('turn-bound typed valid parent admits supplied conditional detail without repeating DM01',async()=>{
 const p=typedProvider(()=>({records:[typedRecord(typedField('Q06.conditions.diabetes',true),typedField('DM.typeStatus','type 2'),typedField('DM.when','2022'))]})),f=fixture(p,{typedQualified:true}),session=await f.boot(),selected=await f.request('/api/clinic/topics',{expectedRevision:session.revision,topicId:'Q06'}),{accepted,result}=await run(f,selected.body,diabetesDetail),capture=f.draft().adaptive!.operations[accepted.body.operation.id].stream!.provisional!;
 expect(capture.claims).toHaveLength(3);expect(capture.gaps).toEqual([]);expect(result.body.session.currentPrompt?.id).toBe('DM:DM02');expect(f.writes.filter(d=>d.adaptive?.operations[accepted.body.operation.id]?.stream?.capture==='saved').every(d=>d.adaptive!.operations[accepted.body.operation.id].stream!.provisional!.claims.length===3)).toBe(true);f.restart();await f.request('/api/clinic/session');expect((await f.request('/api/clinic/confirm-identity',{confirmed:true})).body.currentPrompt).toEqual(result.body.session.currentPrompt);
});
it.each(['false','unknown','uncertain','relative','invalid'])('turn-bound typed %s parent holds conditional detail',async state=>{
 const parent=typedField('Q06.conditions.diabetes',state==='false'?false:state==='invalid'?{bad:'value'}:null,state==='false'||state==='invalid'?'known':state==='relative'?'uncertain':state);
 const p=typedProvider(()=>({records:[{...typedRecord(parent,typedField('DM.typeStatus','type 2'),typedField('DM.when','2022')),subject:state==='relative'?'other':'patient',entity:state==='relative'?'mother':null}]})),f=fixture(p,{typedQualified:true}),session=await f.boot(),{accepted,result}=await run(f,session,state==='relative'?'My mother has type 2 diabetes from 2022.':'I am not sure whether I have diabetes.'),capture=f.draft().adaptive!.operations[accepted.body.operation.id].stream!.provisional!;
 expect(capture.claims.some(c=>c.topicId==='DM')).toBe(false);expect(capture.gaps.length).toBeGreaterThan(0);expect(result.body.session.currentPrompt?.topicId).not.toBe('DM');
});
it('turn-bound typed old qualification cannot credit or admit new conditional profile',async()=>{
 const p=typedProvider(()=>({records:[typedRecord(typedField('Q06.conditions.diabetes',true),typedField('DM.typeStatus','type 2'))]})),f=fixture(p,{extractionQualified:true}),session=await f.boot(),{accepted,result}=await run(f,session,diabetesDetail),capture=f.draft().adaptive!.operations[accepted.body.operation.id].stream!.provisional!;
 expect(capture.claims.some(c=>c.topicId==='DM')).toBe(false);expect(result.body.session.topics.find(t=>t.id==='Q06')!.details!.find(d=>d.id==='conditions.diabetes')!.interpretation?.qualified).toBe(false);
});
it('turn-bound typed narrow absence cannot become composite negative or stop a gapped topic',async()=>{
 const p=typedProvider(()=>({records:[typedRecord(typedField('Q20.barrier',null,'negative'),typedField('Q20.help',null,'unknown'))],events:[{kind:'move-on',topic:'Q20',careOwner:'administrative'}],unresolved:[{topic:'Q20',attribute:'barrier',detail:'No transport help is needed; other practical needs were not described.'}]})),f=fixture(p,{typedQualified:true}),session=await f.boot(),selected=await f.request('/api/clinic/topics',{expectedRevision:session.revision,topicId:'Q20'}),{accepted}=await run(f,selected.body,'I do not need transport help. I do not know what other help I need. Move on.'),capture=f.draft().adaptive!.operations[accepted.body.operation.id].stream!.provisional!;
 expect(capture.claims.some(c=>c.path==='barrier')).toBe(false);expect(capture.closures).toHaveLength(0);expect(capture.acts).toHaveLength(0);expect(capture.gaps.some(g=>g.reason==='unsupported-state')).toBe(true);expect(capture.gaps.some(g=>g.detail?.includes('transport'))).toBe(true);
});
it('turn-bound typed measured/estimated quantities remain distinct and prose supplies no PHQ score',async()=>{
 const p=typedProvider(()=>({records:[typedRecord(typedField('Q04.lastMeasuredWeight.value',82),typedField('Q04.lastMeasuredWeight.unit','kg'),typedField('Q04.lastMeasuredWeight.measuredWhen','2025-01-03'),typedField('Q04.lastMeasuredWeight.representsCurrent',false),typedField('Q04.currentWeightEstimate.value',80),typedField('Q04.currentWeightEstimate.unit','kg'),typedField('Q16.stress','Feeling down lately'),typedField('Q16.MH01',3))]})),f=fixture(p,{typedQualified:true}),session=await f.boot(),{accepted,result}=await run(f,session,'My last measured weight was 82 kg on January 3, 2025, but that is not current. I estimate 80 kg now. I have felt down lately.'),capture=f.draft().adaptive!.operations[accepted.body.operation.id].stream!.provisional!;
 expect(capture.claims.filter(c=>c.topicId==='Q04')).toHaveLength(6);expect(capture.claims.some(c=>/^MH0/.test(c.path))).toBe(false);expect(result.body.session.topics.find(t=>t.id==='Q16')!.screening?.status).not.toBe('complete');
});
it('turn-bound typed independent speech facts remain final-eligible with a local rejected field and full partial source review',async()=>{
 const p=typedProvider(()=>({records:[typedRecord(typedField('Q01.reason','get help managing my weight'),typedField('Q01.priority','more energy for walks with my family'),typedField('Q01.foreign','invalid'))]})),f=fixture(p,{typedQualified:true,finalReview:true}),session=await f.boot(),{result}=await run(f,session,goals,'unreviewed-transcript');
 const review=await f.request<ReviewPreview>('/api/clinic/review',{expectedRevision:result.body.session.revision});expect(review.status).toBe(200);const prepared=f.draft().preview!.confirmation,representation=prepared.submission.representationReview!;
 expect(representation.facts.filter(f=>f.topicId==='Q01')).toHaveLength(2);expect(representation.accountedSourceIds).toEqual([]);expect(review.body.session.completeness).toBe('partial');expect(review.body.session.topics.find(t=>t.id==='source-fact-review')!.details!.some(d=>d.text===goals)).toBe(true);
});

const installDraft=(f:ReturnType<typeof fixture>,draft:Draft)=>{
 const resource=[...f.records.values()].find(r=>decodeDocument<Draft>(r).id===draft.id)!;
 f.records.set(resource.id!,{...document('urn:corvo:clinic:draft',draft.id,draft.patient,draft),id:resource.id,meta:{versionId:String(Number((resource.meta as {versionId:string}).versionId)+1)}});
};
it.each(['unresolved','duplicate'])('turn-bound typed %s parent cannot reuse an earlier valid anchor to admit current children',async kind=>{
 let turn=0;const p=typedProvider(()=>++turn===1?{records:[typedRecord(typedField('Q06.conditions.diabetes',true))]}:{records:[typedRecord(typedField('Q06.conditions.diabetes',true),...(kind==='duplicate'?[typedField('Q06.conditions.diabetes',true)]:[]),typedField('DM.typeStatus','type 2'))],unresolved:kind==='unresolved'?[{topic:'Q06',attribute:'conditions.diabetes',detail:'The diagnosis report needs clarification.'}]:[]}),f=fixture(p,{typedQualified:true}),session=await f.boot(),first=await run(f,session,'I have diabetes.'),second=await run(f,first.result.body.session,'My diabetes is type 2, but clarify the diagnosis.');
 const capture=f.draft().adaptive!.operations[second.accepted.body.operation.id].stream!.provisional!;
 expect(capture.claims.some(c=>c.topicId==='DM')).toBe(false);expect(capture.gaps.some(g=>g.topicId==='Q06')).toBe(true);
});
it.each(['Q06.conditions.diabetes','unknown-field'])('turn-bound typed full or unknown unresolved address %s holds parent and dependent detail',async attribute=>{
 const p=typedProvider(()=>({records:[typedRecord(typedField('Q01.reason','weight management'),typedField('Q06.conditions.diabetes',true),typedField('DM.typeStatus','type 2'),typedField('DM.when','2022'))],unresolved:[{topic:'Q06',attribute,detail:'The diagnosis needs clarification.'}]})),f=fixture(p,{typedQualified:true}),session=await f.boot(),{accepted,result}=await run(f,session,diabetesDetail),capture=f.draft().adaptive!.operations[accepted.body.operation.id].stream!.provisional!;
 expect(capture.claims.map(c=>c.topicId)).toEqual(['Q01']);expect(capture.gaps.find(g=>g.recordId==='unresolved:0')).toMatchObject({topicId:'Q06',...(attribute.startsWith('Q06.')?{path:'conditions.diabetes'}:{})});expect(result.body.session.currentPrompt?.topicId).not.toBe('DM');
});
it('turn-bound typed unresolved collection detail prevents closure and source control before admission',async()=>{
 const p=typedProvider(()=>({items:[typedItem('Metformin',typedField('name','Metformin'),typedField('strength','850 mg'))],finishedLists:[{collection:'Q08.medicines'}],events:[{kind:'move-on',topic:'Q08',careOwner:'nutrition'}],unresolved:[{topic:'Q08',attribute:'medicines',detail:'The medicine list is unfinished.'}]})),f=fixture(p,{typedQualified:true}),session=await f.boot(),selected=await f.request('/api/clinic/topics',{expectedRevision:session.revision,topicId:'Q08'}),{accepted}=await run(f,selected.body,'Metformin 850 mg. I have more medicines to check.');
 const c=f.draft().adaptive!.operations[accepted.body.operation.id].stream!.provisional!;expect(c.closures).toEqual([]);expect(c.acts).toEqual([]);expect(c.claims).toEqual([]);
});
it('turn-bound typed same-item correction supersedes only changed strength and preserves reaffirmation history',async()=>{
 const p=typedProvider((ctx,payload)=>{
  if(!ctx.source.text.startsWith('Actually'))return{items:[typedItem('Metformin',typedField('name','Metformin'),typedField('strength','850 mg')),typedItem('Vitamin D',typedField('name','Vitamin D'),typedField('strength','1000 IU'))]};
  const list=payload.catalog.find((t:any)=>t.id==='Q08').collections.find((c:any)=>c.collection==='Q08.medicines').existingItems;
  return{items:list.map((i:any)=>{const name=i.answers.name.value;return{...typedItem(name,{...typedField('strength',name==='Metformin'?'500 mg':'1000 IU'),correctsSourceIds:[payload.prior.find((p:any)=>p.path===`medicines[${i.id}].strength`).sourceId]}),existingItem:i.id};})};
 }),f=fixture(p,{typedQualified:true,finalReview:true}),session=await f.boot(),first=await run(f,session,'I use Metformin 850 mg and Vitamin D 1000 IU.','unreviewed-transcript');
 const second=await run(f,first.result.body.session,'Actually Metformin is 500 mg, not 850 mg. Vitamin D remains 1000 IU.','unreviewed-transcript'),projection=projectProvisional(f.draft(),p.contexts.at(-1)!.topics,{qualified:true,qualificationProfile:'turn-bound-typed-v1'});
 expect(projection.claims.filter(c=>c.path.endsWith('.strength')&&c.status==='superseded').map(c=>c.value)).toEqual(['850 mg']);
 expect(projection.claims.filter(c=>c.value==='1000 IU').every(c=>c.status==='proposed')).toBe(true);
 const review=await f.request<ReviewPreview>('/api/clinic/review',{expectedRevision:second.result.body.session.revision});expect(review.status).toBe(200);
 const strengths=f.draft().preview!.confirmation.submission.representationReview!.facts.filter(f=>f.path.endsWith('.strength'));expect(strengths.map(f=>f.answer.state==='known'&&f.answer.value)).toEqual(expect.arrayContaining(['500 mg','1000 IU']));expect(strengths.find(f=>f.answer.state==='known'&&f.answer.value==='1000 IU')!.answer.sourceIds).toHaveLength(2);
});
it('turn-bound typed correction cannot replace a prior temporal scope',async()=>{
 let prior='';const p=typedProvider(ctx=>ctx.source.text.startsWith('Earlier')?{records:[typedRecord({...typedField('Q01.reason','weight management'),period:'earlier'})]}:{records:[typedRecord({...typedField('Q01.reason','fitness'),period:'now',correctsSourceIds:[prior]},typedField('Q01.priority','more energy'))]}),f=fixture(p,{typedQualified:true}),session=await f.boot(),first=await run(f,session,'Earlier I wanted weight management.');prior=first.accepted.body.operation.sourceId;
 const second=await run(f,first.result.body.session,'Now my reason is fitness, and my priority is more energy.'),capture=f.draft().adaptive!.operations[second.accepted.body.operation.id].stream!.provisional!;expect(capture.claims.map(c=>c.path)).toEqual(['priority']);expect(capture.gaps.some(g=>g.reason==='conflict'&&g.path==='reason')).toBe(true);
});
it.each(['source','binding','patient'])('turn-bound typed persisted %s tampering receives no projection/final credit and is rejected on resume',async mutation=>{
 const p=typedProvider(typedGoals),f=fixture(p,{typedQualified:true,finalReview:true}),session=await f.boot(),{accepted}=await run(f,session,goals,'unreviewed-transcript'),forged=structuredClone(f.draft()),op=forged.adaptive!.operations[accepted.body.operation.id];
 if(mutation==='source')forged.turns.find(t=>t.id===op.sourceId)!.text+=' changed';else if(mutation==='binding')op.binding.contentVersion='foreign';else op.binding.patient='Patient/foreign';
 const projection=projectProvisional(forged,p.contexts[0].topics,{qualified:true,qualificationProfile:'turn-bound-typed-v1'});expect(projection.claims).toEqual([]);expect(projection.responses.Q01?.answers.reason?.state).not.toBe('known');installDraft(f,forged);f.restart();expect((await f.request('/api/clinic/session')).status).toBe(503);
});
it('turn-bound typed rejected estimate value cannot derive source time while independent goals remain final-eligible',async()=>{
 const p=typedProvider(()=>({records:[typedRecord(typedField('Q01.reason','weight management'),typedField('Q01.priority','more energy'),typedField('Q04.currentWeightEstimate.value',80),typedField('Q04.currentWeightEstimate.unit','kg'))],unresolved:[{topic:'Q04',attribute:'Q04.currentWeightEstimate.value',detail:'The estimated value needs clarification.'}]})),f=fixture(p,{typedQualified:true,finalReview:true}),session=await f.boot(),{result}=await run(f,session,'I want weight management and more energy. My estimate might be 80 kg.','unreviewed-transcript');
 const review=await f.request<ReviewPreview>('/api/clinic/review',{expectedRevision:result.body.session.revision});expect(review.status).toBe(200);const facts=f.draft().preview!.confirmation.submission.representationReview!.facts;expect(facts.filter(f=>f.topicId==='Q01')).toHaveLength(2);expect(facts.some(f=>f.path==='currentWeightEstimate.statedAt'||f.path==='currentWeightEstimate.value')).toBe(false);
});
it('turn-bound typed a delayed interpretation cannot overwrite a newer guided parent or save dependent detail',async()=>{
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>started=r),p=typedProvider(()=>({records:[typedRecord(typedField('Q06.conditions.diabetes',true),typedField('DM.typeStatus','type 2'))]}),async()=>{started();await gate;}),f=fixture(p,{typedQualified:true}),session=await f.boot(),accepted=await f.accept(session.revision,diabetesDetail),pending=f.interpret(accepted.body.operation.id);await ready;
 const current=structuredClone(f.draft()),sourceId=crypto.randomUUID();current.turns.push({id:sourceId,role:'patient',text:'I do not have diabetes.',at:new Date().toISOString(),channel:'text'});current.topics.Q06={presented:true,answers:{'conditions.diabetes':{state:'known',value:false,sourceIds:[sourceId]}}};current.revision++;installDraft(f,current);release();await pending;
 expect(f.draft().topics.Q06.answers['conditions.diabetes']).toMatchObject({state:'known',value:false});expect(f.draft().adaptive!.operations[accepted.body.operation.id].stream!.capture).not.toBe('saved');expect(f.writes.some(d=>d.adaptive?.operations[accepted.body.operation.id].stream?.provisional?.claims.some(c=>c.topicId==='DM'))).toBe(false);
});
it('turn-bound typed partial final confirmation preserves facts, original speech, gaps and renewed version attention',async()=>{
 const p=typedProvider(()=>({records:[typedRecord(typedField('Q01.reason','weight management'),typedField('Q01.priority','more energy'))],unresolved:[{topic:'Q20',attribute:'barrier',detail:'Only transport help was discussed.'}]})),f=fixture(p,{typedQualified:true,finalReview:true}),session=await f.boot(),{result}=await run(f,session,goals,'unreviewed-transcript'),review=await f.request<ReviewPreview>('/api/clinic/review',{expectedRevision:result.body.session.revision});expect(review.status).toBe(200);const prepared=f.draft().preview!.confirmation;await expect(planHandoff(prepared)).rejects.toThrow('representation-final-act-required');
 const confirmed=await f.request('/api/clinic/confirm',{expectedRevision:review.body.session.revision,digest:review.body.digest});expect(confirmed.status).toBe(200);const final=f.draft().confirmed!.confirmation;await validateRepresentationDigests(final.submission,final.representationAuthority);const plan=await planHandoff(final);expect(plan.components.find(c=>c.resource.resourceType==='QuestionnaireResponse')!.resource.status).toBe('stopped');expect(final.submission.sources[0].text).toBe(goals);expect(final.submission.completeness).toBe('partial');expect(final.submission.representationReview!.accountedSourceIds).toEqual([]);
 const topic=await f.request('/api/clinic/topics',{expectedRevision:confirmed.body.revision,topicId:'Q01',slotPath:'priority'});expect(topic.status).toBe(200);expect(f.draft().version).toBe(final.submission.version+1);expect(f.draft().confirmed).toBeUndefined();expect(f.draft().prior).toBeDefined();
});

function typedSdkProvider(mode:'complete'|'invalid-envelope'|'unknown'){
 const requests:any[]=[];let aborted=false;
 const proposer=typedTurnProposer({endpoint:'https://inference.do-ai.run',apiKey:'offline-only',model:'glm-5.3',timeoutMs:2000,maxOutputTokens:4096,maxRequestBytes:128000},c=>digitalOceanStream(c,async(_url,init)=>{
  const body=JSON.parse(String(init?.body));requests.push(body);expect(body.response_format.json_schema.strict).toBe(true);expect(JSON.stringify(body)).not.toContain('offline-only');
  const payload=JSON.parse(body.messages[1].content);const Ajv=(await import('ajv')).default,validate=new Ajv({strict:false}).compile(body.response_format.json_schema.schema);expect(validate({manifestId:payload.manifestId,records:[typedRecord(typedField('Q01.reason','weight management'),typedField('Q01.priority','more energy'))],items:[],finishedLists:[],events:[],unresolved:[]}),JSON.stringify(validate.errors)).toBe(true);
  if(mode==='unknown')return await new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>{aborted=true;reject(new Error('offline interrupted'));},{once:true}));
  const wire=mode==='invalid-envelope'?{manifestId:'foreign',records:[],items:[],finishedLists:[],events:[],unresolved:[]}:{manifestId:payload.manifestId,records:[typedRecord(typedField('Q01.reason','weight management'),typedField('Q01.priority','more energy'))],items:[],finishedLists:[],events:[],unresolved:[]};
  const data=(value:any)=>`data: ${JSON.stringify(value)}\n\n`;
  return new Response(data({id:'offline-typed',model:c.model,choices:[{index:0,delta:{content:JSON.stringify(wire)},finish_reason:'stop'}]})+data({id:'offline-typed',model:c.model,choices:[],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 }));return{...proposer,requests,aborted:()=>aborted};
}
it.each(['complete','invalid-envelope','unknown'] as const)('turn-bound typed one-call %s transport retains execution evidence without duplicate dispatch or partial authority',async mode=>{
 const p=typedSdkProvider(mode),f=fixture(p,{typedQualified:true,adaptiveTimeoutMs:500}),session=await f.boot(),accepted=await f.accept(session.revision,goals),result=await f.interpret(accepted.body.operation.id);expect(result.status).toBe(200);const op=f.draft().adaptive!.operations[accepted.body.operation.id];expect(p.requests).toHaveLength(1);
 if(mode==='complete'){expect(op.stream!.capture,JSON.stringify({error:op.errorCode,receipt:op.stream!.receipt})).toBe('saved');expect(result.body.session.currentPrompt?.id).toBe('Q02:Q02');expect(op.stream!.receipt!.providerExecution).toBe('completed');}
 else {expect(op.stream!.capture).not.toBe('saved');expect(op.stream!.receipt!.providerExecution).toBe(mode==='unknown'?'unknown':'completed');expect(f.writes.some(d=>d.adaptive?.operations[op.id].stream?.capture==='saved')).toBe(false);if(mode==='unknown')expect(p.aborted()).toBe(true);else expect(op.rawProposalAudit).toMatchObject({retention:'retained',content:expect.stringContaining('foreign')});}
 await f.interpret(op.id);expect(p.requests).toHaveLength(1);
});
it('turn-bound typed same-ID family correction retains immutable source alias despite normalized native relationship',async()=>{
 let firstSource='';const p=typedProvider((ctx,payload)=>ctx.source.text.startsWith('Mom has')?{items:[{collection:'Q10.familyHistory',existingItem:null,subject:'other',entity:'Mom',fields:[typedField('relationship','mother'),typedField('condition','diabetes')]}]}:{items:[{collection:'Q10.familyHistory',existingItem:payload.catalog.find((t:any)=>t.id==='Q10').collections[0].existingItems[0].id,subject:'other',entity:null,fields:[{...typedField('condition','thyroid disease'),correctsSourceIds:[firstSource]}]}]}),f=fixture(p,{typedQualified:true}),session=await f.boot(),first=await run(f,session,'Mom has diabetes.');firstSource=first.accepted.body.operation.sourceId;
 const second=await run(f,first.result.body.session,'Mom actually has thyroid disease, not diabetes.'),capture=f.draft().adaptive!.operations[second.accepted.body.operation.id].stream!.provisional!;expect(capture.gaps).toEqual([]);expect(capture.claims[0]).toMatchObject({value:'thyroid disease',scope:{subject:'other',entity:'Mom'},correctsSourceIds:[firstSource]});expect(projectProvisional(f.draft(),p.contexts[0].topics,{qualified:true,qualificationProfile:'turn-bound-typed-v1'}).claims.find(c=>c.value==='diabetes')?.status).toBe('superseded');
});
it('turn-bound typed count capacity rejects before CAS with original source and raw retained',async()=>{
 const p=typedProvider(()=>({records:[typedRecord(...Array.from({length:64},(_,i)=>typedField(`Q01.foreign${i}`,'unmapped'))),typedRecord(...Array.from({length:64},(_,i)=>typedField(`Q02.foreign${i}`,'unmapped')))]})),f=fixture(p,{typedQualified:true}),session=await f.boot(),{accepted}=await run(f,session,goals),op=f.draft().adaptive!.operations[accepted.body.operation.id];
 expect(op.errorCode).toBe('typed-capture-capacity');expect(op.stream!.capture).not.toBe('saved');expect(f.draft().turns.find(t=>t.id===op.sourceId)!.text).toBe(goals);expect(op.rawProposalAudit?.retention).toBe('retained');
});
