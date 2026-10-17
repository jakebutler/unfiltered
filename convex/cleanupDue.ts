import type { Doc } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';

/** Eligibility only: never edits/reschedules a writer or unknown retirement. */
export async function cleanupEligible(ctx: MutationCtx, row: Doc<'researchMedia'>, now: number) {
  if (row.state !== 'delete-pending' || (row.cleanupNextAt ?? 0) > now || row.leaseUntil > now || (row.cleanupUntil ?? 0) > now || (row.cleanupAttempts ?? 0) >= 8) return false;
  if (row.cleanupLeaseId) {
    const lease = await ctx.db.get(row.cleanupLeaseId);
    // An absent lease cannot establish settlement. Reuse of a fixed slot with a
    // newer generation proves the preceding execution was explicitly released.
    if (!lease || lease.generation === row.cleanupLeaseGeneration && lease.workStarted) return false;
  }
  return true;
}
