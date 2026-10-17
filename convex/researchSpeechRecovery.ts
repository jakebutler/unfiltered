import { ConvexError, v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { speechTransportLease } from './researchSpeech';

const state = v.union(v.literal('reserved'), v.literal('completed'), v.literal('interrupted'), v.literal('failed'), v.literal('unknown'));
/** Root-only recovery for an observed stopped provider. The supplied evidence
 * digest binds the reviewed positive close receipt; native code cannot establish
 * that external observation itself. No expiry, refund or completion inference. */
export const fenceStoppedAttempt = internalMutation({
  args: { sessionId: v.id('researchSessions'), requestId: v.string(), provider: v.literal('deepgram'), expectedState: state, transportLease: speechTransportLease, allocationId: v.string(), providerCloseEvidenceSha256: v.string() },
  returns: v.object({ attemptId: v.id('researchSpeechAttempts'), state, active: v.boolean(), fencedGeneration: v.number(), rawSourceId: v.union(v.string(), v.null()), acceptedSourceId: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    const reject = () => { throw new ConvexError('Exact stopped speech recovery unavailable'); };
    const identity = args.transportLease;
    if (!/^[a-f0-9]{64}$/.test(args.providerCloseEvidenceSha256) || !/^[a-zA-Z0-9_-]{8,128}$/.test(args.allocationId) || !/^[a-f0-9]{32}$/.test(identity.owner) || !/^[a-f0-9]{32}$/.test(identity.requestId) || !Number.isSafeInteger(identity.generation) || identity.generation < 1 || identity.generation >= Number.MAX_SAFE_INTEGER) return reject();
    const attempt = await ctx.db.query('researchSpeechAttempts').withIndex('by_sessionId_and_requestId', q => q.eq('sessionId', args.sessionId).eq('requestId', args.requestId)).unique();
    if (!attempt || attempt.provider !== args.provider || !attempt.grantId || !attempt.transportLease || Object.keys(identity).some(key => identity[key as keyof typeof identity] !== attempt.transportLease![key as keyof typeof identity])) return reject();
    const result = () => ({ attemptId: attempt._id, state: attempt.state, active: attempt.active, fencedGeneration: attempt.transportFence!.observedGeneration, rawSourceId: attempt.rawSourceId, acceptedSourceId: attempt.acceptedSourceId });
    if (attempt.transportFence) {
      if (attempt.transportFence.evidenceSha256 !== args.providerCloseEvidenceSha256 || attempt.transportFence.allocationId !== args.allocationId || attempt.transportFence.previousState !== args.expectedState || attempt.transportFence.observedGeneration !== identity.generation + 1) return reject();
      // Exact replay reads the original receipt; it never touches a successor slot.
      return result();
    }
    const slot = await ctx.db.get(identity.leaseId), grant = await ctx.db.get(attempt.grantId), session = await ctx.db.get(args.sessionId);
    if (!slot || slot.kind !== 'voice' || slot.owner !== identity.owner || slot.requestId !== identity.requestId || slot.generation !== identity.generation || (!slot.workStarted && slot.expiresAt !== 0) || slot.allocationId !== args.allocationId || !grant || grant.enabled || !session || grant.studyId !== session.studyId || attempt.state !== args.expectedState) return reject();
    const audit = { reason: 'native-generation-fenced-after-provider-close' as const, evidenceSha256: args.providerCloseEvidenceSha256, allocationId: args.allocationId, previousState: attempt.state, observedGeneration: identity.generation + 1, fencedAt: Date.now() };
    const outcome = attempt.state === 'reserved' ? 'unknown' as const : attempt.state;
    // Reads of both rows conflict with any pre-fence save/settle transaction.
    // Counters, grant/session charges and committed source IDs are never rewritten.
    await ctx.db.patch(slot._id, { generation: audit.observedGeneration, expiresAt: 0, workStarted: false });
    await ctx.db.patch(attempt._id, { transportFence: audit, state: outcome, active: false });
    return { attemptId: attempt._id, state: outcome, active: false, fencedGeneration: audit.observedGeneration, rawSourceId: attempt.rawSourceId, acceptedSourceId: attempt.acceptedSourceId };
  },
});
