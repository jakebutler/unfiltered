import { describe, expect, it, vi } from 'vitest';
import { createClinicHandler } from '../src/handler.js';
import type { AdaptiveProposer } from '../src/adaptive.js';
import { AdaptiveProposalFailure, buildAdaptiveMessages } from '../src/adaptive.js';
import type { AdaptiveContext } from '../src/adaptive-validation.js';
import { document, decodeDocument, SNAPSHOT_SYSTEM } from '../src/store.js';
import type { Draft, ClinicApiConfig } from '../src/types.js';
import type { Runtime } from '../src/runtime.js';
import type { FhirResource } from '../../clinical-core/src/fhir.js';
import { TransportError } from '../../clinical-core/src/transport.js';
import type { AdaptiveTurnResult, ClinicSessionView, ReviewPreview } from '../../clinic-contract/src/index.js';
import { evidence, fact, proposal } from './fixtures/adaptive.js';
import { administrativeTopics, type Snapshot } from '../src/handoffs.js';

const origin = 'http://127.0.0.1:5173';
const patient = { reference: 'Patient/test', displayName: 'Synthetic Patient', description: 'Synthetic only', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
const config = { origin, cookieSecret: 'test-secret-'.repeat(5), mentalHealth: 'phq4', patients: Object.fromEntries(['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'].map(id => [id, patient])) } as ClinicApiConfig;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const good = (ctx: AdaptiveContext) => ({ proposal: proposal([fact(ctx, 'Q01', 'reason', ctx.source.text)]), receipt: { requestId: 'provider-1', model: 'test-only', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } });

/** Faults occur beneath the real readDraft/saveDraft HTTP adapter boundary. */
function fixture(proposer: AdaptiveProposer = { propose: vi.fn(async ctx => good(ctx)) }, options: { timeoutMs?: number; now?: () => number; available?: boolean; snapshotRace?: (resource: FhirResource) => FhirResource } = {}) {
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
        // Real MedplumClient receipts always carry the full DeliveryProgress shape, even when unknown or incomplete.
        async check(confirmation: { digest: string }) { return { state: 'unknown', digest: confirmation.digest, present: 0, resources: {}, anchors: {}, verifiedWork: [] }; },
        deliver: vi.fn(async (confirmation: { digest: string }) => ({ receipt: { state: 'unknown', digest: confirmation.digest, present: 0, resources: {}, anchors: {}, verifiedWork: [] }, write: 'outcome-unknown' })),
    };
    const runtime = async () => ({ client, qualification: {} } as unknown as Runtime);
    const makeHandler = () => createClinicHandler(config, { runtime, ...(options.available === false ? {} : { adaptiveProposer: proposer }), adaptiveTimeoutMs: options.timeoutMs, adaptiveNow: options.now });
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
    const accept = (revision: number, text = 'Improve energy for family activities.', requestId = crypto.randomUUID()) => request<AdaptiveTurnResult>('/api/clinic/adaptive-turns', { requestId, expectedRevision: revision, text, channel: 'text' });
    const interpret = (id: string) => request<AdaptiveTurnResult>(`/api/clinic/adaptive-turns/${id}/interpret`, {});
    const status = (id: string) => request<AdaptiveTurnResult>(`/api/clinic/adaptive-turns/${id}`);
    const draft = () => [...records.values()].map(r => decodeDocument<Draft>(r)).find(d => d.schema === 1 && d.requests)!;
    return { records, writes, deliver: client.deliver, raw: (request: Request) => handler(request), request, boot, accept, interpret, status, draft, proposer, cookie: () => cookie, restart: () => { handler = makeHandler(); }, failNextPut: (failure: typeof failPut) => { failPut = failure; } };
}

async function pendingFixture() {
    const started = deferred<AdaptiveContext>(), done = deferred<ReturnType<typeof good>>();
    const propose = vi.fn(async (ctx: AdaptiveContext) => { started.resolve(ctx); return done.promise; });
    const f = fixture({ propose }); const session = await f.boot();
    const accepted = await f.accept(session.revision);
    const interpreting = f.interpret(accepted.body.operation.id);
    const context = await started.promise;
    return { ...f, propose, done, context, accepted: accepted.body, interpreting };
}

describe('durable adaptive handler and FHIR draft store', () => {
    it('rejects a conflicting conditional-create winner before delivering a reviewed handoff', async () => {
        const f = fixture(undefined, { snapshotRace(resource) {
            const winner = decodeDocument<Snapshot>(resource);
            winner.topics[0].title = 'Different review saved by concurrent request';
            return document(SNAPSHOT_SYSTEM, `${winner.id}.v${winner.confirmation.submission.version}`, winner.patient, winner);
        } });
        const session = await f.boot(), accepted = await f.accept(session.revision);
        const interpreted = await f.interpret(accepted.body.operation.id);
        const review = await f.request<ReviewPreview>('/api/clinic/review', { expectedRevision: interpreted.body.session.revision });
        const confirmed = await f.request<{ error: { code: string } }>('/api/clinic/confirm', { expectedRevision: review.body.session.revision, digest: review.body.digest });
        expect(confirmed.status).toBe(409);
        expect(confirmed.body.error.code).toBe('snapshot-conflict');
        expect(f.deliver).not.toHaveBeenCalled();
    });

    it('retains mixed facts and unmapped wording through restart, patient review and immutable clinical handoff', async () => {
        const mapped = 'I want more energy.', unmapped = 'My schedule changes every third Thursday 🙂.';
        const text = `${mapped}  ${unmapped}`;
        const propose = vi.fn(async (ctx: AdaptiveContext) => ({
            proposal: proposal([fact(ctx, 'Q01', 'reason', mapped)], { unmapped: [{ reason: 'unsupported-target' as const, evidence: evidence(ctx, unmapped) }] }),
            receipt: { requestId: 'mixed-evidence', model: 'offline-test', evidenceProtocol: 'contextual-handles-v4' as const,
                manifest: { id: 'fixture-manifest', sha256: 'fixture-manifest-digest' }, responseSchemaSha256: 'fixture-schema-digest' },
        }));
        const f = fixture({ propose }), session = await f.boot();
        const accepted = await f.accept(session.revision, text);
        const result = await f.interpret(accepted.body.operation.id);
        expect(result.body.operation.status).toBe('applied');
        const durable = structuredClone(f.draft().adaptive!.operations[accepted.body.operation.id]);
        expect(durable.hasUnresolvedInterpretation).toBe(true);
        expect(durable.resultDigest).toBeTruthy();
        expect(durable.unmapped).toHaveLength(1);
        f.restart();
        expect((await f.status(accepted.body.operation.id)).body.operation.status).toBe('applied');
        expect(f.draft().adaptive!.operations[accepted.body.operation.id]).toEqual(durable);
        const review = await f.request<ReviewPreview>('/api/clinic/review', { expectedRevision: result.body.session.revision });
        expect(review.status).toBe(200);
        expect(review.body.session.completeness).toBe('partial');
        const visible = review.body.session.topics.find(topic => topic.id === 'interpretation')!;
        expect(visible.interpretationGaps).toEqual([{ id: `${durable.id}:0`, ...durable.unmapped![0] }]);
        const span = visible.interpretationGaps![0].evidence[0];
        expect(review.body.session.turns.find(turn => turn.id === span.sourceId)!.text.slice(span.start, span.end)).toBe(unmapped);
        expect(review.body.session.topics.find(topic => topic.id === 'Q01')!.details!.find(detail => detail.id === 'reason')!.text).toBe(mapped);
        f.restart();
        const restored = await f.request<ReviewPreview>('/api/clinic/review', { expectedRevision: review.body.session.revision });
        expect(restored.body.session.topics).toEqual(review.body.session.topics);
        const confirmed = await f.request('/api/clinic/confirm', { expectedRevision: review.body.session.revision, digest: review.body.digest });
        expect(confirmed.status).toBe(200);
        expect(confirmed.body.topics.find(topic => topic.id === 'interpretation')).toEqual(visible);
        const snapshot = [...f.records.values()].map(resource => decodeDocument<Snapshot>(resource)).find(value => value.confirmation)!;
        expect(snapshot.topics.find(topic => topic.id === 'interpretation')).toEqual(visible);
        expect(snapshot.confirmation.submission.sources[0].text).toBe(text);
        expect(snapshot.confirmation.submission.answers.some(answer => answer.questionId === 'interpretation')).toBe(false);
        expect(administrativeTopics({ ...snapshot, scenario: 'billing' })).toEqual([]);
        expect(propose).toHaveBeenCalledOnce();
        const [snapshotId, snapshotResource] = [...f.records.entries()].find(([, resource]) => !!decodeDocument<Snapshot>(resource).confirmation)!;
        const changed = structuredClone(snapshot);
        changed.topics.find(topic => topic.id === 'interpretation')!.interpretationGaps![0].reason = 'ambiguous';
        f.records.set(snapshotId, { ...document(SNAPSHOT_SYSTEM, `${snapshot.id}.v1`, snapshot.patient, changed), id: snapshotId, meta: snapshotResource.meta });
        const replay = await f.request<{ error: { code: string } }>('/api/clinic/confirm', { expectedRevision: confirmed.body.revision, digest: review.body.digest });
        expect(replay.status).toBe(409);
        expect(replay.body.error.code).toBe('snapshot-conflict');
        expect(propose).toHaveBeenCalledOnce();
    });

    it('retains projected coverage provenance and covered rejected candidates after a process restart', async () => {
        const text = 'I was told I might have prediabetes, but no diagnosis yet.';
        const propose = vi.fn(async (ctx: AdaptiveContext) => ({ proposal: proposal([
            fact(ctx, 'Q06', 'reportedConditions', text),
        ], { newItems: [{ topicId: 'Q06', collection: 'reportedConditions', key: 'reported-condition', fields: [{ path: 'term', state: 'uncertain', transform: 'verbatim', evidence: evidence(ctx, text) }] }] }), receipt: { requestId: 'coverage-provider', model: 'offline-test', evidenceProtocol: 'literal-disambiguation-v2' as const } }));
        const f = fixture({ propose }), session = await f.boot();
        const accepted = await f.accept(session.revision, text);
        const result = await f.interpret(accepted.body.operation.id);
        expect(result.body.operation.status).toBe('applied');
        f.restart();
        expect((await f.status(accepted.body.operation.id)).body.operation.status).toBe('applied');
        const op = f.draft().adaptive!.operations[accepted.body.operation.id];
        expect(op.coveredCandidates).toHaveLength(1);
        expect(op.coveredCandidates![0].coverage.kind).toBe('collection-item');
        expect(op.provenance?.find(p => p.path === 'conditions.prediabetes')).toMatchObject({ derivedFrom: { version: 'evidence-coverage-v1', kind: 'fact' } });
        expect(op.receipt?.evidenceProtocol).toBe('literal-disambiguation-v2');
        expect(f.draft().topics.Q06.answers['conditions.prediabetes']?.state).toBe('uncertain');
        expect(propose).toHaveBeenCalledOnce();
    });
    it('retains unreviewed speech through duplicate acceptance, interpretation and final confirmation', async () => {
        const f = fixture(), session = await f.boot(), text = '  More energy for daily activities.\n';
        const input = { requestId: crypto.randomUUID(), expectedRevision: session.revision, text, channel: 'unreviewed-transcript' };
        const accepted = await f.request<AdaptiveTurnResult>('/api/clinic/adaptive-turns', input);
        expect(accepted.status).toBe(202);
        expect((await f.request<AdaptiveTurnResult>('/api/clinic/adaptive-turns', input)).body.operation.id).toBe(accepted.body.operation.id);
        expect((await f.request('/api/clinic/adaptive-turns', { ...input, channel: 'confirmed-transcript' })).status).toBe(409);
        expect(f.draft().turns.filter(t => t.role === 'patient')).toHaveLength(1);
        const source = structuredClone(f.draft().turns.find(t => t.id === accepted.body.operation.sourceId)!);
        expect(source).toMatchObject({ text, channel: 'unreviewed-transcript' });
        const interpreted = await f.interpret(accepted.body.operation.id);
        expect(interpreted.body.operation.status).toBe('applied');
        const review = await f.request<ReviewPreview>('/api/clinic/review', { expectedRevision: interpreted.body.session.revision });
        expect(review.status).toBe(200);
        const confirmed = await f.request('/api/clinic/confirm', { expectedRevision: review.body.session.revision, digest: review.body.digest });
        expect(confirmed.status).toBe(200);
        expect(confirmed.body.turns.find(t => t.id === source.id)).toEqual(source);
        expect(f.draft().confirmed!.confirmation.submission.sources[0]).toMatchObject({ id: source.id, text, channel: 'unreviewed-transcript' });
        const snapshot = [...f.records.values()].map(r => decodeDocument<Snapshot>(r)).find(s => s.confirmation)!;
        expect(snapshot.confirmation.submission.sources[0]).toMatchObject({ id: source.id, text, channel: 'unreviewed-transcript' });
        expect(f.proposer.propose).toHaveBeenCalledOnce();
    });
    it.each(['confirmed-transcript', 'unreviewed-transcript'])('rejects %s at frozen PHQ controls without a source or interpretation', async channel => {
        const f = fixture(), session = await f.boot();
        const selected = await f.request('/api/clinic/topics', { expectedRevision: session.revision, topicId: 'Q16', slotPath: 'MH01' });
        const result = await f.request<{ error: { code: string } }>('/api/clinic/turns', { requestId: crypto.randomUUID(), expectedRevision: selected.body.revision, promptId: selected.body.currentPrompt!.id, action: 'answer', text: '2', channel });
        expect(result.status).toBe(409); expect(result.body.error.code).toBe('explicit-screening-choice-required');
        expect(f.draft().turns).toHaveLength(0); expect(f.proposer.propose).not.toHaveBeenCalled();
    });
    it('saves verbatim Unicode/whitespace and actual displayed prompt before inference', async () => {
        const f = fixture(), session = await f.boot(), text = '  🙂\nI want more energy.\n';
        const result = await f.accept(session.revision, text);
        expect(result.status).toBe(202);
        expect(result.body.operation.status).toBe('accepted');
        expect(f.proposer.propose).not.toHaveBeenCalled();
        const source = f.draft().turns.find(t => t.id === result.body.operation.sourceId)!;
        expect(source).toMatchObject({ text, channel: 'text', displayedPromptId: 'Q01' });
        expect(f.draft().topics).toEqual({});
        expect(result.body.session.currentPrompt?.mode).toBe('adaptive');
        expect(result.body.session.adaptive?.unresolvedSources).toHaveLength(1);
    });
    it('recovers a lost raw-save acknowledgement without a duplicate source or provider call', async () => {
        const f = fixture(), session = await f.boot(), requestId = crypto.randomUUID();
        f.failNextPut('after');
        const first = await f.accept(session.revision, 'More energy.', requestId);
        const replay = await f.accept(session.revision, 'More energy.', requestId);
        expect(first.status).toBe(202); expect(replay.body.operation.id).toBe(first.body.operation.id);
        expect(f.draft().turns.filter(t => t.role === 'patient')).toHaveLength(1);
        expect(f.proposer.propose).not.toHaveBeenCalled();
    });
    it('does not infer after raw-save failure and permits only the same stable retry to save later', async () => {
        const f = fixture(), session = await f.boot(), requestId = crypto.randomUUID();
        f.failNextPut('before');
        expect((await f.accept(session.revision, 'More energy.', requestId)).status).toBe(503);
        expect(f.draft().turns).toHaveLength(0); expect(f.proposer.propose).not.toHaveBeenCalled();
        expect((await f.accept(session.revision, 'More energy.', requestId)).status).toBe(202);
        expect((await f.accept(session.revision, 'Different wording.', requestId)).status).toBe(409);
    });
    it('allows only one racing raw turn at a revision', async () => {
        const f = fixture(), session = await f.boot();
        const results = await Promise.all([f.accept(session.revision, 'First words.'), f.accept(session.revision, 'Second words.')]);
        expect(results.map(r => r.status).sort()).toEqual([202, 409]);
        expect(f.draft().turns.filter(t => t.role === 'patient')).toHaveLength(1);
    });
    it('claims once across concurrent interpret calls and another handler instance', async () => {
        const f = await pendingFixture();
        f.restart();
        const duplicate = await f.interpret(f.accepted.operation.id);
        expect(duplicate.body.operation.status).toBe('processing');
        expect(duplicate.body.session.revision).toBe(f.accepted.session.revision + 1);
        expect(f.propose).toHaveBeenCalledTimes(1);
        f.done.resolve(good(f.context));
        const applied = await f.interpreting;
        expect(applied.body.operation.status).toBe('applied');
        expect(applied.body.session.topics.find(t => t.id === 'Q01')?.details?.find(d => d.id === 'reason')?.provenance).toEqual([{ sourceId: f.context.source.id, start: 0, end: f.context.source.text.length, transform: 'verbatim' }]);
        expect(JSON.stringify(applied.body)).not.toContain('snapshotDigest');
        expect(JSON.stringify(applied.body)).not.toContain('provider-1');
    });
    it('wins exactly one processing CAS when two interpret requests race from accepted', async () => {
        const started = deferred<AdaptiveContext>(), done = deferred<ReturnType<typeof good>>();
        const propose = vi.fn(async (context: AdaptiveContext) => { started.resolve(context); return done.promise; });
        const f = fixture({ propose }), session = await f.boot(), accepted = await f.accept(session.revision);
        const first = f.interpret(accepted.body.operation.id), second = f.interpret(accepted.body.operation.id);
        const context = await started.promise;
        expect(propose).toHaveBeenCalledTimes(1);
        expect(f.writes.filter(d => d.adaptive?.operations[accepted.body.operation.id]?.status === 'processing')).toHaveLength(1);
        done.resolve(good(context));
        const results = await Promise.all([first, second]);
        expect(results.every(result => result.status === 200)).toBe(true);
        expect(results.some(result => result.body.operation.status === 'applied')).toBe(true);
        expect(propose).toHaveBeenCalledTimes(1);
    });
    it('reconciles an ambiguous accepted raw save after restart without duplicating text', async () => {
        const f = fixture(), session = await f.boot(), requestId = crypto.randomUUID();
        f.failNextPut('after-read-loss');
        expect((await f.accept(session.revision, 'Saved once despite lost response.', requestId)).status).toBe(503);
        const savedId = f.draft().adaptive!.activeOperationId;
        f.restart();
        const recovered = await f.accept(session.revision, 'Saved once despite lost response.', requestId);
        expect(recovered.body.operation.id).toBe(savedId);
        expect(recovered.body.operation.status).toBe('accepted');
        expect(f.draft().turns.filter(t => t.role === 'patient')).toHaveLength(1);
        expect(f.proposer.propose).not.toHaveBeenCalled();
    });
    it('does not dispatch when a successful processing PUT returns the unchanged accepted draft', async () => {
        const f = fixture(), accepted = await f.accept((await f.boot()).revision);
        f.failNextPut('stale-200');
        expect((await f.interpret(accepted.body.operation.id)).status).toBe(503);
        expect(f.proposer.propose).not.toHaveBeenCalled();
        expect((await f.status(accepted.body.operation.id)).body.operation.status).toBe('accepted');
    });
    it.each(['unknown-status', 'foreign-binding', 'missing-attempt'])('rejects malformed persisted adaptive claims before review or inference: %s', async mutation => {
        const f = fixture(), accepted = await f.accept((await f.boot()).revision);
        const [id, resource] = [...f.records.entries()][0], draft = decodeDocument<Draft>(resource), op = draft.adaptive!.operations[accepted.body.operation.id];
        if (mutation === 'unknown-status') Object.assign(op, { status: 'processing-unknown' });
        if (mutation === 'foreign-binding') op.binding.patient = 'Patient/other';
        if (mutation === 'missing-attempt') op.status = 'processing';
        f.records.set(id, { ...document('urn:corvo:clinic:draft', draft.id, draft.patient, draft), id, meta: resource.meta });
        expect((await f.status(op.id)).status).toBe(503);
        expect((await f.interpret(op.id)).status).toBe(503);
        const review = await f.request<{ error: { code: string } }>('/api/clinic/review', { expectedRevision: draft.revision });
        expect(review.status).toBe(503);
        expect(review.body.error.code).toBe('invalid-stored-operation');
        expect(f.proposer.propose).not.toHaveBeenCalled();
    });
    it('continues reading legacy guided drafts without adaptive metadata', async () => {
        const f = fixture(undefined, { available: false }); await f.boot();
        const [id, resource] = [...f.records.entries()][0], draft = decodeDocument<Draft>(resource);
        delete draft.adaptive;
        f.records.set(id, { ...document('urn:corvo:clinic:draft', draft.id, draft.patient, draft), id, meta: resource.meta });
        const resumed = await f.request('/api/clinic/confirm-identity', { confirmed: true });
        expect(resumed.status).toBe(200);
        expect(resumed.body.currentPrompt?.mode).toBe('guided');
    });
    it('does not dispatch after an ambiguous processing-claim save', async () => {
        let clock = Date.now(); const f = fixture(undefined, { now: () => clock }); const session = await f.boot();
        const accepted = await f.accept(session.revision);
        f.failNextPut('after-read-loss');
        expect((await f.interpret(accepted.body.operation.id)).status).toBe(503);
        expect(f.proposer.propose).not.toHaveBeenCalled();
        f.restart(); clock += 21000;
        expect((await f.status(accepted.body.operation.id)).body.operation.status).toBe('unresolved');
        expect((await f.interpret(accepted.body.operation.id)).body.operation.status).toBe('unresolved');
        expect(f.proposer.propose).not.toHaveBeenCalled();
    });
    it('recovers a saved result with a lost acknowledgement without calling the provider again', async () => {
        const f = await pendingFixture(); f.failNextPut('after'); f.done.resolve(good(f.context));
        const applied = await f.interpreting;
        expect(applied.body.operation.status).toBe('applied');
        expect((await f.interpret(f.accepted.operation.id)).body.operation.status).toBe('applied');
        expect(f.propose).toHaveBeenCalledTimes(1);
    });
    it('makes an unsaved result unresolved instead of repeating inference', async () => {
        const f = await pendingFixture(); f.failNextPut('before'); f.done.resolve(good(f.context));
        expect((await f.interpreting).body.operation.status).toBe('unresolved');
        expect(f.draft().topics.Q01).toBeUndefined();
        expect(f.draft().turns.some(t => t.text === f.context.source.text)).toBe(true);
        expect((await f.interpret(f.accepted.operation.id)).body.operation.status).toBe('unresolved');
        expect(f.propose).toHaveBeenCalledTimes(1);
    });
    it('rejects guided, topic, mode, review and confirmation mutations until explicit discard', async () => {
        const f = await pendingFixture(), current = (await f.status(f.accepted.operation.id)).body.session;
        for (const [path, body] of [
            ['/api/clinic/topics', { expectedRevision: current.revision, topicId: 'Q04' }],
            ['/api/clinic/review', { expectedRevision: current.revision }],
            ['/api/clinic/confirm', { expectedRevision: current.revision, digest: 'a'.repeat(64) }],
            ['/api/clinic/conversation-mode', { expectedRevision: current.revision, mode: 'guided' }],
            ['/api/clinic/turns', { requestId: crypto.randomUUID(), expectedRevision: current.revision, promptId: current.currentPrompt!.id, action: 'unknown' }],
        ] as const) expect((await f.request(path, body)).status).toBe(409);
        expect((await f.request('/api/clinic/leave', {})).status).toBe(200);
        await f.request('/api/clinic/confirm-identity', { confirmed: true });
        f.done.resolve(good(f.context)); await f.interpreting;
    });
    it('discards a late result after a guided correction and preserves the provider receipt without overwriting answers', async () => {
        const f = await pendingFixture(); const current = (await f.status(f.accepted.operation.id)).body.session;
        const stopped = await f.request<AdaptiveTurnResult>(`/api/clinic/adaptive-turns/${f.accepted.operation.id}/discard`, { expectedRevision: current.revision });
        const guided = await f.request('/api/clinic/conversation-mode', { expectedRevision: stopped.body.session.revision, mode: 'guided' });
        const answer = await f.request('/api/clinic/turns', { requestId: crypto.randomUUID(), expectedRevision: guided.body.revision, promptId: guided.body.currentPrompt!.id, action: 'answer', text: 'Different explicit guided answer.' });
        f.done.resolve(good(f.context));
        const late = await f.interpreting;
        expect(late.body.operation.status).toBe('discarded');
        expect(late.body.session.revision).toBe(answer.body.revision);
        expect(f.draft().topics.Q01.answers.reason).toMatchObject({ value: 'Different explicit guided answer.' });
        expect(f.draft().adaptive!.operations[f.accepted.operation.id].receipt?.requestId).toBe('provider-1');
    });
    it('cannot alter a partial confirmation after discard and late completion', async () => {
        const f = await pendingFixture(), current = (await f.status(f.accepted.operation.id)).body.session;
        const stopped = await f.request<AdaptiveTurnResult>(`/api/clinic/adaptive-turns/${f.accepted.operation.id}/discard`, { expectedRevision: current.revision });
        const review = await f.request<ReviewPreview>('/api/clinic/review', { expectedRevision: stopped.body.session.revision });
        expect(review.status).toBe(200);
        expect(review.body.session.completeness).toBe('partial');
        expect(f.draft().preview!.topics.some(t => t.id === 'interpretation')).toBe(true);
        const confirmed = await f.request('/api/clinic/confirm', { expectedRevision: review.body.session.revision, digest: review.body.digest });
        expect(confirmed.status).toBe(200);
        const frozen = structuredClone(f.draft().confirmed);
        f.done.resolve(good(f.context)); await f.interpreting;
        expect(f.draft().confirmed).toEqual(frozen);
        expect(f.draft().phase).toBe('confirmed');
        expect(f.draft().topics.Q01).toBeUndefined();
    });
    it('replays old acceptance without erasing a newer operation or dialogue', async () => {
        const f = fixture(), session = await f.boot(), requestId = crypto.randomUUID();
        const first = await f.accept(session.revision, 'More energy.', requestId);
        const applied = await f.interpret(first.body.operation.id);
        const second = await f.accept(applied.body.session.revision, 'A later statement.');
        const replay = await f.accept(session.revision, 'More energy.', requestId);
        expect(replay.body.operation.id).toBe(first.body.operation.id);
        expect(replay.body.operation.status).toBe('applied');
        expect(replay.body.session.adaptive?.operation?.id).toBe(second.body.operation.id);
        expect(replay.body.session.revision).toBe(second.body.session.revision);
    });
    it('preserves failed proposals and timeout uncertainty without model retry', async () => {
        const invalid = fixture({ propose: vi.fn(async () => { throw new AdaptiveProposalFailure('invalid-adaptive-json', { requestId: 'failed-json', model: 'test-only' }); }) });
        const a = await invalid.accept((await invalid.boot()).revision);
        expect((await invalid.interpret(a.body.operation.id)).body.operation.status).toBe('failed');
        expect(invalid.draft().adaptive!.operations[a.body.operation.id].receipt?.requestId).toBe('failed-json');
        const timeout = fixture({ propose: vi.fn(async () => new Promise(() => undefined)) }, { timeoutMs: 5 });
        const b = await timeout.accept((await timeout.boot()).revision);
        expect((await timeout.interpret(b.body.operation.id)).body.operation.status).toBe('unresolved');
        await timeout.interpret(b.body.operation.id);
        expect(timeout.proposer.propose).toHaveBeenCalledTimes(1);
    });
    it('saves safety wording/help before inference, even at a numeric detail', async () => {
        const f = fixture(), session = await f.boot();
        const selected = await f.request('/api/clinic/topics', { expectedRevision: session.revision, topicId: 'Q04' });
        const text = 'My belly pain is severe and I fainted.';
        const accepted = await f.accept(selected.body.revision, text);
        expect(accepted.body.operation.status).toBe('failed');
        expect(accepted.body.session.notice?.tone).toBe('urgent');
        expect(accepted.body.session.currentPrompt).toBeUndefined();
        expect(f.draft().turns.at(-1)?.text).toBe(text);
        await f.interpret(accepted.body.operation.id);
        expect(f.proposer.propose).not.toHaveBeenCalled();
        expect(f.draft().topics.Q04.answers['height.value']).toBeUndefined();
    });
    it('does not accept another session operation, forged server bindings or cross-origin actions', async () => {
        const f = fixture(), session = await f.boot(), a = await f.accept(session.revision), firstCookie = f.cookie();
        await f.boot('billing');
        expect((await f.status(a.body.operation.id)).status).toBe(404);
        expect((await f.request('/api/clinic/adaptive-turns', { requestId: crypto.randomUUID(), expectedRevision: 0, text: 'Hi', channel: 'text', patient: 'Patient/other', model: 'other' })).status).toBe(400);
        expect((await f.raw(new Request(`${origin}/api/clinic/adaptive-turns`, { method: 'POST', headers: { origin: 'https://other.test', cookie: f.cookie(), 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: crypto.randomUUID(), expectedRevision: 0, text: 'Hi', channel: 'text' }) }))).status).toBe(403);
        const other = fixture();
        expect((await other.request('/api/clinic/adaptive-turns', { requestId: crypto.randomUUID(), expectedRevision: 0, text: 'Hi', channel: 'text' }, firstCookie)).status).toBe(404);
    });
    it('preserves the displayed topic when switching to guided before moving on', async () => {
        const f = fixture({ propose: vi.fn(async ctx => ({ proposal: proposal([], { acts: [{ kind: 'topic-switch', targetTopicId: 'Q04', evidence: evidence(ctx, ctx.source.text) }], next: { topicId: 'Q04', promptId: 'Q04', targetPaths: ['height.value'] } }) })) }), initial = await f.boot();
        const accepted = await f.accept(initial.revision, 'I would rather talk about height and weight first.'), applied = await f.interpret(accepted.body.operation.id);
        expect(applied.body.session.currentPrompt?.topicId).toBe('Q04');
        expect(f.draft().activeTopic).toBeUndefined();
        const guided = await f.request('/api/clinic/conversation-mode', { expectedRevision: applied.body.session.revision, mode: 'guided' });
        expect(guided.body.currentPrompt?.id).toBe('Q04:height.value');
        const moved = await f.request('/api/clinic/turns', { requestId: crypto.randomUUID(), expectedRevision: guided.body.revision, promptId: guided.body.currentPrompt!.id, action: 'move-on' });
        expect(moved.status).toBe(200);
        expect(f.draft().topics.Q04.stopped).toBe('patient-moves-on');
        expect(f.draft().topics.Q01?.stopped).toBeUndefined();
    });
    it('keeps frozen PHQ responses in exact guided controls, then resumes adaptive dialogue', async () => {
        const f = fixture(), session = await f.boot();
        const selected = await f.request('/api/clinic/topics', { expectedRevision: session.revision, topicId: 'Q16', slotPath: 'MH01' });
        expect(selected.body.currentPrompt?.mode).toBe('guided');
        expect(selected.body.currentPrompt?.text).toContain('Over the last 2 weeks');
        expect(selected.body.currentPrompt?.choices).toHaveLength(4);
        const answered = await f.request('/api/clinic/turns', { requestId: crypto.randomUUID(), expectedRevision: selected.body.revision, promptId: selected.body.currentPrompt!.id, action: 'answer', text: '2' });
        expect(answered.status).toBe(200);
        expect(f.draft().topics.Q16.answers.MH01).toMatchObject({ value: 2 });
        const natural = await f.request('/api/clinic/conversation-mode', { expectedRevision: answered.body.revision, mode: 'adaptive' });
        expect(natural.status).toBe(200); expect(f.proposer.propose).not.toHaveBeenCalled();
    });
    it('runs each frozen instrument item through guided controls inside an adaptive session', async () => {
        const f = fixture(); let session = await f.boot();
        for (const path of ['depressionHistory', 'anxietyHistory', 'currentCare']) {
            session = (await f.request('/api/clinic/topics', { expectedRevision: session.revision, topicId: 'Q16', slotPath: path })).body;
            session = (await f.request('/api/clinic/turns', { requestId: crypto.randomUUID(), expectedRevision: session.revision, promptId: session.currentPrompt!.id, action: 'unknown' })).body;
        }
        session = (await f.request('/api/clinic/conversation-mode', { expectedRevision: session.revision, mode: 'adaptive' })).body;
        session = (await f.request('/api/clinic/topics', { expectedRevision: session.revision, topicId: 'Q16' })).body;
        for (const id of ['MH01', 'MH02', 'MH03', 'MH04']) {
            expect(session.adaptive?.mode).toBe('adaptive');
            expect(session.currentPrompt).toMatchObject({ id: `Q16:${id}`, mode: 'guided' });
            expect(session.currentPrompt!.choices).toHaveLength(4);
            const answer = await f.request('/api/clinic/turns', { requestId: crypto.randomUUID(), expectedRevision: session.revision, promptId: session.currentPrompt!.id, action: 'answer', text: '0' });
            expect(answer.status).toBe(200); session = answer.body;
        }
        expect(session.topics.find(t => t.id === 'Q16')?.screening).toMatchObject({ status: 'complete', scores: { gad2: 0, phq2: 0, phq4: 0 }, clinicalClearance: false });
        expect(session.currentPrompt?.mode).toBe('adaptive');
        expect(f.proposer.propose).not.toHaveBeenCalled();
    });
    it('visibly distinguishes applied details with unresolved interpretation and preserves the raw source in preview', async () => {
        const f = fixture({ propose: vi.fn(async ctx => ({ proposal: proposal([fact(ctx, 'Q01', 'reason', 'More energy')], { acts: [{ kind: 'unclear', evidence: [{ sourceId: ctx.source.id, start: 13, end: ctx.source.text.length }] }] }) })) });
        const a = await f.accept((await f.boot()).revision, 'More energy; other things are hard to explain.');
        const result = await f.interpret(a.body.operation.id);
        expect(result.body.operation.status).toBe('applied'); expect(result.body.operation.hasUnresolvedInterpretation).toBe(true);
        expect(result.body.session.adaptive?.unresolvedSources).toHaveLength(1);
        expect(result.body.session.topics.find(t => t.id === 'Q01')?.answer?.text).toContain('More energy');
        const review = await f.request<ReviewPreview>('/api/clinic/review', { expectedRevision: result.body.session.revision });
        expect(review.status).toBe(200);
        expect(f.draft().preview!.confirmation.submission.sources[0].text).toBe('More energy; other things are hard to explain.');
    });
    it('persists omitted question spans and the bounded reply alongside accepted facts', async () => {
        const f = fixture({ propose: vi.fn(async ctx => ({ proposal: proposal([fact(ctx, 'Q01', 'reason', 'More energy')]) })) });
        const accepted = await f.accept((await f.boot()).revision, 'More energy. Should I double my dose?');
        const result = await f.interpret(accepted.body.operation.id);
        expect(result.body.operation.status).toBe('applied');
        expect(result.body.operation.hasUnresolvedInterpretation).toBe(true);
        const saved = f.draft().adaptive!.operations[accepted.body.operation.id];
        expect(saved.unresolvedQuestions?.length).toBeGreaterThan(0);
        expect(saved.unresolvedQuestions!.every(span => span.sourceId === accepted.body.operation.sourceId)).toBe(true);
        expect(result.body.session.adaptive?.reply?.id).toBe('COPY-05');
        expect(result.body.session.adaptive?.unresolvedSources).toHaveLength(1);
    });
    it('detects changed source/snapshot binding before applying a late proposal', async () => {
        const f = await pendingFixture();
        const [id, resource] = [...f.records.entries()][0];
        const draft = decodeDocument<Draft>(resource);
        draft.turns.find(t => t.id === f.context.source.id)!.text = 'Changed outside this operation';
        f.records.set(id, { ...document('urn:corvo:clinic:draft', draft.id, draft.patient, draft), id, meta: resource.meta });
        f.done.resolve(good(f.context));
        expect((await f.interpreting).body.operation.status).toBe('discarded');
        expect(f.draft().topics.Q01).toBeUndefined();
    });
    it('keeps a rich late-intake context intact and bounded while permitting one adaptive attempt', async () => {
        const f = fixture(); let session = await f.boot();
        session = (await f.request('/api/clinic/conversation-mode', { expectedRevision: session.revision, mode: 'guided' })).body;
        for (let n = 0; n < 40 && session.currentPrompt; n++) {
            const p = session.currentPrompt;
            const text = p.choices?.find(c => c.value === '__negative')?.value ?? p.choices?.find(c => c.value === '__done')?.value ?? p.choices?.[0].value ?? (p.id === 'Q04:height.value' ? '172' : p.id === 'Q04:lastMeasuredWeight.value' ? '82' : 'I remember this pattern during this part of my life. '.repeat(10));
            const answer = await f.request('/api/clinic/turns', { requestId: crypto.randomUUID(), expectedRevision: session.revision, promptId: p.id, action: 'answer', text });
            expect(answer.status).toBe(200); session = answer.body;
        }
        session = (await f.request('/api/clinic/conversation-mode', { expectedRevision: session.revision, mode: 'adaptive' })).body;
        const accepted = await f.accept(session.revision, 'I want to add another detail about the routine I described.');
        expect(accepted.status).toBe(202);
        const result = await f.interpret(accepted.body.operation.id);
        expect(result.body.operation.status).toBe('applied');
        expect(f.proposer.propose).toHaveBeenCalledTimes(1);
        const context = vi.mocked(f.proposer.propose).mock.calls[0][0], messages = buildAdaptiveMessages(context);
        expect(messages.every(message => message.content.length <= 32000)).toBe(true);
        expect(messages.reduce((sum, message) => sum + new TextEncoder().encode(message.content).length, 0)).toBeLessThanOrEqual(60000);
        const payloads = messages.slice(1).map(message => JSON.parse(message.content));
        expect(payloads[0].source.text).toBe('I want to add another detail about the routine I described.');
        const facts = payloads.find(payload => payload.currentFacts).currentFacts;
        for (const [topicId, response] of Object.entries(context.responses)) for (const [path, answer] of Object.entries(response?.answers ?? {})) {
            expect(facts[topicId].answers[path][0]).toBe(answer?.state);
            if (answer?.state === 'known' && answer.value !== undefined) expect(facts[topicId].answers[path][1]).toEqual(answer.value);
            expect(facts[topicId].answers[path][2]).toEqual(answer?.sourceIds ?? []);
        }
        expect(result.body.session.adaptive?.guidedFallbackAvailable).toBe(true);
        expect(f.draft().turns.at(-1)?.text).toBe('I want to add another detail about the routine I described.');
    });
    it.each([
        ['first-intake', 'Q01', 'reason', 'priority'],
        ['pre-visit', 'W02', 'changes', 'priority'],
        ['non-visit', 'W03', 'reason', 'help'],
        ['post-visit', 'W04', 'difficulty', 'help'],
        ['billing', 'W05', 'reference', 'help'],
        ['scheduling', 'W06', 'timing', 'help'],
        ['refill', 'W07', 'medicine', 'directions'],
    ])('persists multifield facts and scenario-scoped dialogue for %s', async (scenario, topic, first, second) => {
        const firstText = scenario === 'refill' ? 'Semaglutide' : 'First supplied detail';
        const secondText = scenario === 'refill' ? 'once weekly' : 'Second supplied detail';
        const text = scenario === 'refill' ? 'Semaglutide. The label says once weekly.' : 'First supplied detail. Second supplied detail.';
        const f = fixture({ propose: vi.fn(async ctx => ({ proposal: proposal([fact(ctx, topic, first, firstText), fact(ctx, topic, second, secondText)]) })) });
        const session = await f.boot(scenario);
        const accepted = await f.accept(session.revision, text);
        const result = await f.interpret(accepted.body.operation.id);
        expect(result.body.operation.status).toBe('applied');
        expect(result.body.operation.updates?.map(update => update.path)).toEqual([first, second]);
        if (scenario !== 'first-intake') expect(result.body.session.topics.map(t => t.id)).toEqual([topic]);
        const review = await f.request<ReviewPreview>('/api/clinic/review', { expectedRevision: result.body.session.revision });
        expect(review.status).toBe(200);
        expect(f.draft().preview!.confirmation.submission.sources[0].text).toBe(text);
    });
    it('shows guided availability when no proposer is configured', async () => {
        const f = fixture(undefined, { available: false }), session = await f.boot();
        expect(session.adaptive).toMatchObject({ available: false, mode: 'guided', guidedFallbackAvailable: true });
        expect(session.currentPrompt?.mode).toBe('guided');
        expect((await f.accept(session.revision)).status).toBe(409);
        const [id, resource] = [...f.records.entries()][0], oldAdaptive = decodeDocument<Draft>(resource);
        oldAdaptive.adaptive!.mode = 'adaptive';
        f.records.set(id, { ...document('urn:corvo:clinic:draft', oldAdaptive.id, oldAdaptive.patient, oldAdaptive), id, meta: resource.meta });
        const guided = await f.request('/api/clinic/turns', { requestId: crypto.randomUUID(), expectedRevision: session.revision, promptId: session.currentPrompt!.id, action: 'answer', text: 'Guided answer after provider was disabled.' });
        expect(guided.status).toBe(200);
        expect(f.draft().adaptive!.mode).toBe('guided');
        expect((await f.request('/api/clinic/conversation-mode', { expectedRevision: guided.body.revision, mode: 'adaptive' })).status).toBe(409);
    });
});
