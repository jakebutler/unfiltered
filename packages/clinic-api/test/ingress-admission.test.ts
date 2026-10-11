import { describe, expect, it } from 'vitest';
import { createIngressAdmission, type IngressPolicy, type IngressRequest } from '../src/ingress-admission.js';
import { decodeDocument } from '../src/store.js';
import type { FhirResource } from '../../clinical-core/src/fhir.js';
import type { MedplumClient } from '../../clinical-core/src/medplum.js';
import { TransportError } from '../../clinical-core/src/transport.js';

const policy = (): IngressPolicy => ({ id: 'synthetic-test', limits: { 'session-create': { minute: 20, day: 30, lifetime: 40 }, 'staff-login': { minute: 20, day: 30, lifetime: 40 }, 'speech-upgrade': { minute: 20, day: 30, lifetime: 40 } }, socketConcurrency: 2, socketLeaseMs: 90000 });
const input = (kind: IngressRequest['kind'] = 'session-create', sessionId?: string): IngressRequest => ({ kind, attemptId: crypto.randomUUID(), ...(sessionId ? { sessionId } : {}) });
function fixture() {
  let record: FhirResource | undefined, time = 1800000000000, fault: 'before' | 'after' | 'stale' | undefined;
  let updates = 0, creates = 0;
  const client = { async request(_path: string, method = 'GET', body?: FhirResource, headers?: Record<string, string>) {
    if (method === 'GET') return { body: { resourceType: 'Bundle', type: 'searchset', total: record ? 1 : 0, entry: record ? [{ resource: structuredClone(record) }] : [] } };
    if (method === 'POST') {
      creates++;
      expect(headers?.['If-None-Exist']).toBe('identifier=urn%3Acorvo%3Aclinic%3Aingress%7Ccorvo-clinic-public-ingress');
      record ??= { ...structuredClone(body!), id: 'ingress', meta: { versionId: '1' } };
      return { body: structuredClone(record) };
    }
    updates++;
    if (headers?.['If-Match'] !== `W/"${(record?.meta as { versionId: string }).versionId}"`) throw new TransportError('http', 412);
    const failure = fault; fault = undefined;
    if (failure === 'before') throw new TransportError('network');
    if (failure === 'stale') return { body: structuredClone(record) };
    record = { ...structuredClone(body!), meta: { versionId: String(Number((record!.meta as { versionId: string }).versionId) + 1) } };
    if (failure === 'after') throw new TransportError('network');
    return { body: structuredClone(record) };
  } } as unknown as MedplumClient;
  return { make: (p = policy()) => createIngressAdmission(async () => client, p, () => time), advance: (ms: number) => { time += ms; }, fail: (value: typeof fault) => { fault = value; }, counts: () => ({ creates, updates }), data: () => record && decodeDocument<{ claims: { id: string; kind: string; at: number; sessionHash: string; expiresAt: number; closed: boolean }[] }>(record), native: () => record };
}

describe('shared clinic ingress admission', () => {
  it('serializes concurrent new-session allocations across instances and keeps the limit after restart', async () => {
    const f = fixture(), p = policy(); p.limits['session-create'] = { minute: 2, day: 2, lifetime: 2 };
    const results = await Promise.allSettled([f.make(p).reserve(input()), f.make(p).reserve(input()), f.make(p).reserve(input())]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2);
    expect(f.data()?.claims).toHaveLength(2);
    await expect(f.make(p).reserve(input())).rejects.toMatchObject({ code: 'ingress-allocation-exhausted' });
  });
  it('uses a sliding minute/day window and does not refund the lifetime allocation', async () => {
    const f = fixture(), p = policy(); p.limits['staff-login'] = { minute: 2, day: 3, lifetime: 4 };
    await f.make(p).reserve(input('staff-login'));
    f.advance(59999); await f.make(p).reserve(input('staff-login'));
    await expect(f.make(p).reserve(input('staff-login'))).rejects.toMatchObject({ code: 'ingress-rate-limited' });
    f.advance(1); await f.make(p).reserve(input('staff-login'));
    f.advance(60000); await expect(f.make(p).reserve(input('staff-login'))).rejects.toMatchObject({ code: 'ingress-rate-limited' });
    f.advance(86400000); await f.make(p).reserve(input('staff-login'));
    f.advance(86400000); await expect(f.make(p).reserve(input('staff-login'))).rejects.toMatchObject({ code: 'ingress-allocation-exhausted' });
  });
  it('counts downstream failures without a refund method and separates create/login allocations', async () => {
    const f = fixture(), p = policy(); p.limits['staff-login'] = { minute: 1, day: 1, lifetime: 1 };
    const login = await f.make(p).reserve(input('staff-login')); await login.close();
    await expect(f.make(p).reserve(input('staff-login'))).rejects.toMatchObject({ code: 'ingress-allocation-exhausted' });
    await expect(f.make(p).reserve(input())).resolves.toBeDefined();
    expect(f.data()?.claims).toHaveLength(2);
  });
  it.each(['before', 'after', 'stale'] as const)('never grants admission after %s acknowledgement failure', async failure => {
    const f = fixture(), request = input('speech-upgrade', crypto.randomUUID()); f.fail(failure);
    await expect(f.make().reserve(request)).rejects.toMatchObject({ code: 'ingress-outcome-unknown' });
    if (failure === 'after') {
      expect(f.data()?.claims).toHaveLength(1);
      await expect(f.make().reserve(request)).rejects.toMatchObject({ code: 'ingress-attempt-already-reserved' });
      await expect(f.make().reserve(input('speech-upgrade', request.sessionId))).rejects.toMatchObject({ code: 'ingress-socket-busy' });
    } else expect(f.data()?.claims).toHaveLength(0);
  });
  it('holds global and per-session pending/active socket capacity across instances', async () => {
    const f = fixture(), first = crypto.randomUUID(), second = crypto.randomUUID();
    const a = await f.make().reserve(input('speech-upgrade', first));
    await expect(f.make().reserve(input('speech-upgrade', first))).rejects.toMatchObject({ code: 'ingress-socket-busy' });
    await f.make().reserve(input('speech-upgrade', second));
    await expect(f.make().reserve(input('speech-upgrade', crypto.randomUUID()))).rejects.toMatchObject({ code: 'ingress-socket-busy' });
    await a.close(); await f.make().reserve(input('speech-upgrade', first));
    expect(f.data()?.claims).toHaveLength(3); expect(f.data()?.claims[0].closed).toBe(true);
  });
  it('retains an abandoned unknown claim until deadline and never refunds its attempt', async () => {
    const f = fixture(), p = policy(), session = crypto.randomUUID(); p.socketConcurrency = 1; p.limits['speech-upgrade'] = { minute: 2, day: 2, lifetime: 2 };
    f.fail('after'); await expect(f.make(p).reserve(input('speech-upgrade', session))).rejects.toMatchObject({ code: 'ingress-outcome-unknown' });
    f.advance(89999); await expect(f.make(p).reserve(input('speech-upgrade', crypto.randomUUID()))).rejects.toMatchObject({ code: 'ingress-socket-busy' });
    f.advance(1); await f.make(p).reserve(input('speech-upgrade', session));
    f.advance(90000); await expect(f.make(p).reserve(input('speech-upgrade', session))).rejects.toMatchObject({ code: 'ingress-allocation-exhausted' });
  });
  it('keeps a failed native-close settlement held; confirmed close retains the attempt count', async () => {
    const f = fixture(), p = policy(); p.socketConcurrency = 1;
    const lease = await f.make(p).reserve(input('speech-upgrade', crypto.randomUUID()));
    f.fail('before'); await expect(lease.close()).rejects.toMatchObject({ code: 'ingress-outcome-unknown' });
    await expect(f.make(p).reserve(input('speech-upgrade', crypto.randomUUID()))).rejects.toMatchObject({ code: 'ingress-socket-busy' });
    await lease.close(); expect(f.data()?.claims).toHaveLength(1); expect(f.data()?.claims[0].closed).toBe(true);
  });
  it('refuses backward clock motion without a write and keeps lifetime counts after a forward jump', async () => {
    const f = fixture(), p = policy(); p.limits['session-create'] = { minute: 2, day: 2, lifetime: 2 };
    await f.make(p).reserve(input()); const before = f.counts().updates;
    f.advance(-1); await expect(f.make(p).reserve(input())).rejects.toMatchObject({ code: 'ingress-clock-regression' });
    expect(f.counts().updates).toBe(before);
    f.advance(86400001); await f.make(p).reserve(input());
    f.advance(86400000); await expect(f.make(p).reserve(input())).rejects.toMatchObject({ code: 'ingress-allocation-exhausted' });
  });
  it('changing limits or a policy name cannot initialize a fresh lifetime allocation', async () => {
    const f = fixture(), p = policy(); await f.make(p).reserve(input());
    for (const changed of [{ ...p, id: 'another-policy-name' }, { ...p, socketConcurrency: 3 }]) await expect(f.make(changed).reserve(input())).rejects.toMatchObject({ code: 'ingress-ledger-invalid' });
    expect(f.counts().creates).toBe(1); expect(f.data()?.claims).toHaveLength(1);
  });
  it('stores no plaintext session, email, address or clinical content', async () => {
    const f = fixture(), sessionId = crypto.randomUUID(); await f.make().reserve(input('speech-upgrade', sessionId));
    expect(JSON.stringify(f.data())).not.toContain(sessionId); expect(f.native()?.subject).toBeUndefined();
    const before = f.counts();
    await expect(f.make().reserve({ ...input('staff-login'), sessionId: 'someone@example.com' })).rejects.toMatchObject({ code: 'invalid-ingress-request' });
    expect(f.counts()).toEqual(before);
  });
});
