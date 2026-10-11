import { expect, it, vi } from 'vitest';
import { adaptiveSession, requireNoPendingInterpretation } from '../src/adaptive-session.js';
import { conversation } from '../src/conversation.js';
import { ApiFailure, type ClinicApiConfig, type Draft, type StoredDraft } from '../src/types.js';
import type { AdaptiveStreamProposer } from '../src/adaptive-stream-session.js';
import { document, readDraft, DRAFT_SYSTEM } from '../src/store.js';
import type { MedplumClient } from '../../clinical-core/src/medplum.js';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(timeoutMs = 1000) {
  const patient = { reference: 'Patient/test', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
  const config = { mentalHealth: 'phq4', patients: { 'first-intake': patient } } as ClinicApiConfig;
  const tail = deferred<{ draft: unknown }>(), reply = deferred<Draft>();
  const propose = vi.fn<AdaptiveStreamProposer['propose']>(async (context, manifest, options) => {
    const data = JSON.parse(String(manifest.messages[1].content)), target = data.targets[0], address = { statementId: data.statements[0].id, quote: context.source.text };
    await options.onAdvance({ manifestId: manifest.id, actionId: data.actions[0].id, controls: [], defer: [{ targetId: target.id, evidence: [address] }] });
    return tail.promise;
  });
  const api = adaptiveSession(conversation(config), undefined, { streamProposer: { propose }, timeoutMs, onReplySaved: saved => reply.resolve(saved) });
  const now = new Date().toISOString();
  const draft: Draft = api.initialize({ schema: 1, id: crypto.randomUUID(), patient: patient.reference, scenario: 'first-intake', revision: 0, createdAt: now, savedAt: now, phase: 'conversation', turns: [], topics: {}, requests: {}, version: 1 });
  let stored: StoredDraft = { draft, versionId: '1', resource: { ...document(DRAFT_SYSTEM, draft.id, draft.patient, draft), id: 'record', meta: { versionId: '1' } } };
  const client = { request: async () => ({ body: { resourceType: 'Bundle', type: 'searchset', total: 1, entry: [{ resource: structuredClone(stored.resource) }] } }) } as unknown as MedplumClient;
  const store = { read: () => readDraft(client, draft.id, draft.patient), save: async (previous: StoredDraft, next: Draft) => {
    if (previous.versionId !== stored.versionId) throw new ApiFailure('stale-session', 409);
    const versionId = String(Number(stored.versionId) + 1);
    stored = { draft: structuredClone(next), versionId, resource: { ...document(DRAFT_SYSTEM, next.id, next.patient, next), id: 'record', meta: { versionId } } };
    return readDraft(client, draft.id, draft.patient); // Real stored-state validators, including two-operation queue.
  } };
  const accept = (text: string, requestId = crypto.randomUUID(), revision = stored.draft.revision) => api.accept(store, { text, requestId, expectedRevision: revision, channel: 'text' });
  return { api, store, accept, tail, reply, propose, current: () => structuredClone(stored) };
}
it('accepts one exact idempotent queued source after durable early reply and delays dispatch until known settlement', async () => {
  const f = fixture(), first = await f.accept('Improve my energy.'), running = f.api.interpret(f.store, first.operation.id);
  await f.reply.promise;
  const requestId = crypto.randomUUID(), revision = f.current().draft.revision;
  const queued = await f.accept('I have had a sore knee for three weeks.', requestId, revision);
  expect(queued.operation).toMatchObject({ status: 'accepted', queuedAfter: first.operation.id, queuedWaiting: true });
  expect(queued.operation.displayed!.promptId).toBe(f.current().draft.adaptive!.exchange!.prompt!.promptId);
  expect((await f.accept('I have had a sore knee for three weeks.', requestId, revision)).operation.id).toBe(queued.operation.id);
  expect((await f.api.interpret(f.store, queued.operation.id)).operation.status).toBe('accepted');
  expect(f.propose).toHaveBeenCalledTimes(1);
  await expect(f.accept('A third source cannot enter the queue.')).rejects.toThrow('interpretation-pending');
  const manifest = JSON.parse(String(vi.mocked(f.propose).mock.calls[0][1].messages[1].content));
  f.tail.resolve({ draft: { manifestId: manifest.manifestId, claims: [], acts: [], residual: [], sourceDisposition: 'partially-represented' } });
  await running;
  expect(f.current().draft.adaptive!.operations[queued.operation.id].queuedWaiting).toBe(false);
  expect(f.current().draft.turns.filter(turn => turn.role === 'patient').map(turn => turn.text)).toEqual(['Improve my energy.', 'I have had a sore knee for three weeks.']);
  // Deliberately do not dispatch the ready child in this test; the browser owns that initial attempt.
});
it('unknown predecessor keeps queued words saved; explicit Stop releases review/guided without redispatch or source loss', async () => {
  const f = fixture(20), first = await f.accept('Improve my energy.'), running = f.api.interpret(f.store, first.operation.id);
  await f.reply.promise; const queued = await f.accept('My knee hurts.'); await running;
  expect(f.current().draft.adaptive!.operations[first.operation.id].status).toBe('unresolved');
  expect(f.current().draft.adaptive!.operations[queued.operation.id].queuedWaiting).toBe(true);
  await f.api.interpret(f.store, queued.operation.id); expect(f.propose).toHaveBeenCalledTimes(1);
  const stopped = await f.api.discard(f.store, queued.operation.id, f.current().draft.revision);
  expect(() => requireNoPendingInterpretation(stopped.draft)).not.toThrow();
  const guided = f.api.mode(stopped.draft, 'guided'); expect(guided.adaptive!.mode).toBe('guided');
  expect(guided.turns.filter(turn => turn.role === 'patient').map(turn => turn.text)).toEqual(['Improve my energy.', 'My knee hurts.']);
  expect(guided.adaptive!.operations[first.operation.id].stream!.capture).toBe('partial');
  expect(guided.adaptive!.operations[queued.operation.id].status).toBe('discarded');
  f.tail.resolve({ draft: {} }); await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.propose).toHaveBeenCalledTimes(1); expect(f.current().draft.turns).toEqual(stopped.draft.turns);
});
