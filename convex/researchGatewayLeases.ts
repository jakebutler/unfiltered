import { ConvexError, v } from 'convex/values';
import { mutation, query, internalQuery, internalAction, internalMutation, type MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import { gatewayKind, gatewayLease, leaseIdentity, quotaOperation } from './gatewayLeaseValidators';
import { gatewayProof } from './captureValidators';
import { signGateway, verifyGateway } from '../packages/research-capture/src/proof';
import type { Doc } from './_generated/dataModel';
import { cleanupEligible } from './cleanupDue';
declare const process: { env: Record<string, string | undefined> };
const caps = { operation: 4, upload: 1, read: 2, password: 1, analysis: 1, voice: 1, cleanup: 1 } as const;
const lifetimes = { operation: 30_000, upload: 65_000, read: 30_000, password: 30_000, analysis: 120_000, voice: 180_000, cleanup: 180_000 } as const;
const auth = (operation: string, input: unknown, proof: { at: number; signature: string }) => verifyGateway(process.env.RESEARCH_MEDIA_GATEWAY_SECRET, operation, input, proof);
const identity = (args: { requestId: string; owner: string; generation?: number }) => {
  if (!/^[a-f0-9]{32}$/.test(args.requestId) || !/^[a-f0-9]{32}$/.test(args.owner) || args.generation !== undefined && (!Number.isSafeInteger(args.generation) || args.generation < 1)) throw new ConvexError('Gateway lease unavailable');
};
const receipt = (row: Doc<'researchGatewaySlots'>) => ({ leaseId: row._id, requestId: row.requestId, owner: row.owner, generation: row.generation, kind: row.kind, expiresAt: row.expiresAt, bodyDeadlineAt: row.bodyDeadlineAt, responseDeadlineAt: row.expiresAt - 45_000, ...(row.allocationId ? { allocationId: row.allocationId } : {}) });
const allocationFields = { purpose: v.optional(v.union(v.literal('interactive'), v.literal('cleanup'))), allocationId: v.string(), expiresAt: v.number(), requestLimit: v.number(), readByteLimit: v.number(), storageOperationLimit: v.number() };
const allocationIdValid = (id: string) => /^[a-zA-Z0-9_-]{8,128}$/.test(id);
const countsValid = (row: Doc<'researchGatewayAllocations'>) => [row.requestLimit, row.readByteLimit, row.storageOperationLimit].every(n => Number.isSafeInteger(n) && n > 0) && [row.requestsConsumed, row.readBytesConsumed, row.storageOperationsConsumed].every(n => Number.isSafeInteger(n) && n >= 0) && row.requestsConsumed <= row.requestLimit && row.readBytesConsumed <= row.readByteLimit && row.storageOperationsConsumed <= row.storageOperationLimit;
/** Root administration only. Immutable prospective allocation, never a reset. */
export const provisionAllocation = internalMutation({ args: allocationFields, returns: v.id('researchGatewayAllocations'), handler: async (ctx, args) => {
  if (!allocationIdValid(args.allocationId) || !Number.isSafeInteger(args.expiresAt) || args.expiresAt <= Date.now() || args.expiresAt > Date.now() + (args.purpose === 'cleanup' ? 33 : 30) * 86_400_000 || ![args.requestLimit, args.readByteLimit, args.storageOperationLimit].every(n => Number.isSafeInteger(n) && n > 0) || args.requestLimit > 10_000 || args.readByteLimit > 4_000_000_000 || args.storageOperationLimit > 50_000) throw new ConvexError('Invalid finite demo allocation');
  if (await ctx.db.query('researchGatewayAllocations').withIndex('by_allocationId', q => q.eq('allocationId', args.allocationId)).first()) throw new ConvexError('Allocation is immutable');
  return ctx.db.insert('researchGatewayAllocations', { ...args, purpose: args.purpose ?? 'interactive', ...(args.purpose === 'cleanup' ? { cleanupReservedMedia: 0 } : {}), requestsConsumed: 0, readBytesConsumed: 0, storageOperationsConsumed: 0, createdAt: Date.now() });
} });
/** Bounded private diagnostics for reconciliation. No source content or secrets. */
export const readiness = internalQuery({ args: { captureId: v.optional(v.id('researchCaptures')), mediaId: v.optional(v.id('researchMedia')), allocationId: v.optional(v.string()) }, returns: v.object({
  slots: v.array(v.object({ lease: gatewayLease, workStarted: v.boolean() })),
  due: v.array(v.object({ mediaId: v.id('researchMedia'), captureId: v.id('researchCaptures'), attempt: v.number(), key: v.string(), writerUntil: v.number(), cleanupUntil: v.number(), reservedBytes: v.number() })),
  capture: v.union(v.object({ id: v.id('researchCaptures'), reservedBytes: v.number(), state: v.string() }), v.null()),
  media: v.union(v.object({ id: v.id('researchMedia'), state: v.string(), attempt: v.number(), key: v.string() }), v.null()),
  allocation: v.union(v.object({ ...allocationFields, requestsConsumed: v.number(), readBytesConsumed: v.number(), storageOperationsConsumed: v.number() }), v.null()),
}), handler: async (ctx, args) => {
  const slots = await ctx.db.query('researchGatewaySlots').withIndex('by_slot').take(5);
  const rows = await ctx.db.query('researchMedia').withIndex('by_state_and_cleanupNextAt', q => q.eq('state', 'delete-pending').lte('cleanupNextAt', Date.now())).take(11);
  const capture = args.captureId ? await ctx.db.get(args.captureId) : null, media = args.mediaId ? await ctx.db.get(args.mediaId) : null;
  const allocation = args.allocationId ? await ctx.db.query('researchGatewayAllocations').withIndex('by_allocationId', q => q.eq('allocationId', args.allocationId!)).unique() : null;
  return { slots: slots.map(row => ({ lease: receipt(row), workStarted: row.workStarted })), due: await Promise.all(rows.map(async row => ({ mediaId: row._id, captureId: row.captureId, attempt: row.attempt, key: row.objectKey, writerUntil: row.leaseUntil, cleanupUntil: row.cleanupUntil ?? 0, reservedBytes: (await ctx.db.get(row.captureId))?.reservedBytes ?? 0 }))), capture: capture ? { id: capture._id, reservedBytes: capture.reservedBytes, state: capture.state } : null, media: media ? { id: media._id, state: media.state, attempt: media.attempt, key: media.objectKey } : null, allocation: allocation ? { purpose: allocation.purpose, allocationId: allocation.allocationId, expiresAt: allocation.expiresAt, requestLimit: allocation.requestLimit, readByteLimit: allocation.readByteLimit, storageOperationLimit: allocation.storageOperationLimit, requestsConsumed: allocation.requestsConsumed, readBytesConsumed: allocation.readBytesConsumed, storageOperationsConsumed: allocation.storageOperationsConsumed } : null };
} });
async function acquireSlot(ctx: MutationCtx, args: { kind: keyof typeof caps; requestId: string; owner: string }, allocationId?: string) {
  identity(args); const now = Date.now();
  // This table contains only the four fixed demo slots. The fifth row is a
  // fail-closed corruption sentinel; no growing request/history table is scanned.
  const rows = await ctx.db.query('researchGatewaySlots').withIndex('by_slot').take(5);
  if (rows.length > 4 || new Set(rows.map(r => r.slot)).size !== rows.length || rows.some(r => r.slot < 0 || r.slot > 3)) throw new ConvexError('Gateway capacity unavailable');
  const allocation = allocationId ? await ctx.db.query('researchGatewayAllocations').withIndex('by_allocationId', q => q.eq('allocationId', allocationId)).unique() : null;
  if (allocation?.purpose === 'cleanup' && args.kind !== 'cleanup') return null;
  const previous = rows.find(r => r.requestId === args.requestId);
  if (previous) return previous.owner === args.owner && previous.kind === args.kind && previous.allocationId === allocationId && previous.expiresAt > now ? receipt(previous) : null;
  const active = rows.filter(r => r.expiresAt > now || r.workStarted);
  if (active.length >= 4 || active.filter(r => r.kind === args.kind).length >= caps[args.kind]) return null;
  if (allocationId && (!allocationIdValid(allocationId) || !allocation || !countsValid(allocation) || allocation.expiresAt <= now || allocation.requestsConsumed >= allocation.requestLimit)) return null;
  if (allocation) await ctx.db.patch(allocation._id, { requestsConsumed: allocation.requestsConsumed + 1 });
  const slot = [0, 1, 2, 3].find(n => !active.some(r => r.slot === n))!, old = rows.find(r => r.slot === slot);
  const value = { slot, ...args, generation: (old?.generation ?? 0) + 1, expiresAt: now + lifetimes[args.kind] + 45_000, bodyDeadlineAt: now + (args.kind === 'upload' ? 15_000 : 8_000), cleanupClaimed: false, cleanupCandidates: undefined, workStarted: false, allocationId, quotaOrdinal: allocation ? 0 : undefined, storageOperations: allocation ? 0 : undefined, authorityChecks: allocation ? 0 : undefined };
  const id = old ? (await ctx.db.patch(old._id, value), old._id) : await ctx.db.insert('researchGatewaySlots', value);
  // Expiry frees concurrency only. It never edits media attempts, reservation
  // identities, provider receipts, password attempts or storage operation budgets.
  return receipt((await ctx.db.get(id))!);
}
export const acquire = mutation({ args: { kind: gatewayKind, requestId: v.string(), owner: v.string(), proof: gatewayProof }, returns: v.union(gatewayLease, v.null()), handler: async (ctx, { proof, ...args }) => {
  await auth('lease-acquire', args, proof);
  // Preserve local qualification only. Hosted activation cannot select the
  // legacy unallocated path, even with an otherwise valid private signature.
  if (process.env.CONVEX_SITE_URL && process.env.CONVEX_SITE_URL !== 'http://127.0.0.1:3211' || process.env.RESEARCH_HOSTED_GATEWAY_ORIGIN || process.env.RESEARCH_HOSTED_GATEWAY_ALLOCATION || process.env.RESEARCH_HOSTED_CLEANUP_ALLOCATION) return null;
  return acquireSlot(ctx, args);
} });
/** Hosted transport uses this allocation-bound path; legacy acquire is retained
 * for existing local/native qualification and is not selected by hosted config. */
export const acquireAllocated = mutation({ args: { kind: gatewayKind, requestId: v.string(), owner: v.string(), allocationId: v.string(), proof: gatewayProof }, returns: v.union(gatewayLease, v.null()), handler: async (ctx, { proof, allocationId, ...args }) => { await auth('lease-acquire-allocated', { ...args, allocationId }, proof);
  const allocation = await ctx.db.query('researchGatewayAllocations').withIndex('by_allocationId', q => q.eq('allocationId', allocationId)).unique();
  return allocation?.purpose === 'cleanup' && args.kind === 'cleanup' ? acquireCleanupTick(ctx, args, allocationId) : acquireSlot(ctx, args, allocationId); } });
/** Reserve conservative R2 wire/payload upper bounds before a single dispatch.
 * Lost acknowledgements and unused reservation remain consumed. */
export const reserveOperation = mutation({ args: { ...leaseIdentity, ordinal: v.number(), kind: quotaOperation, readBytes: v.number(), proof: gatewayProof }, returns: v.boolean(), handler: async (ctx, { proof, ...args }) => {
  await auth('lease-reserve-operation', args, proof); identity(args); const row = await ctx.db.get(args.leaseId), now = Date.now();
  if (!row || row.owner !== args.owner || row.requestId !== args.requestId || row.generation !== args.generation || !row.workStarted || row.expiresAt - 45_000 <= now || !row.allocationId || !Number.isSafeInteger(args.ordinal) || args.ordinal !== (row.quotaOrdinal ?? 0) + 1) return false;
  if (!Number.isSafeInteger(args.readBytes) || (args.kind === 'read' ? args.readBytes < 1 || args.readBytes > 4_000_000 : args.readBytes !== 0)) return false;
  const allocation = await ctx.db.query('researchGatewayAllocations').withIndex('by_allocationId', q => q.eq('allocationId', row.allocationId!)).unique();
  const operations = { authority: 0, head: 2, read: 2, put: 3, retire: 3 }[args.kind], bytes = args.kind === 'authority' ? 0 : args.readBytes + 1;
  const checks = (row.authorityChecks ?? 0) + (args.kind === 'authority' ? 1 : 0), storage = (row.storageOperations ?? 0) + operations;
  if (!allocation || !countsValid(allocation) || allocation.expiresAt <= now || allocation.purpose === 'cleanup' && (row.kind !== 'cleanup' || !['authority', 'head', 'retire'].includes(args.kind)) || checks > 128 || storage > 64 || allocation.storageOperationsConsumed + operations > allocation.storageOperationLimit || allocation.readBytesConsumed + bytes > allocation.readByteLimit) return false;
  await ctx.db.patch(allocation._id, { storageOperationsConsumed: allocation.storageOperationsConsumed + operations, readBytesConsumed: allocation.readBytesConsumed + bytes });
  await ctx.db.patch(row._id, { quotaOrdinal: args.ordinal, authorityChecks: checks, storageOperations: storage }); return true;
} });
export const inspect = query({ args: { ...leaseIdentity, proof: gatewayProof }, returns: v.union(gatewayLease, v.null()), handler: async (ctx, { proof, ...args }) => {
  await auth('lease-inspect', args, proof); identity(args); const row = await ctx.db.get(args.leaseId);
  return row && row.owner === args.owner && row.requestId === args.requestId && row.generation === args.generation && row.expiresAt > Date.now() ? receipt(row) : null;
} });
export const beginWork = mutation({ args: { ...leaseIdentity, proof: gatewayProof }, returns: v.boolean(), handler: async (ctx, { proof, ...args }) => {
  await auth('lease-begin', args, proof); identity(args); const row = await ctx.db.get(args.leaseId);
  if (!row || row.owner !== args.owner || row.requestId !== args.requestId || row.generation !== args.generation || row.expiresAt - 45_000 <= Date.now() || row.workStarted) return false;
  if (row.allocationId) {
    const allocation = await ctx.db.query('researchGatewayAllocations').withIndex('by_allocationId', q => q.eq('allocationId', row.allocationId!)).unique();
    if (!allocation || !countsValid(allocation) || allocation.expiresAt <= Date.now() || allocation.purpose === 'cleanup' && row.kind !== 'cleanup') return false;
  }
  await ctx.db.patch(row._id, { workStarted: true }); return true;
} });
export const release = mutation({ args: { ...leaseIdentity, proof: gatewayProof }, returns: v.boolean(), handler: async (ctx, { proof, ...args }) => {
  await auth('lease-release', args, proof); identity(args); const row = await ctx.db.get(args.leaseId);
  if (!row || row.owner !== args.owner || row.requestId !== args.requestId || row.generation !== args.generation) return false;
  await ctx.db.patch(row._id, { expiresAt: 0, workStarted: false }); return true;
} });
async function acquireCleanupTick(ctx: MutationCtx, args: { requestId: string; owner: string }, allocationId?: string) {
  identity(args); const now = Date.now();
  const slots = await ctx.db.query('researchGatewaySlots').withIndex('by_slot').take(5);
  if (slots.length > 4 || slots.some(s => s.kind === 'cleanup' && (s.workStarted || s.expiresAt > now))) return null;
  const allocation = allocationId ? await ctx.db.query('researchGatewayAllocations').withIndex('by_allocationId', q => q.eq('allocationId', allocationId)).unique() : null;
  if (allocationId && (process.env.RESEARCH_HOSTED_CLEANUP_ALLOCATION === allocationId && allocation?.purpose !== 'cleanup' || !allocation || !countsValid(allocation) || allocation.expiresAt <= now || allocation.requestsConsumed >= allocation.requestLimit)) return null;
  // Fixed cutoff keeps the indexed pagination query stable for this pass. New
  // due rows and rows inserted behind the cursor are visited on the next wrap.
  const scan = allocation?.cleanupScan ?? { cursor: null, before: now };
  const page = await ctx.db.query('researchMedia').withIndex('by_state_and_cleanupNextAt', q => q.eq('state', 'delete-pending').lte('cleanupNextAt', scan.before)).paginate({ numItems: 10, cursor: scan.cursor, maximumRowsRead: 10 });
  if (allocation) await ctx.db.patch(allocation._id, { cleanupScan: page.isDone ? undefined : { cursor: page.continueCursor, before: scan.before } });
  const candidates = [];
  for (const row of page.page) {
    const capture = await ctx.db.get(row.captureId);
    const bound = capture?.cleanupAllocationId;
    if (await cleanupEligible(ctx, row, now) && (bound ? allocation?.purpose === 'cleanup' && bound === allocationId : allocation?.purpose !== 'cleanup')) candidates.push(row._id);
  }
  if (!candidates.length) return null;
  const lease = await acquireSlot(ctx, { ...args, kind: 'cleanup' }, allocationId);
  if (lease) await ctx.db.patch(lease.leaseId, { cleanupCandidates: candidates });
  return lease;
}
export const acquireTick = internalMutation({ args: { requestId: v.string(), owner: v.string(), allocationId: v.optional(v.string()) }, returns: v.union(gatewayLease, v.null()), handler: async (ctx, { allocationId, ...args }) => acquireCleanupTick(ctx, args, allocationId) });
/** Durable bounded wakeup. Absent explicit hosted origin is a zero-call no-op.
 * Slot admission happens before fetch; the gateway rechecks the same generation.
 * A failed tick never retries here. Persisted claims/backoff drive later ticks. */
/** Consume a small terminal response without logging/trusting it as retirement proof.
 * EOF keeps the HTTP lifetime open for its native settlement acknowledgement. */
export async function consumeCleanupResponse(response: Response, deadline: number): Promise<void> {
  const reader = response.body?.getReader(); if (!reader) return;
  let bytes = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Cleanup response unresolved')), Math.max(1, deadline - Date.now())); });
  try {
    for (;;) {
      const item = await Promise.race([reader.read(), timeout]);
      if (item.done) return;
      bytes += item.value.byteLength;
      if (bytes > 4096) throw new Error('Cleanup response limit');
    }
  } finally {
    clearTimeout(timer);
    // Disposal cannot authorize release; a stalled cancel must not extend this action.
    void reader.cancel().catch(() => undefined);
  }
}
export const cleanupTick = internalAction({ args: {}, returns: v.null(), handler: async ctx => {
  const origin = process.env.RESEARCH_HOSTED_GATEWAY_ORIGIN, secret = process.env.RESEARCH_MEDIA_GATEWAY_SECRET, allocationId = process.env.RESEARCH_HOSTED_CLEANUP_ALLOCATION ?? process.env.RESEARCH_HOSTED_GATEWAY_ALLOCATION, bypass = process.env.RESEARCH_HOSTED_GATEWAY_BYPASS_SECRET;
  // Project automation credential grants platform access only. The signed
  // native cleanup lease still authorizes the application operation separately.
  // Never forward either credential to another host, a redirect or a URL query.
  if (origin !== 'https://corvo-research-demo.vercel.app' || !secret || !allocationId || !allocationIdValid(allocationId) || !bypass || !/^[\x21-\x7e]{1,4096}$/.test(bypass)) return null;
  const random = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  const lease = await ctx.runMutation(internal.researchGatewayLeases.acquireTick, { requestId: random(), owner: random(), allocationId }); if (!lease) return null;
  const input = { leaseId: lease.leaseId, requestId: lease.requestId, owner: lease.owner, generation: lease.generation }, proof = await signGateway(secret, 'cleanup-tick', input);
  let response: Response | undefined;
  try {
    response = await fetch(`${origin}/api/research/internal/cleanup`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(Math.max(1, lease.responseDeadlineAt - Date.now())), headers: { Origin: origin, 'Content-Type': 'application/json', 'Content-Length': String(new TextEncoder().encode(JSON.stringify(input)).length), 'X-Research-Cleanup-At': String(proof.at), 'X-Research-Cleanup-Proof': proof.signature, 'x-vercel-protection-bypass': bypass }, body: JSON.stringify(input) });
    await consumeCleanupResponse(response, lease.responseDeadlineAt);
  } catch { /* Unknown gateway outcome remains in native cleanup claims. */ }
  // Even HTTP200 cannot prove an interrupted server's underlying work settled.
  // Only its tracked lifetime may release started work; unstarted expiry is safe.
  return null;
} });
