import { describe, expect, it } from 'vitest';
import { digest } from '../src/domain.js';
import { planHandoff, verifyComponent } from '../src/fhir.js';
import { MedplumClient, type DeliveryQualification, type MedplumConfig } from '../src/medplum.js';
import { qualifyConditionalMedplum } from '../src/qualification.js';
import { fixture } from '../../../scripts/qualification/fixture.js';
import { mockFhir } from '../../../scripts/qualification/mock-fhir.js';
const config: MedplumConfig = { baseUrl: 'http://127.0.0.1:8103/fhir/R4/', accessToken: 'synthetic-test-token', timeoutMs: 1000, mode: 'local' };
const q = async (): Promise<DeliveryQualification> => ({ deliveryContract: 'conditional-resumable-v1', baseUrl: config.baseUrl, mode: 'local', credentialFingerprint: await digest(config.accessToken), conditionalCreate: true, conditionalConcurrency: true, versionConflict: true, versionHistory: true, qualifiedAt: new Date().toISOString() });
describe('selected conditional, resumable graph', () => {
  it.each([1, 2, 3, 4])('resumes a lost response after component %s with exact stable identity', async position => {
    const native = mockFhir({ atomic: false }), f = await fixture(); let posts = 0;
    const lossy = new MedplumClient(config, async (input, init) => { const result = await native.fetcher(input, init); if (init?.method === 'POST' && ++posts === position) { await result.arrayBuffer(); throw new Error('lost response'); } return result; });
    const first = await lossy.deliver(f, await q());
    expect(first.write).toBe('outcome-unknown'); expect(first.receipt.present).toBe(position);
    const fresh = new MedplumClient(config, native.fetcher), resumed = await fresh.deliver(f, await q());
    expect(resumed.receipt.state).toBe('received'); expect(native.resources.size).toBe(4); expect(native.counters.writes).toBe(4); expect(native.counters.transactionPosts).toBe(0);
    const before = native.counters.writes; await fresh.deliver(f, await q()); expect(native.counters.writes).toBe(before);
  });
  it('shows verified anchors with zero Tasks, then converges concurrent identical retries', async () => {
    const native = mockFhir(), f = await fixture();
    const failing = new MedplumClient(config, async (input, init) => init?.method === 'POST' && String(input).endsWith('/Task') ? new Response('{}', { status: 503 }) : native.fetcher(input, init));
    const zero = await failing.deliver(f, await q());
    expect(zero.receipt).toMatchObject({ state: 'incomplete', present: 2, verifiedWork: [] }); expect(Object.keys(zero.receipt.anchors)).toEqual(['source', 'response']);
    const client = new MedplumClient(config, native.fetcher), qualification = await q();
    const attempts = await Promise.all([client.deliver(f, qualification), client.deliver(f, qualification)]);
    expect(attempts.every(result => result.receipt.state === 'received')).toBe(true); expect(native.resources.size).toBe(4);
  });
  it('uses original manifest creation time through same-content manifest rewrites and Task updates', async () => {
    const native = mockFhir(), f = await fixture(), client = new MedplumClient(config, native.fetcher);
    const first = await client.deliver(f, await q()); expect(first.receipt.state).toBe('received');
    const manifestRef = first.receipt.resources[`${f.submission.submissionId}.v1.manifest`], manifest = native.resources.get(manifestRef)!;
    const original = first.receipt.state === 'received' ? first.receipt.receivedAt : undefined;
    await client.request(manifestRef, 'PUT', manifest, { 'If-Match': 'W/"1"' });
    const taskRef = first.receipt.resources[`${f.submission.submissionId}.v1.work.intake`];
    await client.request(taskRef, 'PUT', { ...native.resources.get(taskRef), status: 'completed' }, { 'If-Match': 'W/"1"' });
    expect(await client.check(f)).toMatchObject({ state: 'received', receivedAt: original, review: 'not-established' });
    expect((native.resources.get(manifestRef)!.meta as { lastUpdated: string }).lastUpdated).not.toBe(original);
  });
  it('retains uncertainty and performs zero writes when a preflight read fails', async () => {
    const native = mockFhir(), f = await fixture(), client = new MedplumClient(config, native.fetcher);
    await client.deliver(f, await q()); const before = native.counters.writes;
    const failing = new MedplumClient(config, async () => new Response('{}', { status: 503 }));
    expect(await failing.deliver(f, await q())).toMatchObject({ write: 'not-attempted', receipt: { state: 'unknown', present: 0 } }); expect(native.counters.writes).toBe(before);
  });
  it('rejects altered persisted clinical fields and duplicate identities without overwriting', async () => {
    const native = mockFhir(), f = await fixture(), client = new MedplumClient(config, native.fetcher);
    await client.deliver(f, await q()); const before = native.counters.writes;
    const task = [...native.resources.values()].find(resource => resource.resourceType === 'Task')!;
    task.description = 'Unexpected clinical wording';
    expect((await client.deliver(f, await q())).receipt.state).toBe('conflict'); expect(native.counters.writes).toBe(before);
    const source = [...native.resources.values()][0]; native.resources.set('duplicate', { ...source, id: 'duplicate' });
    expect((await client.check(f)).state).toBe('conflict');
  });
  it('only substitutes typed references, preserving literal URNs in patient words', async () => {
    const f = await fixture(), originalPlan = await planHandoff(f), literal = originalPlan.components[0].fullUrl;
    f.submission.answers[0].text = literal; f.digest = await digest(f.submission); f.sufficiency!.submissionDigest = f.digest;
    const native = mockFhir(), client = new MedplumClient(config, native.fetcher);
    expect((await client.deliver(f, await q())).receipt.state).toBe('received');
    const qr = [...native.resources.values()].find(resource => resource.resourceType === 'QuestionnaireResponse')!;
    expect((qr.item as Array<{ answer: Array<{ valueString: string }> }>)[0].answer[0].valueString).toBe(literal);
  });
  it('binds admin logistics and rejects clinical links or additional free text on admin Tasks', async () => {
    const f = await fixture(); f.submission.administrativeLogistics = { kind: 'billing', issueType: 'bill-question', serviceDate: '2026-10-01' };
    f.submission.work.push({ id: 'billing', kind: 'administrative', responsibility: 'administrative', owner: 'CareTeam/admin' }); f.digest = await digest(f.submission); f.sufficiency!.submissionDigest = f.digest;
    const plan = await planHandoff(f), admin = plan.components.find(component => component.key.endsWith('work.billing'))!.resource;
    expect(admin).not.toHaveProperty('focus'); expect(admin).not.toHaveProperty('input');
    expect(verifyComponent(admin, { ...admin, description: 'Patient has abdominal pain.' })).toBe(false);
    expect(verifyComponent(admin, { ...admin, focus: { reference: 'QuestionnaireResponse/clinical' } })).toBe(false);
  });
  it('does not authorize selected delivery with an old atomic attestation', async () => {
    const client = new MedplumClient(config, mockFhir().fetcher);
    await expect(client.deliver(await fixture(), { ...(await q()), deliveryContract: undefined } as never)).rejects.toThrow('conditional-delivery-not-qualified');
  });
  it('qualifies the conditional contract even when transactions behave as independent batches', async () => {
    const native = mockFhir({ atomic: false }), report = await qualifyConditionalMedplum(config, await fixture(), native.fetcher, true);
    expect(report.delivery).toBe('mock-pass'); expect(Object.values(report.checks).every(Boolean)).toBe(true); expect(report.qualification).toBeUndefined(); expect(native.counters.transactionPosts).toBe(0);
  });
});
