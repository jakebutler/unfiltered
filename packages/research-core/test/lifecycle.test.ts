import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../convex/schema';
import { api, internal } from '../../../convex/_generated/api';
import { hashCapability } from '../../../convex/access';

const modules = import.meta.glob('../../../convex/**/*.ts');
const paginationOpts = { numItems: 25, cursor: null };
const consent = { version: 'research-consent-1' as const, storage: true, analysis: true, microphone: false, camera: false, screen: false, shareTranscript: false, shareAudio: false, shareCamera: false, shareScreen: false, retainApprovedExcerpts: false };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-10T03:00:00Z')); });
afterEach(() => vi.useRealTimers());
async function fixture() {
  const t = convexTest(schema, modules);
  const userId = await t.run(ctx => ctx.db.insert('users', { email: 'lifecycle@corvo.example' }));
  const authSession = await t.run(async ctx => {
    await ctx.db.insert('researchOperators', { role: 'operator', userId, name: 'Lifecycle fixture', active: true });
    return ctx.db.insert('authSessions', { userId, expirationTime: Date.now() + 60 * 86400000 });
  });
  const op = t.withIdentity({ subject: `${userId}|${authSession}` });
  const clientId = await op.mutation(api.research.createClient, { name: 'Lifecycle test' });
  const projectId = await op.mutation(api.research.createProject, { clientId, name: 'Lifecycle test' });
  const { studyId } = await op.mutation(api.research.saveStudy, { clientId, projectId, expectedRevision: 0, definition: { title: 'Lifecycle test', introduction: 'Synthetic only', goals: ['Retention'], script: [{ id: 'q1', question: 'First?' }, { id: 'q2', question: 'Second?' }], prototypeUrl: null, repository: null } });
  const token = 'f'.repeat(64);
  const invite = await op.mutation(internal.invitations.issue, { clientId, projectId, studyVersion: 1, requestId: 'lifecycle-invite', tokenHash: await hashCapability(token) });
  const scope = { userId, ownerId: userId, clientId, projectId, studyId };
  const callbackScope = { ownerId: userId, clientId, projectId, studyId, sessionId: invite.sessionId };
  const expiryArgs = { ...callbackScope, invitationId: invite.invitationId, expiresAt: invite.expiresAt };
  const purgeArgs = { ...callbackScope, retainUntil: Date.now() + 30 * 86400000 };
  return { t, op, scope, token, invite, expiryArgs, purgeArgs };
}
async function addSources(f: Awaited<ReturnType<typeof fixture>>) {
  await f.t.mutation(api.participant.agree, { token: f.token, expectedRevision: 0, consent });
  const answer = await f.t.mutation(api.participant.answer, { token: f.token, expectedRevision: 1, requestId: 'original-answer', questionId: 'q1', text: 'Original private words', channel: 'text' });
  await f.t.mutation(api.participant.correct, { token: f.token, expectedRevision: 2, requestId: 'corrected-answer', sourceId: answer.sourceId, text: 'Corrected private words' });
}

describe('research scheduled lifecycle', () => {
  it('native fixture cannot be used without the explicit local deployment opt-in', async () => {
    const f = await fixture();
    await expect(f.t.mutation(internal.lifecycleQualification.prepare, { invitationId: f.invite.invitationId })).rejects.toThrow('Local lifecycle qualification is disabled');
  });
  it('issuance atomically registers seven-day expiry and thirty-day retention callbacks', async () => {
    const f = await fixture();
    const jobs = await f.t.run(ctx => ctx.db.system.query('_scheduled_functions').collect());
    expect(jobs.map(j => j.scheduledTime).sort()).toEqual([f.expiryArgs.expiresAt, f.purgeArgs.retainUntil]);
    expect((await f.t.run(ctx => ctx.db.get(f.invite.invitationId)))?.lifecycleVersion).toBe(1);
    expect((await f.t.run(ctx => ctx.db.get(f.invite.sessionId)))?.retentionState).toBe('retained');
  });
  it('expiry callback changes persisted state at the deadline; early and repeated callbacks are harmless', async () => {
    const f = await fixture();
    await f.t.mutation(internal.lifecycle.expireInvitation, f.expiryArgs);
    expect((await f.t.run(ctx => ctx.db.get(f.invite.invitationId)))?.expiredAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(7 * 86400000);
    await f.t.finishInProgressScheduledFunctions();
    const row = await f.t.run(ctx => ctx.db.get(f.invite.invitationId));
    expect(row?.expiredAt).toBe(f.expiryArgs.expiresAt);
    await expect(f.t.query(api.participant.resume, { token: f.token })).rejects.toThrow('Access unavailable');
    await f.t.mutation(internal.lifecycle.expireInvitation, f.expiryArgs);
    expect(await f.t.run(ctx => ctx.db.get(f.invite.invitationId))).toEqual(row);
  });
  it('wall clock denies access even before the delayed expiry or retention callback runs', async () => {
    const f = await fixture();
    vi.setSystemTime(f.expiryArgs.expiresAt);
    expect((await f.t.run(ctx => ctx.db.get(f.invite.invitationId)))?.expiredAt).toBeUndefined();
    await expect(f.t.query(api.participant.resume, { token: f.token })).rejects.toThrow('Access unavailable');
    vi.setSystemTime(f.purgeArgs.retainUntil);
    await expect(f.op.query(api.research.sessionSources, { clientId: f.scope.clientId, projectId: f.scope.projectId, sessionId: f.invite.sessionId, paginationOpts })).rejects.toThrow('Access unavailable');
  });
  it('stale deadline and stale scope callbacks cannot expire or purge a changed record', async () => {
    const f = await fixture(); await addSources(f);
    vi.setSystemTime(f.purgeArgs.retainUntil + 1);
    const foreignClient = await f.op.mutation(api.research.createClient, { name: 'Unrelated' });
    await f.t.mutation(internal.lifecycle.expireInvitation, { ...f.expiryArgs, clientId: foreignClient });
    await f.t.mutation(internal.lifecycle.purgeSources, { ...f.purgeArgs, clientId: foreignClient });
    await f.t.mutation(internal.lifecycle.expireInvitation, { ...f.expiryArgs, expiresAt: f.expiryArgs.expiresAt - 1 });
    await f.t.mutation(internal.lifecycle.purgeSources, { ...f.purgeArgs, retainUntil: f.purgeArgs.retainUntil - 1 });
    expect((await f.t.run(ctx => ctx.db.get(f.invite.invitationId)))?.expiredAt).toBeUndefined();
    expect((await f.t.run(ctx => ctx.db.get(f.invite.sessionId)))?.sourceCount).toBe(4);
  });
  it('purges prompts, original and corrected text and keeps a metadata-only tombstone', async () => {
    const f = await fixture(); await addSources(f);
    const sibling = await f.op.mutation(internal.invitations.issue, { clientId: f.scope.clientId, projectId: f.scope.projectId, studyVersion: 1, requestId: 'sibling-invite', tokenHash: await hashCapability('e'.repeat(64)) });
    await f.t.mutation(api.participant.agree, { token: 'e'.repeat(64), expectedRevision: 0, consent });
    await f.t.mutation(internal.lifecycle.purgeSources, f.purgeArgs);
    expect((await f.t.run(ctx => ctx.db.get(f.invite.sessionId)))?.sourceCount).toBe(4);
    vi.setSystemTime(f.purgeArgs.retainUntil);
    await f.t.mutation(internal.lifecycle.purgeSources, f.purgeArgs);
    const tombstone = await f.t.run(ctx => ctx.db.get(f.invite.sessionId));
    expect(tombstone).toMatchObject({ retentionState: 'purged', sourceCount: 0, consent: null, consentAt: null, nextQuestion: 0, purgedAt: f.purgeArgs.retainUntil });
    expect(await f.t.run(ctx => ctx.db.query('researchSources').withIndex('by_sessionId_and_sequence', q => q.eq('sessionId', f.invite.sessionId)).collect())).toEqual([]);
    expect((await f.t.run(ctx => ctx.db.query('researchSources').withIndex('by_sessionId_and_sequence', q => q.eq('sessionId', sibling.sessionId)).collect()))).toHaveLength(1);
    await f.t.mutation(internal.lifecycle.purgeSources, f.purgeArgs);
    expect(await f.t.run(ctx => ctx.db.get(f.invite.sessionId))).toEqual(tombstone);
  });
  it('deletes at most 100 sources per callback and continues durably until the session is empty', async () => {
    const f = await fixture();
    await f.t.run(async ctx => {
      for (let i = 0; i < 104; i++) await ctx.db.insert('researchSources', { sessionId: f.invite.sessionId, clientId: f.scope.clientId, projectId: f.scope.projectId, sequence: i, sourceId: `source-${i}`, requestId: `request-${i}`, questionId: 'q1', author: 'participant', channel: 'text', text: 'Private fixture text', recordedAt: Date.now(), supersedes: null });
      await ctx.db.patch(f.invite.sessionId, { sourceCount: 104, consent });
    });
    vi.setSystemTime(f.purgeArgs.retainUntil);
    await f.t.mutation(internal.lifecycle.purgeSources, f.purgeArgs);
    expect(await f.t.run(ctx => ctx.db.get(f.invite.sessionId))).toMatchObject({ retentionState: 'purging', sourceCount: 4, consent: null });
    expect(await f.t.run(ctx => ctx.db.query('researchSources').withIndex('by_sessionId_and_sequence', q => q.eq('sessionId', f.invite.sessionId)).collect())).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(0); await f.t.finishInProgressScheduledFunctions();
    expect(await f.t.run(ctx => ctx.db.get(f.invite.sessionId))).toMatchObject({ retentionState: 'purged', sourceCount: 0 });
  });
  it('persisted purging state denies reads and writes even if a deadline is moved into the future', async () => {
    const f = await fixture(); await addSources(f);
    await f.t.run(ctx => ctx.db.patch(f.invite.sessionId, { retentionState: 'purging' }));
    await expect(f.t.query(api.participant.sources, { token: f.token, paginationOpts })).rejects.toThrow('Access unavailable');
    await expect(f.op.query(api.research.sessionSources, { clientId: f.scope.clientId, projectId: f.scope.projectId, sessionId: f.invite.sessionId, paginationOpts })).rejects.toThrow('Access unavailable');
    await expect(f.t.mutation(api.participant.answer, { token: f.token, expectedRevision: 3, requestId: 'too-late-answer', questionId: 'q2', text: 'Forbidden', channel: 'text' })).rejects.toThrow('Access unavailable');
  });
  it('backfills legacy rows in bounded batches without changing deadlines or duplicating completed work', async () => {
    const f = await fixture();
    await f.t.run(async ctx => {
      const original = (await ctx.db.get(f.invite.sessionId))!;
      const { _id, _creationTime, retentionState, ...legacy } = original;
      for (let i = 0; i < 55; i++) await ctx.db.insert('researchSessions', legacy);
      await ctx.db.patch(f.invite.invitationId, { lifecycleVersion: undefined });
    });
    expect(await f.t.mutation(internal.lifecycle.backfill, {})).toEqual({ invitations: 1, sessions: 50 });
    expect(await f.t.mutation(internal.lifecycle.backfill, {})).toEqual({ invitations: 0, sessions: 5 });
    expect(await f.t.mutation(internal.lifecycle.backfill, {})).toEqual({ invitations: 0, sessions: 0 });
    expect(await f.t.run(ctx => ctx.db.get(f.invite.invitationId))).toMatchObject({ expiresAt: f.expiryArgs.expiresAt, lifecycleVersion: 1 });
  });
  it('recovery sweeps change overdue invitations and resume an interrupted deletion', async () => {
    const f = await fixture(); await addSources(f);
    vi.setSystemTime(f.purgeArgs.retainUntil);
    await f.t.run(ctx => ctx.db.patch(f.invite.sessionId, { retentionState: 'purging' }));
    expect(await f.t.mutation(internal.lifecycle.sweepInvitations, {})).toBe(1);
    expect(await f.t.mutation(internal.lifecycle.sweepInvitations, {})).toBe(0);
    expect(await f.t.mutation(internal.lifecycle.sweepRetention, {})).toBe(1);
    await vi.advanceTimersByTimeAsync(0); await f.t.finishInProgressScheduledFunctions();
    expect(await f.t.run(ctx => ctx.db.get(f.invite.sessionId))).toMatchObject({ retentionState: 'purged', sourceCount: 0 });
  });
  it('an overdue legacy session is scheduled by migration and has all source content physically deleted', async () => {
    const f = await fixture(); await addSources(f);
    await f.t.run(ctx => ctx.db.patch(f.invite.sessionId, { retentionState: undefined }));
    vi.setSystemTime(f.purgeArgs.retainUntil);
    expect(await f.t.mutation(internal.lifecycle.backfill, {})).toEqual({ invitations: 0, sessions: 1 });
    await vi.advanceTimersByTimeAsync(0); await f.t.finishInProgressScheduledFunctions();
    expect(await f.t.run(ctx => ctx.db.get(f.invite.sessionId))).toMatchObject({ retentionState: 'purged', sourceCount: 0 });
  });
});
