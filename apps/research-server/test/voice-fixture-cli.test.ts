import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
// Native ESM administration CLI has no top-level execution when imported.
// @ts-expect-error Deliberately independent runtime .mjs CLI, tested with injected ports.
import { runVoiceFixture, boundedLocalFixtureFetch, fixturePolicy } from '../../../infra/research/voice-fixture.mjs';
const directories: string[] = []; afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture(existingPolicy = false, existingAllocation = false) {
  const directory = await mkdtemp(join(tmpdir(), 'synthetic-voice-cli-')); directories.push(directory); const output = join(directory, 'receipt.private.json');
  let policy: any = existingPolicy ? { enabled: false } : null, allocation: any = existingAllocation ? { allocationId: 'allocation-fixture' } : null, invitations = 0;
  const calls: string[] = [];
  const ports: any = { setAdminAuth: vi.fn(), setAuth: vi.fn(),
    query: async (ref: any, args: any) => { const name = getFunctionName(ref); calls.push(name);
      if (name === 'researchSpeechFixture:readiness') return { policy, sessions: args.sessionIds.map((sessionId: string) => ({ sessionId, chargedSeconds: 0, chargedCharacters: 0, attempts: [] })) };
      if (name === 'researchGatewayLeases:readiness') return { allocation, slots: [] };
      if (name === 'participant:resume') return { state: 'invited', revision: 0, question: null };
      if (name === 'research:sessionSources') return { page: [], isDone: true };
      throw new Error(name);
    },
    mutation: async (ref: any, args: any) => { const name = getFunctionName(ref); calls.push(name);
      if (name === 'research:createClient') return 'client'; if (name === 'research:createProject') return 'project'; if (name === 'research:saveStudy') return null;
      if (name === 'researchSpeechFixture:provision') { policy = { ...args, enabled: true, chargedSeconds: 0, chargedCharacters: 0 }; return policy; }
      if (name === 'researchGatewayLeases:provisionAllocation') { allocation = { ...args, requestsConsumed: 0, readBytesConsumed: 0, storageOperationsConsumed: 0 }; return 'allocation-id'; }
      if (name === 'researchSpeechFixture:disable') { policy = { ...policy, enabled: false }; return policy; } throw new Error(name);
    },
    action: async (ref: any) => { const name = getFunctionName(ref); calls.push(name);
      if (name === 'auth:signIn') return { tokens: { token: 'operator-auth' } }; if (name === 'auth:signOut') return null;
      if (name === 'invitations:create') { invitations++; return { token: String(invitations).repeat(64), invitationId: `invitation${invitations}`, sessionId: `session${invitations}` }; } throw new Error(name);
    },
  };
  const dependencies = { localConfig: async () => ({ CONVEX_SELF_HOSTED_URL: 'http://127.0.0.1:3210', CONVEX_SELF_HOSTED_ADMIN_KEY: 'test-admin' }), privateJson: async (path: string) => path === '/operator-fixture' ? { email: 'fixture@example.test', password: 'test-only' } : JSON.parse(await readFile(path, 'utf8')), client: () => ports };
  const options = { allow: true, output, operator: '/operator-fixture', allocationId: 'allocation-fixture' };
  return { directory, output, calls, options, dependencies };
}
test('prepare writes two private invitation paths and exact prospective allocations using normal auth', async () => {
  const f = await fixture(); const result = await runVoiceFixture('prepare', f.options, f.dependencies); expect(result.state).toBe('ready');
  const receipt = JSON.parse(await readFile(f.output, 'utf8')); expect(receipt.policy).toMatchObject(fixturePolicy); expect(receipt.gateway.allocation).toMatchObject({ requestLimit: 12, readByteLimit: 1, storageOperationLimit: 1 }); expect(receipt.sessions).toHaveLength(2);
  expect((await stat(f.output)).mode & 0o077).toBe(0); expect(receipt.token).toBeUndefined();
  for (const session of receipt.sessions) { expect((await stat(session.tokenPath)).mode & 0o077).toBe(0); expect(JSON.parse(await readFile(session.tokenPath, 'utf8')).url).toContain('/participate/synthetic-voice#'); }
  expect(f.calls.filter(name => name === 'invitations:create')).toHaveLength(2); expect(f.calls.at(-1)).toBe('auth:signOut');
  await runVoiceFixture('readback', f.options, f.dependencies); await runVoiceFixture('disable', f.options, f.dependencies);
  expect(JSON.parse(await readFile(f.output, 'utf8')).speech.policy.enabled).toBe(false); expect(f.calls.filter(name => name === 'invitations:create')).toHaveLength(2);
});
test('prepare refuses existing output, disabled policy or allocation before any mutation', async () => {
  const a = await fixture(); await writeFile(a.output, '{}', { mode: 0o600 }); await expect(runVoiceFixture('prepare', a.options, a.dependencies)).rejects.toThrow('output'); expect(a.calls).toEqual([]);
  const b = await fixture(true); await expect(runVoiceFixture('prepare', b.options, b.dependencies)).rejects.toThrow('policy'); expect(b.calls.some(name => name.includes('provision') || name.includes('create'))).toBe(false);
  const c = await fixture(false, true); await expect(runVoiceFixture('prepare', c.options, c.dependencies)).rejects.toThrow('allocation'); expect(c.calls.some(name => name.includes('provision') || name.includes('create'))).toBe(false);
});
test('exact local fetch guard blocks cloud and preserves bounded non-redirecting native calls', async () => {
  const native = vi.fn(async () => new Response(null)); const guarded = boundedLocalFixtureFetch(native);
  expect(() => guarded('https://remote.example/api/query')).toThrow('Non-local'); expect(() => guarded('http://localhost:3210/api/query')).toThrow('Non-local'); expect(native).not.toHaveBeenCalled();
  await guarded('http://127.0.0.1:3210/api/query', {}); expect(native.mock.calls[0][1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
});
