import { scenarioIds } from '../../clinic-content/src/workflows.js';
import { requireFinalRepresentationAuthority } from './final-representation.js';
import { validateRepresentationDigests } from '../../clinical-core/src/representation-review.js';
import { z } from 'zod';
import { canonicalJson, digest, ClinicalError } from '../../clinical-core/src/domain.js';
import { ContentConfigurationError } from '../../clinic-content/src/types.js';
import type { Fetch } from '../../clinical-core/src/transport.js';
import { sourceChannels, type ScenarioId, type TurnInput } from '../../clinic-contract/src/index.js';
import { cookies, type PatientClaims } from './cookies.js';
import { staffAuthentication } from './auth.js';
import { conversation, scenarioTitles } from './conversation.js';
import { handoffs } from './handoffs.js';
import { runtimeProvider, type Runtime } from './runtime.js';
import { createDraft, readDraft, saveDraft, queueOffset } from './store.js';
import { ApiFailure, type ClinicApiConfig, type Draft, type StoredDraft } from './types.js';
import { adaptiveSession, operationView, requireNoPendingInterpretation, type AdaptiveDraftStore } from './adaptive-session.js';
import { trackDirectAdaptiveEdits, type AdaptiveStreamProposer } from './adaptive-stream-session.js';
import type { AdaptiveProposer } from './adaptive.js';
import type { GroupedExtractionProposer } from './adaptive-extraction-grouped-session-v2.js';
import type { IngressAdmission } from './ingress-admission.js';
import { applyGateOutcome, safetyActionOutcomes, safetyReviews, staffSafety, type SafetyReviewer } from './safety-review.js';
import { createRequestTiming, finishRequest, requestIdFrom, routeName, type RequestTiming } from './request-timing.js';
const revision = z.number().int().nonnegative();
const schemas = {
    sessions: z.object({ scenario: z.enum(scenarioIds), syntheticAcknowledged: z.literal(true) }).strict(),
    identity: z.object({ confirmed: z.literal(true) }).strict(),
    turns: z.object({ requestId: z.string().uuid(), expectedRevision: revision, promptId: z.string().min(1).max(300), action: z.enum(['answer', 'unknown', 'decline', 'move-on']), text: z.string().max(8000).optional(), fields: z.record(z.string().max(8000)).refine(x => Object.keys(x).length <= 8).optional(), channel: z.enum(sourceChannels).optional(), choiceConfirmation: z.object({ optionTranscript: z.string().min(1).max(8000), confirmationTranscript: z.string().max(8000), confirmationMethod: z.enum(['voice', 'control']) }).strict().optional(), choiceTranscriptOnly: z.literal(true).optional(), priorChoiceTranscript: z.string().min(1).max(8000).optional() }).strict(),
    adaptiveTurn: z.object({ requestId: z.string().uuid(), expectedRevision: revision, text: z.string().min(1).max(8000), channel: z.enum(sourceChannels) }).strict(),
    mode: z.object({ expectedRevision: revision, mode: z.enum(['adaptive', 'guided']) }).strict(),
    topics: z.object({ expectedRevision: revision, topicId: z.string().min(1).max(40), slotPath: z.string().max(300).optional() }).strict(),
    review: z.object({ expectedRevision: revision }).strict(),
    confirm: z.object({ expectedRevision: revision, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    empty: z.object({}).strict(),
    login: z.object({ email: z.string().email().max(254), password: z.string().min(1).max(500) }).strict(),
    safetyReview: z.object({ signalId: z.string().uuid() }).strict(),
    safetyAction: z.object({ actionId: z.string().uuid(), signalId: z.string().uuid().optional(), outcome: z.enum(safetyActionOutcomes), note: z.string().min(1).max(1000) }).strict(),
    action: z.object({ actionId: z.string().uuid(), workId: z.string().max(64), expectedVersion: z.number().int().positive(), expectedWorkVersion: z.string().min(1).max(100), outcome: z.enum(['reviewed', 'needs-information', 'declined', 'resolved']), note: z.string().min(1).max(4000) }).strict(),
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
    adaptiveProposer?: AdaptiveProposer;
    /** Simple single-call intake interpreter (intake-interpreter-v1); takes precedence over adaptiveProposer. */
    adaptiveInterpreter?: import('./intake-interpreter.js').IntakeInterpreter;
    /** Offline staged candidate only; production configuration supplies no stream proposer. */
    adaptiveStreamProposer?: AdaptiveStreamProposer;
    /** Explicit staged injection only; runtime factory supplies none by default. */
    adaptiveGroupedExtractor?: GroupedExtractionProposer;
    adaptiveFullCapture?: boolean;
    /** Trusted offline qualification injection only; never request/draft input. */
    provisionalQualification?: import('./provisional-projection.js').ProvisionalQualification;
    finalRepresentationQualification?: import('./final-representation.js').FinalRepresentationQualification;
    adaptiveNow?: () => number;
    adaptiveTimeoutMs?: number;
    speechEnabled?: boolean;
    /** 'upload' = one-shot recording transcribed on the server. 'direct' = hosted hands-free: the browser streams to
     * Deepgram with a server-minted temporary token, and upload stays available as the fallback. */
    speechInput?: 'stream' | 'upload' | 'direct';
    /** Read-aloud: 'provider' = ElevenLabs via the budgeted output route, 'browser' = the browser's own voice. */
    speechOutput?: 'provider' | 'browser';
    /** Tier-2 safety reviewer. Absent: every tier-1 signal fails closed to clinician review. */
    safetyReviewer?: SafetyReviewer;
    ingress?: IngressAdmission;
} = {}) {
    const origin = new URL(config.origin).origin;
    if (origin !== config.origin)
        throw new Error('clinic-origin-must-be-origin');
    const fetcher = options.fetcher ?? fetch, jar = cookies(config.cookieSecret, origin.startsWith('https:')), staff = staffAuthentication(config, fetcher, jar), runtime = options.runtime ?? runtimeProvider(config, fetcher), content = conversation(config, { provisionalQualification: options.provisionalQualification, finalRepresentationQualification: options.finalRepresentationQualification }), handoff = handoffs(config, { provisionalQualification: options.provisionalQualification, finalRepresentationQualification: options.finalRepresentationQualification });
    const adaptive = adaptiveSession(content, options.adaptiveProposer, { now: options.adaptiveNow, timeoutMs: options.adaptiveTimeoutMs, streamProposer: options.adaptiveStreamProposer, groupedExtractor: options.adaptiveGroupedExtractor, fullCapture: options.adaptiveFullCapture, interpreter: options.adaptiveInterpreter });
    const view = (d: Draft, identity = true) => content.view(d, identity, adaptive.available);
    const safety = safetyReviews({ reviewer: options.safetyReviewer }), staffSafetyApi = staffSafety(reference => Object.values(config.patients).find(fixture => fixture.reference === reference)?.displayName);
    function adaptiveStore(p: { r: Runtime; claims: PatientClaims }, timing?: RequestTiming): AdaptiveDraftStore { const timed = <T>(name: string, fn: () => Promise<T>) => timing ? timing.phase(name, fn) : fn(); return { read: () => readDraft(p.r.client, p.claims.sessionId, p.claims.patient), save: (previous, next) => timed('store', () => saveDraft(p.r.client, previous, next)), safetyGate: (draft, sourceId) => timed('safety', () => safety.gate(p.r.client, draft, sourceId)) }; }
    const adaptiveReply = (result: Awaited<ReturnType<typeof adaptive.accept>>, status = 200) => reply({ session: view(result.draft), operation: operationView(result.operation) }, status);
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
        throw new ApiFailure('session-scope-denied', 403);
        for (const frozen of [stored.draft.preview, stored.draft.confirmed]) if (frozen?.confirmation.submission.representationReview) {
            requireFinalRepresentationAuthority(frozen.confirmation, options.provisionalQualification, options.finalRepresentationQualification);
            await validateRepresentationDigests(frozen.confirmation.submission, frozen.confirmation.representationAuthority);
            if (await digest(frozen.confirmation.submission) !== frozen.confirmation.digest || frozen.confirmation.digest !== frozen.digest) throw new ApiFailure('confirmation-digest-mismatch', 409);
        }
        return { claims: c, r, stored }; }
    const checkRevision = (d: Draft, value: number) => { if (d.revision !== value)
        throw new ApiFailure('stale-session', 409, true); };
    async function persist(r: Runtime, previous: StoredDraft, next: Draft) {
        next = trackDirectAdaptiveEdits(previous.draft, next); next.revision = previous.draft.revision + 1; next.savedAt = new Date().toISOString();
        if (options.adaptiveStreamProposer && Object.values(next.adaptive?.operations ?? {}).some(op => op.status === 'processing')
            && Buffer.byteLength(canonicalJson(next), 'utf8') > 434464) throw new ApiFailure('session-size-limit', 413);
        return (await saveDraft(r.client, previous, next)).draft;
    }
    async function refreshed(r: Runtime, stored: StoredDraft) { const d = stored.draft; if (!d.confirmed && !d.prior) return d; return { ...d, delivery: d.confirmed ? await handoff.delivery(r.client, d) : undefined, previousDelivery: d.prior ? await handoff.previousDelivery(r.client, d) : undefined }; }
    // Every response carries X-Request-Id and Server-Timing, and one structured log line; see request-timing.ts.
    const dispatch = async (request: Request, timing: RequestTiming): Promise<Response> => {
        try {
            const url = new URL(request.url), path = url.pathname;
            if (url.search && (!['/api/staff/queue', '/api/staff/safety'].includes(path) || request.method !== 'GET' || [...url.searchParams.keys()].some(key => !(path === '/api/staff/queue' ? ['cursor', 'recoveryCursor'] : ['cursor']).includes(key)) || ['cursor', 'recoveryCursor'].some(key => url.searchParams.getAll(key).length > 1)))
                throw new ApiFailure('unexpected-query');
            if (!['GET', 'POST'].includes(request.method))
                throw new ApiFailure('method-not-allowed', 405);
            const suppliedOrigin = request.headers.get('origin');
            if ((request.method === 'POST' && suppliedOrigin !== origin) || (suppliedOrigin && suppliedOrigin !== origin))
                throw new ApiFailure('origin-denied', 403);
            if (path === '/api/clinic/config' && request.method === 'GET')
                return reply({ clinicName: 'Corvo Clinic', syntheticOnly: true, scenarios: Object.entries(scenarioTitles).map(([id, title]) => ({ id, title, description: content.register.scenarios[id as ScenarioId].patientSummary })), conversation: { mode: adaptive.available ? 'adaptive' : 'guided', explanation: adaptive.available ? 'Natural answers are saved before interpretation. Guided questions remain available; exact screening responses use guided choices.' : 'Adaptive conversation is unavailable. Guided questions record your explicit answers.' }, voice: options.speechEnabled === true ? { available: true, explanation: options.speechInput === 'upload' ? 'Hold a short recording, then review the words before sending. Questions can be read aloud by your browser. You can keep typing at any time.' : options.speechInput === 'direct' ? 'Talk through the questions hands-free, or dictate one answer and check it. Answer choices stay as buttons. You can keep typing at any time.' : 'Review recognized words before sending. You can keep typing at any time.', input: options.speechInput ?? 'stream', output: options.speechOutput ?? (options.speechInput === 'stream' || options.speechInput === undefined ? 'provider' : 'browser') } : { available: false, explanation: 'Voice is currently unavailable. Continue by typing.' } });
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
                    await options.ingress?.reserve({ kind: 'session-create', attemptId: crypto.randomUUID() });
                    if (request.signal.aborted) throw new ApiFailure('request-aborted', 499, false);
                    const now = new Date().toISOString();
                    d = { schema: 1, id: crypto.randomUUID(), patient: config.patients[input.scenario].reference, scenario: input.scenario, revision: 0, savedAt: now, createdAt: now, phase: 'conversation', turns: [], topics: {}, requests: {}, version: 1 };
                    d = (await createDraft(r.client, adaptive.initialize(d))).draft;
                }
                const c: PatientClaims = { kind: 'patient', sessionId: d.id, patient: d.patient, scenario: d.scenario, identityConfirmed: false, expires: Date.now() + 30 * 86400000 };
                return reply(view(d, false), 201, await jar.issue('clinic_patient', c));
            }
            if (path === '/api/clinic/session' && request.method === 'GET') {
                const p = await patient(request, false);
                return reply(view(p.stored.draft, false), 200, await jar.issue('clinic_patient', { ...p.claims, identityConfirmed: false }));
            }
            if (path === '/api/clinic/confirm-identity' && request.method === 'POST') {
                await body(request, schemas.identity);
                const p = await patient(request, false);
                return reply(view(await refreshed(p.r, p.stored)), 200, await jar.issue('clinic_patient', { ...p.claims, identityConfirmed: true }));
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
            if (path === '/api/clinic/adaptive-turns' && request.method === 'POST') {
                const input = await body(request, schemas.adaptiveTurn), p = await timing.phase('session', () => patient(request));
                return adaptiveReply(await timing.phase('accept', () => adaptive.accept(adaptiveStore(p, timing), input)), 202);
            }
            const operationMatch = path.match(/^\/api\/clinic\/adaptive-turns\/([a-f0-9-]{36})(?:\/(interpret|discard))?$/);
            if (operationMatch) {
                if (request.method === 'GET' && !operationMatch[2]) {
                    const p = await patient(request);
                    return adaptiveReply(await adaptive.reconcile(adaptiveStore(p), operationMatch[1]));
                }
                if (request.method === 'POST' && operationMatch[2] === 'interpret') {
                    await body(request, schemas.empty);
                    const p = await timing.phase('session', () => patient(request));
                    return adaptiveReply(await timing.phase('interpret', () => adaptive.interpret(adaptiveStore(p, timing), operationMatch[1])));
                }
                if (request.method === 'POST' && operationMatch[2] === 'discard') {
                    const input = await body(request, schemas.review), p = await patient(request);
                    return adaptiveReply(await adaptive.discard(adaptiveStore(p), operationMatch[1], input.expectedRevision));
                }
                throw new ApiFailure('method-not-allowed', 405);
            }
            if (path === '/api/clinic/conversation-mode' && request.method === 'POST') {
                const input = await body(request, schemas.mode), p = await patient(request);
                checkRevision(p.stored.draft, input.expectedRevision);
                return reply(view(await persist(p.r, p.stored, adaptive.mode(p.stored.draft, input.mode))));
            }
            if (path === '/api/clinic/turns' && request.method === 'POST') {
                const input = await body(request, schemas.turns), p = await timing.phase('session', () => patient(request)), d = p.stored.draft;
                const fingerprint = canonicalJson(input), prior = d.requests[input.requestId];
                if (prior) {
                    if (prior.fingerprint !== fingerprint)
                        throw new ApiFailure('request-id-conflict', 409);
                    return reply(view(d));
                }
                checkRevision(d, input.expectedRevision);
                if (d.phase === 'confirmed')
                    throw new ApiFailure('choose-detail-to-amend', 409);
                if (Object.keys(d.requests).length >= 550)
                    throw new ApiFailure('session-turn-limit', 413);
                const guidedDraft = !adaptive.available && d.adaptive ? { ...d, adaptive: { ...d.adaptive, mode: 'guided' as const } } : d;
                const next = timing.measure('dialogue', () => adaptive.dialogue(content.turn(guidedDraft, input as TurnInput)));
                next.requests[input.requestId] = { fingerprint, revision: d.revision + 1 };
                // Guided free text gets the same synchronous safety gate before the next question is shown.
                const newSources = next.turns.filter(turn => turn.role === 'patient' && !d.turns.some(prior => prior.id === turn.id));
                // A spoken reply that could not fill a choice is still the patient's own words, so it is reviewed too.
                // Structured field answers are the patient's words too; bare numbers need no review.
                const recoveredSpeech = input.channel === 'text' ? input.priorChoiceTranscript : undefined;
                const source = newSources.find(turn => !recoveredSpeech || turn.channel !== 'unreviewed-transcript');
                const typed = input.text ?? Object.values(input.fields ?? {}).join(' ');
                const freeText = input.action === 'answer' && /\p{L}/u.test(typed) && !typed.startsWith('__') && !content.view(guidedDraft).currentPrompt?.choices?.some(choice => choice.value === input.text);
                const gateSources = [...(recoveredSpeech ? newSources.filter(turn => turn.channel === 'unreviewed-transcript') : []), ...(source && freeText ? [source] : [])];
                for (const candidate of gateSources) {
                    if (next.safety?.paused) break;
                    const gated = await timing.phase('safety', () => safety.gate(p.r.client, next, candidate.id)).catch(() => undefined);
                    if (gated) applyGateOutcome(next, gated.entry, gated.signal, gated.unsaved);
                }
                return reply(view(await timing.phase('store', () => persist(p.r, p.stored, next))));
            }
            if (path === '/api/clinic/topics' && request.method === 'POST') {
                const input = await body(request, schemas.topics), p = await patient(request);
                checkRevision(p.stored.draft, input.expectedRevision);
                requireNoPendingInterpretation(p.stored.draft, true);
                if (p.stored.draft.confirmed)
                    await handoff.snapshot(p.r.client, p.stored.draft);
                let next = content.select(p.stored.draft, input.topicId, input.slotPath);
                if (input.slotPath && next.adaptive && !options.adaptiveStreamProposer) next.adaptive.mode = 'guided';
                next = adaptive.dialogue(next);
                return reply(view(await persist(p.r, p.stored, next)));
            }
            if (path === '/api/clinic/safety-reviews' && request.method === 'POST') {
                const input = await body(request, schemas.safetyReview), p = await patient(request);
                limit(`safety:${p.claims.sessionId}`, 60);
                const result = await safety.review(p.r.client, p.stored.draft, input.signalId);
                // Only an escalation touches the draft, so background reviews never make the patient's next turn stale.
                const escalated = !!result.entry?.escalated && !p.stored.draft.safety?.paused && !p.stored.draft.confirmed;
                // The escalated (paused) view is returned directly: a session GET would drop identity confirmation.
                const paused = escalated ? await safety.settleDraft(p.r.client, p.claims.sessionId, p.claims.patient, result.entry!, result.unsaved) : undefined;
                return reply({ signalId: input.signalId, state: result.pending ? 'pending' : 'reviewed', escalated, ...(paused ? { session: view(paused) } : {}) });
            }
            if (path === '/api/clinic/review' && request.method === 'POST') {
                const input = await body(request, schemas.review), p = await patient(request), d = p.stored.draft;
                checkRevision(d, input.expectedRevision);
                requireNoPendingInterpretation(d);
                if (d.confirmed)
                    throw new ApiFailure('already-confirmed', 409);
                if (d.preview && d.phase === 'review')
                    return reply({ session: view(d), digest: d.preview.digest, confirmationText: 'I reviewed my full saved words and the answers shown, checked for missing meaning and visible unresolved details, and want to send this version to my care team.' });
                // Every tier-1 signal gets a terminal tier-2 outcome before the patient reviews; unfinished reviews fail closed.
                const swept = await safety.sweep(p.r.client, d), preview = await content.preview(swept);
                const next = await persist(p.r, p.stored, { ...swept, phase: 'review', preview });
                return reply({ session: view(next), digest: preview.digest, confirmationText: next.preview?.confirmation.submission.completeness === 'complete' ? 'I reviewed my full saved words and the answers shown, checked for missing meaning and visible unresolved details, and want to send this complete intake to my care team.' : 'I reviewed my full saved words and the answers shown, checked for missing meaning and visible unresolved details, and want to send this partial handoff, including the visible gaps, to my care team.' });
            }
            if (path === '/api/clinic/confirm' && request.method === 'POST') {
                const input = await body(request, schemas.confirm), p = await patient(request), d = p.stored.draft;
                requireNoPendingInterpretation(d);
                if (d.confirmed) {
                    if (input.digest !== (d.confirmed.previewDigest ?? d.confirmed.digest))
                        throw new ApiFailure('confirmation-digest-mismatch', 409);
                    await handoff.snapshot(p.r.client, d);
                    await p.r.client.deliver(d.confirmed.confirmation, p.r.qualification);
                    return reply(view(await refreshed(p.r, p.stored)));
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
                return reply(view(next));
            }
            if (path === '/api/clinic/retry-delivery' && request.method === 'POST') {
                await body(request, schemas.empty);
                const p = await patient(request), d = p.stored.draft;
                if (!d.confirmed)
                    throw new ApiFailure('confirmation-required', 409);
                const check = await p.r.client.check(d.confirmed.confirmation);
                if (!['absent', 'incomplete'].includes(check.state))
                    throw new ApiFailure('delivery-retry-not-permitted', 409, true);
                await handoff.snapshot(p.r.client, d);
                await p.r.client.deliver(d.confirmed.confirmation, p.r.qualification);
                return reply(view(await refreshed(p.r, p.stored)));
            }
            if (path === '/api/clinic/receipt' && request.method === 'GET') {
                const p = await patient(request);
                return reply(view(await refreshed(p.r, p.stored)));
            }
            if (path === '/api/staff/login' && request.method === 'POST') {
                const input = await body(request, schemas.login);
                limit('login', 10);
                await options.ingress?.reserve({ kind: 'staff-login', attemptId: crypto.randomUUID() });
                if (request.signal.aborted) throw new ApiFailure('request-aborted', 499, false);
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
                const cursor = url.searchParams.get('cursor') ?? undefined, recoveryCursor = url.searchParams.get('recoveryCursor') ?? undefined;
                queueOffset(cursor); queueOffset(recoveryCursor);
                const s = await staff.read(request);
                if (!s.assignment.patients.length || !s.assignment.careTeams.length)
                    return reply({ items: [], recovery: [] });
                const r = await runtime();
                return reply(await handoff.queue(r.client, s.client, s.assignment, cursor, recoveryCursor));
            }
            if (path === '/api/staff/safety' && request.method === 'GET') {
                const cursor = url.searchParams.get('cursor') ?? undefined;
                queueOffset(cursor);
                const s = await staff.read(request), r = await runtime();
                return reply(await staffSafetyApi.list(r.client, s.assignment, cursor));
            }
            const safetyMatch = path.match(/^\/api\/staff\/safety\/([a-f0-9-]{36})(\/actions)?$/);
            if (safetyMatch) {
                const s = await staff.read(request), r = await runtime();
                if (request.method === 'GET' && !safetyMatch[2]) return reply(await staffSafetyApi.view(r.client, s.assignment, safetyMatch[1]));
                if (request.method === 'POST' && safetyMatch[2]) return reply(await staffSafetyApi.act(r.client, s.assignment, safetyMatch[1], await body(request, schemas.safetyAction)));
                throw new ApiFailure('method-not-allowed', 405);
            }
            const match = path.match(/^\/api\/staff\/handoffs\/([a-f0-9-]+\.v[1-9]\d*)(\/(?:actions|resume))?$/);
            if (match) {
                const s = await staff.read(request), r = await runtime();
                if (request.method === 'GET' && !match[2])
                    return reply(await handoff.view(r.client, s.client, s.assignment, match[1]));
                if (request.method === 'POST' && match[2] === '/resume') { await body(request, schemas.empty); return reply(await handoff.resume(r.client, s.client, s.assignment, match[1], r.qualification)); }
                if (request.method === 'POST' && match[2] === '/actions')
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
            else {
                // Unclassified failures stay generic for the client; log only the error class and code-like message for operators.
                console.error('clinic-api-unexpected', error instanceof Error ? `${error.name}: ${error.message.slice(0, 160)}` : typeof error);
                failure = new ApiFailure('service-unavailable', 503, true);
            }
            return reply({ error: { code: failure.code, message: messages[failure.code] ?? 'This action could not be completed. Your saved answers have not been discarded.', retryable: failure.retryable } }, failure.status);
        }
    };
    return async (request: Request): Promise<Response> => {
        const timing = createRequestTiming(), requestId = requestIdFrom(request.headers.get('x-request-id'));
        return finishRequest(await dispatch(request, timing), { requestId, route: requestRoute(request), timing });
    };
}
function requestRoute(request: Request) {
    let pathname = '/';
    try {
        pathname = new URL(request.url).pathname;
    }
    catch { /* a malformed URL is logged under the root route */ }
    return routeName(request.method, pathname);
}
const messages: Record<string, string> = { 'interpretation-pending': 'Your words are saved. Wait for interpretation or explicitly stop it before changing topics, using guided questions, or reviewing.', 'adaptive-unavailable': 'Adaptive interpretation is unavailable. Continue using guided questions.', 'choose-guided-mode': 'Switch to guided questions before submitting a guided answer.', 'operation-not-found': 'This saved interpretation is not part of your session.', 'session-required': 'Open a synthetic clinic session to continue.', 'identity-confirmation-required': 'Confirm the displayed synthetic persona before opening saved answers.', 'origin-denied': 'This request did not come from this clinic.', 'stale-session': 'These answers changed in another window. Reload the saved session before continuing.', 'stale-work': 'This work changed since you opened it. Reload before recording an outcome.', 'save-outcome-unknown': 'The save result is not known yet. Check the saved session before retrying.', 'confirmation-digest-mismatch': 'The answers changed since this preview. Review the current version before sending.', 'staff-login-failed': 'The staff sign-in could not be verified. Check the credentials and try again.', 'action-outcome-unknown': 'The staff action result is not known yet. Reload this work to check its actual status.' };
