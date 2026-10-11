import { expect, it, vi } from 'vitest';
import { adaptiveSession } from '../src/adaptive-session.js';
import { conversation } from '../src/conversation.js';
import { ApiFailure, type ClinicApiConfig, type Draft, type StoredDraft } from '../src/types.js';
import type { AdaptiveStreamProposer } from '../src/adaptive-stream-session.js';
import { document, readDraft, DRAFT_SYSTEM } from '../src/store.js';
import type { MedplumClient } from '../../clinical-core/src/medplum.js';
import { VoiceConversation, type ConversationVoiceContext } from '../../../apps/clinic/src/voice-conversation.js';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const patient = { reference: 'Patient/test', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
  const config = { mentalHealth: 'phq4', patients: { 'first-intake': patient } } as ClinicApiConfig;
  const tail = deferred<{ draft: unknown }>(), reply = deferred<Draft>();
  const propose = vi.fn<AdaptiveStreamProposer['propose']>(async (context, manifest, options) => {
    const data = JSON.parse(String(manifest.messages[1].content));
    await options.onAdvance({ manifestId: manifest.id, actionId: data.actions.at(-1).id, controls: [], defer: [] });
    const result = { draft: { manifestId: manifest.id, claims: [], acts: [], residual: [], sourceDisposition: 'partially-represented' } };
    return propose.mock.calls.length === 1 ? tail.promise : result;
  });
  const content = conversation(config);
  const api = adaptiveSession(content, undefined, { streamProposer: { propose }, timeoutMs: 1000, onReplySaved: saved => reply.resolve(saved) });
  const now = new Date().toISOString();
  const draft: Draft = api.initialize({ schema: 1, id: crypto.randomUUID(), patient: patient.reference, scenario: 'first-intake', revision: 0, createdAt: now, savedAt: now, phase: 'conversation', turns: [], topics: {}, requests: {}, version: 1 });
  let stored: StoredDraft = { draft, versionId: '1', resource: { ...document(DRAFT_SYSTEM, draft.id, draft.patient, draft), id: 'review-record', meta: { versionId: '1' } } };
  const client = { request: async () => ({ body: { resourceType: 'Bundle', type: 'searchset', total: 1, entry: [{ resource: structuredClone(stored.resource) }] } }) } as unknown as MedplumClient;
  const store = { read: () => readDraft(client, draft.id, draft.patient), save: async (previous: StoredDraft, next: Draft) => {
    if (previous.versionId !== stored.versionId) throw new ApiFailure('stale-session', 409);
    const versionId = String(Number(stored.versionId) + 1);
    stored = { draft: structuredClone(next), versionId, resource: { ...document(DRAFT_SYSTEM, next.id, next.patient, next), id: 'review-record', meta: { versionId } } };
    return readDraft(client, draft.id, draft.patient);
  } };
  const accept = (text: string) => api.accept(store, { text, requestId: crypto.randomUUID(), expectedRevision: stored.draft.revision, channel: 'text' });
  const finish = () => tail.resolve({ draft: { manifestId: propose.mock.calls[0][1].id, claims: [], acts: [], residual: [], sourceDisposition: 'partially-represented' } });
  return { api, store, accept, tail, reply, propose, finish, content, current: () => structuredClone(stored) };
}

it('urgent queued source durably reads back E01 and both immutable sources, revokes both interpretation admissions and never dispatches again', async () => {
  const f = fixture(), first = await f.accept('Improve my energy.'), running = f.api.interpret(f.store, first.operation.id);
  await f.reply.promise; const urgent = await f.accept('I cannot breathe now.');
  expect(urgent.operation).toMatchObject({ status: 'failed', errorCode: 'safety-interruption', queuedWaiting: false, queuedAfter: first.operation.id });
  const readback = await f.store.read(), predecessor = readback.draft.adaptive!.operations[first.operation.id];
  expect(readback.draft.safety).toMatchObject({ rule: 'E01', paused: true });
  expect(readback.draft.turns.filter(turn => turn.role === 'patient').map(turn => turn.text)).toEqual(['Improve my energy.', 'I cannot breathe now.']);
  expect(predecessor).toMatchObject({ status: 'discarded', errorCode: 'safety-interruption', stream: { capture: 'discarded', reply: 'saved' } });
  expect(predecessor.attemptId).toBeTruthy();
  expect((await f.api.reconcile(f.store, urgent.operation.id)).draft).toEqual(readback.draft);
  expect((await f.api.interpret(f.store, urgent.operation.id)).operation.status).toBe('failed');
  const receipt = { model: 'synthetic-only', requestBytes: 1, responseSchema: 'json-schema', outcome: 'complete', providerExecution: 'completed', usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }, timings: { dispatchMs: 0, terminalMs: 10 }, contentBytes: 1 };
  f.tail.resolve({ draft: { manifestId: f.propose.mock.calls[0][1].id, claims: [], acts: [], residual: [], sourceDisposition: 'partially-represented' }, receipt } as any);
  await running; const late = await f.store.read();
  expect(late.draft.revision).toBe(readback.draft.revision);
  expect(late.draft.turns).toEqual(readback.draft.turns); expect(late.draft.safety).toEqual(readback.draft.safety);
  expect(late.draft.adaptive!.exchange).toEqual(readback.draft.adaptive!.exchange);
  expect(late.draft.adaptive!.operations[first.operation.id].stream).toMatchObject({ capture: 'discarded', receipt });
  expect(late.draft.adaptive!.operations[first.operation.id].stream!.provisional).toBeUndefined();
  expect((await f.api.interpret(f.store, first.operation.id)).operation.status).toBe('discarded');
  expect(f.propose).toHaveBeenCalledTimes(1);
  const preview = await f.content.preview(late.draft);
  expect(preview.confirmation.submission.sources).toHaveLength(2); // Partial review remains available.
});

it('actual continuous controller consumes durable early operation event, starts next audio/capture before tail, and ignores terminal bookkeeping', async () => {
  const f = fixture(), first = await f.accept('Improve my energy.');
  const interpreting = deferred<void>(), terminal = deferred<Awaited<ReturnType<typeof f.api.interpret>>>();
  const initialScope = { sessionId: f.current().draft.id, expectedRevision: 0, promptId: 'initial', requestId: first.operation.requestId };
  let ctx: ConversationVoiceContext = { eligible: true, blocked: false, scope: initialScope };
  const captures = vi.fn(), speak = vi.fn(), interpret = vi.fn(async () => { interpreting.resolve(); const value = await terminal.promise; return { session: f.content.view(value.draft, true, true), operation: value.operation }; });
  const controller = new VoiceConversation({ context: () => ctx, startCapture: captures, finishCapture: vi.fn(), stopCapture: vi.fn(), stopPlayback: vi.fn(), speak,
    save: async () => ({ session: f.content.view(f.current().draft, true, true), operation: first.operation }), interpret, changed: vi.fn() });
  controller.start(); controller.event({ type: 'ready', scope: initialScope });
  controller.state.status = 'finishing'; controller.event({ type: 'completed', scope: initialScope, text: 'Improve my energy.', clean: true });
  await interpreting.promise; const running = f.api.interpret(f.store, first.operation.id), savedEarly = await f.reply.promise;
  const earlyView = f.content.view(savedEarly, true, true), earlyScope = { ...initialScope, requestId: crypto.randomUUID(), expectedRevision: savedEarly.revision, promptId: earlyView.currentPrompt!.id };
  ctx = { eligible: true, blocked: false, scope: earlyScope, speech: { id: earlyView.currentPrompt!.id, text: earlyView.currentPrompt!.text } };
  controller.operation({ session: earlyView, operation: earlyView.adaptive!.operation! }); controller.reconcile();
  expect(controller.state.status).toBe('connecting'); expect(captures).toHaveBeenCalledTimes(2);
  controller.event({ type: 'ready', scope: earlyScope }); expect(speak).toHaveBeenCalledExactlyOnceWith(earlyView.currentPrompt!.id);
  controller.event({ type: 'voice', scope: earlyScope }); expect(controller.state.status).toBe('listening');
  f.finish(); const complete = await running;
  const finalView = f.content.view(complete.draft, true, true);
  // Model PatientApp preserving an already active speech scope across tail metadata.
  controller.operation({ session: finalView, operation: finalView.adaptive!.operation! }); terminal.resolve(complete);
  await new Promise(resolve => setTimeout(resolve, 0)); controller.reconcile();
  expect(controller.state).toMatchObject({ active: true, status: 'listening' });
  expect(captures).toHaveBeenCalledTimes(2); expect(speak).toHaveBeenCalledTimes(1); expect(interpret).toHaveBeenCalledTimes(1);
  controller.dispose();
});

it('queued continuous turn waits for durable status events, while a stopped controller ignores late early events', async () => {
  const first = { id: 'queued-child', requestId: 'spoken-answer', sourceId: 'source', status: 'accepted' as const, acceptedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), queuedAfter: 'parent', queuedWaiting: true };
  const scope = { sessionId: 'session', expectedRevision: 2, promptId: 'current', requestId: first.requestId };
  const base = { id: scope.sessionId, revision: 3, phase: 'conversation', currentPrompt: { id: 'current', topicId: 'Q01', text: 'Current question', purpose: '', mode: 'adaptive' } } as any;
  let ctx: ConversationVoiceContext = { eligible: true, blocked: false, scope };
  const captures = vi.fn(), interpret = vi.fn();
  const controller = new VoiceConversation({ context: () => ctx, startCapture: captures, finishCapture: vi.fn(), stopCapture: vi.fn(), stopPlayback: vi.fn(), speak: vi.fn(), save: async () => ({ session: base, operation: first }), interpret, changed: vi.fn() });
  controller.start(); controller.event({ type: 'ready', scope }); controller.state.status = 'finishing'; controller.event({ type: 'completed', scope, text: 'Exact queued words', clean: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(controller.state.status).toBe('thinking'); expect(interpret).not.toHaveBeenCalled(); expect(captures).toHaveBeenCalledTimes(1);
  const ready = { ...first, status: 'processing' as const, queuedWaiting: false, stream: { reply: 'saved' as const, capture: 'pending' as const } };
  ctx = { eligible: true, blocked: false, scope: { ...scope, promptId: 'next', expectedRevision: 5, requestId: 'next-answer' } };
  const session = { ...base, revision: 5, currentPrompt: { ...base.currentPrompt, id: 'next' } };
  controller.operation({ session, operation: ready }); controller.reconcile(); expect(captures).toHaveBeenCalledTimes(2);
  controller.stop('Explicit Stop'); controller.operation({ session: { ...session, revision: 6 }, operation: ready }); controller.reconcile();
  expect(controller.state).toMatchObject({ active: false, status: 'paused' }); expect(captures).toHaveBeenCalledTimes(2);
});

