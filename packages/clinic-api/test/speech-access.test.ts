import { describe, expect, it } from 'vitest';
import { createSpeechAccess } from '../src/speech-access.js';
import { cookies, type Claims } from '../src/cookies.js';
import { conversation } from '../src/conversation.js';
import { adaptiveSession, type AdaptiveDraftStore } from '../src/adaptive-session.js';
import { DRAFT_SYSTEM, document } from '../src/store.js';
import type { ClinicApiConfig, Draft, StoredDraft } from '../src/types.js';
import type { Runtime } from '../src/runtime.js';
import { streamSpeechScopeDigest } from '../src/adaptive-stream-session.js';

const origin = 'http://127.0.0.1:5173';
const patient = { reference: 'Patient/synthetic', displayName: 'Synthetic', description: 'Fictional', careTeams: { medical: 'CareTeam/md', nutrition: 'CareTeam/rd', administrative: 'CareTeam/admin' } };
const config = { origin, cookieSecret: 'test-only-secret'.repeat(4), mentalHealth: 'phq4', patients: Object.fromEntries(['first-intake', 'pre-visit', 'non-visit', 'post-visit', 'billing', 'scheduling', 'refill'].map(id => [id, patient])) } as ClinicApiConfig;
const content = conversation(config);
async function fixture(enabled = true) {
  let draft: Draft = { schema: 1, id: crypto.randomUUID(), patient: patient.reference, scenario: 'first-intake', revision: 3, savedAt: new Date().toISOString(), createdAt: new Date().toISOString(), phase: 'conversation', turns: [], topics: {}, requests: {}, version: 1 };
  const resource = () => ({ ...document(DRAFT_SYSTEM, draft.id, draft.patient, draft), id: 'draft', meta: { versionId: '1' } });
  const runtime = async () => ({ client: { request: async () => ({ body: { resourceType: 'Bundle', type: 'searchset', total: 1, entry: [{ resource: resource() }] } }) } } as unknown as Runtime);
  const access = createSpeechAccess(config, { enabled, runtime, adaptiveAvailable: true });
  const claims: Claims = { kind: 'patient', sessionId: draft.id, patient: draft.patient, scenario: draft.scenario, identityConfirmed: true, expires: Date.now() + 100000 };
  const request = async (overrides: Partial<Claims> = {}, requestOrigin = origin) => new Request(`${origin}/api/clinic/speech/input`, { headers: { origin: requestOrigin, cookie: (await cookies(config.cookieSecret, false).issue('clinic_patient', { ...claims, ...overrides } as Claims)).split(';')[0] } });
  const scope = () => ({ sessionId: draft.id, expectedRevision: draft.revision, promptId: content.view(draft, true, true).currentPrompt!.id, requestId: crypto.randomUUID() });
  return { access, request, scope, draft: () => draft, set: (d: Draft) => { draft = d; }, stored: () => ({ resource: resource(), draft, versionId: '1' }) as StoredDraft };
}
describe('clinic speech authorization', () => {
  it('authorizes only the saved early question across metadata-only tail revisions and revokes it on semantic edits or consent loss', async () => {
    const f = await fixture(), adaptive = adaptiveSession(content, { propose: async () => { throw Error('must-not-call'); } });
    f.set(adaptive.initialize(f.draft()));
    const store: AdaptiveDraftStore = { read: async () => f.stored(), save: async (_previous, next) => { f.set(next); return f.stored(); } };
    const accepted = await adaptive.accept(store, { requestId: crypto.randomUUID(), expectedRevision: 3, text: 'I want more energy.', channel: 'text' });
    const early = structuredClone(accepted.draft), op = early.adaptive!.operations[accepted.operation.id];
    early.revision = 6; op.status = 'processing'; op.attemptId = crypto.randomUUID(); op.processingRevision = 5; op.deadlineAt = new Date(Date.now() + 10000).toISOString();
    op.stream = { protocol: 'durable-provisional-stream-v1', reply: 'saved', capture: 'pending', targetGenerations: {}, replyId: `${op.id}:Q01` };
    op.stream.replyScope = { revision: 6, sha256: streamSpeechScopeDigest(early) }; f.set(early);
    const input = f.scope(), request = await f.request();
    await expect(f.access.capture(request, input)).resolves.toMatchObject({ revision: 6 });
    const output = { sessionId: input.sessionId, requestId: input.requestId, expectedRevision: 6, sourceId: input.promptId };
    await expect(f.access.output(request, output)).resolves.toMatchObject({ revision: 6 });
    const tail = structuredClone(early); tail.revision = 7;
    tail.adaptive!.operations[op.id].status = 'unresolved'; tail.adaptive!.operations[op.id].stream!.capture = 'partial'; f.set(tail);
    await expect(f.access.capture(request, input)).resolves.toMatchObject({ revision: 6 });
    await expect(f.access.output(request, output)).resolves.toMatchObject({ revision: 6 });
    await expect(f.access.capture(await f.request({ identityConfirmed: false }), input)).rejects.toMatchObject({ code: 'identity-confirmation-required' });
    for (const change of [
      (draft: Draft) => { draft.topics.Q01 = { presented: true, answers: { reason: { state: 'known', value: 'Changed priority', sourceIds: [op.sourceId] } } }; },
      (draft: Draft) => { draft.turns.push({ id: crypto.randomUUID(), role: 'patient', text: 'New words', at: new Date().toISOString() }); },
      (draft: Draft) => { draft.adaptive!.exchange!.prompt!.text = 'Changed question'; },
      (draft: Draft) => { draft.adaptive!.mode = 'guided'; },
    ]) {
      const edited = structuredClone(tail); edited.revision++; change(edited); f.set(edited);
      await expect(f.access.capture(request, input)).rejects.toMatchObject({ code: 'stale-session' });
      await expect(f.access.output(request, output)).rejects.toMatchObject({ code: 'stale-session' });
    }
    f.set({ ...tail, phase: 'review' }); await expect(f.access.output(request, output)).rejects.toMatchObject({ code: 'speech-conversation-required' });
  });
  it('push-to-talk transcription survives a question change but not a paused, reviewed or foreign session', async () => {
    const f = await fixture(), input = f.scope(), request = await f.request();
    await expect(f.access.upload(request, input)).resolves.toMatchObject({ sessionId: f.draft().id });
    // The transcript only fills the unsent answer box; a newer revision or prompt does not invalidate it.
    f.set({ ...f.draft(), revision: f.draft().revision + 2 });
    await expect(f.access.upload(request, { ...input, promptId: 'Q99:gone' })).resolves.toMatchObject({ revision: f.draft().revision });
    await expect(f.access.capture(request, input)).rejects.toMatchObject({ code: 'stale-session' });
    await expect(f.access.upload(request, { ...input, sessionId: crypto.randomUUID() })).rejects.toMatchObject({ code: 'session-scope-denied' });
    await expect(f.access.upload(await f.request({ identityConfirmed: false }), input)).rejects.toMatchObject({ code: 'identity-confirmation-required' });
    f.set({ ...f.draft(), safety: { rule: 'E04', version: 'E-0.2', sourceId: 's', text: 't', at: new Date().toISOString(), paused: true } });
    await expect(f.access.upload(request, input)).rejects.toMatchObject({ code: 'speech-conversation-required' });
    f.set({ ...f.draft(), safety: undefined, phase: 'review' });
    await expect(f.access.upload(request, input)).rejects.toMatchObject({ code: 'speech-conversation-required' });
  });
  it('requires enabled speech, exact origin, valid confirmed patient cookie', async () => {
    const f = await fixture();
    await expect(f.access.capture(await f.request(), f.scope())).resolves.toMatchObject({ sessionId: f.draft().id });
    for (const origin of ['https://evil.example', '', 'http://localhost:5173']) await expect(f.access.capture(await f.request({}, origin), f.scope())).rejects.toMatchObject({ code: 'origin-denied' });
    await expect(f.access.capture(await f.request({ identityConfirmed: false }), f.scope())).rejects.toMatchObject({ code: 'identity-confirmation-required' });
    await expect(f.access.capture(new Request(`${origin}/api/clinic/speech/input`, { headers: { origin } }), f.scope())).rejects.toMatchObject({ code: 'session-required' });
    const disabled = await fixture(false); await expect(disabled.access.capture(await disabled.request(), disabled.scope())).rejects.toMatchObject({ code: 'speech-unavailable' });
  });
  it('denies cross-session, wrong patient, stale revision and stale prompt', async () => {
    const f = await fixture(), request = await f.request();
    await expect(f.access.capture(request, { ...f.scope(), sessionId: crypto.randomUUID() })).rejects.toMatchObject({ code: 'session-scope-denied' });
    await expect(f.access.capture(await f.request({ patient: 'Patient/other' } as Partial<Claims>), f.scope())).rejects.toMatchObject({ code: 'session-scope-denied' });
    await expect(f.access.capture(request, { ...f.scope(), expectedRevision: 2 })).rejects.toMatchObject({ code: 'stale-session' });
    await expect(f.access.capture(request, { ...f.scope(), promptId: 'guessed' })).rejects.toMatchObject({ code: 'stale-prompt' });
  });
  it('resolves only current prompt/reply text, not patient turns or client-provided text', async () => {
    const f = await fixture(); const scope = f.scope(), request = await f.request();
    const input = { requestId: scope.requestId, sessionId: scope.sessionId, expectedRevision: scope.expectedRevision, sourceId: scope.promptId };
    const resolved = await f.access.output(request, input); expect(resolved.text).toBe(content.view(f.draft()).currentPrompt!.text);
    await expect(f.access.output(request, { ...input, sourceId: 'patient-source' })).rejects.toMatchObject({ code: 'speech-source-denied' });
    await expect(f.access.output(request, { ...input, text: 'Say arbitrary text' } as typeof input)).rejects.toMatchObject({ code: 'invalid-speech-request' });
    f.set({ ...f.draft(), phase: 'review' }); await expect(f.access.output(request, input)).rejects.toMatchObject({ code: 'speech-conversation-required' });
  });
  it.each(['confirmed-transcript', 'unreviewed-transcript'] as const)('keeps frozen PHQ responses on explicit controls instead of %s', async channel => {
    const f = await fixture(); f.set(content.select(f.draft(), 'Q16', 'MH01'));
    await expect(f.access.capture(await f.request(), f.scope())).resolves.toMatchObject({ promptId: 'Q16:MH01' });
    const input = { ...f.scope(), text: '2', action: 'answer' as const, channel };
    expect(() => content.turn(f.draft(), input)).toThrow('explicit-screening-choice-required');
    expect(content.turn(f.draft(), { ...input, channel: 'text' }).topics.Q16.answers.MH01).toMatchObject({ value: 2 });
    f.set({ ...f.draft(), adaptive: { mode: 'adaptive', operations: {}, exchange: { prompt: { topicId: 'Q16', promptId: 'MH01', targetPaths: ['MH01'], kind: 'instrument', text: 'Frozen item', labels: [], optional: false }, state: {}, status: 'question' } } });
    const store: AdaptiveDraftStore = { read: async () => f.stored(), save: async () => { throw Error('must-not-save'); } };
    await expect(adaptiveSession(content, { propose: async () => { throw Error('must-not-call'); } }).accept(store, { requestId: crypto.randomUUID(), expectedRevision: 3, text: 'several days', channel })).rejects.toThrow('explicit-screening-choice-required');
  });
  it('records the confirmed transcript channel only on the normal deliberate answer path', async () => {
    const f = await fixture();
    const next = content.turn(f.draft(), { ...f.scope(), action: 'answer', text: 'Improve everyday energy.', channel: 'confirmed-transcript' });
    expect(next.turns.at(-1)).toMatchObject({ channel: 'confirmed-transcript' });
    expect(f.draft().turns).toHaveLength(0);
  });
  it('speaks every frozen option and only a current offered choice confirmation', async () => {
    const f = await fixture(); f.set(content.select(f.draft(), 'Q16', 'MH01'));
    const scope = f.scope(), request = await f.request();
    const input = { requestId: scope.requestId, sessionId: scope.sessionId, expectedRevision: scope.expectedRevision, sourceId: scope.promptId };
    const spoken = await f.access.output(request, input);
    for (const option of ['Not at all', 'Several days', 'More than half the days', 'Nearly every day']) expect(spoken.text).toContain(option);
    await expect(f.access.output(request, { ...input, choiceConfirmation: { value: '1' } })).resolves.toMatchObject({ text: expect.stringContaining('You chose: Several days.') });
    await expect(f.access.output(request, { ...input, choiceConfirmation: { value: 'all zeros' } })).rejects.toMatchObject({ code: 'speech-source-denied' });
    await expect(f.access.output(request, { ...input, sourceId: 'Q16:MH02', choiceConfirmation: { value: '1' } })).rejects.toMatchObject({ code: 'speech-source-denied' });
  });
  it('resolves combined reply and current question from the same authorized revision', async () => {
    const f = await fixture();
    f.set({ ...f.draft(), adaptive: { mode: 'adaptive', operations: {}, exchange: { prompt: { topicId: 'Q04', promptId: 'Q04', targetPaths: ['height.value'], kind: 'detail', text: 'What is your height?', labels: [], optional: false }, reply: { id: 'COPY-05', text: 'Ask your prescriber about changes to your dose.' }, state: {}, status: 'question' } } });
    const request = await f.request(), scope = f.scope();
    const input = { requestId: scope.requestId, sessionId: scope.sessionId, expectedRevision: scope.expectedRevision, sourceId: 'conversation-current' };
    const view = content.view(f.draft(), true, true);
    await expect(f.access.output(request, input)).resolves.toMatchObject({ text: `${view.adaptive!.reply!.text}\n\n${view.currentPrompt!.text}` });
    f.set({ ...f.draft(), revision: f.draft().revision + 1 });
    await expect(f.access.output(request, input)).rejects.toMatchObject({ code: 'stale-session' });
  });
  it('preserves confirmed transcript provenance before interpretation and denies capture while it is pending', async () => {
    const f = await fixture(); const adaptive = adaptiveSession(content, { propose: async () => { throw Error('must-not-call'); } });
    f.set(adaptive.initialize(f.draft()));
    const store: AdaptiveDraftStore = { read: async () => f.stored(), save: async (_previous, next) => { f.set(next); return f.stored(); } };
    const result = await adaptive.accept(store, { requestId: crypto.randomUUID(), expectedRevision: 3, text: 'I want more energy.', channel: 'confirmed-transcript' });
    expect(result.draft.turns.at(-1)).toMatchObject({ text: 'I want more energy.', channel: 'confirmed-transcript' });
    await expect(f.access.capture(await f.request(), f.scope())).rejects.toMatchObject({ code: 'interpretation-pending' });
  });
});
describe('hosted hands-free token authorization', () => {
  it('mints for the current natural or free-text prompt of the verified session', async () => {
    const f = await fixture(), request = await f.request(), scope = f.scope();
    await expect(f.access.token(request, scope)).resolves.toEqual({ sessionId: f.draft().id, promptId: scope.promptId, revision: 3 });
    f.set({ ...f.draft(), adaptive: { mode: 'adaptive', operations: {}, exchange: { prompt: { topicId: 'Q04', promptId: 'Q04', targetPaths: ['height.value'], kind: 'detail', text: 'What is your height?', labels: [], optional: false }, state: {}, status: 'question' } } });
    const natural = f.scope();
    expect(natural.promptId).toBe('Q04:Q04');
    await expect(f.access.token(request, natural)).resolves.toMatchObject({ promptId: 'Q04:Q04', revision: 3 });
  });
  it('refuses exact-choice and structured-field prompts as button-only', async () => {
    const f = await fixture(), request = await f.request();
    f.set(content.select(f.draft(), 'Q06'));
    expect(f.scope().promptId).toBe('Q06:conditions.diabetes');
    await expect(f.access.token(request, f.scope())).rejects.toMatchObject({ code: 'speech-buttons-only', status: 409 });
    f.set(content.select(f.draft(), 'Q04'));
    expect(f.scope().promptId).toBe('Q04:height.value');
    await expect(f.access.token(request, f.scope())).rejects.toMatchObject({ code: 'speech-buttons-only' });
  });
  it('refuses PHQ-4 items even though they are otherwise capture-eligible', async () => {
    const f = await fixture(), request = await f.request();
    f.set(content.select(f.draft(), 'Q16', 'MH01'));
    await expect(f.access.capture(request, f.scope())).resolves.toMatchObject({ promptId: 'Q16:MH01' });
    await expect(f.access.token(request, f.scope())).rejects.toMatchObject({ code: 'speech-buttons-only' });
  });
  it('refuses a stale revision, a wrong prompt, a paused safety state and a confirmed draft', async () => {
    const f = await fixture(), request = await f.request(), scope = f.scope();
    await expect(f.access.token(request, { ...scope, expectedRevision: 2 })).rejects.toMatchObject({ code: 'stale-session', status: 409 });
    await expect(f.access.token(request, { ...scope, promptId: 'guessed' })).rejects.toMatchObject({ code: 'stale-prompt', status: 409 });
    f.set({ ...f.draft(), safety: { rule: 'E04', version: 'E-0.2', sourceId: 's', text: 't', at: new Date().toISOString(), paused: true } });
    await expect(f.access.token(request, scope)).rejects.toMatchObject({ code: 'speech-conversation-required', status: 409 });
    // Amendment drafts stay in the conversation phase while a confirmed submission exists.
    f.set({ ...f.draft(), safety: undefined, confirmed: {} as never });
    await expect(f.access.token(request, scope)).rejects.toMatchObject({ code: 'speech-conversation-required', status: 409 });
  });
  it('refuses a foreign origin and an unconfirmed identity before any draft read', async () => {
    const f = await fixture();
    await expect(f.access.token(await f.request({}, 'https://evil.example'), f.scope())).rejects.toMatchObject({ code: 'origin-denied', status: 403 });
    await expect(f.access.token(await f.request({ identityConfirmed: false }), f.scope())).rejects.toMatchObject({ code: 'identity-confirmation-required', status: 403 });
    await expect(f.access.token(await f.request(), { ...f.scope(), sessionId: crypto.randomUUID() })).rejects.toMatchObject({ code: 'session-scope-denied', status: 403 });
  });
});
