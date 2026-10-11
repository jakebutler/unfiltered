import { describe, expect, it } from 'vitest';
import { createIngressAdmission, hostedIngressPolicy, type IngressRequest } from '../src/ingress-admission.js';
import { decodeDocument } from '../src/store.js';
import type { FhirResource } from '../../clinical-core/src/fhir.js';
import type { MedplumClient } from '../../clinical-core/src/medplum.js';
import { TransportError } from '../../clinical-core/src/transport.js';

type Fault = 'empty-version' | 'wrong-status' | 'missing-status' | 'commit-then-throw' | 'conflict' | 'delay-expired' | 'clock-backward';
const request = (kind: IngressRequest['kind'] = 'session-create', sessionId?: string): IngressRequest => ({ kind, attemptId: crypto.randomUUID(), ...(sessionId ? { sessionId } : {}) });
function storage() {
  let native: FhirResource | undefined, time = 1800000000000, fault: Fault | undefined;
  const writes: { method: string; headers?: Record<string, string> }[] = [];
  const client = { async request(_path: string, method = 'GET', body?: FhirResource, headers?: Record<string, string>) {
    if (method === 'GET') return { body: { resourceType: 'Bundle', type: 'searchset', total: native ? 1 : 0, entry: native ? [{ resource: structuredClone(native) }] : [] } };
    writes.push({ method, headers });
    if (method === 'POST') {
      native ??= { ...structuredClone(body!), id: 'independent-ledger', meta: { versionId: '1' } };
      return { body: structuredClone(native) };
    }
    if (fault === 'conflict' || headers?.['If-Match'] !== `W/"${(native!.meta as { versionId: string }).versionId}"`) throw new TransportError('http', 412);
    native = { ...structuredClone(body!), meta: { versionId: String(Number((native!.meta as { versionId: string }).versionId) + 1) } };
    const acknowledgement = structuredClone(native);
    if (fault === 'empty-version') acknowledgement.meta = { versionId: '' };
    if (fault === 'wrong-status') acknowledgement.status = 'superseded';
    if (fault === 'missing-status') delete acknowledgement.status;
    if (fault === 'commit-then-throw') throw new TransportError('network');
    if (fault === 'delay-expired') time += 90000;
    if (fault === 'clock-backward') time -= 1;
    return { body: acknowledgement };
  } } as unknown as MedplumClient;
  return {
    guard: () => createIngressAdmission(async () => client, structuredClone(hostedIngressPolicy), () => time),
    fault: (value: Fault | undefined) => { fault = value; }, advance: (ms: number) => { time += ms; },
    writes, native: () => native!, data: () => decodeDocument<{ claims: { id: string; closed: boolean; sessionHash: string }[] }>(native!),
  };
}

describe('independent ingress acknowledgement and contention boundaries', () => {
  it.each(['empty-version', 'wrong-status', 'missing-status'] as const)('grants no downstream lease for a malformed %s acknowledgement', async fault => {
    const f = storage(); f.fault(fault);
    await expect(f.guard().reserve(request())).rejects.toMatchObject({ code: 'ingress-outcome-unknown' });
    // Even rejected acknowledgements can conceal a committed reservation. Never refund it.
    expect(f.data().claims).toHaveLength(1);
    expect(f.writes.filter(write => write.method === 'PUT')).toHaveLength(1);
  });
  it('bounds explicit native conflict retries at four and never admits', async () => {
    const f = storage(); f.fault('conflict');
    await expect(f.guard().reserve(request())).rejects.toMatchObject({ code: 'ingress-contention' });
    expect(f.writes.filter(write => write.method === 'PUT')).toHaveLength(4);
    expect(f.data().claims).toHaveLength(0);
  });
  it('never redispatches an uncertain committed attempt, including from a restarted guard', async () => {
    const f = storage(), attempt = request(); f.fault('commit-then-throw');
    await expect(f.guard().reserve(attempt)).rejects.toMatchObject({ code: 'ingress-outcome-unknown' });
    f.fault(undefined); const before = f.writes.length;
    await expect(f.guard().reserve(attempt)).rejects.toMatchObject({ code: 'ingress-attempt-already-reserved' });
    expect(f.writes).toHaveLength(before); expect(f.data().claims).toHaveLength(1);
  });
  it.each(['delay-expired', 'clock-backward'] as const)('rejects a speech lease when %s happens during CAS acknowledgement', async fault => {
    const f = storage(); f.fault(fault);
    await expect(f.guard().reserve(request('speech-upgrade', crypto.randomUUID()))).rejects.toMatchObject({ code: fault === 'delay-expired' ? 'ingress-lease-expired' : 'ingress-clock-regression' });
    expect(f.data().claims).toHaveLength(1); expect(f.data().claims[0].closed).toBe(false);
  });
  it('does not delete an attempt when a native closure update commits but loses its acknowledgement', async () => {
    const f = storage(), session = crypto.randomUUID(), lease = await f.guard().reserve(request('speech-upgrade', session));
    f.fault('commit-then-throw'); await expect(lease.close()).rejects.toMatchObject({ code: 'ingress-outcome-unknown' });
    f.fault(undefined); await f.guard().reserve(request('speech-upgrade', session));
    expect(f.data().claims).toHaveLength(2); expect(f.data().claims[0].closed).toBe(true);
    expect(JSON.stringify(f.native())).not.toContain(session);
  });
  it('only grants one of two concurrently reserved copies of the same attempt', async () => {
    const f = storage(), attempt = request();
    const results = await Promise.allSettled([f.guard().reserve(attempt), f.guard().reserve(attempt)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(f.data().claims).toHaveLength(1);
    expect(f.writes.filter(write => write.method === 'POST').every(write => write.headers?.['If-None-Exist'] === 'identifier=urn%3Acorvo%3Aclinic%3Aingress%7Ccorvo-clinic-public-ingress')).toBe(true);
  });
});
