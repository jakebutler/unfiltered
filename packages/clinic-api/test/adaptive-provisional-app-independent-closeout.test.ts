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

it('urgent queue is readable, reviewable and immutable after late known-usage audit', async () => {
  const f = fixture(), first = await f.accept('Improve my energy.'), running = f.api.interpret(f.store, first.operation.id);
  await f.reply.promise;
  const urgent = await f.accept('I cannot breathe now.'), before = await f.store.read();
  expect(urgent.operation).toMatchObject({ status: 'failed', queuedWaiting: false, errorCode: 'safety-interruption' });
  expect(before.draft.adaptive!.operations[first.operation.id]).toMatchObject({ status: 'discarded', stream: { capture: 'discarded' } });
  expect(before.draft.safety).toMatchObject({ rule: 'E01', paused: true });
  const confirmedAt = before.draft.savedAt, frozen = await f.content.preview(before.draft, confirmedAt);
  expect(frozen.confirmation.submission.sources.map(source => source.text)).toEqual(['Improve my energy.', 'I cannot breathe now.']);
  const receipt = { model: 'synthetic-only', requestBytes: 1, outcome: 'complete', providerExecution: 'completed', usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }, timings: { dispatchMs: 0, terminalMs: 10 }, contentBytes: 1 };
  f.tail.resolve({ draft: {}, receipt } as any); await running;
  const after = await f.store.read();
  const expected = structuredClone(before.draft); expected.adaptive!.operations[first.operation.id].stream!.receipt = receipt as any;
  expect(after.draft).toEqual(expected); expect(after.versionId).not.toBe(before.versionId);
  expect(await f.content.preview(after.draft, confirmedAt)).toEqual(frozen);
  expect((await f.api.reconcile(f.store, urgent.operation.id)).draft).toEqual(after.draft);
  expect((await f.api.interpret(f.store, urgent.operation.id)).operation.status).toBe('failed'); expect(f.propose).toHaveBeenCalledTimes(1);
});

it('known settlement permits actual queued child once, while explicit Stop revokes both attempts', async () => {
  const f = fixture(), first = await f.accept('Improve my energy.'), running = f.api.interpret(f.store, first.operation.id);
  await f.reply.promise; const child = await f.accept('My knee has hurt for three weeks.');
  expect((await f.api.interpret(f.store, child.operation.id)).operation.queuedWaiting).toBe(true); expect(f.propose).toHaveBeenCalledTimes(1);
  f.finish(); await running;
  expect((await f.api.interpret(f.store, child.operation.id)).operation.status).toBe('applied');
  expect((await f.api.interpret(f.store, child.operation.id)).operation.status).toBe('applied'); expect(f.propose).toHaveBeenCalledTimes(2);
  expect(f.propose.mock.calls[1][0].displayed).toEqual(child.operation.displayed);
  const s = fixture(), parent = await s.accept('Improve my energy.'), pending = s.api.interpret(s.store, parent.operation.id);
  await s.reply.promise; const queued = await s.accept('My knee hurts.');
  const stopped = await s.api.discard(s.store, queued.operation.id, s.current().draft.revision); s.finish(); await pending;
  expect((await s.store.read()).draft).toEqual(stopped.draft); expect(s.propose).toHaveBeenCalledTimes(1);
});

function controllerFixture() {
  const scope = { sessionId: 'session', expectedRevision: 0, promptId: 'initial', requestId: 'answer-1' };
  const operation = { id: 'parent', requestId: scope.requestId, sourceId: 'source-1', status: 'accepted' as const, acceptedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const session = { id: scope.sessionId, phase: 'conversation', revision: 1, currentPrompt: { id: 'initial', topicId: 'Q01', text: 'Initial question', mode: 'adaptive' }, adaptive: { operation } } as any;
  let ctx: ConversationVoiceContext = { eligible: true, blocked: false, scope };
  const terminal = deferred<any>(), captures = vi.fn(), speech = vi.fn(), stopCapture = vi.fn();
  const save = vi.fn(async () => ({ session, operation })), interpret = vi.fn(async () => terminal.promise);
  const controller = new VoiceConversation({ context: () => ctx, startCapture: captures, finishCapture: vi.fn(), stopCapture, stopPlayback: vi.fn(), speak: speech, save, interpret, changed: vi.fn() });
  const submit = async (current = ctx.scope!) => { controller.state.status = 'finishing'; controller.event({ type: 'completed', scope: current, text: 'Exact words', clean: true }); await new Promise(resolve => setTimeout(resolve, 0)); };
  const early = (id = operation.id, revision = 3) => ({ session: { ...session, revision, currentPrompt: { ...session.currentPrompt, id: 'early', text: 'Early question' } }, operation: { ...operation, id, status: 'processing' as const, stream: { reply: 'saved' as const, capture: 'pending' as const } } });
  const install = (result: ReturnType<typeof early>, requestId = 'answer-2') => { ctx = { ...ctx, scope: { ...scope, expectedRevision: result.session.revision, promptId: result.session.currentPrompt.id, requestId }, speech: { id: result.session.currentPrompt.id, text: result.session.currentPrompt.text } }; };
  controller.start(); controller.event({ type: 'ready', scope });
  return { controller, operation, terminal, captures, speech, stopCapture, save, interpret, submit, early, install, context: () => ctx, change: (patch: Partial<ConversationVoiceContext>) => { ctx = { ...ctx, ...patch }; } };
}

it('controller requires current operation, consumes early question once before tail and ignores terminal bookkeeping', async () => {
  const h = controllerFixture(); await h.submit();
  h.controller.operation(h.early('obsolete')); h.controller.reconcile(); expect(h.captures).toHaveBeenCalledTimes(1);
  const early = h.early(); h.install(early); h.controller.operation(early); h.controller.reconcile();
  h.controller.event({ type: 'ready', scope: h.context().scope! }); expect(h.captures).toHaveBeenCalledTimes(2); expect(h.speech).toHaveBeenCalledExactlyOnceWith('early');
  h.controller.operation(early); h.controller.reconcile(); expect(h.captures).toHaveBeenCalledTimes(2);
  const final = { ...early, session: { ...early.session, revision: 4 }, operation: { ...early.operation, status: 'applied' as const, stream: { reply: 'saved' as const, capture: 'saved' as const } } };
  h.controller.operation(final); h.terminal.resolve(final); await new Promise(resolve => setTimeout(resolve, 0)); h.controller.reconcile();
  expect(h.controller.state.active).toBe(true); expect(h.captures).toHaveBeenCalledTimes(2); expect(h.speech).toHaveBeenCalledTimes(1); h.controller.dispose();
});

it('queued child owns subsequent events and an obsolete parent completion cannot pause that capture', async () => {
  const h = controllerFixture(); await h.submit(); const early = h.early(); h.install(early); h.controller.operation(early); h.controller.reconcile();
  h.controller.event({ type: 'ready', scope: h.context().scope! });
  const child = { ...h.operation, id: 'child', requestId: h.context().scope!.requestId, sourceId: 'source-2', queuedAfter: 'parent', queuedWaiting: true };
  h.save.mockImplementation(async () => ({ session: { ...early.session, revision: 4 }, operation: child })); await h.submit();
  expect(h.controller.state.status).toBe('thinking'); expect(h.interpret).toHaveBeenCalledTimes(1);
  const childEarly = h.early('child', 6); h.install(childEarly, 'answer-3'); h.controller.operation(childEarly); h.controller.reconcile();
  h.controller.event({ type: 'ready', scope: h.context().scope! }); expect(h.captures).toHaveBeenCalledTimes(3);
  h.terminal.resolve({ ...early, operation: { ...early.operation, status: 'unresolved' } }); await new Promise(resolve => setTimeout(resolve, 0)); h.controller.reconcile();
  expect(h.controller.state.active).toBe(true); expect(h.captures).toHaveBeenCalledTimes(3); h.controller.dispose();
});

it('direct-edit scope, safety eligibility and explicit Stop revoke early capture and ignore late events', async () => {
  for (const revocation of ['direct-edit', 'safety', 'stop']) {
    const h = controllerFixture(); await h.submit(); const early = h.early(); h.install(early); h.controller.operation(early); h.controller.reconcile();
    h.controller.event({ type: 'ready', scope: h.context().scope! });
    if (revocation === 'direct-edit') h.change({ scope: { ...h.context().scope!, expectedRevision: 4 } });
    else if (revocation === 'safety') h.change({ eligible: false, scope: undefined });
    else h.controller.stop('Explicit Stop');
    h.controller.reconcile(); expect(h.controller.state.active).toBe(false);
    const calls = h.captures.mock.calls.length; h.controller.operation(h.early('parent', 5)); h.controller.reconcile();
    expect(h.captures).toHaveBeenCalledTimes(calls); expect(h.stopCapture).toHaveBeenCalled(); h.controller.dispose();
  }
});

