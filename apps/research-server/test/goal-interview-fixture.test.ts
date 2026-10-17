import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { syntheticGoalAnswer, syntheticGoalQuestion, syntheticGoalInterview } from '../src/synthetic-interview-fixture';
import { interviewMessages, type InterviewReservation } from '../src/interview';
import { scriptPrompt, type InterviewContext } from '../../../packages/research-core/src/interview';
// @ts-expect-error Native administration ESM module is tested with injected ports.
import { runGoalInterviewFixture, goalFixturePolicy, goalFixtureStudy } from '../../../infra/research/goal-interview-fixture.mjs';
const directories: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture(existing = false) {
  const directory = await mkdtemp(join(tmpdir(), 'goal-fixture-')); directories.push(directory);
  const output = join(directory, 'goal.private.json'), calls: string[] = []; let policy: any = existing ? { enabled: false } : null;
  const ports = { setAdminAuth: vi.fn(), setAuth: vi.fn(),
    query: async (reference: any, args: any) => { const name = getFunctionName(reference); calls.push(name);
      if (name === 'researchInterviewFixture:readiness') return { policy, hasPriorEvidence: false, activeAttempts: 0, activeTruncated: false, sessions: args.sessionIds.map((sessionId: string) => ({ sessionId, chargedCalls: 0, attempts: [], truncated: false })) };
      if (name === 'participant:resume') return { state: 'invited', revision: 0, question: null, pendingInterview: null };
      if (name === 'research:sessionSources') return { page: [], isDone: true }; throw new Error(name);
    },
    mutation: async (reference: any, args: any) => { const name = getFunctionName(reference); calls.push(name);
      if (name === 'research:createClient') return 'client'; if (name === 'research:createProject') return 'project'; if (name === 'research:saveStudy') { expect(args.definition).toEqual(goalFixtureStudy); return { studyId: 'study' }; }
      if (name === 'researchInterview:provision') { policy = { ...args, qualification: 'root-reviewed-research-interview', chargedCalls: 0 }; return null; }
      if (name === 'researchInterviewFixture:disable') { policy = { ...policy, enabled: false }; return policy; } throw new Error(name);
    },
    action: async (reference: any) => { const name = getFunctionName(reference); calls.push(name);
      if (name === 'auth:signIn') return { tokens: { token: 'normal-operator-token' } }; if (name === 'auth:signOut') return null;
      if (name === 'invitations:create') return { token: 'a'.repeat(64), sessionId: 'session', invitationId: 'invitation' }; throw new Error(name);
    },
  };
  const dependencies = { client: () => ports, localConfig: async () => ({ CONVEX_SELF_HOSTED_URL: 'http://127.0.0.1:3210', CONVEX_SELF_HOSTED_ADMIN_KEY: 'offline-only' }), privateJson: async (path: string) => path === '/operator-fixture' ? { email: 'synthetic@example.test', password: 'offline-only' } : JSON.parse(await readFile(path, 'utf8')) };
  return { options: { allow: true, output, operator: '/operator-fixture' }, dependencies, calls, output };
}
test('private lifecycle provisions exactly two calls and one deterministic session, then readback and disable retain counters', async () => {
  const f = await fixture(); expect(await runGoalInterviewFixture('prepare', f.options, f.dependencies)).toMatchObject({ state: 'ready', receiptHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  const receipt = JSON.parse(await readFile(f.output, 'utf8'));
  expect(receipt.native.policy).toMatchObject(goalFixturePolicy); expect(receipt.policy.expiresAt - receipt.createdAt).toBeLessThanOrEqual(86_400_010);
  expect(receipt.sessions).toHaveLength(1); expect(receipt.liveSessionAuthorized).toBe(false); expect(receipt.token).toBeUndefined();
  expect((await stat(f.output)).mode & 0o077).toBe(0); expect((await stat(receipt.sessions[0].tokenPath)).mode & 0o077).toBe(0);
  expect(JSON.parse(await readFile(receipt.sessions[0].tokenPath, 'utf8')).url).toContain('/participate#token=');
  await runGoalInterviewFixture('readback', f.options, f.dependencies); await runGoalInterviewFixture('disable', f.options, f.dependencies);
  expect(JSON.parse(await readFile(f.output, 'utf8')).native.policy).toMatchObject({ enabled: false, allocatedCalls: 2, chargedCalls: 0 });
  expect(f.calls.filter(n => n === 'researchInterview:provision')).toHaveLength(1); expect(f.calls.filter(n => n === 'invitations:create')).toHaveLength(1); expect(f.calls.at(-1)).toBe('auth:signOut');
});
test('existing output or policy refuses provisioning before normal operator mutations', async () => {
  const a = await fixture(); await writeFile(a.output, '{}'); await expect(runGoalInterviewFixture('prepare', a.options, a.dependencies)).rejects.toThrow('output'); expect(a.calls).toEqual([]);
  const b = await fixture(true); await expect(runGoalInterviewFixture('prepare', b.options, b.dependencies)).rejects.toThrow('cannot be replaced'); expect(b.calls).toEqual(['researchInterviewFixture:readiness']);
});
test('deterministic adapter binds goal, typed source and reviewed wire caps without global network access', async () => {
  const network = vi.fn(() => { throw new Error('Network forbidden'); }); vi.stubGlobal('fetch', network);
  const context: InterviewContext = { sessionId: 'session', revision: 2, consentEpoch: 1, retainUntil: Date.now() + 60_000, goals: goalFixtureStudy.goals, script: goalFixtureStudy.script, scriptIndex: 0, currentPrompt: scriptPrompt(goalFixtureStudy.script[0]), followUps: [], answer: { sourceId: 'session:1', promptId: 'q1', text: syntheticGoalAnswer, channel: 'text', intent: 'answer' } };
  const reservation: InterviewReservation = { id: 'synthetic-reservation', model: 'qwen3.8-max', maxInputBytes: 64_000, maxOutputTokens: 512, expiresAt: Date.now() + 60_000 };
  const provider = syntheticGoalInterview('session'), messages = interviewMessages(context), prepared = await provider.prepare(messages, reservation);
  expect(prepared).toMatchObject({ inputHash: expect.stringMatching(/^[a-f0-9]{64}$/), maxOutputTokens: 512 }); expect(prepared.requestBytes).toBeLessThanOrEqual(64_000);
  expect(await provider.generate(messages, reservation, prepared, new AbortController().signal)).toMatchObject({ proposal: { decision: 'follow-up', question: syntheticGoalQuestion, sourceId: 'session:1', quote: 'delivery cost' }, receipt: { requestId: 'synthetic-goal-session', usage: null, requestBytes: prepared.requestBytes }, outputHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  context.answer.sourceId = 'another-session:1'; expect(() => provider.prepare(interviewMessages(context), reservation)).toThrow('exact deterministic');
  expect(network).not.toHaveBeenCalled();
});
