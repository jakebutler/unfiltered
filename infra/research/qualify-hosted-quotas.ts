import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference as ref } from 'convex/server';
import { localConfig } from './setup-local.mjs';
import { privateJson } from '../../apps/research-server/src/config';
import { convexHostedAuthority, newLeaseOwner, leaseIdentity } from '../../apps/research-server/src/hosted-admission';

// One owned local allocation; never resets counters or dispatches object/provider work.
const id = 'S7-QUOTA-NATIVE-A1', allocationId = 'local-quota-native-a1';
const output = `docs/implementation/evidence/${id}.json`;
const result: any = { id, allocationId, state: 'intent', startedAt: new Date().toISOString(), checks: [], providerCalls: 0, storageCalls: 0, cloudCalls: 0 };
await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  assert.equal(new URL(input instanceof Request ? input.url : String(input)).origin, 'http://127.0.0.1:3210');
  return originalFetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(init?.signal ? [init.signal] : [])]) });
};
let phase = 'private local configuration';
const check = async (name: string, run: () => Promise<void>) => { phase = name; await run(); result.checks.push(name); };
try {
  const env = await localConfig();
  const config = await privateJson('apps/research-server/runtime/capture.private.json') as { deployment: string; gatewaySecret: string };
  assert.equal(config.deployment, 'http://127.0.0.1:3210'); assert.equal(env.CONVEX_SELF_HOSTED_URL, config.deployment);
  const admin = new ConvexHttpClient(config.deployment, { logger: false }); admin.setAdminAuth(env.CONVEX_SELF_HOSTED_ADMIN_KEY);
  const snapshot = () => admin.query(ref<'query'>('researchGatewayLeases:readiness'), { allocationId });
  const make = () => convexHostedAuthority(config.deployment, config.gatewaySecret, allocationId);
  await check('idle exact local target and unused allocation before mutation', async () => {
    const before = await snapshot(); assert.equal(before.allocation, null); assert.deepEqual(before.due, []);
    assert(before.slots.every((row: any) => !row.workStarted && row.lease.expiresAt <= Date.now()));
  });
  const allocation = { allocationId, expiresAt: Date.now() + 30 * 60_000, requestLimit: 2, readByteLimit: 6, storageOperationLimit: 4 };
  await check('prospective immutable allocation', async () => {
    await admin.mutation(ref<'mutation'>('researchGatewayLeases:provisionAllocation'), allocation);
    await assert.rejects(admin.mutation(ref<'mutation'>('researchGatewayLeases:provisionAllocation'), allocation));
  });
  const authority = make(), request = { ...newLeaseOwner(), kind: 'read' as const };
  phase = 'first allocation-bound lease';
  const lease = await authority.acquire(request); assert(lease); const identity = leaseIdentity(lease);
  await check('acquisition replay consumes one request and operation replay never dispatches twice', async () => {
    assert.deepEqual(await authority.acquire(request), lease); assert.equal(await authority.beginWork(identity), true);
    assert.equal(await authority.reserveOperation!({ ...identity, ordinal: 1, kind: 'read', readBytes: 2 }), true);
    assert.equal(await authority.reserveOperation!({ ...identity, ordinal: 1, kind: 'read', readBytes: 2 }), false);
    const current = (await snapshot()).allocation; assert.equal(current.requestsConsumed, 1); assert.equal(current.readBytesConsumed, 3); assert.equal(current.storageOperationsConsumed, 2);
  });
  await check('exact byte and operation ceilings deny excess without consuming a rejected ordinal', async () => {
    assert.equal(await authority.reserveOperation!({ ...identity, ordinal: 2, kind: 'read', readBytes: 3 }), false);
    assert.equal(await authority.reserveOperation!({ ...identity, ordinal: 2, kind: 'read', readBytes: 2 }), true);
    assert.equal(await authority.reserveOperation!({ ...identity, ordinal: 3, kind: 'head', readBytes: 0 }), false);
    assert.equal(await authority.release(identity), true);
  });
  await check('new client and successor lease retain exhausted counters and reject stale work', async () => {
    const fresh = make(), next = await fresh.acquire({ ...newLeaseOwner(), kind: 'read' }); assert(next);
    const nextIdentity = leaseIdentity(next); assert.equal(await fresh.beginWork(nextIdentity), true);
    assert.equal(await fresh.reserveOperation!({ ...nextIdentity, ordinal: 1, kind: 'head', readBytes: 0 }), false);
    assert.equal(await authority.reserveOperation!({ ...identity, ordinal: 3, kind: 'head', readBytes: 0 }), false);
    assert.equal(await fresh.release(nextIdentity), true);
    assert.equal(await make().acquire({ ...newLeaseOwner(), kind: 'operation' }), null);
  });
  result.readback = await snapshot();
  assert.equal(result.readback.allocation.requestsConsumed, 2); assert.equal(result.readback.allocation.readBytesConsumed, 6); assert.equal(result.readback.allocation.storageOperationsConsumed, 4);
  assert(result.readback.slots.every((row: any) => !row.workStarted && row.lease.expiresAt <= Date.now()));
  result.state = 'passed';
} catch { result.state = 'failed-or-unknown'; result.failurePhase = phase; process.exitCode = 1; }
finally {
  globalThis.fetch = originalFetch; result.finishedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ state: result.state, checks: result.checks.length, failurePhase: result.failurePhase, evidence: output }));
}
