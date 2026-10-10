import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import schema from '../../../convex/schema';
import { api, internal } from '../../../convex/_generated/api';
import { signInProfile } from '../../../convex/auth';
import { hashCapability } from '../../../convex/access';

const modules = import.meta.glob('../../../convex/**/*.ts');
const paginationOpts = { numItems: 10, cursor: null };
const definition = { title: 'Checkout research', introduction: 'A fictional study.', goals: ['Understand checkout'], script: [{ id: 'q1', question: 'What do you expect here?' }, { id: 'q2', question: 'What was confusing?' }], prototypeUrl: null, repository: null };
const consent = { version: 'research-consent-1' as const, storage: true, analysis: true, microphone: true, camera: false, screen: false, shareTranscript: false, shareAudio: false, shareCamera: false, shareScreen: false, retainApprovedExcerpts: false };

async function fixture() {
  const t = convexTest(schema, modules);
  const userId = await t.run(async ctx => { const id = await ctx.db.insert('users', { email: 'operator@corvo.example' }); await ctx.db.insert('researchOperators', { userId: id, role: 'operator', name: 'Operator', active: true }); return id; });
  const authSessionId = await t.run(ctx => ctx.db.insert('authSessions', { userId, expirationTime: Date.now() + 3600000 }));
  const op = t.withIdentity({ subject: `${userId}|${authSessionId}` });
  const clientId = await op.mutation(api.research.createClient, { name: 'Client A' });
  const clientB = await op.mutation(api.research.createClient, { name: 'Client B' });
  const projectId = await op.mutation(api.research.createProject, { clientId, name: 'Checkout' });
  await op.mutation(api.research.saveStudy, { clientId, projectId, expectedRevision: 0, definition });
  const token = 'a'.repeat(64);
  const invite = await op.mutation(internal.invitations.issue, { clientId, projectId, studyVersion: 1, requestId: 'invite-0001', tokenHash: await hashCapability(token) });
  return { t, op, userId, authSessionId, clientId, clientB, projectId, token, invite };
}

describe('research authorization and scope', () => {
  test('anonymous and unrelated identities cannot enumerate or mutate clients', async () => {
    const { t } = await fixture();
    await expect(t.query(api.research.clients, { paginationOpts })).rejects.toThrow('Access unavailable');
    await expect(t.withIdentity({ subject: 'someone-else' }).mutation(api.research.createClient, { name: 'Intruder' })).rejects.toThrow('Access unavailable');
  });
  test('mixed client/project identifiers fail on write, study read and sources', async () => {
    const { op, clientB, projectId, invite } = await fixture();
    await expect(op.mutation(api.research.saveStudy, { clientId: clientB, projectId, expectedRevision: 1, definition })).rejects.toThrow('Access unavailable');
    await expect(op.query(api.research.readStudy, { clientId: clientB, projectId, version: 1 })).rejects.toThrow('Access unavailable');
    await expect(op.query(api.research.sessionSources, { clientId: clientB, projectId, sessionId: invite.sessionId, paginationOpts })).rejects.toThrow('Access unavailable');
  });
  test('public sign up and password reset flows are closed', () => {
    for (const flow of ['signUp', 'reset', 'reset-verification', 'email-verification', '']) expect(() => signInProfile({ flow, email: 'x@y.com', password: 'x'.repeat(20) })).toThrow();
    expect(signInProfile({ flow: 'signIn', email: ' OPERATOR@CORVO.EXAMPLE ', password: 'x'.repeat(20) }).email).toBe('operator@corvo.example');
  });
  test('deleted auth session cannot keep using an otherwise valid identity', async () => {
    const { t, op, authSessionId } = await fixture();
    await t.run(ctx => ctx.db.delete(authSessionId));
    await expect(op.query(api.research.me, {})).rejects.toThrow('Access unavailable');
  });
  test('operator pages expose no token hashes or owner credentials', async () => {
    const { op, clientId, projectId } = await fixture();
    expect((await op.query(api.research.clients, { paginationOpts })).page).toHaveLength(2);
    expect((await op.query(api.research.projects, { clientId, paginationOpts })).page).toHaveLength(1);
    expect((await op.query(api.research.sessions, { clientId, projectId, paginationOpts })).page).toHaveLength(1);
    const invites = await op.query(api.invitations.list, { clientId, projectId, paginationOpts });
    expect(invites.page).toHaveLength(1); expect(invites.page[0]).not.toHaveProperty('tokenHash');
    expect((await op.query(api.research.project, { clientId, projectId })).client.name).toBe('Client A');
  });
  test('revocation stops both existing reads and writes immediately', async () => {
    const { t, op, clientId, projectId, token, invite } = await fixture();
    await t.query(api.participant.resume, { token });
    await op.mutation(api.invitations.revoke, { clientId, projectId, invitationId: invite.invitationId });
    await expect(t.query(api.participant.resume, { token })).rejects.toThrow('Access unavailable');
    await expect(t.mutation(api.participant.agree, { token, expectedRevision: 0, consent })).rejects.toThrow('Access unavailable');
  });
  test('expiry, archival and invalid capabilities fail closed', async () => {
    const { t, op, clientId, token, invite } = await fixture();
    await expect(t.query(api.participant.resume, { token: 'b'.repeat(64) })).rejects.toThrow('Access unavailable');
    await t.run(ctx => ctx.db.patch(invite.invitationId, { expiresAt: Date.now() - 1 }));
    await expect(t.query(api.participant.resume, { token })).rejects.toThrow('Access unavailable');
    await t.run(ctx => ctx.db.patch(invite.invitationId, { expiresAt: Date.now() + 100000 }));
    await op.mutation(api.research.updateClient, { clientId, expectedRevision: 0, name: 'A', state: 'archived' });
    await expect(t.query(api.participant.resume, { token })).rejects.toThrow('Access unavailable');
  });
  test('participant cannot read another session by supplying its identifier', async () => {
    const { t, op, clientId, projectId, token } = await fixture();
    const other = await op.mutation(internal.invitations.issue, { clientId, projectId, studyVersion: 1, requestId: 'invite-0002', tokenHash: await hashCapability('b'.repeat(64)) });
    await expect(t.query(api.participant.sources, { token, paginationOpts, sessionId: other.sessionId } as never)).rejects.toThrow();
    expect((await t.query(api.participant.sources, { token, paginationOpts })).page).toEqual([]);
  });
});

describe('immutable study and durable interview', () => {
  test('invitation retains its exact study after later edits, and context stays private', async () => {
    const { t, op, clientId, projectId, token } = await fixture();
    await op.mutation(api.research.saveStudy, { clientId, projectId, expectedRevision: 1, definition: { ...definition, title: 'New private study' } });
    const resume = await t.query(api.participant.resume, { token });
    expect(resume.title).toBe('Checkout research'); expect(resume).not.toHaveProperty('goals'); expect(resume).not.toHaveProperty('repository');
    expect((await op.query(api.research.readStudy, { clientId, projectId, version: 1 }))?.definition.title).toBe('Checkout research');
  });
  test('no sources or answers before explicit storage and analysis consent', async () => {
    const { t, token } = await fixture();
    await expect(t.mutation(api.participant.agree, { token, expectedRevision: 0, consent: { ...consent, analysis: false } })).rejects.toThrow();
    await expect(t.mutation(api.participant.answer, { token, expectedRevision: 0, requestId: 'answer-0001', questionId: 'q1', text: 'hello', channel: 'text' })).rejects.toThrow();
    expect((await t.query(api.participant.sources, { token, paginationOpts })).page).toHaveLength(0);
  });
  test('accepted response survives a lost acknowledgement and is not duplicated', async () => {
    const { t, token } = await fixture();
    await t.mutation(api.participant.agree, { token, expectedRevision: 0, consent });
    const args = { token, expectedRevision: 1, requestId: 'answer-0001', questionId: 'q1', text: '  I expected delivery choices.\n', channel: 'text' as const };
    const saved = await t.mutation(api.participant.answer, args);
    expect(await t.mutation(api.participant.answer, args)).toEqual(saved);
    await expect(t.mutation(api.participant.answer, { ...args, text: 'Changed' })).rejects.toThrow('different content');
    const sources = (await t.query(api.participant.sources, { token, paginationOpts })).page;
    expect(sources).toHaveLength(3); expect(sources[1].text).toBe(args.text); expect(sources[1].sourceId).toBe(saved.sourceId);
  });
  test('stale revisions, wrong current question and forged channels are rejected', async () => {
    const { t, token } = await fixture();
    await t.mutation(api.participant.agree, { token, expectedRevision: 0, consent });
    const args = { token, expectedRevision: 1, requestId: 'answer-0001', questionId: 'q1', text: 'hello', channel: 'text' as const };
    await expect(t.mutation(api.participant.answer, { ...args, expectedRevision: 0 })).rejects.toThrow('changed');
    await expect(t.mutation(api.participant.answer, { ...args, questionId: 'q2' })).rejects.toThrow('not ready');
    await expect(t.mutation(api.participant.answer, { ...args, channel: 'script' } as never)).rejects.toThrow();
  });
  test('correction preserves original, rejects cross-session source and branches', async () => {
    const { t, token } = await fixture();
    await t.mutation(api.participant.agree, { token, expectedRevision: 0, consent });
    const saved = await t.mutation(api.participant.answer, { token, expectedRevision: 1, requestId: 'answer-0001', questionId: 'q1', text: 'Original', channel: 'text' });
    const correction = await t.mutation(api.participant.correct, { token, expectedRevision: 2, requestId: 'correct-0001', sourceId: saved.sourceId, text: 'Correction' });
    await expect(t.mutation(api.participant.correct, { token, expectedRevision: 3, requestId: 'correct-0002', sourceId: saved.sourceId, text: 'Branch' })).rejects.toThrow('latest version');
    await expect(t.mutation(api.participant.correct, { token, expectedRevision: 3, requestId: 'correct-0003', sourceId: 'other:1', text: 'Cross session' })).rejects.toThrow('Source unavailable');
    const sources = (await t.query(api.participant.sources, { token, paginationOpts })).page;
    expect(sources.find(s => s.sourceId === saved.sourceId)?.text).toBe('Original');
    expect(sources.find(s => s.sourceId === correction.sourceId)?.supersedes).toBe(saved.sourceId);
  });
  test('pause/resume preserves progress, complete requires all questions, closed is immutable', async () => {
    const { t, token } = await fixture();
    await t.mutation(api.participant.agree, { token, expectedRevision: 0, consent });
    await t.mutation(api.participant.transition, { token, expectedRevision: 1, state: 'paused' });
    expect((await t.query(api.participant.resume, { token })).question?.id).toBe('q1');
    await expect(t.mutation(api.participant.transition, { token, expectedRevision: 2, state: 'completed' })).rejects.toThrow('partial');
    await t.mutation(api.participant.transition, { token, expectedRevision: 2, state: 'partial' });
    await expect(t.mutation(api.participant.transition, { token, expectedRevision: 3, state: 'active' })).rejects.toThrow('closed');
  });
  test('bounded queries and context reject overlarge or credential-bearing inputs', async () => {
    const { op, clientId, projectId } = await fixture();
    await expect(op.query(api.research.clients, { paginationOpts: { cursor: null, numItems: 1000 } })).rejects.toThrow('1–25');
    await expect(op.mutation(api.research.saveStudy, { clientId, projectId, expectedRevision: 1, definition: { ...definition, repository: { url: 'https://github.com/demo/repo', revision: 'a'.repeat(40), files: [{ path: '.env.local', text: 'safe' }] } } })).rejects.toThrow('safe relative');
    await expect(op.mutation(api.research.saveStudy, { clientId, projectId, expectedRevision: 1, definition: { ...definition, prototypeUrl: 'https://example.com/?token=secret' } })).rejects.toThrow('without credentials');
  });
});
