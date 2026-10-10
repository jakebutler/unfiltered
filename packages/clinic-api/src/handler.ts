import { z } from 'zod';
import { canonicalJson, ClinicalError } from '../../clinical-core/src/domain.js';
import { ContentConfigurationError } from '../../clinic-content/src/types.js';
import type { Fetch } from '../../clinical-core/src/transport.js';
import type { ScenarioId, TurnInput } from '../../clinic-contract/src/index.js';
import { cookies, type PatientClaims } from './cookies.js';
import { staffAuthentication } from './auth.js';
import { conversation, scenarioTitles } from './conversation.js';
import { handoffs } from './handoffs.js';
import { runtimeProvider, type Runtime } from './runtime.js';
import { createDraft, readDraft, saveDraft } from './store.js';
import { ApiFailure, type ClinicApiConfig, type Draft, type StoredDraft } from './types.js';
const revision = z.number().int().nonnegative();
const schemas = {
    sessions: z.object({ scenario: z.enum(['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill']), syntheticAcknowledged: z.literal(true) }).strict(),
    identity: z.object({ confirmed: z.literal(true) }).strict(),
    turns: z.object({ requestId: z.string().uuid(), expectedRevision: revision, promptId: z.string().min(1).max(300), action: z.enum(['answer', 'unknown', 'decline', 'move-on']), text: z.string().max(8000).optional(), fields: z.record(z.string().max(8000)).refine(x => Object.keys(x).length <= 8).optional() }).strict(),
    topics: z.object({ expectedRevision: revision, topicId: z.string().min(1).max(40), slotPath: z.string().max(300).optional() }).strict(),
    review: z.object({ expectedRevision: revision }).strict(),
    confirm: z.object({ expectedRevision: revision, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    empty: z.object({}).strict(),
    login: z.object({ email: z.string().email().max(254), password: z.string().min(1).max(500) }).strict(),
    action: z.object({ workId: z.string().max(64), expectedVersion: z.number().int().positive(), expectedWorkVersion: z.string().min(1).max(100), outcome: z.enum(['reviewed', 'needs-information', 'declined', 'resolved']), note: z.string().min(1).max(4000) }).strict(),
};
async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> { if (!request.headers.get('content-type')?.startsWith('application/json'))
    throw new ApiFailure('json-required', 415); if (Number(request.headers.get('content-length')) > 20000)
    throw new ApiFailure('request-too-large', 413); const reader = request.body?.getReader(); let bytes = 0; const chunks: Uint8Array[] = []; if (reader) {
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done)
                break;
            bytes += value.byteLength;
            if (bytes > 20000)
                throw new ApiFailure('request-too-large', 413);
            chunks.push(value);
        }
    }
    finally {
        await reader.cancel().catch(() => undefined);
    }
} const all = new Uint8Array(bytes); let index = 0; for (const c of chunks) {
    all.set(c, index);
    index += c.length;
} try {
    const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(all)));
    if (!parsed.success)
        throw new Error();
    return parsed.data;
}
catch {
    throw new ApiFailure('invalid-request');
} }
function reply(value: unknown, status = 200, cookie?: string) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...(cookie ? { 'Set-Cookie': cookie } : {}) } }); }
export function createClinicHandler(config: ClinicApiConfig, options: {
    fetcher?: Fetch;
    runtime?: () => Promise<Runtime>;
} = {}) {
    const origin = new URL(config.origin).origin;
    if (origin !== config.origin)
        throw new Error('clinic-origin-must-be-origin');
    const fetcher = options.fetcher ?? fetch, jar = cookies(config.cookieSecret, origin.startsWith('https:')), staff = staffAuthentication(config, fetcher, jar), runtime = options.runtime ?? runtimeProvider(config, fetcher), content = conversation(config), handoff = handoffs(config);
    const rate = new Map<string, {
        at: number;
        count: number;
    }>();
    function limit(key: string, max: number) { const now = Date.now(); if (rate.size > 200)
        for (const [k, v] of rate)
            if (now - v.at > 60000)
                rate.delete(k); const r = rate.get(key); if (!r || now - r.at > 60000) {
        rate.set(key, { at: now, count: 1 });
        return;
    } if (++r.count > max)
        throw new ApiFailure('try-again-later', 429, true); }
    async function claims(request: Request, confirmed = true) { const c = await jar.read(request, 'clinic_patient'); if (c.kind !== 'patient' || !Object.hasOwn(config.patients, c.scenario) || config.patients[c.scenario as ScenarioId].reference !== c.patient)
        throw new ApiFailure('session-scope-denied', 403); if (confirmed && !c.identityConfirmed)
        throw new ApiFailure('identity-confirmation-required', 403); return c; }
    async function patient(request: Request, confirmed = true) { const c = await claims(request, confirmed), r = await runtime(), stored = await readDraft(r.client, c.sessionId, c.patient); if (stored.draft.scenario !== c.scenario)
        throw new ApiFailure('session-scope-denied', 403); return { claims: c, r, stored }; }
    const checkRevision = (d: Draft, value: number) => { if (d.revision !== value)
        throw new ApiFailure('stale-session', 409, true); };
    async function persist(r: Runtime, previous: StoredDraft, next: Draft) { next.revision = previous.draft.revision + 1; next.savedAt = new Date().toISOString(); return (await saveDraft(r.client, previous, next)).draft; }
    async function refreshed(r: Runtime, stored: StoredDraft) { const d = stored.draft; if (!d.confirmed && !d.prior)
        return d; const delivery = d.confirmed ? await handoff.delivery(r.client, d) : undefined; const previousDelivery = d.prior ? await handoff.previousDelivery(r.client, d) : undefined; if (canonicalJson(d.delivery) === canonicalJson(delivery) && canonicalJson(d.previousDelivery) === canonicalJson(previousDelivery))
        return d; const next = { ...d, delivery, previousDelivery }; return (await saveDraft(r.client, stored, next)).draft; }
    return async (request: Request): Promise<Response> => {
        try {
            const url = new URL(request.url), path = url.pathname;
            if (url.search && (path !== '/api/staff/queue' || request.method !== 'GET' || [...url.searchParams.keys()].some(key => key !== 'cursor') || url.searchParams.getAll('cursor').length !== 1))
                throw new ApiFailure('unexpected-query');
            if (!['GET', 'POST'].includes(request.method))
                throw new ApiFailure('method-not-allowed', 405);
            const suppliedOrigin = request.headers.get('origin');
            if ((request.method === 'POST' && suppliedOrigin !== origin) || (suppliedOrigin && suppliedOrigin !== origin))
                throw new ApiFailure('origin-denied', 403);
            if (path === '/api/clinic/config' && request.method === 'GET')
                return reply({ clinicName: 'Corvo Clinic', syntheticOnly: true, scenarios: Object.entries(scenarioTitles).map(([id, title]) => ({ id, title, description: content.register.scenarios[id as ScenarioId].patientSummary })), conversation: { mode: 'guided', explanation: 'Guided questions record your explicit answers. Adaptive conversation is not active in this local build.' }, voice: { available: false, explanation: 'Voice is not available in this local build. Continue by typing.' } });
            if (path === '/api/clinic/sessions' && request.method === 'POST') {
                const input = await body(request, schemas.sessions);
                limit('create', 30);
                const r = await runtime();
                let d: Draft | undefined;
                try {
                    const old = await claims(request, false);
                    if (old.scenario === input.scenario)
                        d = (await readDraft(r.client, old.sessionId, old.patient)).draft;
                }
                catch (error) {
                    if (!(error instanceof ApiFailure) || !['session-required', 'session-not-found', 'session-expired'].includes(error.code))
                        throw error;
                }
                if (!d) {
                    const now = new Date().toISOString();
                    d = { schema: 1, id: crypto.randomUUID(), patient: config.patients[input.scenario].reference, scenario: input.scenario, revision: 0, savedAt: now, createdAt: now, phase: 'conversation', turns: [], topics: {}, requests: {}, version: 1 };
                    d = (await createDraft(r.client, d)).draft;
                }
                const c: PatientClaims = { kind: 'patient', sessionId: d.id, patient: d.patient, scenario: d.scenario, identityConfirmed: false, expires: Date.now() + 30 * 86400000 };
                return reply(content.view(d, false), 201, await jar.issue('clinic_patient', c));
            }
            if (path === '/api/clinic/session' && request.method === 'GET') {
                const p = await patient(request, false);
                return reply(content.view(p.stored.draft, false), 200, await jar.issue('clinic_patient', { ...p.claims, identityConfirmed: false }));
            }
            if (path === '/api/clinic/confirm-identity' && request.method === 'POST') {
                await body(request, schemas.identity);
                const p = await patient(request, false);
                return reply(content.view(await refreshed(p.r, p.stored)), 200, await jar.issue('clinic_patient', { ...p.claims, identityConfirmed: true }));
            }
            if (path === '/api/clinic/reject-identity' && request.method === 'POST') {
                await body(request, schemas.empty);
                return reply({ cleared: true }, 200, jar.clear('clinic_patient'));
            }
            if (path === '/api/clinic/leave' && request.method === 'POST') {
                await body(request, schemas.empty);
                const p = await patient(request);
                return reply({ savedAt: p.stored.draft.savedAt }, 200, await jar.issue('clinic_patient', { ...p.claims, identityConfirmed: false }));
            }
            if (path === '/api/clinic/turns' && request.method === 'POST') {
                const input = await body(request, schemas.turns), p = await patient(request), d = p.stored.draft;
                const fingerprint = canonicalJson(input), prior = d.requests[input.requestId];
                if (prior) {
                    if (prior.fingerprint !== fingerprint)
                        throw new ApiFailure('request-id-conflict', 409);
                    return reply(content.view(d));
                }
                checkRevision(d, input.expectedRevision);
                if (d.phase === 'confirmed')
                    throw new ApiFailure('choose-detail-to-amend', 409);
                if (Object.keys(d.requests).length >= 550)
                    throw new ApiFailure('session-turn-limit', 413);
                const next = content.turn(d, input as TurnInput);
                next.requests[input.requestId] = { fingerprint, revision: d.revision + 1 };
                return reply(content.view(await persist(p.r, p.stored, next)));
            }
            if (path === '/api/clinic/topics' && request.method === 'POST') {
                const input = await body(request, schemas.topics), p = await patient(request);
                checkRevision(p.stored.draft, input.expectedRevision);
                if (p.stored.draft.confirmed)
                    await handoff.snapshot(p.r.client, p.stored.draft);
                return reply(content.view(await persist(p.r, p.stored, content.select(p.stored.draft, input.topicId, input.slotPath))));
            }
            if (path === '/api/clinic/review' && request.method === 'POST') {
                const input = await body(request, schemas.review), p = await patient(request), d = p.stored.draft;
                checkRevision(d, input.expectedRevision);
                if (d.confirmed)
                    throw new ApiFailure('already-confirmed', 409);
                if (d.preview && d.phase === 'review')
                    return reply({ session: content.view(d), digest: d.preview.digest, confirmationText: 'I reviewed these answers and want to send this version to my care team.' });
                const preview = await content.preview(d);
                const next = await persist(p.r, p.stored, { ...d, phase: 'review', preview });
                return reply({ session: content.view(next), digest: preview.digest, confirmationText: next.preview?.confirmation.submission.completeness === 'complete' ? 'I reviewed these answers and want to send this complete intake to my care team.' : 'I reviewed these answers and want to send this partial handoff, including the visible gaps, to my care team.' });
            }
            if (path === '/api/clinic/confirm' && request.method === 'POST') {
                const input = await body(request, schemas.confirm), p = await patient(request), d = p.stored.draft;
                if (d.confirmed) {
                    if (input.digest !== (d.confirmed.previewDigest ?? d.confirmed.digest))
                        throw new ApiFailure('confirmation-digest-mismatch', 409);
                    await handoff.snapshot(p.r.client, d);
                    await p.r.client.deliver(d.confirmed.confirmation, p.r.qualification);
                    return reply(content.view(await refreshed(p.r, p.stored)));
                }
                checkRevision(d, input.expectedRevision);
                if (!d.preview || d.preview.digest !== input.digest || d.phase !== 'review')
                    throw new ApiFailure('confirmation-digest-mismatch', 409);
                const confirmed = await content.finalize(d);
                let next = await persist(p.r, p.stored, { ...d, phase: 'confirmed', confirmed, preview: undefined, delivery: { state: 'pending', reference: `${d.id}.v${d.version}`, version: d.version, work: [] } });
                await handoff.snapshot(p.r.client, next);
                const result = await p.r.client.deliver(next.confirmed!.confirmation, p.r.qualification);
                const stored = await readDraft(p.r.client, next.id, next.patient);
                next = stored.draft;
                next.delivery = await handoff.delivery(p.r.client, next);
                if (result.receipt.state === 'unknown' || result.write === 'outcome-unknown' && next.delivery.state === 'pending') {
                    next.delivery.state = 'unknown';
                    next.delivery.canRetryDelivery = false;
                }
                next = (await saveDraft(p.r.client, stored, next)).draft;
                return reply(content.view(next));
            }
            if (path === '/api/clinic/retry-delivery' && request.method === 'POST') {
                await body(request, schemas.empty);
                const p = await patient(request), d = p.stored.draft;
                if (!d.confirmed)
                    throw new ApiFailure('confirmation-required', 409);
                const check = await p.r.client.check(d.confirmed.confirmation);
                if (check.state !== 'absent')
                    throw new ApiFailure('delivery-retry-not-permitted', 409, true);
                await handoff.snapshot(p.r.client, d);
                await p.r.client.deliver(d.confirmed.confirmation, p.r.qualification);
                return reply(content.view(await refreshed(p.r, p.stored)));
            }
            if (path === '/api/clinic/receipt' && request.method === 'GET') {
                const p = await patient(request);
                return reply(content.view(await refreshed(p.r, p.stored)));
            }
            if (path === '/api/staff/login' && request.method === 'POST') {
                const input = await body(request, schemas.login);
                limit('login', 10);
                const result = await staff.login(input.email, input.password);
                return reply(result.identity, 200, result.cookie);
            }
            if (path === '/api/staff/logout' && request.method === 'POST') {
                await body(request, schemas.empty);
                return reply({ loggedOut: true }, 200, await staff.logout(request));
            }
            if (path === '/api/staff/me' && request.method === 'GET') {
                const s = await staff.read(request);
                return reply({ name: s.assignment.name, role: s.assignment.role });
            }
            if (path === '/api/staff/queue' && request.method === 'GET') {
                const cursor = url.searchParams.get('cursor') ?? undefined;
                if (cursor !== undefined && (!/^(0|[1-9]\d{0,5})$/.test(cursor) || Number(cursor) > 100000 || Number(cursor) % 5 !== 0))
                    throw new ApiFailure('invalid-queue-cursor');
                const s = await staff.read(request);
                if (!s.assignment.patients.length || !s.assignment.careTeams.length)
                    return reply({ items: [] });
                const r = await runtime();
                return reply(await handoff.queue(r.client, s.client, s.assignment, cursor));
            }
            const match = path.match(/^\/api\/staff\/handoffs\/([a-f0-9-]+\.v[1-9]\d*)(\/actions)?$/);
            if (match) {
                const s = await staff.read(request), r = await runtime();
                if (request.method === 'GET' && !match[2])
                    return reply(await handoff.view(r.client, s.client, s.assignment, match[1]));
                if (request.method === 'POST' && match[2])
                    return reply(await handoff.action(r.client, s.client, s.assignment, match[1], await body(request, schemas.action)));
            }
            throw new ApiFailure('not-found', 404);
        }
        catch (error) {
            let failure: ApiFailure;
            if (error instanceof ApiFailure)
                failure = error;
            else if (error instanceof ContentConfigurationError)
                failure = new ApiFailure(error.code, 400);
            else if (error instanceof ClinicalError)
                failure = new ApiFailure(error.code.includes('denied') ? error.code : 'invalid-clinical-state', error.code.includes('denied') ? 403 : 409);
            else
                failure = new ApiFailure('service-unavailable', 503, true);
            return reply({ error: { code: failure.code, message: messages[failure.code] ?? 'This action could not be completed. Your saved answers have not been discarded.', retryable: failure.retryable } }, failure.status);
        }
    };
}
const messages: Record<string, string> = { 'session-required': 'Open a synthetic clinic session to continue.', 'identity-confirmation-required': 'Confirm the displayed synthetic persona before opening saved answers.', 'origin-denied': 'This request did not come from this clinic.', 'stale-session': 'These answers changed in another window. Reload the saved session before continuing.', 'stale-work': 'This work changed since you opened it. Reload before recording an outcome.', 'save-outcome-unknown': 'The save result is not known yet. Check the saved session before retrying.', 'confirmation-digest-mismatch': 'The answers changed since this preview. Review the current version before sending.', 'staff-login-failed': 'The staff sign-in could not be verified. Check the credentials and try again.', 'action-outcome-unknown': 'The staff action result is not known yet. Reload this work to check its actual status.' };
