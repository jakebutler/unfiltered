import { convexTest } from 'convex-test';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import schema from '../../../convex/schema';
import { api, internal } from '../../../convex/_generated/api';
const modules = import.meta.glob('../../../convex/**/*.ts');
const allocation = { allocatedSeconds: 120, allocatedCharacters: 400, maxSessionSeconds: 120, maxSessionCharacters: 200 };
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv('CONVEX_CLOUD_URL', 'http://127.0.0.1:3210'); }); afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function fixture() {
  const t = convexTest(schema, modules);
  const userId = await t.run(async ctx => { const id = await ctx.db.insert('users', { email: 'fixture@corvo.example' }); await ctx.db.insert('researchOperators', { userId: id, role: 'operator', name: 'Fixture', active: true }); return id; });
  const authId = await t.run(ctx => ctx.db.insert('authSessions', { userId, expirationTime: Date.now() + 3600_000 }));
  const op = t.withIdentity({ subject: `${userId}|${authId}` });
  const clientId = await op.mutation(api.research.createClient, { name: 'Synthetic' });
  const projectId = await op.mutation(api.research.createProject, { clientId, name: 'Voice fixture' });
  await op.mutation(api.research.saveStudy, { clientId, projectId, expectedRevision: 0, definition: { title: 'Fixture', introduction: 'Synthetic', goals: ['Observe checkout'], script: [{ id: 'q1', question: 'What did you expect?' }], prototypeUrl: null, repository: null } });
  const invitation = await op.mutation(internal.invitations.issue, { clientId, projectId, studyVersion: 1, requestId: 'invite-fixture', tokenHash: 'a'.repeat(64) });
  return { t, sessionId: invitation.sessionId };
}
test('fixture provisioning is finite, prospective and immutable including after disable', async () => {
  const t = convexTest(schema, modules);
  expect(await t.mutation(internal.researchSpeechFixture.provision, allocation)).toMatchObject({ ...allocation, enabled: true, chargedSeconds: 0, chargedCharacters: 0 });
  await expect(t.mutation(internal.researchSpeechFixture.provision, allocation)).rejects.toThrow('immutable');
  await t.mutation(internal.researchSpeechFixture.disable, {});
  await expect(t.mutation(internal.researchSpeechFixture.provision, allocation)).rejects.toThrow('immutable');
});
test('fixture refuses remote deployment and excessive allocations', async () => {
  const t = convexTest(schema, modules); vi.stubEnv('CONVEX_CLOUD_URL', 'https://cloud.example');
  await expect(t.mutation(internal.researchSpeechFixture.provision, allocation)).rejects.toThrow('isolated local');
  vi.stubEnv('CONVEX_CLOUD_URL', 'http://127.0.0.1:3210');
  await expect(t.mutation(internal.researchSpeechFixture.provision, { ...allocation, allocatedSeconds: 121 })).rejects.toThrow('bounded');
  await expect(t.mutation(internal.researchSpeechFixture.provision, { ...allocation, maxSessionCharacters: 201 })).rejects.toThrow('bounded');
});
test('private readiness and disable preserve charged budgets and unknown reservations', async () => {
  const f = await fixture(); await f.t.mutation(internal.researchSpeechFixture.provision, allocation);
  await f.t.run(async ctx => {
    const policy = await ctx.db.query('researchSpeechPolicy').first(); await ctx.db.patch(policy!._id, { chargedSeconds: 60, chargedCharacters: 20 });
    await ctx.db.insert('researchSpeechBudgets', { sessionId: f.sessionId, chargedSeconds: 60, chargedCharacters: 20 });
    await ctx.db.insert('researchSpeechAttempts', { sessionId: f.sessionId, requestId: 'unknown-fixture-attempt', provider: 'deepgram', promptId: 'q1', expectedRevision: 1, consentAt: Date.now(), consentEpoch: 0, textHash: null, reservedSeconds: 60, reservedCharacters: 0, state: 'unknown', active: true, createdAt: Date.now(), deadline: Date.now() + 70_000, rawSourceId: 'original-source', acceptedSourceId: null });
  });
  const before = await f.t.query(internal.researchSpeechFixture.readiness, { sessionIds: [f.sessionId] });
  expect(before.sessions[0]).toMatchObject({ chargedSeconds: 60, chargedCharacters: 20, attempts: [{ state: 'unknown', active: true, rawSourceId: 'original-source' }] });
  expect(await f.t.mutation(internal.researchSpeechFixture.disable, {})).toMatchObject({ enabled: false, chargedSeconds: 60, chargedCharacters: 20 });
  const after = await f.t.query(internal.researchSpeechFixture.readiness, { sessionIds: [f.sessionId] }); expect(after.sessions).toEqual(before.sessions);
  await expect(f.t.query(internal.researchSpeechFixture.readiness, { sessionIds: [f.sessionId, f.sessionId] })).rejects.toThrow('distinct');
});
test('orphaned prior budgets prevent a fresh allowance reset', async () => {
  const f = await fixture(); await f.t.run(ctx => ctx.db.insert('researchSpeechBudgets', { sessionId: f.sessionId, chargedSeconds: 60, chargedCharacters: 0 }));
  await expect(f.t.mutation(internal.researchSpeechFixture.provision, allocation)).rejects.toThrow('Prior speech allowance');
});
test('named grant readiness preserves legacy counters and charged unknown evidence across disable', async () => {
  const f = await fixture(); await f.t.mutation(internal.researchSpeechFixture.provision, allocation);
  const studyId = (await f.t.run(ctx => ctx.db.get(f.sessionId)))!.studyId;
  const grantId = await f.t.mutation(internal.researchSpeechGrants.provision, { name: 'continuous-fixture-grant', studyId, enabled: true, allocatedSeconds: 180, allocatedCharacters: 600, maxSessionSeconds: 180, maxSessionCharacters: 600, expiresAt: Date.now() + 600000 });
  await f.t.run(async ctx => {
    await ctx.db.patch(grantId, { chargedSeconds: 60, chargedCharacters: 35 });
    await ctx.db.insert('researchSpeechGrantBudgets', { grantId, sessionId: f.sessionId, chargedSeconds: 60, chargedCharacters: 35 });
    await ctx.db.insert('researchSpeechAttempts', { grantId, sessionId: f.sessionId, requestId: 'unknown-named-attempt', provider: 'deepgram', promptId: 'q1', expectedRevision: 1, consentAt: Date.now(), consentEpoch: 0, textHash: null, reservedSeconds: 60, reservedCharacters: 0, state: 'unknown', active: true, createdAt: Date.now(), deadline: Date.now() + 70000, rawSourceId: null, acceptedSourceId: null });
  });
  const input = { name: 'continuous-fixture-grant', sessionIds: [f.sessionId] }, before = await f.t.query(internal.researchSpeechGrants.readiness, input);
  expect(before.grant).toMatchObject({ chargedSeconds: 60, chargedCharacters: 35 });
  expect(before.sessions[0].attempts[0]).toMatchObject({ state: 'unknown', active: true, grantId });
  await f.t.mutation(internal.researchSpeechGrants.disable, { name: input.name });
  const after = await f.t.query(internal.researchSpeechGrants.readiness, input); expect(after.sessions).toEqual(before.sessions); expect(after.grant).toMatchObject({ enabled: false, chargedSeconds: 60, chargedCharacters: 35 });
  expect((await f.t.query(internal.researchSpeechFixture.readiness, { sessionIds: [] })).policy).toMatchObject({ allocatedSeconds: 120, chargedSeconds: 0 });
  await expect(f.t.query(internal.researchSpeechGrants.readiness, { ...input, sessionIds: [f.sessionId, f.sessionId] })).rejects.toThrow('distinct');
});
