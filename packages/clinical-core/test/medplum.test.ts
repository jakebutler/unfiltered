import { describe, expect, it } from 'vitest';
import { digest } from '../src/domain.js';
import { planHandoff } from '../src/fhir.js';
import { MedplumClient, type AtomicQualification, type MedplumConfig } from '../src/medplum.js';
import { qualifyMedplum } from '../src/qualification.js';
import type { Fetch } from '../src/transport.js';
import { fixture } from '../../../scripts/qualification/fixture.js';
import { mockFhir } from '../../../scripts/qualification/mock-fhir.js';
const config: MedplumConfig = { baseUrl: 'http://127.0.0.1:8103/fhir/R4/', accessToken: 'only-for-tests', timeoutMs: 1000, mode: 'local' };
const qualification = async (): Promise<AtomicQualification> => ({ baseUrl: config.baseUrl, mode: 'local', credentialFingerprint: await digest(config.accessToken), atomicRollback: true, conditionalCreate: true, versionConflict: true, qualifiedAt: '2026-10-09T00:00:00Z' });

describe('historic native atomic capability drill', () => {
  it('uses only the verified immutable response storage time for receipt time', async () => {
    const server = mockFhir(); const client = new MedplumClient(config, server.fetcher); const f = await fixture();
    await client.deliverAtomic(f, await qualification());
    const response = [...server.resources.values()].find(r => r.resourceType === 'QuestionnaireResponse')!;
    const task = [...server.resources.values()].find(r => r.resourceType === 'Task')!;
    response.meta = { ...(response.meta as object), lastUpdated: '2026-10-09T10:05:12.345Z' };
    task.meta = { ...(task.meta as object), lastUpdated: '2026-10-09T12:00:00.000Z' };
    expect(await client.checkAtomic(f)).toMatchObject({ state: 'received', receivedAt: '2026-10-09T10:05:12.345Z' });
    task.meta = { ...(task.meta as object), lastUpdated: '2026-10-10T12:00:00.000Z' };
    expect(await client.checkAtomic(f)).toMatchObject({ state: 'received', receivedAt: '2026-10-09T10:05:12.345Z' });
    response.meta = { versionId: '1' };
    expect(await client.checkAtomic(f)).not.toHaveProperty('receivedAt');
  });
  it('writes one linked immutable handoff and a duplicate call performs no write', async () => {
    const server = mockFhir(); const client = new MedplumClient(config, server.fetcher); const f = await fixture(); const q = await qualification();
    const first = await client.deliverAtomic(f, q);
    expect(first.write).toBe('acknowledged'); expect(first.receipt.state).toBe('received');
    expect(first.receipt).toMatchObject({ review: 'not-established' });
    const before = server.counters.writes;
    expect((await client.deliverAtomic(f, q)).write).toBe('not-attempted');
    expect(server.counters.writes).toBe(before);
    expect(server.resources.size).toBe(4);
    const plan = await planHandoff(f);
    expect(plan.components.map(c => c.key)).toEqual([`${f.submission.submissionId}.v1.sources`, `${f.submission.submissionId}.v1.response`, `${f.submission.submissionId}.v1.work.intake`, `${f.submission.submissionId}.v1.manifest`]);
  });
  it('handles concurrent identical conditional submissions without duplicate resources', async () => {
    const server = mockFhir(); const client = new MedplumClient(config, server.fetcher); const f = await fixture(); const q = await qualification();
    const attempts = await Promise.all([client.deliverAtomic(f, q), client.deliverAtomic(f, q)]);
    expect(attempts.every(a => a.receipt.state === 'received')).toBe(true);
    expect(server.resources.size).toBe(4); expect(server.counters.writes).toBe(4);
  });
  it('revalidates intrinsic provenance and rejects unqualified recording references before persistence', async () => {
    const f = await fixture();
    f.submission.sources[0].patient = 'Patient/wrong'; f.digest = await digest(f.submission);
    await expect(planHandoff(f)).rejects.toThrow('source-patient-mismatch');
    f.submission.sources[0].patient = f.submission.patient;
    f.submission.sources[0].recording = { reference: 'DocumentReference/unqualified', startMs: 0, endMs: 100 };
    f.digest = await digest(f.submission);
    await expect(planHandoff(f)).rejects.toThrow('recording-evidence-not-qualified');
  });
  it('rejects a structurally valid but oversized handoff before a write', async () => {
    const f = await fixture();
    for (let i = 0; i < 100; i++) f.submission.sources.push({ id: `large-${i}`, patient: f.submission.patient, kind: 'patient-statement', capturedAt: '2026-10-09T00:00:00Z', text: 'x'.repeat(12000) });
    f.digest = await digest(f.submission); f.sufficiency!.submissionDigest = f.digest;
    const server = mockFhir();
    await expect(new MedplumClient(config, server.fetcher).deliverAtomic(f, await qualification())).rejects.toThrow('submission-too-large');
    expect(server.counters.requests).toBe(0);
  });
  it('recovers a response lost after acceptance without resubmitting', async () => {
    const server = mockFhir(); let lost = false;
    const fetcher: Fetch = async (url, init) => {
      const response = await server.fetcher(url, init);
      if (init?.method === 'POST' && !lost) { lost = true; await response.arrayBuffer(); throw new Error('lost secret-like body'); }
      return response;
    };
    const client = new MedplumClient(config, fetcher);
    const result = await client.deliverAtomic(await fixture(), await qualification());
    expect(result).toMatchObject({ write: 'outcome-unknown', receipt: { state: 'received', review: 'not-established' } });
    expect(server.counters.transactionPosts).toBe(1);
  });
  it('refuses an identifier collision with a different payload before mutation', async () => {
    const server = mockFhir(); const client = new MedplumClient(config, server.fetcher); const f = await fixture(); const q = await qualification();
    await client.deliverAtomic(f, q); const writes = server.counters.writes;
    f.submission.answers[0].text = 'different confirmed value'; f.digest = await digest(f.submission); f.sufficiency!.submissionDigest = f.digest;
    expect(await client.deliverAtomic(f, q)).toMatchObject({ write: 'not-attempted', receipt: { state: 'conflict' } });
    expect(server.counters.writes).toBe(writes);
  });
  it('rejects content tampering even when the confirmation tag is retained', async () => {
    const server = mockFhir(); const client = new MedplumClient(config, server.fetcher); const f = await fixture();
    await client.deliverAtomic(f, await qualification());
    const source = [...server.resources.values()].find(r => r.resourceType === 'DocumentReference')!;
    source.content = [{ attachment: { contentType: 'application/json', data: btoa('changed') } }];
    expect((await client.checkAtomic(f)).state).toBe('conflict');
  });
  it('does not treat missing components or failed source reads as received', async () => {
    const server = mockFhir(); const client = new MedplumClient(config, server.fetcher); const f = await fixture();
    await client.deliverAtomic(f, await qualification());
    const manifest = [...server.resources.entries()].filter(([, r]) => r.resourceType === 'DocumentReference')[1][0];
    server.resources.delete(manifest);
    const count = server.counters.writes;
    expect(await client.deliverAtomic(f, await qualification())).toMatchObject({ write: 'not-attempted', receipt: { state: 'incomplete' } });
    expect(server.counters.writes).toBe(count);
    const denied = new MedplumClient(config, async () => new Response('{}', { status: 403 }));
    expect((await denied.checkAtomic(f)).state).toBe('unknown');
  });
  it('blocks duplicate conditional matches and mismatched credential qualification', async () => {
    const server = mockFhir(); const client = new MedplumClient(config, server.fetcher); const f = await fixture();
    await client.deliverAtomic(f, await qualification());
    const first = [...server.resources.values()][0]; server.resources.set('duplicate', { ...structuredClone(first), id: 'duplicate' });
    expect((await client.checkAtomic(f)).state).toBe('conflict');
    await expect(new MedplumClient({ ...config, accessToken: 'different-project-token' }, server.fetcher).deliverAtomic(f, await qualification())).rejects.toThrow('native-transaction-not-qualified');
  });
  it('allows staff Task state changes while never inferring explicit review', async () => {
    const server = mockFhir(); const client = new MedplumClient(config, server.fetcher); const f = await fixture();
    await client.deliverAtomic(f, await qualification());
    [...server.resources.values()].find(r => r.resourceType === 'Task')!.status = 'completed';
    expect(await client.checkAtomic(f)).toMatchObject({ state: 'received', review: 'not-established' });
  });
  it('keeps ambiguity explicit when a receipt read fails and never blindly retries', async () => {
    let calls = 0;
    const client = new MedplumClient(config, async () => { calls++; throw new Error('secret'); });
    expect(await client.deliverAtomic(await fixture(), await qualification())).toMatchObject({ write: 'not-attempted', receipt: { state: 'unknown' } });
    expect(calls).toBe(1);
  });
  it('requires explicit local/live endpoint mode and does not forward secrets to URL credentials', () => {
    expect(() => new MedplumClient({ ...config, mode: 'live' })).toThrow('invalid-medplum-configuration');
    expect(() => new MedplumClient({ ...config, baseUrl: 'https://evil.example/fhir/R4/' })).toThrow('invalid-medplum-configuration');
    expect(() => new MedplumClient({ ...config, baseUrl: 'http://user:secret@localhost/fhir/R4/' })).toThrow('invalid-medplum-configuration');
  });
});
describe('qualification distinguishes observations', () => {
  it('exercises conditional create, stale update, rollback and lost receipt on the mock only', async () => {
    const report = await qualifyMedplum(config, await fixture(), mockFhir().fetcher, true);
    expect(report.mode).toBe('mock'); expect(report.qualification).toBeUndefined();
    expect(Object.values(report.checks).every(Boolean)).toBe(true);
    expect(report.authorization).toBe('not-qualified'); expect(report.providerInference).toBe('not-called');
  });
  it('detects batch-like transaction behavior and refuses native handoff qualification', async () => {
    const server = mockFhir({ atomic: false });
    const report = await qualifyMedplum(config, await fixture(), server.fetcher, true);
    expect(report.checks.batchControl).toBe(true); expect(report.checks.atomicRollback).toBe(false);
    expect(report.nativeTransactions).toBe('not-qualified'); expect(report.handoff).toBe('not-qualified');
    expect(report.checks.lostResponseRecovery).toBe(false);
    expect([...server.resources.values()].filter(r => r.resourceType === 'Task')).toHaveLength(0);
  });
  it('withholds qualification from a server that accepts batches but rejects every transaction', async () => {
    const server = mockFhir();
    const fetcher: Fetch = (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return body?.type === 'transaction' ? Promise.resolve(new Response('{}', { status: 412 })) : server.fetcher(url, init);
    };
    const report = await qualifyMedplum(config, await fixture(), fetcher);
    expect(report.checks.batchControl).toBe(true); expect(report.checks.atomicRollback).toBe(false);
    expect(report.checks.validTransaction).toBe(false); expect(report.qualification).toBeUndefined();
    expect(report.nativeTransactions).toBe('not-qualified');
  });
  it('does not mistake a server that rejects all bundles for atomic rollback', async () => {
    const server = mockFhir();
    const fetcher: Fetch = (url, init) => init?.method === 'POST' && String(url) === config.baseUrl ? Promise.resolve(new Response('{}', { status: 400 })) : server.fetcher(url, init);
    const report = await qualifyMedplum(config, await fixture(), fetcher, true);
    expect(report.checks.batchControl).toBe(false); expect(report.checks.atomicRollback).toBe(false);
  });
});
