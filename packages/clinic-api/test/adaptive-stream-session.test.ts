import { expect, it, vi } from 'vitest';
import { context } from './fixtures/adaptive.js';
import { createReplyDraftManifest, type ReplyDraft } from '../src/adaptive-reply.js';
import { runAdaptiveStreamOperation, trackDirectAdaptiveEdits, streamSpeechScopeDigest, targetKey, type AdaptiveStreamProposer } from '../src/adaptive-stream-session.js';
import { requireNoPendingInterpretation } from '../src/adaptive-session.js';
import { interpretationReview } from '../src/interpretation-review.js';
import { ApiFailure, type Draft, type StoredDraft } from '../src/types.js';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const ctx = context('The scale read 230 pounds yesterday.', ['Q04', 'Q05']);
  ctx.binding.operationId = crypto.randomUUID(); ctx.binding.sessionId = crypto.randomUUID(); ctx.binding.revision = 1;
  ctx.source.id = crypto.randomUUID();
  const manifest = createReplyDraftManifest(ctx), payload = JSON.parse(String(manifest.messages[1].content));
  const target = payload.targets.find((item: { path: string }) => item.path === 'lastMeasuredWeight.value');
  const address = { statementId: payload.statements[0].id, quote: ctx.source.text };
  const draft: ReplyDraft = { manifestId: manifest.id, claims: [{ targetId: target.id, state: 'known', value: '230', valueEvidence: address, evidence: [address], scope: { subject: 'patient', entity: 'measured-weight', period: 'yesterday', predicate: address }, correctsSourceIds: [] }], acts: [], residual: [], sourceDisposition: 'represented' };
  const id = ctx.binding.operationId;
  let stored: StoredDraft = { resource: { resourceType: 'DocumentReference', id: '1' }, versionId: '1', draft: {
    schema: 1, id: ctx.binding.sessionId, patient: ctx.binding.patient, scenario: ctx.binding.scenario, revision: 2, savedAt: ctx.source.at, createdAt: ctx.source.at,
    phase: 'conversation', turns: [ctx.source], topics: {}, requests: {}, version: 1,
    adaptive: { mode: 'adaptive', operations: { [id]: { id, sourceId: ctx.source.id, requestId: crypto.randomUUID(), fingerprint: 'test', binding: ctx.binding, status: 'processing', attemptId: crypto.randomUUID(), processingRevision: 2, acceptedAt: ctx.source.at, updatedAt: ctx.source.at,
      stream: { protocol: 'durable-provisional-stream-v1', reply: 'pending', capture: 'pending', targetGenerations: {} } } }, activeOperationId: id },
  } };
  let failReplySave = false;
  let tailRace: ((draft: Draft) => void) | undefined;
  const writes: Draft[] = [];
  const store = { read: async () => structuredClone(stored), save: async (previous: StoredDraft, next: Draft) => {
    if (tailRace && next.adaptive!.operations[id].stream!.capture !== 'pending') { const race = tailRace; tailRace = undefined; edit(race); }
    if (previous.versionId !== stored.versionId) throw new ApiFailure('stale-session', 409);
    if (failReplySave && next.adaptive!.operations[id].stream!.reply === 'saved') { failReplySave = false; throw new ApiFailure('save-outcome-unknown', 503); }
    stored = { ...stored, draft: structuredClone(next), versionId: String(Number(stored.versionId) + 1) }; writes.push(structuredClone(next)); return structuredClone(stored);
  } };
  const tail = deferred<{ draft: unknown }>(), notified = deferred<Draft>();
  const onReplySaved = vi.fn((saved: Draft) => { notified.resolve(saved); });
  const propose = vi.fn(async (_ctx, _manifest, options) => { await options.onAdvance({ manifestId: manifest.id, actionId: 'a0', controls: [], defer: [] }); return tail.promise; }) as unknown as AdaptiveStreamProposer['propose'];
  const run = (proposer = { propose }, timeoutMs = 1000) => runAdaptiveStreamOperation(store, structuredClone(stored), ctx, proposer, { now: Date.now, timeoutMs, onReplySaved });
  const edit = (change: (draft: Draft) => void) => { const next = structuredClone(stored.draft); change(next); next.revision++; stored = { ...stored, draft: trackDirectAdaptiveEdits(stored.draft, next), versionId: String(Number(stored.versionId) + 1) }; };
  return { ctx, draft, store, id, tail, notified, onReplySaved, propose, writes, run, edit, current: () => structuredClone(stored), failReply: () => { failReplySave = true; }, raceTail: (change: (draft: Draft) => void) => { tailRace = change; } };
}
it('persists a closed useful question before notification and does not wait for capture', async () => {
  const f = fixture(), running = f.run();
  const saved = await f.notified.promise;
  expect(f.current().draft.revision).toBe(saved.revision);
  expect(saved.adaptive!.operations[f.id].stream).toMatchObject({ reply: 'saved', capture: 'pending' });
  expect(() => requireNoPendingInterpretation(saved, true)).not.toThrow();
  expect(() => requireNoPendingInterpretation(saved)).toThrow('interpretation-pending');
  const prompt = structuredClone(saved.adaptive!.exchange);
  f.tail.resolve({ draft: f.draft }); const complete = await running;
  expect(complete.draft.adaptive!.exchange).toEqual(prompt);
  expect(complete.draft.topics).toEqual({});
  expect(streamSpeechScopeDigest(complete.draft)).toBe(streamSpeechScopeDigest(saved));
  const direct = structuredClone(complete.draft); direct.topics.Q04 = { presented: true, answers: { 'lastMeasuredWeight.value': { state: 'known', value: 240, sourceIds: [f.ctx.source.id] } } };
  expect(streamSpeechScopeDigest(direct)).not.toBe(streamSpeechScopeDigest(saved));
  expect(complete.draft.adaptive!.operations[f.id].stream!.provisional!.claims[0]).toMatchObject({ value: 230, status: 'proposed' });
  expect(interpretationReview(complete.draft)[0].details![0].text).toBe('230');
  expect(f.onReplySaved).toHaveBeenCalledTimes(1);
});
it('a malformed tail leaves the already saved question durable and makes capture partial', async () => {
  const f = fixture(), running = f.run(); await f.notified.promise;
  const prompt = f.current().draft.adaptive!.exchange;
  f.tail.resolve({ draft: { unsupported: true } }); const saved = await running;
  expect(saved.draft.adaptive!.exchange).toEqual(prompt);
  expect(saved.draft.adaptive!.operations[f.id].stream).toMatchObject({ reply: 'saved', capture: 'partial' });
  expect(saved.draft.adaptive!.operations[f.id].status).toBe('failed');
});
it('a typed correction wins without allowing the later capture to change the edited target or current question', async () => {
  const f = fixture(), running = f.run(); await f.notified.promise;
  f.edit(draft => { draft.topics.Q04 = { presented: true, answers: { 'lastMeasuredWeight.value': { state: 'known', value: 240, sourceIds: ['direct-correction'] } } }; draft.activeTopic = 'Q05'; });
  const before = f.current().draft;
  expect(before.adaptive!.targetGenerations![targetKey('Q04', 'lastMeasuredWeight.value')]).toBe(1);
  f.tail.resolve({ draft: f.draft }); const saved = await running;
  expect(saved.draft.topics).toEqual(before.topics); expect(saved.draft.activeTopic).toBe('Q05');
  expect(saved.draft.adaptive!.exchange).toEqual(before.adaptive!.exchange);
  expect(saved.draft.adaptive!.operations[f.id].stream!.provisional!.claims[0].status).toBe('superseded');
});
it('discard or frozen review prevents any tail capture or question change', async () => {
  for (const phase of ['discard', 'review', 'confirmed'] as const) {
    const f = fixture(), running = f.run(); await f.notified.promise;
    f.edit(draft => { if (phase === 'discard') { draft.adaptive!.operations[f.id].status = 'discarded'; draft.adaptive!.operations[f.id].stream!.capture = 'discarded'; } else draft.phase = phase; });
    const before = f.current(); f.tail.resolve({ draft: f.draft }); const saved = await running;
    expect(saved).toEqual(before); expect(f.propose).toHaveBeenCalledTimes(1);
  }
});
it('an unknown reply save cannot notify or silently continue to clinical capture', async () => {
  const f = fixture(); f.failReply(); const saved = await f.run();
  expect(f.onReplySaved).not.toHaveBeenCalled();
  expect(saved.draft.adaptive!.exchange).toBeUndefined();
  expect(saved.draft.adaptive!.operations[f.id].stream!.capture).toBe('partial');
});
it('timeout records partial capture and late provider completion cannot apply or notify again', async () => {
  const f = fixture(), running = f.run(undefined, 20); await f.notified.promise;
  const saved = await running, before = f.current();
  expect(saved.draft.adaptive!.operations[f.id].status).toBe('unresolved');
  f.tail.resolve({ draft: f.draft }); await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.current()).toEqual(before); expect(f.propose).toHaveBeenCalledTimes(1); expect(f.onReplySaved).toHaveBeenCalledTimes(1);
});
it('one reread recomputes terminal metadata across an actual tail-save/direct-edit CAS conflict without rerunning inference', async () => {
  const f = fixture(), running = f.run(); await f.notified.promise;
  f.raceTail(draft => { draft.topics.Q04 = { presented: true, answers: { 'lastMeasuredWeight.value': { state: 'known', value: 240, sourceIds: ['correction'] } } }; });
  f.tail.resolve({ draft: f.draft }); const saved = await running;
  expect(saved.draft.adaptive!.operations[f.id].status).toBe('applied');
  expect(saved.draft.adaptive!.operations[f.id].stream!.provisional!.claims[0].status).toBe('superseded');
  expect(saved.draft.topics.Q04.answers['lastMeasuredWeight.value']).toMatchObject({ value: 240 });
  expect(f.propose).toHaveBeenCalledTimes(1);
});
it('capacity settles as explicit partial source retention rather than stranding processing', async () => {
  const f = fixture(), running = f.run(); await f.notified.promise;
  f.edit(draft => { draft.notice = { tone: 'info', text: 'x'.repeat(492000) }; });
  f.tail.resolve({ draft: f.draft }); const saved = await running;
  const op = saved.draft.adaptive!.operations[f.id];
  expect(op).toMatchObject({ status: 'failed', errorCode: 'provisional-capacity', stream: { reply: 'saved', capture: 'partial' } });
  expect(op.stream!.provisional!.claims).toEqual([]);
  expect(op.stream!.provisional!.gaps[0]).toMatchObject({ reason: 'capacity' });
  expect(saved.draft.turns).toEqual(f.current().draft.turns); expect(f.propose).toHaveBeenCalledTimes(1);
});
