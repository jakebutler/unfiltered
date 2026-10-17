import { ConvexError } from 'convex/values';
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
declare const process: { env: Record<string, string | undefined> };
export const CLEANUP_GRACE_MS = 2 * 86_400_000;
// Per admitted row: eight single-row ticks, retirement(3)+head(2), two probe bytes.
// Batching only reduces requests. Unused capture reservations are never refunded.
export const CLEANUP_RESERVE = { requests: 8, operations: 40, bytes: 16 } as const;
async function allocation(ctx: QueryCtx) {
  const id = process.env.RESEARCH_HOSTED_CLEANUP_ALLOCATION;
  return id ? ctx.db.query('researchGatewayAllocations').withIndex('by_allocationId', q => q.eq('allocationId', id)).unique() : null;
}
export async function cleanupAdmissionReady(ctx: QueryCtx, retainUntil: number, mediaLimit: number) {
  const row = await allocation(ctx), reserved = row?.cleanupReservedMedia ?? 0;
  return !!row && row.purpose === 'cleanup' && Number.isSafeInteger(retainUntil) && Number.isSafeInteger(mediaLimit) && mediaLimit > 0 && Number.isSafeInteger(reserved) && reserved >= 0 && row.expiresAt >= retainUntil + CLEANUP_GRACE_MS &&
    [row.requestsConsumed, row.storageOperationsConsumed, row.readBytesConsumed].every(n => Number.isSafeInteger(n) && n >= 0) &&
    row.requestLimit >= (reserved + mediaLimit) * CLEANUP_RESERVE.requests && row.storageOperationLimit >= (reserved + mediaLimit) * CLEANUP_RESERVE.operations && row.readByteLimit >= (reserved + mediaLimit) * CLEANUP_RESERVE.bytes &&
    row.requestLimit - row.requestsConsumed >= mediaLimit * CLEANUP_RESERVE.requests && row.storageOperationLimit - row.storageOperationsConsumed >= mediaLimit * CLEANUP_RESERVE.operations && row.readByteLimit - row.readBytesConsumed >= mediaLimit * CLEANUP_RESERVE.bytes;
}
/** Atomic lifetime commitment, never released/refunded for unused capture slots. */
export async function reserveCaptureCleanup(ctx: MutationCtx, retainUntil: number, mediaLimit: number) {
  if (!await cleanupAdmissionReady(ctx, retainUntil, mediaLimit)) throw new ConvexError('Recording cleanup authority is unavailable');
  const row = (await allocation(ctx))!;
  await ctx.db.patch(row._id, { cleanupReservedMedia: (row.cleanupReservedMedia ?? 0) + mediaLimit });
  return { cleanupAllocationId: row.allocationId, cleanupMediaLimit: mediaLimit };
}
export async function captureCleanupCovered(ctx: QueryCtx, capture: Doc<'researchCaptures'>) {
  const row = await allocation(ctx);
  return !!row && row.purpose === 'cleanup' && row.allocationId === capture.cleanupAllocationId && Number.isSafeInteger(capture.cleanupMediaLimit) && capture.cleanupMediaLimit! > 0 && Number.isSafeInteger(row.cleanupReservedMedia) && row.cleanupReservedMedia! >= capture.cleanupMediaLimit! && row.expiresAt >= capture.retainUntil + CLEANUP_GRACE_MS &&
    row.requestLimit >= row.cleanupReservedMedia! * CLEANUP_RESERVE.requests && row.storageOperationLimit >= row.cleanupReservedMedia! * CLEANUP_RESERVE.operations && row.readByteLimit >= row.cleanupReservedMedia! * CLEANUP_RESERVE.bytes &&
    [row.requestsConsumed, row.storageOperationsConsumed, row.readBytesConsumed].every(n => Number.isSafeInteger(n) && n >= 0) &&
    row.requestLimit - row.requestsConsumed >= CLEANUP_RESERVE.requests && row.storageOperationLimit - row.storageOperationsConsumed >= CLEANUP_RESERVE.operations && row.readByteLimit - row.readBytesConsumed >= CLEANUP_RESERVE.bytes;
}
