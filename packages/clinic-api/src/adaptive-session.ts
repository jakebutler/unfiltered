import { createHash } from 'node:crypto';
import type { AdaptiveOperationView, AdaptiveSessionView, AdaptiveTurnInput } from '../../clinic-contract/src/index.js';
import { canonicalJson, digest } from '../../clinical-core/src/domain.js';
import { AdaptiveError, applyValidatedTurn, validateAdaptiveProposal, type AdaptiveContext, type AdaptiveOutcome } from './adaptive-validation.js';
import { AdaptiveProposalFailure, buildAdaptiveMessages, type AdaptiveProposer, type AdaptiveProposalReceipt } from './adaptive.js';
import { eligibleAdaptiveProbes, selectAdaptiveDialogue } from './dialogue.js';
import { countSpecificityAsk, settleSpecificityReply, specificityFindings } from './specificity.js';
import type { conversation } from './conversation.js';
import { escalation, escalationCopy, safetyVersion } from './safety.js';
import { safetySignalSeed } from './safety-screen.js';
import { applyGateOutcome, type SafetyReviewEntry } from './safety-review.js';
import { ApiFailure, type AdaptiveOperation, type AdaptiveRawProposalAudit, type Draft, type StoredDraft } from './types.js';
import { runAdaptiveStreamOperation, type AdaptiveStreamProposer } from './adaptive-stream-session.js';
import { runGroupedExtractionOperation, type GroupedExtractionProposer } from './adaptive-extraction-grouped-session-v2.js';
import { createGroupedExtractionManifest } from './adaptive-extraction-grouped-v2.js';
import { createCompactReplyManifest } from './adaptive-reply-compact.js';
import { createFullReplyManifest } from './adaptive-reply-full.js';
import { buildIntakeInterpreterMessages, type IntakeInterpreter } from './intake-interpreter.js';

const rawAuditLimit = 128 * 1024;
/** Stream a canonical representation into a digest, retaining at most 128KiB. Not transport bytes.
 * Native provider bodies are already bounded. This avoids allocating a second unbounded JSON string.
 */
export function auditAdaptiveRawProposal(raw: unknown): AdaptiveRawProposalAudit | undefined {
    if (raw === undefined) return;
    const representation = typeof raw === 'string' ? 'raw-proposal-string-v1' : 'canonical-json-v1';
    const hasher = createHash('sha256'); let bytes = 0; let retained: string[] | undefined = [];
    const write = (chunk: string) => {
        const encoded = Buffer.from(chunk, 'utf8'); bytes += encoded.length; hasher.update(encoded);
        if (bytes <= rawAuditLimit) retained?.push(chunk); else retained = undefined;
    };
    const string = (value: string, escaped: boolean) => {
        if (escaped) write('"');
        for (let start = 0; start < value.length;) {
            let end = Math.min(start + 4096, value.length);
            if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]) && /[\uDC00-\uDFFF]/.test(value[end])) end++;
            const chunk = value.slice(start, end); write(escaped ? JSON.stringify(chunk).slice(1, -1) : chunk); start = end;
        }
        if (escaped) write('"');
    };
    try {
        if (typeof raw === 'string') string(raw, false);
        else {
            type Frame = { kind: 'value'; value: unknown } | { kind: 'array'; value: unknown[]; index: number } | { kind: 'object'; value: Record<string, unknown>; keys: string[]; index: number };
            const stack: Frame[] = [{ kind: 'value', value: raw }], active = new Set<object>();
            while (stack.length) {
                const frame = stack.at(-1)!;
                if (frame.kind === 'value') {
                    stack.pop(); const value = frame.value;
                    if (typeof value === 'string') string(value, true);
                    else if (value === null || typeof value === 'boolean' || typeof value === 'number') write(JSON.stringify(value));
                    else if (typeof value !== 'object' || value === null || active.has(value)) throw new Error('not-json');
                    else {
                        active.add(value);
                        if (Array.isArray(value)) { write('['); stack.push({ kind: 'array', value, index: 0 }); }
                        else if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
                            write('{'); stack.push({ kind: 'object', value: value as Record<string, unknown>, keys: Object.keys(value).sort(), index: 0 });
                        } else throw new Error('not-json');
                    }
                } else {
                    const length = frame.kind === 'array' ? frame.value.length : frame.keys.length;
                    if (frame.index === length) { write(frame.kind === 'array' ? ']' : '}'); active.delete(frame.value); stack.pop(); continue; }
                    if (frame.index) write(',');
                    if (frame.kind === 'object') { string(frame.keys[frame.index], true); write(':'); }
                    const value = frame.kind === 'array' ? frame.value[frame.index] : frame.value[frame.keys[frame.index]];
                    frame.index++; stack.push({ kind: 'value', value });
                }
            }
        }
        const sha256 = hasher.digest('hex');
        return retained ? { representation, retention: 'retained', bytes, sha256, content: retained.join('') } : { representation, retention: 'oversize', bytes, sha256 };
    } catch { return { representation, retention: 'unserializable' }; }
}

/** Keep the total serialized retained audit allocation within 128KiB per session.
 * JSON escaping/metadata count toward this bound; earlier audits and clinical sources are untouched.
 */
export function fitAdaptiveRawAudit(draft: Draft, operationId: string, audit: AdaptiveRawProposalAudit): AdaptiveRawProposalAudit {
    if (audit.retention !== 'retained') return audit;
    const used = Object.values(draft.adaptive?.operations ?? {}).filter(op => op.id !== operationId && op.rawProposalAudit?.retention === 'retained')
        .reduce((total, op) => total + Buffer.byteLength(JSON.stringify(op.rawProposalAudit), 'utf8'), 0);
    if (used + Buffer.byteLength(JSON.stringify(audit), 'utf8') <= rawAuditLimit) return audit;
    return { representation: audit.representation, retention: 'session-capacity', bytes: audit.bytes, sha256: audit.sha256 };
}

type Content = ReturnType<typeof conversation>;
export interface AdaptiveDraftStore {
    read(): Promise<StoredDraft>;
    save(previous: StoredDraft, next: Draft): Promise<StoredDraft>;
    /** Model safety gate for one free-text turn. The single-call interpreter waits before extraction. Undefined: nothing to record. */
    safetyGate?(draft: Draft, sourceId: string): Promise<{ signal?: NonNullable<Draft['safetySignals']>[number]; entry: SafetyReviewEntry; unsaved?: true } | undefined>;
}
const pending = (op: AdaptiveOperation) => op.status === 'accepted' || op.status === 'processing';
export function requireNoPendingInterpretation(d: Draft, allowDirectCorrection = false) {
    if (Object.values(d.adaptive?.operations ?? {}).some(op => pending(op)
        && !(allowDirectCorrection && op.stream?.reply === 'saved' && op.stream.capture === 'pending'))) throw new ApiFailure('interpretation-pending', 409);
}
const statusText = (op: AdaptiveOperation): string => {
    if (op.queuedWaiting) return 'Your next words are saved. They are waiting for the previous draft interpretation to finish; another interpretation has not started.';
    if (op.stream) {
        if (op.stream.capture === 'saved') return 'A proposed draft interpretation is saved with its source. Review it and any remaining gaps; it is not clinically verified.';
        if (op.stream.reply === 'saved' && op.stream.capture === 'pending') return 'Your next question is saved. A proposed interpretation of your words is still being prepared.';
        if (op.stream.capture === 'partial') return 'Your words and any saved question remain available. The draft interpretation did not finish; this attempt will not be repeated.';
    }
    if (op.status === 'accepted') return 'Your exact words are saved. Interpretation has not started.';
    if (op.status === 'processing') return 'Your exact words are saved. Interpretation is in progress.';
    if (op.status === 'applied') return op.hasUnresolvedInterpretation ? 'Some details were added. Other wording still needs clarification; review the source and visible gaps.' : 'Supported details were added to your answers. Review them and change anything that is wrong.';
    if (op.status === 'discarded') return 'Interpretation was stopped. Your words remain saved, and a late result cannot change these answers.';
    if (op.status === 'unresolved') return 'The interpretation outcome is uncertain. Your words remain saved. Continue with guided questions or review a partial handoff; this attempt will not be repeated.';
    return op.errorCode === 'safety-interruption' ? 'Your words and help guidance are saved. Ordinary interpretation is paused.' : 'Your words are saved, but interpretation could not be applied. Continue with guided questions or review a partial handoff.';
};
export function operationView(op: AdaptiveOperation): AdaptiveOperationView {
    return { id: op.id, requestId: op.requestId, sourceId: op.sourceId, status: op.status, acceptedAt: op.acceptedAt, updatedAt: op.updatedAt, message: statusText(op), ...(op.updates ? { updates: op.updates.map(({ topicId, path }) => ({ topicId, path })) } : {}), ...(op.hasUnresolvedInterpretation !== undefined ? { hasUnresolvedInterpretation: op.hasUnresolvedInterpretation } : {}), ...(op.stream ? { stream: { reply: op.stream.reply, capture: op.stream.capture } } : {}), ...(op.queuedAfter ? { queuedAfter: op.queuedAfter, queuedWaiting: op.queuedWaiting } : {}) };
}
export function adaptiveView(d: Draft, available: boolean): AdaptiveSessionView {
    const operations = Object.values(d.adaptive?.operations ?? {});
    const latest = d.adaptive?.activeOperationId && d.adaptive.operations[d.adaptive.activeOperationId];
    return { available, mode: available ? d.adaptive?.mode ?? 'guided' : 'guided', guidedFallbackAvailable: true, ...(latest ? { operation: operationView(latest) } : {}), ...(d.adaptive?.exchange?.reply ? { reply: d.adaptive.exchange.reply } : {}), unresolvedSources: operations.filter(op => op.status !== 'applied' || op.hasUnresolvedInterpretation).map(op => ({ sourceId: op.sourceId, reason: statusText(op) })) };
}

/** Durable interpretation owns no identity or clinical policy; all scope comes from the saved draft and register. */
export function adaptiveSession(content: Content, proposer?: AdaptiveProposer, options: { now?: () => number; timeoutMs?: number; streamProposer?: AdaptiveStreamProposer; groupedExtractor?: GroupedExtractionProposer; onReplySaved?: (draft: Draft) => void; fullCapture?: boolean; /** Simple single-call interpreter (intake-interpreter-v1); takes precedence over `proposer`. */ interpreter?: IntakeInterpreter } = {}) {
    const now = options.now ?? Date.now;
    if (options.groupedExtractor && (!options.fullCapture || options.streamProposer)) throw new ApiFailure('invalid-extraction-injection');
    if (options.interpreter && (options.streamProposer || options.groupedExtractor || options.fullCapture)) throw new ApiFailure('invalid-extraction-injection');
    const interpreter = options.interpreter;
    const durableStreaming = !!options.streamProposer || !!options.groupedExtractor;
    const fullStreaming = !!options.fullCapture && durableStreaming;
    // Explicit full mode permits a30s provider tail and5s settlement margin.
    // The legacy proposer/stream contract retains its original15s bound.
    const maximumTimeoutMs = fullStreaming ? 35000 : 15000;
    const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? maximumTimeoutMs, maximumTimeoutMs));
    const at = () => new Date(now()).toISOString();
    const available = !!proposer || !!interpreter || durableStreaming;
    function operation(d: Draft, id: string) {
        const op = d.adaptive?.operations[id];
        if (!op) throw new ApiFailure('operation-not-found', 404);
        return op;
    }
    function allowedTopics(d: Draft) {
        if (options.fullCapture) return content.captureDefinitions(d);
        const topics = content.definitions(d).filter(t => t.id !== 'Q18' || d.relevantTopicIds?.includes('Q18'));
        // Candidate branches are offered to extraction, but dialogue requires their explicit applicability anchors.
        if (topics.some(t => t.id === 'Q06')) for (const branch of Object.values(content.register.branches).filter(branch => content.register.mentalHealth !== 'phq4' || branch.topic.id !== 'COND'))
            if (!topics.some(t => t.id === branch.topic.id)) topics.push(branch.topic);
        return topics;
    }
    function baseContext(d: Draft, op?: AdaptiveOperation): AdaptiveContext {
        const source = op ? d.turns.find(t => t.id === op.sourceId && t.role === 'patient') : undefined;
        if (op && !source) throw new ApiFailure('invalid-operation-source', 409);
        const context: AdaptiveContext = {
            binding: op?.binding ?? { operationId: '', sessionId: d.id, patient: d.patient, scenario: d.scenario, revision: d.revision, contentVersion: `${content.register.provenance.version}.${content.register.mentalHealth}`, snapshotDigest: '' },
            source: source ?? { id: '', role: 'patient', text: '', at: d.savedAt },
            sources: d.turns.filter(t => t.role === 'patient'), topics: allowedTopics(d), responses: options.fullCapture ? content.effective(d, true).responses : d.topics,
            ...(options.fullCapture ? { directResponses: d.topics, captureResponses: content.effective(d).responses, provisionalClaims: content.effective(d).claims } : {}),
            displayed: op?.displayed ?? d.adaptive?.exchange?.prompt,
            dialogue: op?.dialogue ?? d.adaptive?.exchange?.state,
            safetyPaused: d.safety?.paused,
            // Specificity follow-ups run with the single-call interpreter, which settles their replies.
            ...(interpreter ? { specificity: d.specificity ?? {} } : {}),
            displayedText: content.view(d).currentPrompt?.text,
            ...(content.register.mentalHealth === 'phq4' ? { nativeRouting: content.nativeNavigation(d) } : {}),
        };
        if (options.streamProposer && !options.fullCapture) {
            // Intermediate scalar slice: current scope plus one eligible next topic.
            // Raw source is retained in full; collection/branch qualification is pending.
            const displayedId = context.displayed?.topicId;
            const probes = eligibleAdaptiveProbes(context);
            const first = displayedId ?? probes[0]?.topicId;
            const second = probes.find(probe => probe.topicId !== first)?.topicId;
            context.topics = context.topics.filter(topic => topic.id === first || topic.id === second);
        }
        return context;
    }
    async function snapshotDigest(context: AdaptiveContext) {
        return digest({ source: context.source, sources: context.sources, topics: context.topics, responses: context.directResponses ?? context.responses, displayed: context.displayed, dialogue: context.dialogue, safetyPaused: context.safetyPaused, content: { provenance: content.register.provenance, mentalHealth: content.register.mentalHealth, prompts: content.register.promptsById } });
    }
    async function trustedContext(d: Draft, op: AdaptiveOperation) {
        const context = baseContext(d, op);
        if (op.binding.patient !== d.patient || op.binding.sessionId !== d.id || op.binding.scenario !== d.scenario || op.binding.contentVersion !== `${content.register.provenance.version}.${content.register.mentalHealth}` || await snapshotDigest(context) !== op.binding.snapshotDigest)
            throw new ApiFailure('stale-interpretation', 409);
        return context;
    }
    function dialogue(d: Draft, outcome?: AdaptiveOutcome) {
        if (!d.adaptive) return d;
        const next = structuredClone(d);
        if (next.adaptive!.mode === 'guided') { delete next.adaptive!.exchange; return next; }
        const context = baseContext(next);
        // Explicit topic/detail selection is trusted UI state, never a model binding.
        if (next.activeTopic) context.dialogue = { activeTopicId: next.activeTopic };
        const shown = next.adaptive!.exchange?.prompt?.specificity?.key;
        next.adaptive!.exchange = selectAdaptiveDialogue(context, outcome);
        const asked = next.adaptive!.exchange.prompt?.specificity;
        if (asked && asked.key !== shown) next.specificity = countSpecificityAsk(next.specificity ?? {}, asked, specificityFindings(next.topics).find(finding => finding.key === asked.key)?.value);
        return next;
    }
    function initialize(d: Draft) {
        return dialogue({ ...d, adaptive: d.adaptive ?? { mode: available ? 'adaptive' : 'guided', operations: {} } });
    }
    async function commit(store: AdaptiveDraftStore, previous: StoredDraft, draft: Draft) {
        const next = { ...draft, revision: previous.draft.revision + 1, savedAt: at() };
        return store.save(previous, next);
    }
    async function accept(store: AdaptiveDraftStore, input: AdaptiveTurnInput) {
        const stored = await store.read(), d = stored.draft;
        const fingerprint = canonicalJson(input), replay = d.requests[input.requestId];
        if (replay) {
            if (replay.fingerprint !== fingerprint || !replay.operationId) throw new ApiFailure('request-id-conflict', 409);
            return { draft: d, operation: operation(d, replay.operationId) };
        }
        if (d.revision !== input.expectedRevision) throw new ApiFailure('stale-session', 409, true);
        requireNoPendingInterpretation(d, durableStreaming);
        if (d.phase === 'confirmed') throw new ApiFailure('choose-detail-to-amend', 409);
        if (!available || d.adaptive?.mode !== 'adaptive') throw new ApiFailure('adaptive-unavailable', 409);
        if (d.adaptive.exchange?.prompt?.kind === 'instrument') throw new ApiFailure('explicit-screening-choice-required', 409);
        if (!input.text.trim() || input.text.length > 8000) throw new ApiFailure('invalid-adaptive-source');
        if (Object.keys(d.requests).length >= 550) throw new ApiFailure('session-turn-limit', 413);
        const n = structuredClone(d), id = crypto.randomUUID(), sourceId = crypto.randomUUID();
        const time = new Date(Math.max(now(), Date.parse(n.turns.at(-1)?.at ?? n.createdAt) + 1)).toISOString();
        // When the adaptive exchange has no question, the screen shows the guided fallback; free text answers THAT question.
        const fallback = n.adaptive!.exchange?.prompt ? undefined : content.current(d), fallbackText = fallback && content.view(d).currentPrompt?.text;
        const displayed = n.adaptive!.exchange?.prompt ?? (fallback && fallbackText && !/^MH0[1-4]$/.test(fallback.field.path) && fallback.field.path !== '__applicability'
            ? { kind: 'question' as const, topicId: fallback.topic.id, promptId: fallback.field.promptIds[0], targetPaths: [fallback.field.path], text: fallbackText, labels: [fallback.field.label], optional: false } : undefined);
        if (displayed) n.turns.push({ id: `p-${sourceId}`, role: 'assistant', text: displayed.text, at: time });
        n.turns.push({ id: sourceId, role: 'patient', text: input.text, at: time, channel: input.channel, ...(displayed ? { displayedPromptId: displayed.promptId } : {}) });
        const op: AdaptiveOperation = { id, requestId: input.requestId, sourceId, fingerprint, status: 'accepted', acceptedAt: time, updatedAt: time, binding: { operationId: id, sessionId: n.id, patient: n.patient, scenario: n.scenario, revision: d.revision + 1, contentVersion: `${content.register.provenance.version}.${content.register.mentalHealth}`, snapshotDigest: '' }, ...(displayed ? { displayed: { topicId: displayed.topicId, promptId: displayed.promptId, targetPaths: [...displayed.targetPaths], ...(displayed.wording ? { wording: structuredClone(displayed.wording) } : {}), ...('specificity' in displayed && displayed.specificity ? { specificity: structuredClone(displayed.specificity) } : {}) } } : {}), dialogue: structuredClone(n.adaptive!.exchange?.state) };
        const predecessor = Object.values(d.adaptive!.operations).find(candidate => pending(candidate));
        if (predecessor) { op.queuedAfter = predecessor.id; op.queuedWaiting = true; }
        n.adaptive!.operations[id] = op;
        n.adaptive!.activeOperationId = id;
        n.requests[input.requestId] = { fingerprint, revision: d.revision + 1, operationId: id };
        delete n.preview;
        n.phase = 'conversation';
        const rule = escalation(input.text);
        if (rule || n.safety?.paused) {
            op.status = 'failed'; op.errorCode = 'safety-interruption';
            if (op.queuedAfter) {
                op.queuedWaiting = false;
                const interrupted = n.adaptive!.operations[op.queuedAfter];
                if (pending(interrupted)) {
                    interrupted.status = 'discarded'; interrupted.errorCode = 'safety-interruption'; interrupted.updatedAt = time;
                    if (interrupted.stream) interrupted.stream.capture = 'discarded';
                    // The durable attempt/receipt stays charged and retained.
                    // Revoking admission does not assert provider termination.
                }
            }
            if (rule) n.safety = { rule, version: safetyVersion, sourceId, text: escalationCopy[rule], at: time, paused: true };
            if (displayed) n.topics[displayed.topicId] = { ...(n.topics[displayed.topicId] ?? { presented: true, answers: {} }), stopped: 'safety-interruption' };
        }
        // Tier 1 and scoped floor hits become a signal in this same commit; interpretation runs the model gate on it.
        const screen = rule ? undefined : safetySignalSeed(input.text);
        if (screen) n.safetySignals = [...(n.safetySignals ?? []), { id: crypto.randomUUID(), sourceId, categories: screen.categories, terms: screen.terms, at: time, version: screen.version, ...(screen.floor ? { floor: screen.floor } : {}) }];
        op.binding.snapshotDigest = await snapshotDigest(baseContext(n, op));
        // Leave 64KiB inside the existing 500KiB document ceiling for a claim,
        // bounded provisional result, receipt and terminal/queued settlement.
        if (durableStreaming && Buffer.byteLength(canonicalJson(n), 'utf8') > 434464) throw new ApiFailure('session-size-limit', 413);
        const saved = await commit(store, stored, n);
        return { draft: saved.draft, operation: operation(saved.draft, id) };
    }
    /** Applies a safety-gate verdict on its own save (bounded stale-session retry), outside any interpretation result. */
    async function settleGate(store: AdaptiveDraftStore, gated: { signal?: NonNullable<Draft['safetySignals']>[number]; entry: SafetyReviewEntry; unsaved?: true }) {
        for (let attempt = 0; attempt < 6; attempt++) {
            const stored = await store.read(), n = structuredClone(stored.draft);
            applyGateOutcome(n, gated.entry, gated.signal, gated.unsaved);
            if (canonicalJson(n) === canonicalJson(stored.draft)) return;
            try { await commit(store, stored, n); return; }
            catch (error) { if (!(error instanceof ApiFailure) || error.code !== 'stale-session') throw error; }
        }
        // Never continue as if the verdict were applied: the caller surfaces this and the patient retries.
        throw new ApiFailure('safety-verdict-unsaved', 503, true);
    }
    async function reconcile(store: AdaptiveDraftStore, id: string) {
        const stored = await store.read(), op = operation(stored.draft, id);
        if (op.status !== 'processing' || !op.deadlineAt || Date.parse(op.deadlineAt) > now()) return { draft: stored.draft, operation: op };
        const n = structuredClone(stored.draft);
        Object.assign(operation(n, id), { status: 'unresolved', errorCode: 'processing-interrupted', updatedAt: at() });
        if (operation(n, id).stream) operation(n, id).stream!.capture = 'partial';
        try {
            const saved = await commit(store, stored, n);
            return { draft: saved.draft, operation: operation(saved.draft, id) };
        } catch (error) {
            // A simultaneous completion/discard wins its own CAS; status reads never overwrite it.
            if (!(error instanceof ApiFailure) || error.code !== 'stale-session') throw error;
            const fresh = await store.read();
            return { draft: fresh.draft, operation: operation(fresh.draft, id) };
        }
    }
    async function lateReceipt(store: AdaptiveDraftStore, id: string, attemptId: string, expected: Pick<AdaptiveOperation, 'sourceId' | 'fingerprint' | 'binding'>, receipt?: AdaptiveProposalReceipt, rawProposalAudit?: AdaptiveRawProposalAudit) {
        if (!receipt && !rawProposalAudit) return;
        try {
            const stored = await store.read(), op = operation(stored.draft, id);
            if (op.attemptId !== attemptId || op.sourceId !== expected.sourceId || op.fingerprint !== expected.fingerprint || canonicalJson(op.binding) !== canonicalJson(expected.binding) || (!receipt || op.receipt) && (!rawProposalAudit || op.rawProposalAudit)) return;
            const next = structuredClone(stored.draft), target = operation(next, id);
            if (receipt && !target.receipt) target.receipt = receipt;
            if (rawProposalAudit && !target.rawProposalAudit) target.rawProposalAudit = fitAdaptiveRawAudit(next, id, rawProposalAudit);
            // Audit-only recovery cannot change the current prompt/revision or apply any facts.
            await store.save(stored, next);
        } catch { /* A lost metadata save remains unknown; never replay inference to recover it. */ }
    }
    async function interpret(store: AdaptiveDraftStore, id: string) {
        let stored = await store.read(), op = operation(stored.draft, id);
        if (op.status !== 'accepted') return reconcile(store, id);
        if (op.queuedWaiting) return { draft: stored.draft, operation: op };
        if (!available) throw new ApiFailure('adaptive-unavailable', 409);
        let context: AdaptiveContext;
        try {
            if (!op.queuedAfter && stored.draft.revision !== op.binding.revision) throw new ApiFailure('stale-interpretation', 409);
            context = await trustedContext(stored.draft, op);
            if (options.groupedExtractor) createGroupedExtractionManifest(context);
            else if (options.streamProposer) { if (options.fullCapture) createFullReplyManifest(context); else createCompactReplyManifest(context); }
            else if (interpreter) buildIntakeInterpreterMessages(context); // Same size/safety preflight for the interpreter request.
            else buildAdaptiveMessages(context); // Size/safety preflight before spending the durable attempt.
        } catch (error) {
            const n = structuredClone(stored.draft);
            Object.assign(operation(n, id), { status: 'failed', updatedAt: at(), errorCode: error instanceof AdaptiveError || error instanceof ApiFailure ? error.code : 'invalid-adaptive-context' });
            stored = await commit(store, stored, n);
            return { draft: stored.draft, operation: operation(stored.draft, id) };
        }
        const claimed = structuredClone(stored.draft), attemptId = crypto.randomUUID();
        Object.assign(operation(claimed, id), { status: 'processing', attemptId, updatedAt: at(), processingRevision: stored.draft.revision + 1, deadlineAt: new Date(now() + timeoutMs + (fullStreaming ? 0 : 5000)).toISOString() });
        if (durableStreaming) {
            const keys = context.topics.flatMap(topic => topic.slots.map(slot => `${topic.id}:${slot.id}`));
            operation(claimed, id).stream = { protocol: 'durable-provisional-stream-v1', reply: 'pending', capture: 'pending', targetGenerations: Object.fromEntries(keys.map(key => [key, claimed.adaptive?.targetGenerations?.[key] ?? 0])) };
        }
        try { stored = await commit(store, stored, claimed); }
        catch (error) {
            if (error instanceof ApiFailure && error.code === 'stale-session') return reconcile(store, id);
            // An unconfirmed claim must never dispatch. Recovery may find processing and will not replay it.
            throw error;
        }
        op = operation(stored.draft, id);
        if (op.status !== 'processing' || op.attemptId !== attemptId || op.processingRevision !== stored.draft.revision)
            throw new ApiFailure('processing-claim-unverified', 503);
        // The single-call intake interpreter must screen the patient's words before extraction.
        // Legacy proposer concurrency and the already-gated streaming protocols retain their existing ordering.
        const gate = store.safetyGate ? store.safetyGate(stored.draft, op.sourceId).catch(() => undefined) : undefined;
        if (interpreter && gate) {
            const screened = await gate;
            if (screened?.entry.escalated) {
                await settleGate(store, screened);
                const paused = await store.read();
                return { draft: paused.draft, operation: operation(paused.draft, id) };
            }
            // A stop or discard while screening was pending must prevent a new provider dispatch.
            const screenedDraft = await store.read(), screenedOperation = operation(screenedDraft.draft, id);
            if (screenedOperation.status !== 'processing' || screenedOperation.attemptId !== attemptId || screenedDraft.draft.revision !== op.processingRevision) {
                if (screened) await settleGate(store, screened);
                return reconcile(store, id);
            }
        }
        if (options.groupedExtractor || options.streamProposer) {
            // These paths save (and may publish) their next question themselves, so the gate decides first.
            const gated = gate ? await gate : undefined;
            if (gated) await settleGate(store, gated);
            if (gated?.entry.escalated) { const paused = await store.read(); return { draft: paused.draft, operation: operation(paused.draft, id) }; }
            const onReplySaved = options.onReplySaved;
            const saved = options.groupedExtractor
                ? (await runGroupedExtractionOperation(store, stored, context, options.groupedExtractor, { now, timeoutMs, onReplySaved, recognitionContinuation: true,
                    navigationContext: draft => ({ responses: content.effective(draft, true).responses, nativeRouting: content.nativeNavigation(draft), qualification: content.navigationQualification }) })).stored
                : await runAdaptiveStreamOperation(store, stored, context, options.streamProposer!, { now, timeoutMs, onReplySaved, fullCapture: options.fullCapture });
            return { draft: saved.draft, operation: operation(saved.draft, id) };
        }
        let receipt: AdaptiveProposalReceipt | undefined, outcome: AdaptiveOutcome | undefined, rawProposalAudit: AdaptiveRawProposalAudit | undefined;
        let status: AdaptiveOperation['status'] = 'applied', errorCode: string | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        // The interpreter validates per fact and returns an outcome; the legacy proposer is validated here, unchanged.
        type Candidate = { receipt?: AdaptiveProposalReceipt; rawProposal?: unknown; proposal?: unknown; outcome?: AdaptiveOutcome };
        const proposal = Promise.resolve().then((): Promise<Candidate> => interpreter ? interpreter.interpret(context) : proposer!.propose(context));
        try {
            const candidate = await Promise.race([proposal, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('adaptive-deadline')), timeoutMs); })]);
            receipt = candidate.receipt;
            rawProposalAudit = auditAdaptiveRawProposal(candidate.rawProposal);
            if (interpreter) {
                if (!candidate.outcome) throw new AdaptiveError('invalid-interpreter-output');
                outcome = candidate.outcome;
            } else {
                const validated = validateAdaptiveProposal(candidate.proposal, context);
                outcome = applyValidatedTurn(context, validated);
            }
        } catch (error) {
            if (error instanceof AdaptiveProposalFailure) { receipt = error.receipt; rawProposalAudit = auditAdaptiveRawProposal(error.rawProposal); }
            // A valid provider response with a receipt or a rejected proposal is a terminal failure;
            // a transport/process timeout leaves provider execution/usage unresolved.
            status = error instanceof AdaptiveError || receipt ? 'failed' : 'unresolved';
            errorCode = error instanceof AdaptiveError ? error.code : 'provider-outcome-unknown';
            if (status === 'unresolved') void proposal.then(result => lateReceipt(store, id, attemptId, op, result.receipt, auditAdaptiveRawProposal(result.rawProposal)), failure => failure instanceof AdaptiveProposalFailure ? lateReceipt(store, id, attemptId, op, failure.receipt, auditAdaptiveRawProposal(failure.rawProposal)) : undefined);
        } finally { if (timer) clearTimeout(timer); }
        const gated = gate ? await gate : undefined;
        let fresh: StoredDraft;
        try { fresh = await store.read(); }
        catch (error) { await lateReceipt(store, id, attemptId, op, receipt, rawProposalAudit); throw error; }
        const current = operation(fresh.draft, id);
        if (current.status !== 'processing' || current.attemptId !== attemptId || current.sourceId !== op.sourceId || current.fingerprint !== op.fingerprint || canonicalJson(current.binding) !== canonicalJson(op.binding) || fresh.draft.revision !== op.processingRevision) {
            await lateReceipt(store, id, attemptId, op, receipt, rawProposalAudit);
            // A stopped or superseded interpretation never drops the safety verdict for the patient's words.
            if (gated) await settleGate(store, gated);
            return reconcile(store, id);
        }
        try { await trustedContext(fresh.draft, current); }
        catch { status = 'discarded'; errorCode = 'stale-interpretation'; outcome = undefined; }
        let n = structuredClone(fresh.draft);
        const result = operation(n, id);
        Object.assign(result, { status, updatedAt: at(), ...(receipt ? { receipt } : {}), ...(rawProposalAudit ? { rawProposalAudit: fitAdaptiveRawAudit(n, id, rawProposalAudit) } : {}), ...(errorCode ? { errorCode } : {}) });
        if (outcome && status === 'applied') {
            n.topics = Object.fromEntries(Object.entries(outcome.responses).filter((entry): entry is [string, NonNullable<typeof entry[1]>] => entry[1] !== undefined));
            Object.assign(result, { updates: outcome.updates, provenance: outcome.provenance, clarifications: outcome.clarifications, ...(outcome.coveredCandidates ? { coveredCandidates: outcome.coveredCandidates } : {}), ...(outcome.unresolvedQuestions ? { unresolvedQuestions: outcome.unresolvedQuestions } : {}), ...(outcome.unmapped ? { unmapped: outcome.unmapped } : {}), ...(outcome.rejectedCandidates ? { rejectedCandidates: outcome.rejectedCandidates } : {}), hasUnresolvedInterpretation: outcome.hasUnresolvedInterpretation, resultDigest: await digest(outcome) });
            content.synchronize(n);
            outcome = { ...outcome, responses: n.topics };
            // A reply to a specificity follow-up that added no new detail may still settle it ("I'll bring the bottle", "yes").
            const mark = op.displayed?.specificity;
            if (interpreter && mark) n.specificity = settleSpecificityReply(n.specificity ?? {}, mark, { sourceId: op.sourceId, text: context.source.text, updatedPath: outcome.updates.some(update => update.topicId === op.displayed!.topicId && op.displayed!.targetPaths.includes(update.path)), value: specificityFindings(n.topics).find(finding => finding.key === mark.key)?.value });
            const dialogueContext = { ...context, nativeRouting: content.nativeNavigation(n), ...(interpreter ? { specificity: n.specificity ?? {} } : {}) };
            n.adaptive!.exchange = selectAdaptiveDialogue(dialogueContext, outcome);
            // With no alternative authored question, leave the interrupted topic for review;
            // the guided fallback must not immediately repeat it or fabricate an answer.
            if (outcome.acknowledgement && outcome.unmapped?.length && !n.adaptive!.exchange.prompt && context.displayed)
                n.adaptive!.parkedTopicIds = [...new Set([...(n.adaptive!.parkedTopicIds ?? []), context.displayed.topicId])];
            // Interpreter path: never show the same question a third time, in a short window (A/B cycles) or for the same topic all session.
            // Park that topic for now and continue with others; its gaps stay visible in review.
            const recentPrompts = n.turns.filter(turn => turn.role === 'assistant').slice(-12).map(turn => turn.text);
            const parked = new Set<string>();
            for (let guard = 0; interpreter && guard <= dialogueContext.topics.length; guard++) { // one topic parked per pass
                const cycling = n.adaptive!.exchange.prompt;
                // Specificity follow-ups reuse their field's prompt id but have their own budget; they are not repeats.
                const shownForTopic = Object.values(n.adaptive!.operations ?? {}).filter(op => !op.displayed?.specificity && op.displayed?.wording?.version !== 'spoken-number-confirm.1' && op.displayed?.topicId === cycling?.topicId && op.displayed?.promptId === cycling?.promptId).length;
                if (!cycling || cycling.kind === 'instrument' || cycling.specificity || recentPrompts.filter(text => text === cycling.text).length < 2 && shownForTopic < 2) break;
                parked.add(cycling.topicId);
                const remaining = outcome.clarifications.filter(item => !parked.has(item.topicId));
                n.adaptive!.exchange = selectAdaptiveDialogue({ ...dialogueContext, topics: dialogueContext.topics.filter(topic => !parked.has(topic.id)), dialogue: { ...dialogueContext.dialogue, activeTopicId: undefined, suspended: undefined, lastUnsuccessful: undefined } },
                    { ...outcome, clarifications: remaining, hasUnresolvedInterpretation: remaining.length > 0 });
            }
            // The guided fallback (shown when no adaptive question remains) follows the same rule: park its topic after two showings.
            for (let guard = 0; interpreter && !n.adaptive!.exchange.prompt && guard < dialogueContext.topics.length; guard++) {
                const next = content.current(n), text = next && content.view(n).currentPrompt?.text;
                if (!next || !text || /^MH0[1-4]$/.test(next.field.path) || n.turns.filter(turn => turn.role === 'assistant' && turn.text === text).length < 2) break;
                n.adaptive!.parkedTopicIds = [...new Set([...(n.adaptive!.parkedTopicIds ?? []), next.topic.id])];
            }
            const asked = n.adaptive!.exchange.prompt?.specificity;
            if (asked) n.specificity = countSpecificityAsk(n.specificity ?? {}, asked, specificityFindings(n.topics).find(finding => finding.key === asked.key)?.value);
            // A guarded acknowledgement precedes the next AUTHORED question; approved replies always win.
            if (outcome.acknowledgement && !n.adaptive!.exchange.reply && ['question', 'review-available', 'interpretation-review'].includes(n.adaptive!.exchange.status))
                n.adaptive!.exchange.reply = { id: `ack-${outcome.sourceId}`, text: outcome.acknowledgement };
            delete n.activeTopic; delete n.activeSlot; delete n.preview;
        }
        if (gated) applyGateOutcome(n, gated.entry, gated.signal, gated.unsaved);
        try {
            const saved = await commit(store, fresh, n);
            return { draft: saved.draft, operation: operation(saved.draft, id) };
        } catch (error) {
            // The normal store already read-backs ambiguous writes. Do one bounded operation-level
            // readback: accept the exact result, or retain processing/terminal status; never re-infer.
            try {
                const saved = await store.read(), recovered = operation(saved.draft, id);
                // A stop or discard that won the race keeps its status, but never drops the safety verdict.
                if (recovered.status !== 'processing') {
                    if (!gated) return { draft: saved.draft, operation: recovered };
                    await settleGate(store, gated);
                    const settled = await store.read();
                    return { draft: settled.draft, operation: operation(settled.draft, id) };
                }
                if (recovered.attemptId === attemptId && recovered.sourceId === op.sourceId && recovered.fingerprint === op.fingerprint && canonicalJson(recovered.binding) === canonicalJson(op.binding) && saved.draft.revision === fresh.draft.revision) {
                    const unresolved = structuredClone(saved.draft);
                    if (gated) applyGateOutcome(unresolved, gated.entry, gated.signal, gated.unsaved);
                    Object.assign(operation(unresolved, id), { status: 'unresolved', errorCode: 'result-save-outcome-unknown', updatedAt: at(), ...(receipt ? { receipt } : {}), ...(rawProposalAudit ? { rawProposalAudit: fitAdaptiveRawAudit(unresolved, id, rawProposalAudit) } : {}), ...(result.resultDigest ? { resultDigest: result.resultDigest } : {}) });
                    const recoveredSave = await commit(store, saved, unresolved);
                    return { draft: recoveredSave.draft, operation: operation(recoveredSave.draft, id) };
                }
            } catch { /* Retain the original uncertainty; status recovery remains read-only with respect to inference. */ }
            throw error;
        }
    }
    async function discard(store: AdaptiveDraftStore, id: string, expectedRevision: number) {
        const stored = await store.read(), op = operation(stored.draft, id);
        if (op.status === 'discarded') return { draft: stored.draft, operation: op };
        if (stored.draft.revision !== expectedRevision) throw new ApiFailure('stale-session', 409, true);
        if (!pending(op)) throw new ApiFailure('interpretation-already-finished', 409);
        const n = structuredClone(stored.draft);
        Object.assign(operation(n, id), { status: 'discarded', updatedAt: at() });
        if (operation(n, id).stream) operation(n, id).stream!.capture = 'discarded';
        if (op.queuedAfter) {
            const predecessor = operation(n, op.queuedAfter);
            if (pending(predecessor)) {
                Object.assign(predecessor, { status: 'discarded', updatedAt: at() });
                if (predecessor.stream) predecessor.stream.capture = 'discarded';
            }
            operation(n, id).queuedWaiting = false;
        }
        const saved = await commit(store, stored, n);
        return { draft: saved.draft, operation: operation(saved.draft, id) };
    }
    function mode(d: Draft, selected: 'adaptive' | 'guided') {
        requireNoPendingInterpretation(d);
        if (selected === 'adaptive' && !available) throw new ApiFailure('adaptive-unavailable', 409);
        if (d.phase === 'confirmed') throw new ApiFailure('choose-detail-to-amend', 409);
        const n = structuredClone(d);
        n.adaptive ??= { mode: selected, operations: {} };
        const priorPrompt = d.adaptive?.mode === 'adaptive' ? d.adaptive.exchange?.prompt : undefined;
        const priorTopic = priorPrompt?.topicId ?? content.current(d)?.topic.id;
        n.adaptive.mode = selected;
        if (priorTopic) n.activeTopic = priorTopic;
        if (selected === 'adaptive') delete n.activeSlot;
        else if (priorPrompt?.targetPaths[0]) n.activeSlot = priorPrompt.targetPaths[0];
        return dialogue(n);
    }
    return { available, initialize, dialogue, mode, accept, interpret, reconcile, discard };
}
