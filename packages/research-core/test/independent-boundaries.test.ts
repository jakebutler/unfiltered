import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../convex/schema';
import { api, internal } from '../../../convex/_generated/api';
import { hashCapability } from '../../../convex/access';

// Convex schedules thirty-day retention; fake timers avoid Node's 32-bit timer overflow.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const modules = import.meta.glob('../../../convex/**/*.ts');
const paginationOpts = { numItems: 25, cursor: null };
const consent = { version: 'research-consent-1' as const, storage: true, analysis: true, microphone: false, camera: false, screen: false, shareTranscript: false, shareAudio: false, shareCamera: false, shareScreen: false, retainApprovedExcerpts: false };
async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'independent@corvo.example' });
    const operatorId = await ctx.db.insert('researchOperators', { userId, role: 'operator', name: 'Independent fixture', active: true });
    const authSessionId = await ctx.db.insert('authSessions', { userId, expirationTime: Date.now() + 60_000 });
    return { userId, operatorId, authSessionId };
  });
  const op = t.withIdentity({ subject: `${ids.userId}|${ids.authSessionId}` });
  const clientId = await op.mutation(api.research.createClient, { name: 'Independent client' });
  const projectId = await op.mutation(api.research.createProject, { clientId, name: 'Source scope' });
  await op.mutation(api.research.saveStudy, { clientId, projectId, expectedRevision: 0, definition: { title: 'Scope test', introduction: 'Fictional test.', goals: ['Source isolation'], script: [{ id: 'q1', question: 'What happened?' }], prototypeUrl: null, repository: null } });
  const token = 'c'.repeat(64);
  const invite = await op.mutation(internal.invitations.issue, { clientId, projectId, studyVersion: 1, requestId: 'independent-invite', tokenHash: await hashCapability(token) });
  return { t, op, ...ids, clientId, projectId, token, invite };
}

describe('independent research boundary probes', () => {
  it('an existing signed identity loses reads and writes when its operator is disabled', async () => {
    const f = await fixture();
    await f.t.run(ctx => ctx.db.patch(f.operatorId, { active: false }));
    await expect(f.op.query(api.research.clients, { paginationOpts })).rejects.toThrow('Access unavailable');
    await expect(f.op.mutation(api.research.createProject, { clientId: f.clientId, name: 'Forbidden' })).rejects.toThrow('Access unavailable');
  });
  it('an expired Auth session cannot use a still-present operator identity', async () => {
    const f = await fixture();
    await f.t.run(ctx => ctx.db.patch(f.authSessionId, { expirationTime: Date.now() - 1 }));
    await expect(f.op.query(api.research.me, {})).rejects.toThrow('Access unavailable');
  });
  it('capture sharing is not silently consented and text consent cannot authorize speech sources', async () => {
    const f = await fixture();
    await expect(f.t.mutation(api.participant.agree, { token: f.token, expectedRevision: 0, consent: { ...consent, shareAudio: true } })).rejects.toThrow('Sharing requires matching capture consent');
    await f.t.mutation(api.participant.agree, { token: f.token, expectedRevision: 0, consent });
    await expect(f.t.mutation(api.participant.answer, { token: f.token, expectedRevision: 1, requestId: 'speech-without-consent', questionId: 'q1', text: 'A claimed transcript', channel: 'confirmed-transcript' })).rejects.toThrow('Microphone consent is required');
    expect((await f.t.query(api.participant.sources, { token: f.token, paginationOpts })).page.map(s => s.author)).toEqual(['interviewer']);
  });
  it('a second valid participant capability cannot read or correct the first participant source', async () => {
    const f = await fixture();
    await f.t.mutation(api.participant.agree, { token: f.token, expectedRevision: 0, consent });
    const saved = await f.t.mutation(api.participant.answer, { token: f.token, expectedRevision: 1, requestId: 'private-answer', questionId: 'q1', text: 'Private first participant words.', channel: 'text' });
    const tokenB = 'd'.repeat(64);
    await f.op.mutation(internal.invitations.issue, { clientId: f.clientId, projectId: f.projectId, studyVersion: 1, requestId: 'independent-invite-b', tokenHash: await hashCapability(tokenB) });
    await f.t.mutation(api.participant.agree, { token: tokenB, expectedRevision: 0, consent });
    const other = await f.t.query(api.participant.sources, { token: tokenB, paginationOpts });
    expect(other.page.some(s => s.sourceId === saved.sourceId || s.text.includes('Private first'))).toBe(false);
    await expect(f.t.mutation(api.participant.correct, { token: tokenB, expectedRevision: 1, requestId: 'foreign-correction', sourceId: saved.sourceId, text: 'Replacement' })).rejects.toThrow('Source unavailable');
  });
  it('retention denies both operator and participant source reads on server re-execution', async () => {
    const f = await fixture();
    await f.t.run(ctx => ctx.db.patch(f.invite.sessionId, { retainUntil: Date.now() - 1 }));
    await expect(f.t.query(api.participant.sources, { token: f.token, paginationOpts })).rejects.toThrow('Access unavailable');
    await expect(f.op.query(api.research.sessionSources, { clientId: f.clientId, projectId: f.projectId, sessionId: f.invite.sessionId, paginationOpts })).rejects.toThrow('Access unavailable');
  });
});
