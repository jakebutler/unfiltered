import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../convex/schema';
import { api, internal } from '../../../convex/_generated/api';
import { hashCapability } from '../../../convex/access';
import { signGateway } from '../../../packages/research-capture/src/proof';
import { evidenceId } from '../../../packages/research-core/src/analysis';
import { researchReportsGateway } from '../src/reports';
import type { AnalysisRuntime } from '../src/analysis';
import type { ReportAuthority } from '../src/report-authority';
import type { PrivateObjectStore } from '../../../packages/research-capture/src/contracts';
const modules = import.meta.glob('../../../convex/**/*.ts'), secret = 'synthetic-runtime-key-'.repeat(4), origin = 'http://127.0.0.1:5174';
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv('RESEARCH_MEDIA_GATEWAY_SECRET', secret); }); afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function fixture() {
  const t = convexTest(schema, modules);
  const userId = await t.run(async ctx => { const id = await ctx.db.insert('users', { email: 'runtime@synthetic.example' }); await ctx.db.insert('researchOperators', { userId: id, role: 'operator', name: 'Synthetic Operator', active: true }); return id; });
  const authSessionId = await t.run(ctx => ctx.db.insert('authSessions', { userId, expirationTime: Date.now() + 3600_000 })), op = t.withIdentity({ subject: `${userId}|${authSessionId}` });
  const clientId = await op.mutation(api.research.createClient, { name: 'Synthetic runtime client' }), projectId = await op.mutation(api.research.createProject, { clientId, name: 'Synthetic runtime project' });
  await op.mutation(api.research.saveStudy, { clientId, projectId, expectedRevision: 0, definition: { title: 'Synthetic study', introduction: 'Offline only.', goals: ['Checkout clarity'], script: [{ id: 'q1', question: 'What was clear?' }], prototypeUrl: null, repository: null } });
  const token = '2'.repeat(64), invitation = await op.mutation(internal.invitations.issue, { clientId, projectId, studyVersion: 1, requestId: 'synthetic-invitation', tokenHash: await hashCapability(token) });
  await t.mutation(api.participant.agree, { token, expectedRevision: 0, consent: { version: 'research-consent-1', storage: true, analysis: true, microphone: false, camera: false, screen: false, dom: false, shareDom: false, shareTranscript: false, shareAudio: false, shareScreen: false, shareCamera: false, retainApprovedExcerpts: false } });
  await t.mutation(api.participant.answer, { token, expectedRevision: 1, requestId: 'synthetic-text-answer', questionId: 'q1', text: 'Delivery unclear', channel: 'text' });
  const scope = { clientId, projectId }, inventory = await op.query(api.researchAnalysis.inventory, { ...scope, sessionId: invitation.sessionId, kind: 'self-report', paginationOpts: { cursor: null, numItems: 10 } }), selection = inventory.page[0].selection;
  const signed = async <T,>(operation: string, args: T) => ({ ...args, proof: await signGateway(secret, `research:${operation}`, args) });
  const authority = { operator: () => op.query(api.research.me, {}), availableReservations: async args => op.query(api.researchAnalysis.availableReservations, await signed('availableReservations', args)), admit: async args => op.mutation(api.researchAnalysis.admit, await signed('admit', args)), material: async args => op.query(api.researchAnalysis.material, await signed('material', args)), beginDispatch: async args => op.mutation(api.researchAnalysis.beginDispatch, await signed('beginDispatch', args)), finish: async args => op.mutation(api.researchAnalysis.finish, await signed('finish', args)) } as ReportAuthority;
  const reservations = [1, 2].map(i => ({ id: `root-offline-reservation-${i}`, model: 'qwen3.8-max' as const, maxInputBytes: 64_000, maxOutputTokens: 128, expiresAt: Date.now() + 120_000, live: false }));
  const generate = vi.fn(async () => ({ requestId: 'synthetic-provider-response', model: 'qwen3.8-max', findings: [{ id: 'f1', type: 'self-report', statement: 'Participant reported delivery unclear.', supports: [evidenceId(selection)], counterevidence: [], limitations: 'Synthetic offline fixture.' }] }));
  const runtime: AnalysisRuntime = { reservations, visionQualified: false, provider: { model: 'qwen3.8-max', classification: 'offline-fixture', prepare: async () => ({ inputHash: 'a'.repeat(64), requestBytes: 1000, maxOutputTokens: 128 }), generate } };
  const restart = () => researchReportsGateway({} as PrivateObjectStore, { deployment: 'http://127.0.0.1:3210', gatewaySecret: secret, publicOrigin: origin }, { ...runtime, reservations: [...reservations] }, () => authority);
  const readiness = async (gateway: ReturnType<typeof restart>) => { const result = await gateway(new Request(`${origin}/api/research/analysis/readiness`, { headers: { Origin: origin, Authorization: 'Bearer synthetic' } })); expect(result.status).toBe(200); return result.json(); };
  const run = async (gateway: ReturnType<typeof restart>, reservationId: string, requestId: string) => gateway(new Request(`${origin}/api/research/analysis`, { method: 'POST', headers: { Origin: origin, Authorization: 'Bearer synthetic', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...scope, reservationId, requestId, selections: [selection] }) }));
  return { t, op, authority, reservations, runtime, generate, restart, readiness, run };
}
describe('durable private analysis availability', () => {
  it('offers a different unused run for the second analysis and stays exhausted after gateway restart', async () => {
    const f = await fixture(); let gateway = f.restart(); expect((await f.readiness(gateway)).reservations.map(r => r.id)).toEqual(f.reservations.map(r => r.id));
    expect((await (await f.run(gateway, f.reservations[0].id, 'synthetic-request-1')).json()).state).toBe('ready');
    expect((await f.readiness(gateway)).reservations.map(r => r.id)).toEqual([f.reservations[1].id]);
    expect((await (await f.run(gateway, f.reservations[1].id, 'synthetic-request-2')).json()).state).toBe('ready'); expect(f.generate).toHaveBeenCalledTimes(2);
    gateway = f.restart(); expect(await f.readiness(gateway)).toMatchObject({ state: 'disabled', reservations: [] });
    expect((await f.run(gateway, f.reservations[0].id, 'synthetic-request-3')).status).toBe(409); expect(f.generate).toHaveBeenCalledTimes(2);
  });
  it('never resurrects an unknown or invalidated reservation after restart, and native admission denies another request', async () => {
    const f = await fixture(), gateway = f.restart(); f.generate.mockRejectedValueOnce(new Error('timeout'));
    const response = await f.run(gateway, f.reservations[0].id, 'synthetic-unknown-1'); expect((await response.json()).state).toBe('unknown');
    expect((await f.readiness(f.restart())).reservations.map(r => r.id)).toEqual([f.reservations[1].id]);
    expect((await f.run(f.restart(), f.reservations[0].id, 'synthetic-unknown-2')).status).toBe(409); expect(f.generate).toHaveBeenCalledOnce();
    await f.t.run(async ctx => { const row = await ctx.db.query('researchAnalyses').withIndex('by_reservationId', q => q.eq('reservation.id', f.reservations[0].id)).unique(); await ctx.db.patch(row!._id, { state: 'invalidated', evidence: [], findings: [], excerpts: [], studyContext: '' }); });
    expect((await f.readiness(f.restart())).reservations.map(r => r.id)).toEqual([f.reservations[1].id]);
  });
  it('fails closed on native readback failure and requires both gateway proof and operator auth', async () => {
    const f = await fixture();
    await expect(f.op.query(api.researchAnalysis.availableReservations, { reservationIds: f.reservations.map(r => r.id), proof: { at: Date.now(), signature: 'a'.repeat(64) } })).rejects.toThrow();
    const args = { reservationIds: f.reservations.map(r => r.id) };
    await expect(f.t.query(api.researchAnalysis.availableReservations, { ...args, proof: await signGateway(secret, 'research:availableReservations', args) })).rejects.toThrow('Access unavailable');
    f.authority.availableReservations = vi.fn().mockRejectedValue(new Error('unresolved'));
    const result = await f.restart()(new Request(`${origin}/api/research/analysis/readiness`, { headers: { Origin: origin, Authorization: 'Bearer synthetic' } })); expect(result.status).toBe(409); expect(f.generate).not.toHaveBeenCalled();
  });
});
