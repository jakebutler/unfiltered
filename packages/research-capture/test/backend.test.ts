import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import schema from '../../../convex/schema';
import type { Id } from '../../../convex/_generated/dataModel';
import { api, internal } from '../../../convex/_generated/api';
import { hashCapability } from '../../../convex/access';
import { signGateway } from '../src/proof';
const modules = import.meta.glob('../../../convex/**/*.ts');
const secret = 'qualification-only-media-key-'.repeat(2);
const consent = { version: 'research-consent-1' as const, storage: true, analysis: true, microphone: true, camera: true, screen: true, dom: true, shareTranscript: false, shareAudio: false, shareCamera: false, shareScreen: false, retainApprovedExcerpts: false };
const descriptor = { modality: 'microphone' as const, sequence: 0, startMs: 0, endMs: 1000, bytes: 20, sha256: 'a'.repeat(64), mime: 'audio/webm', questionId: 'q1', sourceId: null };
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv('RESEARCH_MEDIA_GATEWAY_SECRET', secret); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function fixture() {
  const t = convexTest(schema, modules);
  const userId = await t.run(async ctx => { const id = await ctx.db.insert('users', { email: 'operator@corvo.example' }); await ctx.db.insert('researchOperators', { userId: id, role: 'operator', name: 'Operator', active: true }); return id; });
  const authSessionId = await t.run(ctx => ctx.db.insert('authSessions', { userId, expirationTime: Date.now() + 3600000 }));
  const op = t.withIdentity({ subject: `${userId}|${authSessionId}` });
  const clientId = await op.mutation(api.research.createClient, { name: 'Capture client' }), otherClientId = await op.mutation(api.research.createClient, { name: 'Other client' });
  const projectId = await op.mutation(api.research.createProject, { clientId, name: 'Capture project' });
  await op.mutation(api.research.saveStudy, { clientId, projectId, expectedRevision: 0, definition: { title: 'Capture study', introduction: 'Synthetic only.', goals: ['Review checkout'], script: [{ id: 'q1', question: 'What is clear?' }], prototypeUrl: 'https://prototype.example.test/', repository: null } });
  const study = await op.query(api.research.readStudy, { clientId, projectId, version: 1 });
  const token = '1'.repeat(64), invite = await op.mutation(internal.invitations.issue, { clientId, projectId, studyVersion: 1, requestId: 'invitation-001', tokenHash: await hashCapability(token) });
  await t.mutation(api.participant.agree, { token, expectedRevision: 0, consent });
  const scope = { clientId, projectId, sessionId: invite.sessionId };
  return { t, op, token, invite, scope, otherClientId, studyId: study!.studyId, authSessionId };
}
async function reserved(f: Awaited<ReturnType<typeof fixture>>) {
  const capture = await f.t.mutation(api.capture.start, { token: f.token });
  const media = await f.t.mutation(api.capture.reserve, { token: f.token, requestId: 'segment-0001', descriptor });
  return { capture, media };
}
async function available(f: Awaited<ReturnType<typeof fixture>>, mediaId: Id<'researchMedia'>) {
  const claim = { token: f.token, mediaId, attempt: 0 };
  await f.t.mutation(api.captureGateway.claim, { ...claim, proof: await signGateway(secret, 'claim', claim) });
  const commit = { mediaId, attempt: 0, bytes: descriptor.bytes, sha256: descriptor.sha256, mime: descriptor.mime };
  expect(await f.t.mutation(api.captureGateway.finalize, { ...commit, proof: await signGateway(secret, 'finalize', commit) })).toBe(true);
}
describe('private research capture admission and evidence', () => {
  test('admission requires explicit modality consent and has an independent bounded capacity', async () => {
    const f = await fixture();
    await f.t.mutation(api.capture.changeConsent, { token: f.token, expectedRevision: 1, consent: { ...consent, microphone: false, camera: false, screen: false, dom: false } });
    await expect(f.t.mutation(api.capture.start, { token: f.token })).rejects.toThrow('consent');
    await f.t.mutation(api.capture.changeConsent, { token: f.token, expectedRevision: 2, consent });
    vi.stubEnv('RESEARCH_CAPTURE_LIMITS_JSON', JSON.stringify({ sessionBytes: 10 }));
    await f.t.mutation(api.capture.start, { token: f.token });
    await expect(f.t.mutation(api.capture.reserve, { token: f.token, requestId: 'segment-0001', descriptor })).rejects.toThrow('capacity');
    vi.stubEnv('RESEARCH_CAPTURE_LIMITS_JSON', JSON.stringify({ sessionBytes: 800_000_000 }));
    await expect(f.t.query(api.capture.status, { token: f.token })).rejects.toThrow('reduce');
  });
  test('exact replay does not double reserve; conflicting replay and out-of-order intervals fail', async () => {
    const f = await fixture(), { media } = await reserved(f);
    const args = { token: f.token, requestId: 'segment-0001', descriptor };
    expect(await f.t.mutation(api.capture.reserve, args)).toEqual(media);
    await expect(f.t.mutation(api.capture.reserve, { ...args, descriptor: { ...descriptor, bytes: 21 } })).rejects.toThrow('different');
    await expect(f.t.mutation(api.capture.reserve, { ...args, requestId: 'segment-0002', descriptor: { ...descriptor, sequence: 2 } })).rejects.toThrow('sequence');
    expect((await f.t.query(api.capture.status, { token: f.token })).bytesRemaining).toBe(750_000_000 - 20);
    expect(media).not.toHaveProperty('objectKey');
  });
  test('source references must be in the same session and question', async () => {
    const f = await fixture(); await f.t.mutation(api.capture.start, { token: f.token });
    await expect(f.t.mutation(api.capture.reserve, { token: f.token, requestId: 'segment-0001', descriptor: { ...descriptor, sourceId: 'foreign:0' } })).rejects.toThrow('Access unavailable');
  });
  test('only a fresh operation-bound gateway proof can finalize; upload claims are single dispatch', async () => {
    const f = await fixture(), { media } = await reserved(f), claim = { token: f.token, mediaId: media.id, attempt: 0 };
    await expect(f.t.mutation(api.captureGateway.claim, { ...claim, proof: await signGateway(secret, 'read', claim) })).rejects.toThrow('authorization');
    await f.t.mutation(api.captureGateway.claim, { ...claim, proof: await signGateway(secret, 'claim', claim) });
    await expect(f.t.mutation(api.captureGateway.claim, { ...claim, proof: await signGateway(secret, 'claim', claim) })).rejects.toThrow('reconciliation');
    const commit = { mediaId: media.id, attempt: 0, bytes: 20, sha256: descriptor.sha256, mime: descriptor.mime };
    await expect(f.t.mutation(api.captureGateway.finalize, { ...commit, proof: await signGateway(secret, 'finalize', commit, Date.now() - 30_001) })).rejects.toThrow('authorization');
  });
  test('operator reads require matching client/session, live login, available bytes and current consent', async () => {
    const f = await fixture(), { media } = await reserved(f); await available(f, media.id);
    const args = { ...f.scope, mediaId: media.id };
    expect((await f.op.query(api.captureGateway.read, { ...args, proof: await signGateway(secret, 'read', args) })).descriptor).toEqual(descriptor);
    const mixed = { ...args, clientId: f.otherClientId };
    await expect(f.op.query(api.captureGateway.read, { ...mixed, proof: await signGateway(secret, 'read', mixed) })).rejects.toThrow('Access unavailable');
    await expect(f.t.query(api.captureGateway.read, { ...args, proof: await signGateway(secret, 'read', args) })).rejects.toThrow('Access unavailable');
    await f.t.mutation(api.capture.changeConsent, { token: f.token, expectedRevision: 1, consent: { ...consent, microphone: false } });
    await expect(f.op.query(api.captureGateway.read, { ...args, proof: await signGateway(secret, 'read', args) })).rejects.toThrow('Access unavailable');
    await f.t.mutation(api.capture.changeConsent, { token: f.token, expectedRevision: 2, consent });
    await expect(f.op.query(api.captureGateway.read, { ...args, proof: await signGateway(secret, 'read', args) })).rejects.toThrow('Access unavailable');
  });
  test('revocation during upload persists deletion intent; cleanup waits for the writer lease', async () => {
    const f = await fixture(), { media, capture } = await reserved(f), claim = { token: f.token, mediaId: media.id, attempt: 0 };
    const lease = await f.t.mutation(api.captureGateway.claim, { ...claim, proof: await signGateway(secret, 'claim', claim) });
    await f.op.mutation(api.invitations.revoke, { clientId: f.scope.clientId, projectId: f.scope.projectId, invitationId: f.invite.invitationId });
    const commit = { mediaId: media.id, attempt: 0, bytes: 20, sha256: descriptor.sha256, mime: descriptor.mime };
    expect(await f.t.mutation(api.captureGateway.finalize, { ...commit, proof: await signGateway(secret, 'finalize', commit) })).toBe(false);
    expect(await f.t.query(api.captureGateway.cleanup, { proof: await signGateway(secret, 'cleanup', {}) })).toHaveLength(0);
    vi.setSystemTime(lease.leaseUntil + 1);
    expect(await f.t.query(api.captureGateway.cleanup, { proof: await signGateway(secret, 'cleanup', {}) })).toHaveLength(1);
    const remove = { mediaId: media.id, attempt: 0 };
    await f.t.mutation(api.captureGateway.deleted, { ...remove, proof: await signGateway(secret, 'deleted', remove) });
    await f.t.mutation(api.captureGateway.deleted, { ...remove, proof: await signGateway(secret, 'deleted', remove) });
    expect((await f.t.run(ctx => ctx.db.get(capture.captureId)))?.reservedBytes).toBe(0);
  });
  test('retention preserves cleanup receipts until byte retirement then releases the retained slot', async () => {
    const f = await fixture(), { media, capture } = await reserved(f); await available(f, media.id);
    await f.t.run(ctx => ctx.db.patch(capture.captureId, { retainUntil: Date.now() - 1 }));
    await f.t.mutation(internal.captureLifecycle.purge, { captureId: capture.captureId });
    expect((await f.t.run(ctx => ctx.db.get(media.id)))?.state).toBe('delete-pending');
    const remove = { mediaId: media.id, attempt: 0 }; await f.t.mutation(api.captureGateway.deleted, { ...remove, proof: await signGateway(secret, 'deleted', remove) });
    await f.t.mutation(internal.captureLifecycle.purge, { captureId: capture.captureId });
    expect(await f.t.run(ctx => ctx.db.get(media.id))).toBeNull();
    expect((await f.t.run(ctx => ctx.db.get(capture.captureId)))?.state).toBe('purged');
  });
  test('full storage withdrawal denies source reads immediately and permits early physical purge', async () => {
    const f = await fixture(); await reserved(f);
    await f.t.mutation(api.capture.changeConsent, { token: f.token, expectedRevision: 1, consent: { ...consent, storage: false } });
    await expect(f.t.query(api.participant.sources, { token: f.token, paginationOpts: { numItems: 5, cursor: null } })).rejects.toThrow('Access unavailable');
    const session = (await f.t.run(ctx => ctx.db.get(f.invite.sessionId)))!;
    await f.t.mutation(internal.lifecycle.purgeSources, { ownerId: session.ownerId, clientId: session.clientId, projectId: session.projectId, studyId: session.studyId, sessionId: session._id, retainUntil: session.retainUntil });
    expect(await f.t.run(ctx => ctx.db.query('researchSources').withIndex('by_sessionId_and_sequence', q => q.eq('sessionId', session._id)).take(5))).toEqual([]);
  });
});
describe('controlled DOM evidence', () => {
  test('readiness requires a real accepted handshake; rejects wrong origin, unknown IDs, raw values and replay changes', async () => {
    const f = await fixture(); await f.t.mutation(api.capture.start, { token: f.token });
    await f.op.mutation(api.capture.authorizePrototype, { clientId: f.scope.clientId, projectId: f.scope.projectId, studyId: f.studyId, origin: 'https://prototype.example.test', componentIds: ['c1', 'c2'] });
    const connect = { token: f.token, challenge: 'd'.repeat(64), origin: 'https://prototype.example.test' };
    await expect(f.t.mutation(api.capture.connectDom, { ...connect, origin: 'https://attacker.example' })).rejects.toThrow('Access unavailable');
    await f.t.mutation(api.capture.connectDom, connect);
    expect((await f.t.query(api.capture.status, { token: f.token })).domConnected).toBe(false);
    const args = { ...connect, requestId: 'dom-batch-001', events: [{ sequence: 0, atMs: 0, kind: 'connected' as const, target: 'none', tag: 'none' as const, x: null, y: null }] };
    const source = await f.t.mutation(api.capture.appendDom, args);
    expect(await f.t.mutation(api.capture.appendDom, args)).toBe(source);
    expect((await f.t.query(api.capture.status, { token: f.token })).domConnected).toBe(true);
    await expect(f.t.mutation(api.capture.appendDom, { ...args, events: [{ ...args.events[0], value: 'secret' }] } as never)).rejects.toThrow();
    await expect(f.t.mutation(api.capture.appendDom, { ...args, requestId: 'dom-batch-002', events: [{ ...args.events[0], sequence: 1, kind: 'click', target: 'c99', tag: 'button' }] })).rejects.toThrow('Unapproved');
    await expect(f.t.mutation(api.capture.appendDom, { ...args, events: [{ ...args.events[0], atMs: 1 }] })).rejects.toThrow('Conflicting');
  });
});

describe('capture browser resume and operator inspection contracts', () => {
  test('status retains reservation continuity; paginated inspection denies wrong scope, revoked DOM epochs and expired operator login', async () => {
    const f = await fixture();
    expect(await f.t.query(api.capture.status, { token: f.token })).toMatchObject({ startedAt: null, nextSequence: { microphone: 0, camera: 0, screen: 0 }, nextStartMs: { microphone: 0, camera: 0, screen: 0 }, domPolicy: null });
    const { capture } = await reserved(f);
    await f.op.mutation(api.capture.authorizePrototype, { clientId: f.scope.clientId, projectId: f.scope.projectId, studyId: f.studyId, origin: 'https://prototype.example.test', componentIds: ['c1'] });
    const status = await f.t.query(api.capture.status, { token: f.token });
    expect(status).toMatchObject({ startedAt: capture.startedAt, nextSequence: { microphone: 1, camera: 0, screen: 0 }, nextStartMs: { microphone: 1000, camera: 0, screen: 0 }, domPolicy: { origin: 'https://prototype.example.test', componentIds: ['c1'] } });
    expect(Object.keys(status).sort()).toEqual(['bytesRemaining', 'deadline', 'domConnected', 'domPolicy', 'nextSequence', 'nextStartMs', 'recording', 'startedAt']);
    await expect(f.t.query(api.capture.status, { token: '2'.repeat(64) })).rejects.toThrow('Access unavailable');
    const connection = { token: f.token, challenge: 'd'.repeat(64), origin: 'https://prototype.example.test' };
    await f.t.mutation(api.capture.connectDom, connection);
    const event = { sequence: 0, atMs: 0, kind: 'connected' as const, target: 'none', tag: 'none' as const, x: null, y: null };
    await f.t.mutation(api.capture.appendDom, { ...connection, requestId: 'inspect-dom-before', events: [event] });
    await f.t.mutation(api.capture.gap, { token: f.token, requestId: 'inspect-gap', modality: 'microphone', atMs: 100, reason: 'permission-denied' });
    const args = { ...f.scope, paginationOpts: { numItems: 1, cursor: null } };
    const dom = await f.op.query(api.capture.domBatches, args), gaps = await f.op.query(api.capture.gaps, args);
    expect(dom.page).toHaveLength(1); expect(gaps.page).toHaveLength(1);
    expect(Object.keys(dom.page[0]).sort()).toEqual(['events', 'generation', 'origin', 'recordedAt', 'sourceId']);
    expect(Object.keys(gaps.page[0]).sort()).toEqual(['atMs', 'modality', 'reason', 'recordedAt']);
    await expect(f.t.query(api.capture.domBatches, args)).rejects.toThrow('Access unavailable');
    await expect(f.op.query(api.capture.gaps, { ...args, clientId: f.otherClientId })).rejects.toThrow('Access unavailable');
    await expect(f.op.query(api.capture.domBatches, { ...args, paginationOpts: { numItems: 26, cursor: null } })).rejects.toThrow('1–25');
    await f.t.mutation(api.capture.changeConsent, { token: f.token, expectedRevision: 1, consent: { ...consent, dom: false } });
    expect((await f.t.query(api.capture.status, { token: f.token })).domPolicy).toBeNull();
    await expect(f.op.query(api.capture.domBatches, args)).rejects.toThrow('Access unavailable');
    await f.t.mutation(api.capture.changeConsent, { token: f.token, expectedRevision: 2, consent });
    expect((await f.op.query(api.capture.domBatches, args)).page).toEqual([]);
    const renewed = { ...connection, challenge: 'e'.repeat(64) };
    await f.t.mutation(api.capture.connectDom, renewed);
    await f.t.mutation(api.capture.appendDom, { ...renewed, requestId: 'inspect-dom-after', events: [{ ...event, sequence: 1, atMs: 10 }] });
    expect((await f.op.query(api.capture.domBatches, args)).page[0].generation).toBe(2);
    await f.t.run(ctx => ctx.db.patch(f.authSessionId, { expirationTime: Date.now() - 1 }));
    await expect(f.op.query(api.capture.gaps, args)).rejects.toThrow('Access unavailable');
  });
  test('DOM disconnect is current-challenge bound and replay-safe; a stale popup cannot close its successor', async () => {
    const f = await fixture(); await f.t.mutation(api.capture.start, { token: f.token });
    await f.op.mutation(api.capture.authorizePrototype, { clientId: f.scope.clientId, projectId: f.scope.projectId, studyId: f.studyId, origin: 'https://prototype.example.test', componentIds: ['c1'] });
    const old = { token: f.token, challenge: 'd'.repeat(64), origin: 'https://prototype.example.test' };
    await f.t.mutation(api.capture.connectDom, old);
    const event = { sequence: 0, atMs: 0, kind: 'connected' as const, target: 'none', tag: 'none' as const, x: null, y: null };
    await f.t.mutation(api.capture.appendDom, { ...old, requestId: 'disconnect-before', events: [event] });
    expect((await f.t.query(api.capture.status, { token: f.token })).domConnected).toBe(true);
    const disconnect = { token: f.token, challenge: old.challenge };
    await f.t.mutation(api.capture.disconnectDom, disconnect);
    await f.t.mutation(api.capture.disconnectDom, disconnect);
    expect((await f.t.query(api.capture.status, { token: f.token })).domConnected).toBe(false);
    await expect(f.t.mutation(api.capture.appendDom, { ...old, requestId: 'disconnect-late', events: [{ ...event, sequence: 1, atMs: 10 }] })).rejects.toThrow('Access unavailable');
    const renewed = { ...old, challenge: 'e'.repeat(64) };
    expect(await f.t.mutation(api.capture.connectDom, renewed)).toEqual({ generation: 2, nextSequence: 1 });
    await f.t.mutation(api.capture.appendDom, { ...renewed, requestId: 'disconnect-after', events: [{ ...event, sequence: 1, atMs: 10 }] });
    await f.t.mutation(api.capture.disconnectDom, disconnect);
    expect((await f.t.query(api.capture.status, { token: f.token })).domConnected).toBe(true);
    const gaps = await f.op.query(api.capture.gaps, { ...f.scope, paginationOpts: { numItems: 25, cursor: null } });
    expect(gaps.page.filter(gap => gap.modality === 'dom' && gap.reason === 'track-ended')).toHaveLength(1);
    await f.t.mutation(api.capture.disconnectDom, { token: f.token, challenge: renewed.challenge });
    expect((await f.op.query(api.capture.gaps, { ...f.scope, paginationOpts: { numItems: 25, cursor: null } })).page).toHaveLength(2);
    await f.t.mutation(api.capture.changeConsent, { token: f.token, expectedRevision: 1, consent: { ...consent, dom: false } });
    await expect(f.t.mutation(api.capture.disconnectDom, { token: f.token, challenge: renewed.challenge })).rejects.toThrow('Access unavailable');
  });
  test('DOM disconnect at gap capacity closes capture and releases its active slot without erasing continuity', async () => {
    const f = await fixture(), { capture } = await reserved(f);
    await f.op.mutation(api.capture.authorizePrototype, { clientId: f.scope.clientId, projectId: f.scope.projectId, studyId: f.studyId, origin: 'https://prototype.example.test', componentIds: ['c1'] });
    const connection = { token: f.token, challenge: 'd'.repeat(64), origin: 'https://prototype.example.test' };
    await f.t.mutation(api.capture.connectDom, connection);
    await f.t.run(async ctx => { for (let i = 0; i < 100; i++) await ctx.db.insert('researchCaptureGaps', { captureId: capture.captureId, sessionId: f.invite.sessionId, requestId: `full-gap-${i}`, modality: 'dom', atMs: i, reason: 'track-ended', recordedAt: Date.now() }); });
    await f.t.mutation(api.capture.disconnectDom, { token: f.token, challenge: connection.challenge });
    expect((await f.t.query(api.capture.status, { token: f.token })).recording).toBe('stopped');
    expect((await f.t.run(ctx => ctx.db.query('researchCaptureCapacity').withIndex('by_name', q => q.eq('name', 'demo')).unique()))?.activeSessionId).toBeNull();
    expect(await f.t.run(ctx => ctx.db.query('researchCaptureGaps').withIndex('by_sessionId', q => q.eq('sessionId', f.invite.sessionId)).take(101))).toHaveLength(100);
    await expect(f.t.mutation(api.capture.connectDom, { ...connection, challenge: 'e'.repeat(64) })).rejects.toThrow('Access unavailable');
  });
});

describe('S5 independent-review counterexamples', () => {
  test.each(['available', 'reserved', 'uploading'] as const)('R1: 50 still-consented %s microphone rows cannot starve camera withdrawal; a later epoch change is recovered too', async state => {
    const f = await fixture(), { media, capture } = await reserved(f); await available(f, media.id);
    await f.t.run(async ctx => {
      const template = (await ctx.db.get(media.id))!;
      const { _id, _creationTime, ...fields } = template, base = { ...fields, state };
      await ctx.db.patch(media.id, { state });
      for (let i = 1; i < 50; i++) await ctx.db.insert('researchMedia', { ...base, requestId: `microphone-${i}`, sourceId: `mic-${i}`, objectKey: `research/${f.invite.sessionId}/mic-${i}`, descriptor: { ...descriptor, sequence: i, startMs: i * 1000, endMs: (i + 1) * 1000 } });
      await ctx.db.insert('researchMedia', { ...base, requestId: 'last-camera', sourceId: 'camera-last', objectKey: `research/${f.invite.sessionId}/camera-last`, descriptor: { ...descriptor, modality: 'camera', mime: 'video/webm' } });
      await ctx.db.patch(capture.captureId, { reservedBytes: 51 * 20, segmentCount: 51 });
    });
    await f.t.mutation(api.capture.changeConsent, { token: f.token, expectedRevision: 1, consent: { ...consent, camera: false } });
    const camera = (await f.t.run(ctx => ctx.db.query('researchMedia').withIndex('by_sessionId_and_requestId', q => q.eq('sessionId', f.invite.sessionId).eq('requestId', 'last-camera')).unique()))!;
    const readCamera = { ...f.scope, mediaId: camera._id };
    await expect(f.op.query(api.captureGateway.read, { ...readCamera, proof: await signGateway(secret, 'read', readCamera) })).rejects.toThrow('Access unavailable');
    await f.t.mutation(internal.captureLifecycle.purge, { captureId: capture.captureId });
    const first = await f.t.run(ctx => ctx.db.query('researchMedia').withIndex('by_sessionId', q => q.eq('sessionId', f.invite.sessionId)).take(60));
    expect(first.find(row => row.sourceId === 'camera-last')?.state).toBe('delete-pending');
    expect(first.filter(row => row.descriptor.modality === 'microphone' && row.state === state)).toHaveLength(50);
    await f.t.mutation(api.capture.changeConsent, { token: f.token, expectedRevision: 2, consent: { ...consent, camera: false, microphone: false } });
    for (let i = 0; i < 3; i++) await f.t.mutation(internal.captureLifecycle.purge, { captureId: capture.captureId });
    const second = await f.t.run(ctx => ctx.db.query('researchMedia').withIndex('by_sessionId', q => q.eq('sessionId', f.invite.sessionId)).take(60));
    expect(second.every(row => row.state === 'delete-pending')).toBe(true);
  });
  test('R2: only a fenced successor attempt can retry the same logical segment, without double capacity or stale writer mutation', async () => {
    const f = await fixture(), { media, capture } = await reserved(f), input = { token: f.token, mediaId: media.id, attempt: 0 };
    const claimed = await f.t.mutation(api.captureGateway.claim, { ...input, proof: await signGateway(secret, 'claim', input) });
    await expect(f.t.mutation(api.captureGateway.beginRetry, { ...input, proof: await signGateway(secret, 'beginRetry', input) })).rejects.toThrow('Retry unavailable');
    vi.setSystemTime(claimed.leaseUntil + 1);
    await f.t.mutation(api.captureGateway.beginRetry, { ...input, proof: await signGateway(secret, 'beginRetry', input) });
    const oldCommit = { mediaId: media.id, attempt: 0, bytes: descriptor.bytes, sha256: descriptor.sha256, mime: descriptor.mime };
    expect(await f.t.mutation(api.captureGateway.finalize, { ...oldCommit, proof: await signGateway(secret, 'finalize', oldCommit) })).toBe(false);
    const activate = { ...input, retiredKey: claimed.key };
    const next = await f.t.mutation(api.captureGateway.activateRetry, { ...activate, proof: await signGateway(secret, 'activateRetry', activate) });
    expect(next.attempt).toBe(1); expect(next.key).not.toBe(claimed.key);
    const claimNext = { ...input, attempt: 1 };
    await f.t.mutation(api.captureGateway.claim, { ...claimNext, proof: await signGateway(secret, 'claim', claimNext) });
    // Lost activation acknowledgement must not reset the already uploading successor.
    expect((await f.t.mutation(api.captureGateway.activateRetry, { ...activate, proof: await signGateway(secret, 'activateRetry', activate) })).state).toBe('uploading');
    expect(await f.t.mutation(api.captureGateway.finalize, { ...oldCommit, proof: await signGateway(secret, 'finalize', oldCommit) })).toBe(false);
    const current = await f.t.run(ctx => ctx.db.get(media.id));
    expect(current).toMatchObject({ state: 'uploading', attempt: 1, sourceId: media.sourceId, descriptor });
    expect((await f.t.run(ctx => ctx.db.get(capture.captureId)))?.reservedBytes).toBe(20);
    expect(await f.t.run(ctx => ctx.db.query('researchMedia').withIndex('by_sessionId', q => q.eq('sessionId', f.invite.sessionId)).take(5))).toHaveLength(1);
    vi.setSystemTime(current!.leaseUntil + 1);
    await f.t.mutation(api.captureGateway.beginRetry, { ...claimNext, proof: await signGateway(secret, 'beginRetry', claimNext) });
    const secondActivation = { ...claimNext, retiredKey: current!.objectKey };
    const lastAttempt = await f.t.mutation(api.captureGateway.activateRetry, { ...secondActivation, proof: await signGateway(secret, 'activateRetry', secondActivation) });
    const exhausted = { ...input, attempt: lastAttempt.attempt };
    await expect(f.t.mutation(api.captureGateway.beginRetry, { ...exhausted, proof: await signGateway(secret, 'beginRetry', exhausted) })).rejects.toThrow('Retry unavailable');
  });
  test.each(['paused', 'partial', 'completed'] as const)('R3: %s rejects new DOM collection but allows an exact prior receipt', async state => {
    const f = await fixture(); await f.t.mutation(api.capture.start, { token: f.token });
    await f.op.mutation(api.capture.authorizePrototype, { clientId: f.scope.clientId, projectId: f.scope.projectId, studyId: f.studyId, origin: 'https://prototype.example.test', componentIds: ['c1'] });
    const connection = { token: f.token, challenge: 'd'.repeat(64), origin: 'https://prototype.example.test' };
    await f.t.mutation(api.capture.connectDom, connection);
    const batch = { ...connection, requestId: 'before-pause', events: [{ sequence: 0, atMs: 0, kind: 'connected' as const, target: 'none', tag: 'none' as const, x: null, y: null }] };
    const receipt = await f.t.mutation(api.capture.appendDom, batch);
    let rev = 1;
    if (state === 'completed') { await f.t.mutation(api.participant.answer, { token: f.token, expectedRevision: rev++, requestId: 'answer-complete', questionId: 'q1', text: 'Clear', channel: 'text' }); }
    await f.t.mutation(api.participant.transition, { token: f.token, expectedRevision: rev++, state });
    expect(await f.t.mutation(api.capture.appendDom, batch)).toBe(receipt);
    const newBatch = { ...connection, requestId: 'after-pause', events: [{ sequence: 1, atMs: 100, kind: 'click' as const, target: 'c1', tag: 'button' as const, x: null, y: null }] };
    await expect(f.t.mutation(api.capture.appendDom, newBatch)).rejects.toThrow('Access unavailable');
    await expect(f.t.mutation(api.capture.connectDom, connection)).rejects.toThrow('Access unavailable');
    if (state === 'paused') {
      await f.t.mutation(api.participant.transition, { token: f.token, expectedRevision: rev, state: 'active' });
      expect((await f.t.query(api.capture.status, { token: f.token })).recording).toBe('paused');
      await expect(f.t.mutation(api.capture.appendDom, newBatch)).rejects.toThrow('Access unavailable');
      await f.t.mutation(api.capture.start, { token: f.token });
      const renewed = { ...connection, challenge: 'e'.repeat(64) };
      expect((await f.t.mutation(api.capture.connectDom, renewed)).nextSequence).toBe(1);
      await f.t.mutation(api.capture.appendDom, { ...renewed, requestId: 'resume-handshake', events: [{ ...batch.events[0], sequence: 1, atMs: 100 }] });
      expect((await f.t.query(api.capture.status, { token: f.token })).domConnected).toBe(true);
      expect((await f.t.run(ctx => ctx.db.query('researchCaptureGaps').withIndex('by_sessionId', q => q.eq('sessionId', f.invite.sessionId)).take(10))).some(gap => gap.modality === 'dom' && gap.reason === 'paused')).toBe(true);
    }
  });
  test('R4: recovery alone resumes day-one withdrawal across multiple source batches before day thirty', async () => {
    const f = await fixture(), original = (await f.t.run(ctx => ctx.db.get(f.invite.sessionId)))!;
    const recoveryAt = original.createdAt + 86400000;
    vi.setSystemTime(recoveryAt);
    // Persist an interrupted withdrawal without scheduling its normal immediate job.
    await f.t.run(async ctx => {
      for (let i = 1; i < 151; i++) await ctx.db.insert('researchSources', { sessionId: original._id, clientId: original.clientId, projectId: original.projectId, sequence: i, sourceId: `withdraw-${i}`, requestId: `withdraw-${i}`, questionId: 'q1', author: 'participant', channel: 'text', text: 'Synthetic retained source', recordedAt: Date.now(), supersedes: null });
      await ctx.db.patch(original._id, { withdrawnAt: Date.now(), retentionState: 'purging', sourceCount: 151 });
    });
    expect(await f.t.mutation(internal.lifecycle.sweepRetention, {})).toBe(1);
    await vi.advanceTimersByTimeAsync(0); await f.t.finishInProgressScheduledFunctions();
    expect(await f.t.run(ctx => ctx.db.get(original._id))).toMatchObject({ retentionState: 'purging', sourceCount: 51, retainUntil: original.retainUntil });
    const continuations = await f.t.run(ctx => ctx.db.system.query('_scheduled_functions').collect());
    expect(continuations.filter(job => job.name === 'lifecycle:purgeSources' && job.state.kind === 'pending' && job.scheduledTime === recoveryAt)).toHaveLength(1);
    // Vitest defers zero-delay timers created during a tick by 1 ms. The persisted
    // continuation is still runAfter(0); drain that next turn, not future deadlines.
    await vi.advanceTimersByTimeAsync(1); await f.t.finishInProgressScheduledFunctions();
    expect(Date.now()).toBe(recoveryAt + 1);
    expect(Date.now()).toBeLessThan(original.retainUntil);
    expect(await f.t.run(ctx => ctx.db.get(original._id))).toMatchObject({ retentionState: 'purged', sourceCount: 0, retainUntil: original.retainUntil, purgedAt: recoveryAt + 1 });
    expect(await f.t.run(ctx => ctx.db.query('researchSources').withIndex('by_sessionId_and_sequence', q => q.eq('sessionId', original._id)).take(1))).toEqual([]);
  });
});
