import { convexTest } from 'convex-test';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { makeFunctionReference } from 'convex/server';
import schema from '../../../convex/schema';
import { api, internal } from '../../../convex/_generated/api';
import { hashCapability } from '../../../convex/access';
import { signGateway } from '../../research-capture/src/proof';

const modules = import.meta.glob('../../../convex/**/*.ts');
const secret = 'c'.repeat(64), token = 'a'.repeat(64);
const consent = { version: 'research-consent-1' as const, storage: true, analysis: true, microphone: true, camera: false, screen: false, shareTranscript: false, shareAudio: false, shareCamera: false, shareScreen: false, retainApprovedExcerpts: false };
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv('RESEARCH_MEDIA_GATEWAY_SECRET', secret); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function fixture(policy = true) {
  const t = convexTest(schema, modules);
  const userId = await t.run(async ctx => { const id = await ctx.db.insert('users', { email: 'speech@corvo.example' }); await ctx.db.insert('researchOperators', { userId: id, role: 'operator', name: 'Operator', active: true }); return id; });
  const authId = await t.run(ctx => ctx.db.insert('authSessions', { userId, expirationTime: Date.now() + 3600_000 }));
  const op = t.withIdentity({ subject: `${userId}|${authId}` });
  const clientId = await op.mutation(api.research.createClient, { name: 'A' });
  const projectId = await op.mutation(api.research.createProject, { clientId, name: 'Speech' });
  await op.mutation(api.research.saveStudy, { clientId, projectId, expectedRevision: 0, definition: { title: 'Speech study', introduction: 'Synthetic only', goals: ['Observe checkout'], script: [{ id: 'q1', question: 'What do you expect?' }, { id: 'q2', question: 'What happened?' }], prototypeUrl: null, repository: null } });
  const invitation = await op.mutation(internal.invitations.issue, { clientId, projectId, studyVersion: 1, requestId: 'invite-speech', tokenHash: await hashCapability(token) });
  await t.mutation(api.participant.agree, { token, expectedRevision: 0, consent });
  if (policy) await t.run(ctx => ctx.db.insert('researchSpeechPolicy', { name: 'demo', enabled: true, qualification: 'root-reviewed-synthetic-speech', allocatedSeconds: 180, allocatedCharacters: 1200, chargedSeconds: 0, chargedCharacters: 0, maxSessionSeconds: 180, maxSessionCharacters: 1200 }));
  const scope = { sessionId: invitation.sessionId, promptId: 'q1', expectedRevision: 1, requestId: 'speech-attempt-0001' };
  async function read(name: string, input: Record<string, any>) { return t.query(makeFunctionReference<'query'>(`researchSpeech:${name}`), { ...input, proof: await signGateway(secret, `speech:${name}`, input) }); }
  async function write(name: string, input: Record<string, any>) { return t.mutation(makeFunctionReference<'mutation'>(`researchSpeech:${name}`), { ...input, proof: await signGateway(secret, `speech:${name}`, input) }); }
  const reserve = (provider = 'deepgram', nextScope = scope) => write('reserve', { token, scope: nextScope, provider, maxAudioSeconds: provider === 'deepgram' ? 60 : 0, maxCharacters: provider === 'deepgram' ? 0 : 19 });
  return { t, read, write, scope, reserve };
}
test('no reviewed allocation disables speech and provider reservations', async () => {
  const f = await fixture(false);
  expect(await f.read('status', { token })).toEqual({ enabled: false });
  await expect(f.reserve()).rejects.toThrow('Access unavailable');
});
test('public raw writes and forged capabilities cannot create transcripts', async () => {
  const f = await fixture();
  await expect(f.t.mutation(makeFunctionReference<'mutation'>('researchSpeech:saveTranscript'), { token, scope: f.scope, text: 'forged', outcome: 'completed', proof: { at: Date.now(), signature: '0'.repeat(64) } })).rejects.toThrow();
  await expect(f.read('authorize', { token: 'b'.repeat(64), scope: f.scope, provider: 'deepgram' })).rejects.toThrow('Access unavailable');
  expect((await f.t.query(api.participant.sources, { token, paginationOpts: { numItems: 25, cursor: null } })).page).toHaveLength(1);
});
test('unknown attempts remain charged and occupied across new request IDs', async () => {
  const f = await fixture(); await f.reserve();
  await f.write('settle', { sessionId: f.scope.sessionId, requestId: f.scope.requestId, provider: 'deepgram', outcome: 'unknown' });
  await expect(f.reserve('deepgram', { ...f.scope, requestId: 'speech-attempt-0002' })).rejects.toThrow('unresolved');
  await expect(f.reserve()).rejects.toThrow('original');
  const policy = await f.t.run(ctx => ctx.db.query('researchSpeechPolicy').withIndex('by_name', q => q.eq('name', 'demo')).unique());
  expect(policy?.chargedSeconds).toBe(60);
});
test('raw recognition saves once without advancing; edited acceptance preserves raw and advances once', async () => {
  const f = await fixture(); await f.reserve();
  const raw = { token, scope: f.scope, text: 'I wanted a receipt', outcome: 'completed' };
  const saved = await f.write('saveTranscript', raw);
  expect(await f.write('saveTranscript', raw)).toEqual(saved);
  expect(await f.read('readTranscript', { token, scope: f.scope })).toEqual(saved);
  await expect(f.write('saveTranscript', { ...raw, text: 'different raw words' })).rejects.toThrow();
  const before = await f.t.query(api.participant.resume, { token }); expect(before.revision).toBe(1); expect(before.question?.id).toBe('q1');
  const answer = { token, expectedRevision: 1, requestId: 'answer-voice-0001', questionId: 'q1', text: 'I wanted an email receipt', channel: 'confirmed-transcript' as const, speechAttemptId: f.scope.requestId };
  const receipt = await f.t.mutation(api.participant.answer, answer);
  expect(await f.t.mutation(api.participant.answer, answer)).toEqual(receipt);
  const sources = (await f.t.query(api.participant.sources, { token, paginationOpts: { numItems: 25, cursor: null } })).page;
  expect(sources).toHaveLength(4); expect(sources[1].channel).toBe('unreviewed-transcript'); expect(sources[1].text).toBe(raw.text); expect(sources[2].supersedes).toBe(saved.rawSourceId); expect(sources[2].text).toBe(answer.text);
  expect((await f.t.query(api.participant.resume, { token })).question?.id).toBe('q2');
  await expect(f.t.mutation(api.participant.answer, { ...answer, expectedRevision: 2, requestId: 'answer-voice-0002', questionId: 'q2' })).rejects.toThrow('original voice');
});
test('pause denies late raw recognition and exact-generation acceptance', async () => {
  const f = await fixture(); await f.reserve();
  await f.t.mutation(api.participant.transition, { token, expectedRevision: 1, state: 'paused' });
  await expect(f.write('saveTranscript', { token, scope: f.scope, text: 'late words', outcome: 'interrupted' })).rejects.toThrow('changed');
  await expect(f.read('inspect', { token, scope: f.scope, provider: 'deepgram' })).rejects.toThrow('changed');
});
test('owned raw receipt remains readable after pause without authorizing old answer advancement', async () => {
  const f = await fixture(); await f.reserve();
  const saved = await f.write('saveTranscript', { token, scope: f.scope, text: 'original words', outcome: 'completed' });
  await f.t.mutation(api.participant.transition, { token, expectedRevision: 1, state: 'paused' });
  expect(await f.read('readTranscript', { token, scope: f.scope })).toEqual(saved);
  await expect(f.t.mutation(api.participant.answer, { token, expectedRevision: 2, requestId: 'old-answer-001', questionId: 'q1', text: 'corrected words', channel: 'confirmed-transcript', speechAttemptId: f.scope.requestId })).rejects.toThrow();
});
test('TTS resolves actual current script text and rejects arbitrary source or character budgets', async () => {
  const f = await fixture(); const input = { sessionId: f.scope.sessionId, sourceId: 'q1', expectedRevision: 1, requestId: f.scope.requestId };
  expect(await f.read('output', { token, input })).toMatchObject({ text: 'What do you expect?', sourceId: 'q1', revision: 1 });
  await expect(f.read('output', { token, input: { ...input, sourceId: 'q2' } })).rejects.toThrow();
  await expect(f.write('reserve', { token, scope: f.scope, provider: 'elevenlabs', maxAudioSeconds: 0, maxCharacters: 1 })).rejects.toThrow();
});
test('confirmed voice provenance cannot be forged without an immutable raw source', async () => {
  const f = await fixture();
  await expect(f.t.mutation(api.participant.answer, { token, expectedRevision: 1, requestId: 'answer-forged-001', questionId: 'q1', text: 'forged', channel: 'confirmed-transcript' })).rejects.toThrow('saved voice');
});
