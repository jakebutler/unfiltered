import { convexTest } from 'convex-test';
import { afterEach, expect, test, vi } from 'vitest';
import schema from '../../../convex/schema';
import { internal } from '../../../convex/_generated/api';
const modules = import.meta.glob('../../../convex/**/*.ts');
afterEach(() => vi.unstubAllEnvs());
test('local interview disable is monotonic and preserves finite charges and unknown reservation evidence', async () => {
  vi.stubEnv('CONVEX_CLOUD_URL', 'http://127.0.0.1:3210'); const t = convexTest(schema, modules);
  await t.mutation(internal.researchInterview.provision, { enabled: true, allocatedCalls: 2, maxSessionCalls: 1, model: 'qwen3.8-max', maxInputBytes: 64_000, maxOutputTokens: 512, expiresAt: Date.now() + 86_400_000 });
  await t.run(async ctx => {
    const policy = await ctx.db.query('researchInterviewPolicy').withIndex('by_name', q => q.eq('name', 'demo')).unique(); await ctx.db.patch(policy!._id, { chargedCalls: 1 });
    // Administrative retention proof; no participant/browser/provider operation.
    const ownerId = await ctx.db.insert('users', { email: 'synthetic@example.test' });
    const clientId = await ctx.db.insert('researchClients', { ownerId, name: 'Synthetic', state: 'active', revision: 0, updatedAt: Date.now() });
    const projectId = await ctx.db.insert('researchProjects', { ownerId, clientId, name: 'Synthetic', state: 'active', revision: 0, latestStudyVersion: 1, updatedAt: Date.now() });
    const studyId = await ctx.db.insert('researchStudies', { ownerId, clientId, projectId, version: 1, createdAt: Date.now(), definition: { title: 'Synthetic', introduction: 'Synthetic', goals: ['Understand checkout'], script: [{ id: 'q1', question: 'What happened?' }], prototypeUrl: null, repository: null } });
    const sessionId = await ctx.db.insert('researchSessions', { ownerId, clientId, projectId, studyId, state: 'invited', revision: 0, nextQuestion: 0, sourceCount: 0, consent: null, consentAt: null, createdAt: Date.now(), savedAt: Date.now(), retainUntil: Date.now() + 86_400_000 });
    await ctx.db.insert('researchInterviewBudgets', { sessionId, chargedCalls: 1 });
    await ctx.db.insert('researchInterviewAttempts', { sessionId, requestId: 'unknown-fixture-attempt', answerSourceId: `${sessionId}:1`, promptId: 'q1', expectedRevision: 2, contextHash: 'a'.repeat(64), reservation: { id: 'unknown-fixture-attempt', model: 'qwen3.8-max', maxInputBytes: 64_000, maxOutputTokens: 512, expiresAt: Date.now() + 30_000 }, state: 'unknown', active: true, inputHash: 'b'.repeat(64), requestBytes: 1234, outputHash: null, receipt: null, errorCode: 'interview-provider-outcome-unknown', installedRevision: null, createdAt: Date.now() });
  });
  const before = await t.query(internal.researchInterviewFixture.readiness, { sessionIds: [] }); expect(before).toMatchObject({ hasPriorEvidence: true, activeAttempts: 1, policy: { chargedCalls: 1 } });
  const attempts = await t.run(ctx => ctx.db.query('researchInterviewAttempts').take(2));
  expect(await t.mutation(internal.researchInterviewFixture.disable, {})).toMatchObject({ enabled: false, allocatedCalls: 2, chargedCalls: 1 });
  await t.mutation(internal.researchInterviewFixture.disable, {});
  const after = await t.query(internal.researchInterviewFixture.readiness, { sessionIds: [attempts[0].sessionId] });
  expect(after).toMatchObject({ activeAttempts: 1, sessions: [{ chargedCalls: 1, attempts: [{ state: 'unknown', active: true, inputHash: 'b'.repeat(64), requestBytes: 1234 }] }] });
  expect(await t.run(ctx => ctx.db.query('researchInterviewAttempts').take(2))).toEqual(attempts);
});
test('administrative fixture reads and disable reject cloud deployment, including missing-policy no-op', async () => {
  vi.stubEnv('CONVEX_CLOUD_URL', 'https://unrelated.convex.cloud'); const t = convexTest(schema, modules);
  await expect(t.query(internal.researchInterviewFixture.readiness, { sessionIds: [] })).rejects.toThrow('isolated localhost');
  await expect(t.mutation(internal.researchInterviewFixture.disable, {})).rejects.toThrow('isolated localhost');
  expect(await t.run(ctx => ctx.db.query('researchInterviewPolicy').take(1))).toEqual([]);
});
