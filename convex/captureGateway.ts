import { ConvexError, v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { denied, operator, participant, projectFor, retainsSources } from './access';
import { captureFor, segmentVisible } from './capture';
import { gatewayObject, gatewayProof } from './captureValidators';
import { captureLimits } from '../packages/research-capture/src/contracts';
import { verifyGateway } from '../packages/research-capture/src/proof';

// Convex provides process.env in its V8 runtime; this is a module-scoped type only.
declare const process: { env: Record<string, string | undefined> };

const auth = (operation: string, input: unknown, proof: { at: number; signature: string }) => verifyGateway(process.env.RESEARCH_MEDIA_GATEWAY_SECRET, operation, input, proof);
const object = (row: import('./_generated/dataModel').Doc<'researchMedia'>) => ({ id: row._id, key: row.objectKey, attempt: row.attempt, retryUntil: row.retryUntil, claimUntil: row.claimUntil, descriptor: row.descriptor, leaseUntil: row.leaseUntil, state: row.state });
export const claim = mutation({ args: { token: v.string(), mediaId: v.id('researchMedia'), attempt: v.number(), proof: gatewayProof }, returns: gatewayObject, handler: async (ctx, { proof, ...args }) => {
  await auth('claim', args, proof);
  const { session } = await participant(ctx, args.token), row = await ctx.db.get(args.mediaId), capture = await captureFor(ctx, session._id);
  if (!row || !capture || row.sessionId !== session._id || !session.consent?.storage || !session.consent[row.descriptor.modality] || row.consentEpoch <= capture.revokedThrough[row.descriptor.modality] || ['purging', 'purged'].includes(capture.state)) return denied();
  if (row.attempt !== args.attempt) throw new ConvexError('Upload attempt changed; reconcile');
  if (row.state === 'available') return object(row);
  if (row.claimUntil <= Date.now() || row.retryUntil <= Date.now() || row.state !== 'reserved') throw new ConvexError('Upload requires reconciliation');
  const leaseUntil = Math.min(row.retryUntil, Date.now() + captureLimits(process.env.RESEARCH_CAPTURE_LIMITS_JSON).uploadLeaseMs);
  await ctx.db.patch(row._id, { state: 'uploading', leaseUntil });
  return { ...object(row), state: 'uploading' as const, leaseUntil };
} });
export const inspect = query({ args: { token: v.string(), mediaId: v.id('researchMedia'), proof: gatewayProof }, returns: gatewayObject, handler: async (ctx, { proof, ...args }) => {
  await auth('inspect', args, proof);
  const { session } = await participant(ctx, args.token), row = await ctx.db.get(args.mediaId), capture = await captureFor(ctx, session._id);
  if (!row || !capture || row.sessionId !== session._id || !session.consent?.[row.descriptor.modality] || row.consentEpoch <= capture.revokedThrough[row.descriptor.modality] || !['reserved', 'uploading', 'retry-fencing', 'available'].includes(row.state)) return denied();
  return object(row);
} });
export const beginRetry = mutation({ args: { token: v.string(), mediaId: v.id('researchMedia'), attempt: v.number(), proof: gatewayProof }, returns: gatewayObject, handler: async (ctx, { proof, ...args }) => {
  await auth('beginRetry', args, proof);
  const { session } = await participant(ctx, args.token), row = await ctx.db.get(args.mediaId), capture = await captureFor(ctx, session._id);
  if (!row || !capture || row.sessionId !== session._id || !session.consent?.storage || !session.consent[row.descriptor.modality] || row.consentEpoch <= capture.revokedThrough[row.descriptor.modality] || ['purging', 'purged'].includes(capture.state)) return denied();
  if (row.attempt !== args.attempt || row.retryUntil <= Date.now() || row.attempt + 1 >= captureLimits(process.env.RESEARCH_CAPTURE_LIMITS_JSON).uploadAttempts || row.leaseUntil > Date.now() || !['reserved', 'uploading', 'retry-fencing'].includes(row.state)) throw new ConvexError('Retry unavailable; reconcile the current attempt');
  // Once this intent exists, late finalization cannot make this old key available.
  // The gateway must retire and read back this exact key before activating a new one.
  if (row.state !== 'retry-fencing') await ctx.db.patch(row._id, { state: 'retry-fencing' });
  return { ...object(row), state: 'retry-fencing' as const };
} });
export const activateRetry = mutation({ args: { token: v.string(), mediaId: v.id('researchMedia'), attempt: v.number(), retiredKey: v.string(), proof: gatewayProof }, returns: gatewayObject, handler: async (ctx, { proof, ...args }) => {
  await auth('activateRetry', args, proof);
  const { session } = await participant(ctx, args.token), row = await ctx.db.get(args.mediaId), capture = await captureFor(ctx, session._id);
  if (!row || !capture || row.sessionId !== session._id || !session.consent?.storage || !session.consent[row.descriptor.modality] || row.consentEpoch <= capture.revokedThrough[row.descriptor.modality] || ['purging', 'purged'].includes(capture.state)) return denied();
  // An activation acknowledgement may be lost. It returns the current receipt;
  // it never rotates again or resets an already claimed successor attempt.
  if (row.attempt === args.attempt + 1 && row.retiredKeys.at(-1) === args.retiredKey && ['reserved', 'uploading', 'available'].includes(row.state)) return object(row);
  if (row.attempt !== args.attempt || row.objectKey !== args.retiredKey || row.state !== 'retry-fencing' || row.leaseUntil > Date.now() || row.retryUntil <= Date.now() || row.attempt + 1 >= captureLimits(process.env.RESEARCH_CAPTURE_LIMITS_JSON).uploadAttempts) return denied();
  const next = row.attempt + 1;
  await ctx.db.patch(row._id, { state: 'reserved', attempt: next, objectKey: `research/${row.sessionId}/${row._id}-a${next}`, retiredKeys: [...row.retiredKeys, row.objectKey], leaseUntil: 0, claimUntil: Math.min(row.retryUntil, Date.now() + captureLimits(process.env.RESEARCH_CAPTURE_LIMITS_JSON).reservationMs) });
  return object((await ctx.db.get(row._id))!);
} });
export const finalize = mutation({ args: { mediaId: v.id('researchMedia'), attempt: v.number(), bytes: v.number(), sha256: v.string(), mime: v.string(), proof: gatewayProof }, returns: v.boolean(), handler: async (ctx, { proof, ...args }) => {
  await auth('finalize', args, proof);
  const row = await ctx.db.get(args.mediaId);
  if (!row) return denied();
  // A retired writer can never finalize or modify its successor's state.
  if (row.attempt !== args.attempt || row.state === 'retry-fencing') return false;
  const session = await ctx.db.get(row.sessionId), capture = await ctx.db.get(row.captureId);
  if (!session || !capture) return denied();
  if (row.descriptor.bytes !== args.bytes || row.descriptor.sha256 !== args.sha256 || row.descriptor.mime !== args.mime) throw new ConvexError('Stored object differs from reservation');
  // Re-read the invitation and scope after upload, even when consent changed mid-flight.
  const invitations = await ctx.db.query('researchInvitations').withIndex('by_sessionId', q => q.eq('sessionId', session._id)).take(2);
  const invite = invitations[0], project = await ctx.db.get(session.projectId), client = await ctx.db.get(session.clientId);
  const allowed = (row.state === 'available' || row.retryUntil > Date.now()) && retainsSources(session) && !!session.consent?.storage && !!session.consent[row.descriptor.modality] && row.consentEpoch > capture.revokedThrough[row.descriptor.modality] && !['purging', 'purged'].includes(capture.state) && project?.state === 'active' && client?.state === 'active' && invitations.length === 1 && invite.revokedAt === null && invite.expiredAt === undefined && invite.expiresAt > Date.now();
  if (!allowed || !['uploading', 'available'].includes(row.state)) {
    if (row.state !== 'deleted') await ctx.db.patch(row._id, { state: 'delete-pending' });
    return false;
  }
  if (row.state !== 'available') await ctx.db.patch(row._id, { state: 'available', availableAt: Date.now(), leaseUntil: 0 });
  return true;
} });
export const read = query({ args: { mediaId: v.id('researchMedia'), clientId: v.id('researchClients'), projectId: v.id('researchProjects'), sessionId: v.id('researchSessions'), proof: gatewayProof }, returns: gatewayObject, handler: async (ctx, { proof, ...args }) => {
  await auth('read', args, proof);
  const actor = await operator(ctx), { client, project } = await projectFor(ctx, actor.userId, args.clientId, args.projectId);
  const session = await ctx.db.get(args.sessionId), row = await ctx.db.get(args.mediaId), capture = session && await captureFor(ctx, session._id);
  if (!session || !row || !capture || row.sessionId !== session._id || session.clientId !== args.clientId || session.projectId !== args.projectId || client.state !== 'active' || project.state !== 'active' || !segmentVisible(session, capture, row)) return denied();
  return object(row);
} });
export const cleanup = query({ args: { proof: gatewayProof }, returns: v.array(gatewayObject), handler: async (ctx, args) => {
  await auth('cleanup', {}, args.proof);
  // Do not delete while an admitted writer may still produce bytes.
  const rows = await ctx.db.query('researchMedia').withIndex('by_state_and_leaseUntil', q => q.eq('state', 'delete-pending').lte('leaseUntil', Date.now())).take(10);
  return rows.map(object);
} });
export const deleted = mutation({ args: { mediaId: v.id('researchMedia'), attempt: v.number(), proof: gatewayProof }, returns: v.null(), handler: async (ctx, { proof, ...args }) => {
  await auth('deleted', args, proof);
  const row = await ctx.db.get(args.mediaId);
  if (!row || row.state === 'deleted') return null;
  if (row.attempt !== args.attempt) return denied();
  if (row.state !== 'delete-pending' || row.leaseUntil > Date.now()) return denied();
  const capture = await ctx.db.get(row.captureId);
  await ctx.db.patch(row._id, { state: 'deleted', deletedAt: Date.now() });
  if (capture) await ctx.db.patch(capture._id, { reservedBytes: Math.max(0, capture.reservedBytes - row.descriptor.bytes) });
  return null;
} });
