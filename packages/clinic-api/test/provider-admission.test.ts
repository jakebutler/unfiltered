import { describe, expect, it } from 'vitest';
import { createProviderAdmission, noUnits, type ProviderBudgetPolicy } from '../src/provider-admission.js';
import { TransportError } from '../../clinical-core/src/transport.js';
import type { MedplumClient } from '../../clinical-core/src/medplum.js';
import type { FhirResource } from '../../clinical-core/src/fhir.js';
import { decodeDocument } from '../src/store.js';

const policy: ProviderBudgetPolicy = { id: 'synthetic-test', limits: Object.fromEntries(['digitalocean', 'deepgram', 'elevenlabs'].map(provider => [provider, { account: { requests: 3, inputBytes: 180000, outputTokens: 12288, characters: 3000, audioSeconds: 180 }, session: { requests: 2, inputBytes: 120000, outputTokens: 8192, characters: 2000, audioSeconds: 120 }, concurrency: 1, leaseMs: provider === 'digitalocean' ? 20000 : provider === 'deepgram' ? 70000 : 35000 }])) as ProviderBudgetPolicy['limits'] };
const request = (id = crypto.randomUUID(), sessionId = 'session-a') => ({ provider: 'digitalocean' as const, sessionId, requestId: id, units: { ...noUnits(), requests: 1, inputBytes: 60000, outputTokens: 4096 } });
function fixture() {
  let record: FhirResource | undefined, fault: 'before' | 'after' | undefined, time = Date.now();
  const client = { async request(path: string, method = 'GET', body?: FhirResource, headers?: Record<string, string>) {
    if (method === 'GET') return { body: { resourceType: 'Bundle', type: 'searchset', entry: record ? [{ resource: structuredClone(record) }] : [], total: record ? 1 : 0 } };
    if (method === 'POST') {
      if (!headers?.['If-None-Exist']) throw Error('missing-condition');
      record ??= { ...structuredClone(body!), id: 'budget', meta: { versionId: '1' } };
      return { body: structuredClone(record) };
    }
    if (headers?.['If-Match'] !== `W/"${(record?.meta as { versionId: string }).versionId}"`) throw new TransportError('http', 412);
    const failure = fault; fault = undefined;
    if (failure === 'before') throw new TransportError('network');
    record = { ...structuredClone(body!), meta: { versionId: String(Number((record!.meta as { versionId: string }).versionId) + 1) } };
    if (failure === 'after') throw new TransportError('network');
    return { body: structuredClone(record) };
  } } as unknown as MedplumClient;
  return { make: (p = policy) => createProviderAdmission(async () => client, p, () => time), fail: (f: typeof fault) => { fault = f; }, advance: (ms: number) => { time += ms; }, contents: () => record && decodeDocument<{ claims: unknown[] }>(record) };
}

describe('durable provider credit admission', () => {
  it('enforces per-session concurrency independently of a larger account limit', async () => {
    const p = structuredClone(policy); p.limits.deepgram.concurrency = 3;
    const f = fixture();
    const capture = (sessionId = 'a') => ({ provider: 'deepgram' as const, sessionId, requestId: crypto.randomUUID(), units: { ...noUnits(), requests: 1, audioSeconds: 60 } });
    const first = await f.make(p).reserve(capture());
    await expect(f.make(p).reserve(capture())).rejects.toMatchObject({ code: 'provider-session-busy' });
    await f.make(p).reserve(capture('b'));
    await first.settle('interrupted');
    await expect(f.make(p).reserve(capture())).rejects.toMatchObject({ code: 'provider-session-busy' });
    f.advance(70001); await f.make(p).reserve(capture());
  });
  it('serializes simultaneous claims against account concurrency and survives restart', async () => {
    const f = fixture();
    const result = await Promise.allSettled([f.make().reserve(request()), f.make().reserve(request())]);
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(f.contents()?.claims).toHaveLength(1);
    await expect(f.make().reserve(request())).rejects.toMatchObject({ code: 'provider-busy' });
  });
  it('denies duplicate attempt IDs across sessions, even after completion', async () => {
    const f = fixture(), input = request(), lease = await f.make().reserve(input);
    await lease.settle('completed');
    await expect(f.make().reserve({ ...input, sessionId: 'different' })).rejects.toMatchObject({ code: 'provider-attempt-already-reserved' });
  });
  it('charges failed work and session/account limits without replenishing on restart', async () => {
    const f = fixture();
    await (await f.make().reserve(request())).settle('failed');
    await (await f.make().reserve(request())).settle('completed');
    await expect(f.make().reserve(request())).rejects.toMatchObject({ code: 'provider-budget-exhausted' });
    await (await f.make().reserve(request(crypto.randomUUID(), 'b'))).settle('completed');
    await expect(f.make().reserve(request(crypto.randomUUID(), 'c'))).rejects.toMatchObject({ code: 'provider-budget-exhausted' });
  });
  it.each(['unknown', 'interrupted'] as const)('retains %s concurrency to deadline and keeps its credit reservation', async outcome => {
    const f = fixture(), lease = await f.make().reserve(request());
    await lease.settle(outcome);
    await expect(f.make().reserve(request())).rejects.toMatchObject({ code: 'provider-busy' });
    f.advance(20001);
    await (await f.make().reserve(request())).settle('completed');
    await expect(f.make().reserve(request())).rejects.toMatchObject({ code: 'provider-budget-exhausted' });
  });
  it('losing a reservation acknowledgement cannot return a dispatch lease or permit replay', async () => {
    const f = fixture(), input = request(); f.fail('after');
    await expect(f.make().reserve(input)).rejects.toMatchObject({ code: 'budget-outcome-unknown' });
    await expect(f.make().reserve(input)).rejects.toMatchObject({ code: 'provider-attempt-already-reserved' });
    expect(f.contents()?.claims).toHaveLength(1);
  });
  it('never dispatches after a failed reservation write', async () => {
    const f = fixture(); f.fail('before');
    await expect(f.make().reserve(request())).rejects.toMatchObject({ code: 'budget-outcome-unknown' });
    expect(f.contents()?.claims).toHaveLength(0);
  });
  it('cannot reset a used budget by changing its limits under the same ID', async () => {
    const f = fixture(); await (await f.make().reserve(request())).settle('completed');
    const changed = structuredClone(policy); changed.limits.digitalocean.account.requests = 9;
    await expect(f.make(changed).reserve(request())).rejects.toMatchObject({ code: 'budget-ledger-invalid' });
  });
  it('validates provider-specific units and does not spend speech quotas for inference', async () => {
    const f = fixture();
    await expect(f.make().reserve({ ...request(), units: { ...request().units, characters: 10 } })).rejects.toMatchObject({ code: 'invalid-reservation' });
    await f.make().reserve(request());
    const speech = { provider: 'elevenlabs' as const, sessionId: 'session-a', requestId: crypto.randomUUID(), units: { ...noUnits(), requests: 1, characters: 1200 } };
    await (await f.make().reserve(speech)).settle('completed');
    await expect(f.make().reserve({ ...speech, requestId: crypto.randomUUID() })).rejects.toMatchObject({ code: 'provider-budget-exhausted' });
  });
});
