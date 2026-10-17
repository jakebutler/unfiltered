import { beforeAll, it, expect, vi } from 'vitest';
import { handoffs, administrativeTopics, type Snapshot } from '../src/handoffs.js';
import { createClinicHandler } from '../src/handler.js';
import { createDraft, document, SNAPSHOT_SYSTEM, DRAFT_SYSTEM } from '../src/store.js';
import type { ClinicApiConfig, Draft, StaffAssignment } from '../src/types.js';
import { digest } from '../../clinical-core/src/domain.js';
import { MedplumClient, type DeliveryQualification } from '../../clinical-core/src/medplum.js';
import { fixture } from '../../../scripts/qualification/fixture.js';
import { mockFhir } from '../../../scripts/qualification/mock-fhir.js';
const baseUrl = 'http://localhost:8103/fhir/R4/';
const assignment: StaffAssignment = { membershipId: 'member', profile: 'Practitioner/md', policy: 'AccessPolicy/clinical', name: 'Synthetic MD', role: 'physician', patients: ['Patient/assigned'], careTeams: ['CareTeam/medical'] };
const patient = { reference: 'Patient/assigned', displayName: 'Synthetic Patient', description: 'Technical fixture', careTeams: { medical: 'CareTeam/medical', nutrition: 'CareTeam/nutrition', administrative: 'CareTeam/admin' } };
const config = { origin: 'http://localhost:5173', projectId: 'synthetic-project', cookieSecret: 'synthetic-secret-'.repeat(4), mentalHealth: 'phq4', patients: { 'first-intake': patient }, staff: [assignment] } as unknown as ClinicApiConfig;
const uuid = (index: number) => `12345678-1234-4234-9234-${String(index).padStart(12, '0')}`;
const native = mockFhir({ atomic: false });
let snapshots: Snapshot[] = [];
const clientConfig = { baseUrl, accessToken: 'synthetic-token', mode: 'local' as const, timeoutMs: 1000 };
const real = new MedplumClient(clientConfig, native.fetcher);
beforeAll(async () => {
  const q: DeliveryQualification = { deliveryContract: 'conditional-resumable-v1', ...clientConfig, credentialFingerprint: await digest(clientConfig.accessToken), conditionalCreate: true, conditionalConcurrency: true, versionConflict: true, versionHistory: true, qualifiedAt: new Date().toISOString() };
  for (let index = 0; index < 106; index++) {
    const confirmation = await fixture(patient.reference, patient.careTeams.medical, uuid(index));
    const s: Snapshot = { schema: 2, deliveryContract: 'conditional-resumable-v1', id: uuid(index), patient: patient.reference, patientName: patient.displayName, scenario: 'first-intake', topics: [], confirmation };
    snapshots.push(s);
    const saved = (await real.request('DocumentReference', 'POST', document(SNAPSHOT_SYSTEM, `${s.id}.v1`, s.patient, s))).body as { resourceType: string; id: string; meta: { lastUpdated: string } };
    // Deterministic pagination order; metadata does not change frozen content.
    const reference = `DocumentReference/${saved.id}`, updated = new Date(Date.now() - index * 1000).toISOString();
    (native.resources.get(reference)!.meta as { lastUpdated: string }).lastUpdated = updated;
    (native.histories.get(reference)![0].meta as { lastUpdated: string }).lastUpdated = updated;
    if (index < 5 || index >= 100) await real.deliver(confirmation, q);
  }
}, 30000);
function observed(options: { foreign?: boolean; unknown?: boolean; nextUrl?: string; malformed?: boolean } = {}) {
  const pages: URL[] = [], reads: string[] = [], checks: string[] = [];
  const c = new MedplumClient(clientConfig, async (input, init) => {
    const url = new URL(String(input)), identifier = url.searchParams.get('identifier');
    const aggregate = identifier === `${SNAPSHOT_SYSTEM}|` || identifier === `${DRAFT_SYSTEM}|`;
    if (aggregate) pages.push(url); else reads.push(url.href);
    const response = await native.fetcher(input, init);
    if (!aggregate || !response.ok) return response;
    const body = await response.json();
    if (options.foreign) for (const row of body.entry ?? []) row.resource.subject = { reference: 'Patient/unassigned' };
    if (options.nextUrl && identifier === `${SNAPSHOT_SYSTEM}|`) body.link = [{ relation: 'next', url: options.nextUrl }];
    if (options.malformed && identifier === `${SNAPSHOT_SYSTEM}|`) body.entry = [{}];
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/fhir+json' } });
  });
  const original = c.check.bind(c);
  c.check = async confirmation => { checks.push(confirmation.submission.submissionId); return options.unknown ? { state: 'unknown', digest: confirmation.digest, present: 0, resources: {}, anchors: {}, verifiedWork: [] } : original(confirmation); };
  return { client: c, pages, reads, checks };
}
it('reads fixed five-row pages with fresh receipt checks and explicit continuation beyond 100', async () => {
  const c = observed(), queue = handoffs(config).queue;
  const first = await queue(c.client, c.client, assignment);
  expect(first.items).toHaveLength(5); expect(first.recovery).toEqual([]); expect(first.nextCursor).toBe('5');
  expect(c.pages).toHaveLength(2); expect(c.checks).toHaveLength(5);
  const late = await queue(c.client, c.client, assignment, '100');
  expect(late.items.map(item => item.id).sort()).toEqual([100, 101, 102, 103, 104].map(index => `${uuid(index)}.v1`)); expect(late.nextCursor).toBe('105');
  const last = await queue(c.client, c.client, assignment, late.nextCursor);
  expect(last.items).toHaveLength(1); expect(last.nextCursor).toBeUndefined();
  expect(c.pages.filter(url => url.searchParams.get('identifier') === `${SNAPSHOT_SYSTEM}|`).map(url => url.searchParams.get('_offset'))).toEqual(['0', '100', '105']);
  expect(c.pages.every(url => url.searchParams.get('_count') === '5' && url.searchParams.get('subject') === patient.reference)).toBe(true);
});
it('exposes unknown delivery as recovery metadata while preserving continuation', async () => {
  const c = observed({ unknown: true }), page = await handoffs(config).queue(c.client, c.client, assignment);
  expect(page.items).toEqual([]); expect(page.nextCursor).toBe('5'); expect(page.recovery).toHaveLength(5);
  expect(page.recovery.every(item => item.deliveryState === 'unknown' && !item.anchorsVerified && !item.canResume)).toBe(true);
  expect(c.checks).toHaveLength(5);
});
it('paginates confirmed no-snapshot intent independently from ordinary handoffs', async () => {
  const n = mockFhir(), c = new MedplumClient(clientConfig, n.fetcher), now = new Date().toISOString();
  for (const s of snapshots.slice(0, 7)) {
    const draft: Draft = { schema: 1, id: s.id, patient: s.patient, scenario: s.scenario, revision: 1, savedAt: now, createdAt: now, phase: 'confirmed', turns: [], topics: {}, requests: {}, version: 1, confirmed: { confirmation: s.confirmation, digest: s.confirmation.digest, topics: [] } };
    await createDraft(c, draft);
  }
  const first = await handoffs(config).queue(c, c, assignment);
  expect(first.items).toEqual([]); expect(first.recovery).toHaveLength(5); expect(first.recoveryCursor).toBe('5'); expect(first.nextCursor).toBeUndefined();
  const next = await handoffs(config).queue(c, c, assignment, undefined, first.recoveryCursor);
  expect(next.recovery).toHaveLength(2); expect(next.recoveryCursor).toBeUndefined(); expect(next.recovery.every(item => item.deliveryState === 'pending' && item.canResume && !item.anchorsVerified)).toBe(true);
});
it('does not fetch sources for a foreign subject even when a scoped search misbehaves', async () => {
  const c = observed({ foreign: true });
  expect(await handoffs(config).queue(c.client, c.client, assignment)).toEqual({ items: [], recovery: [], nextCursor: '5' });
  expect(c.pages[0].searchParams.get('subject')).toBe(patient.reference); expect(c.reads).toHaveLength(0); expect(c.checks).toHaveLength(0);
});
it('does no queue reads for empty patient or care-team assignments', async () => {
  const c = observed(), queue = handoffs(config).queue;
  expect(await queue(c.client, c.client, { ...assignment, patients: [] })).toEqual({ items: [], recovery: [] });
  expect(await queue(c.client, c.client, { ...assignment, careTeams: [] })).toEqual({ items: [], recovery: [] }); expect(c.pages).toHaveLength(0);
});
it('rejects forged cursors, malformed rows and foreign continuation URLs without following them', async () => {
  const c = observed(), queue = handoffs(config).queue;
  for (const cursor of ['', '-5', '1', '5.0', '05', '1e2', '100005', 'https://other.test/fhir/R4/DocumentReference', '5&subject=Patient/other']) {
    await expect(queue(c.client, c.client, assignment, cursor)).rejects.toMatchObject({ code: 'invalid-queue-cursor' });
    await expect(queue(c.client, c.client, assignment, undefined, cursor)).rejects.toMatchObject({ code: 'invalid-queue-cursor' });
  }
  // Invalid recovery cursor is checked before either namespace is queried.
  const before = c.pages.length; expect(before).toBe(0);
  const foreign = observed({ nextUrl: 'http://other.test/fhir/R4/DocumentReference?_offset=5' });
  await expect(queue(foreign.client, foreign.client, assignment)).rejects.toMatchObject({ code: 'invalid-queue-pagination' }); expect(foreign.pages).toHaveLength(1); expect(foreign.reads).toHaveLength(0);
  const malformed = observed({ malformed: true }); await expect(queue(malformed.client, malformed.client, assignment)).rejects.toMatchObject({ code: 'queue-unavailable' }); expect(malformed.reads).toHaveLength(0);
  expect(c.pages).toHaveLength(before);
});
it('accepts only the two independent cursor parameters at the queue route', async () => {
  const fetcher = vi.fn(async () => { throw new Error('No upstream call expected'); });
  const handler = createClinicHandler(config, { fetcher });
  for (const query of ['cursor=5&subject=Patient/other', 'cursor=5&cursor=10', 'recoveryCursor=5&recoveryCursor=10', 'cursor=-5', 'cursor=', 'cursor=5.0', 'cursor=100005', 'recoveryCursor=-5', 'recoveryCursor=', 'recoveryCursor=5.0', 'recoveryCursor=100005']) expect((await handler(new Request(`${config.origin}/api/staff/queue?${query}`))).status).toBe(400);
  expect((await handler(new Request(`${config.origin}/api/staff/queue?cursor=5&recoveryCursor=10`))).status).toBe(401); expect(fetcher).not.toHaveBeenCalled();
});
it('projects only confirmed closed admin logistics, ignoring snapshot presentation text', () => {
  const s = { ...snapshots[0], scenario: 'scheduling', topics: [{ details: [{ text: 'Private clinical history' }] }], confirmation: { ...snapshots[0].confirmation, submission: { ...snapshots[0].confirmation.submission, administrativeLogistics: { kind: 'scheduling', preferredDay: 'Tuesday', requestedDate: '2026-10-20' } } } } as Snapshot;
  const projected = administrativeTopics(s); expect(projected[0].details?.find(d => d.id === 'preferredDay')?.text).toBe('Tuesday'); expect(projected[0].details?.find(d => d.id === 'requestedDate')?.text).toBe('2026-10-20'); expect(JSON.stringify(projected)).not.toContain('Private clinical'); expect(projected[0].details?.every(d => !d.sourceIds.length)).toBe(true);
  expect(() => administrativeTopics({ ...s, confirmation: { ...s.confirmation, submission: { ...s.confirmation.submission, administrativeLogistics: { kind: 'scheduling', requestedDate: '2026-02-30' } } } })).toThrow();
  expect(() => administrativeTopics({ ...s, confirmation: { ...s.confirmation, submission: { ...s.confirmation.submission, administrativeLogistics: { kind: 'scheduling', preferredWindow: 'Private clinical history' } as never } } })).toThrow();
});
