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

it('reproduces urgent queued-source write that preserves safety bytes but makes real stored readback fail', async () => {
  const f = fixture(), first = await f.accept('Improve my energy.'), running = f.api.interpret(f.store, first.operation.id);
  const stoppedResult = running.catch(error => error);
  await f.reply.promise;
  await expect(f.accept("I cannot breathe now.")).rejects.toMatchObject({ code: 'invalid-stored-operation' });
  const persisted = f.current().draft, child = persisted.adaptive!.operations[persisted.adaptive!.activeOperationId!];
  expect(persisted.safety).toMatchObject({ rule: 'E01', paused: true });
  expect(persisted.turns.filter(turn => turn.role === 'patient').map(turn => turn.text)).toEqual(['Improve my energy.', 'I cannot breathe now.']);
  expect(child).toMatchObject({ status: 'failed', errorCode: 'safety-interruption', queuedWaiting: true, queuedAfter: first.operation.id });
  await expect(f.store.read()).rejects.toMatchObject({ code: 'invalid-stored-operation' });
  await expect(f.api.reconcile(f.store, child.id)).rejects.toMatchObject({ code: 'invalid-stored-operation' });
  await expect(f.api.discard(f.store, child.id, persisted.revision)).rejects.toMatchObject({ code: 'invalid-stored-operation' });
  f.finish(); expect(await stoppedResult).toMatchObject({ code: 'invalid-stored-operation' });
  expect(f.propose).toHaveBeenCalledTimes(1);
});

it('actually dispatches one queued next answer after valid predecessor settlement with unchanged prompt binding', async () => {
  const f = fixture(), first = await f.accept('Improve my energy.'), running = f.api.interpret(f.store, first.operation.id);
  await f.reply.promise;
  const child = await f.accept('My knee has hurt for three weeks.');
  const displayed = structuredClone(child.operation.displayed);
  expect((await f.api.interpret(f.store, child.operation.id)).operation.queuedWaiting).toBe(true);
  f.finish(); await running;
  const settled = await f.api.interpret(f.store, child.operation.id);
  expect(settled.operation.status).toBe('applied'); expect(settled.operation.displayed).toEqual(displayed);
  expect(f.propose).toHaveBeenCalledTimes(2);
  expect(f.propose.mock.calls[1][0].source.text).toBe('My knee has hurt for three weeks.');
  expect(f.propose.mock.calls[1][0].sources.map(source => source.text)).toEqual(['Improve my energy.', 'My knee has hurt for three weeks.']);
  expect((await f.api.interpret(f.store, child.operation.id)).operation.status).toBe('applied'); expect(f.propose).toHaveBeenCalledTimes(2);
});

it('explicit Stop beats queued settlement, preserving both words and preventing child dispatch', async () => {
  const f = fixture(), first = await f.accept('Improve my energy.'), running = f.api.interpret(f.store, first.operation.id);
  await f.reply.promise; const child = await f.accept('My knee hurts.');
  const stopped = await f.api.discard(f.store, child.operation.id, f.current().draft.revision);
  f.finish(); await running;
  const durable = await f.store.read();
  expect(durable.draft).toEqual(stopped.draft);
  expect((await f.api.interpret(f.store, child.operation.id)).operation.status).toBe('discarded');
  expect(f.propose).toHaveBeenCalledTimes(1);
  expect(durable.draft.turns.filter(turn => turn.role === 'patient')).toHaveLength(2);
});

it('reproduces continuous voice retaining early scope until final interpretation then stopping on its held revision', async () => {
  const f = fixture(), first = await f.accept('Improve my energy.');
  const early = deferred<void>(), final = deferred<Awaited<ReturnType<typeof f.api.interpret>>>();
  const initialScope = { sessionId: f.current().draft.id, expectedRevision: 0, promptId: 'initial', requestId: first.operation.requestId };
  let ctx: ConversationVoiceContext = { eligible: true, blocked: false, scope: initialScope };
  const captures = vi.fn(), speak = vi.fn();
  const controller = new VoiceConversation({ context: () => ctx, startCapture: captures, finishCapture: vi.fn(), stopCapture: vi.fn(), stopPlayback: vi.fn(), speak,
    save: async () => ({ session: f.content.view(f.current().draft, true, true), operation: first.operation }),
    interpret: async () => { early.resolve(); const value = await final.promise; return { session: f.content.view(value.draft, true, true), operation: value.operation }; }, changed: vi.fn() });
  controller.start(); controller.event({ type: 'ready', scope: initialScope });
  controller.state.status = 'finishing'; controller.event({ type: 'completed', scope: initialScope, text: 'Improve my energy.', clean: true });
  await early.promise; const running = f.api.interpret(f.store, first.operation.id); const savedEarly = await f.reply.promise;
  const earlyView = f.content.view(savedEarly, true, true);
  ctx = { ...ctx, scope: { ...initialScope, expectedRevision: savedEarly.revision, promptId: earlyView.currentPrompt!.id } };
  controller.reconcile(); expect(controller.state.status).toBe('thinking'); expect(captures).toHaveBeenCalledTimes(1); expect(speak).not.toHaveBeenCalled();
  f.finish(); const terminal = await running;
  // PatientApp holds bookkeeping-only onSession updates while voice.active.
  final.resolve(terminal); await new Promise(resolve => setTimeout(resolve, 0)); controller.reconcile();
  expect(controller.state).toMatchObject({ status: 'paused', active: false, message: 'The question changed. Check the current conversation before resuming voice.' });
  expect(captures).toHaveBeenCalledTimes(1); expect(speak).not.toHaveBeenCalled(); controller.dispose();
});
