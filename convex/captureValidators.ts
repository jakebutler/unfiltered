import { v } from 'convex/values';
export const modality = v.union(v.literal('microphone'), v.literal('camera'), v.literal('screen'));
export const segmentState = v.union(v.literal('reserved'), v.literal('uploading'), v.literal('retry-fencing'), v.literal('available'), v.literal('delete-pending'), v.literal('deleted'));
export const descriptor = v.object({ modality, sequence: v.number(), startMs: v.number(), endMs: v.number(), bytes: v.number(), sha256: v.string(), mime: v.string(), questionId: v.string(), sourceId: v.union(v.string(), v.null()) });
export const domEvent = v.object({ sequence: v.number(), atMs: v.number(), kind: v.union(v.literal('connected'), v.literal('click'), v.literal('focus'), v.literal('change'), v.literal('scroll')), target: v.string(), tag: v.union(v.literal('none'), v.literal('button'), v.literal('link'), v.literal('input'), v.literal('select'), v.literal('other')), x: v.union(v.number(), v.null()), y: v.union(v.number(), v.null()) });
export const gatewayProof = v.object({ at: v.number(), signature: v.string() });
export const segmentView = v.object({ id: v.id('researchMedia'), descriptor, state: segmentState, sourceId: v.string(), recordedAt: v.number(), availableAt: v.union(v.number(), v.null()) });
export const gatewayObject = v.object({ id: v.id('researchMedia'), key: v.string(), attempt: v.number(), retryUntil: v.number(), claimUntil: v.number(), descriptor, leaseUntil: v.number(), state: segmentState });
