import { v } from 'convex/values';
export const gatewayKind = v.union(v.literal('operation'), v.literal('upload'), v.literal('read'), v.literal('password'), v.literal('analysis'), v.literal('voice'), v.literal('cleanup'));
export const leaseIdentity = { leaseId: v.id('researchGatewaySlots'), requestId: v.string(), owner: v.string(), generation: v.number() };
export const gatewayLease = v.object({ ...leaseIdentity, kind: gatewayKind, expiresAt: v.number(), bodyDeadlineAt: v.number(), responseDeadlineAt: v.number(), allocationId: v.optional(v.string()) });
export const quotaOperation = v.union(v.literal('authority'), v.literal('head'), v.literal('read'), v.literal('put'), v.literal('retire'));
export const cleanupClaim = v.object({ mediaId: v.id('researchMedia'), attempt: v.number(), key: v.string(), owner: v.string(), generation: v.number(), expiresAt: v.number(), operations: v.literal(4) });
