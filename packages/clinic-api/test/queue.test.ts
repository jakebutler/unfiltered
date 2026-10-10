import { it, expect, vi } from 'vitest';
import { handoffs, administrativeTopics, type Snapshot } from '../src/handoffs.js';
import { createClinicHandler } from '../src/handler.js';
import { document, SNAPSHOT_SYSTEM } from '../src/store.js';
import type { ClinicApiConfig, StaffAssignment } from '../src/types.js';
import type { MedplumClient } from '../../clinical-core/src/medplum.js';
const baseUrl = 'http://localhost:8103/fhir/R4/';
const assignment: StaffAssignment = { membershipId: 'member', profile: 'Practitioner/md', policy: 'AccessPolicy/clinical', name: 'Synthetic MD', role: 'physician', patients: ['Patient/assigned'], careTeams: ['CareTeam/medical'] };
const id = '12345678-1234-4234-9234-123456789abc';
const snapshot = { schema: 1, id, patient: 'Patient/assigned', patientName: 'Synthetic Patient', scenario: 'first-intake', topics: [], confirmation: { digest: 'a'.repeat(64), submission: { submissionId: id, version: 1, patient: 'Patient/assigned', scenario: 'first-intake', completeness: 'partial', confirmedAt: '2026-10-09T00:00:00.000Z', sources: [], work: [{ id: 'medical', responsibility: 'medical', owner: 'CareTeam/medical' }] } } } as unknown as Snapshot;
const target = { ...document(SNAPSHOT_SYSTEM, `${id}.v1`, 'Patient/assigned', snapshot), id: 'doc' };
function client(total: number, options: { foreign?: boolean; receipt?: 'received' | 'unknown'; nextUrl?: string } = {}) {
    const pages: URL[] = [], reads: string[] = [], checks: string[] = [];
    const uuid = (index: number) => `12345678-1234-4234-9234-${String(index).padStart(12, '0')}`;
    const fullDocument = (value: string) => ({ ...document(SNAPSHOT_SYSTEM, `${value}.v1`, 'Patient/assigned', { ...snapshot, id: value, confirmation: { ...snapshot.confirmation, submission: { ...snapshot.confirmation.submission, submissionId: value } } }), id: `doc-${value}` });
    const c = {
        config: { baseUrl },
        async request(path: string) {
            const url = new URL(path, baseUrl);
            const identifier = url.searchParams.get('identifier');
            if (path.startsWith('Task/')) { reads.push(path); return { body: { resourceType: 'Task', id: 'work', status: 'requested', meta: { versionId: '1' } } }; }
            if (path.startsWith('DocumentReference/doc-')) { reads.push(path); return { body: target }; }
            if (identifier?.startsWith(`${SNAPSHOT_SYSTEM}|`) && identifier !== `${SNAPSHOT_SYSTEM}|`) {
                reads.push(path);
                return { body: { resourceType: 'Bundle', type: 'searchset', entry: [{ resource: fullDocument(identifier.split('|')[1].slice(0, -3)) }] } };
            }
            pages.push(url);
            const offset = Number(url.searchParams.get('_offset') ?? 0), count = Number(url.searchParams.get('_count'));
            const end = Math.min(offset + count, total);
            return { body: { resourceType: 'Bundle', type: 'searchset', total, entry: Array.from({ length: Math.max(0, end - offset) }, (_, index) => ({ resource: { resourceType: 'DocumentReference', id: `doc-${offset + index}`, subject: { reference: options.foreign ? 'Patient/unassigned' : 'Patient/assigned' }, identifier: [{ system: SNAPSHOT_SYSTEM, value: `${uuid(offset + index)}.v1` }] } })), link: end < total ? [{ relation: 'next', url: options.nextUrl ?? `${baseUrl}DocumentReference?_offset=${end}` }] : [] } };
        },
        async check(confirmation: Snapshot['confirmation']) {
            const value = confirmation.submission.submissionId;
            checks.push(value);
            return options.receipt === 'unknown' ? { state: 'unknown', digest: 'a'.repeat(64), present: 0 } : { state: 'received', digest: 'a'.repeat(64), receivedAt: '2026-10-09T00:01:00.000Z', resources: { [`${value}.v1.work.medical`]: 'Task/work' } };
        },
    };
    return { client: c as unknown as MedplumClient, pages, reads, checks };
}
it('reads only five snapshots and freshly checks each returned item, with explicit continuation beyond 100', async () => {
    const c = client(106), queue = handoffs({} as ClinicApiConfig).queue;
    const first = await queue(c.client, c.client, assignment);
    expect(first.items).toHaveLength(5);
    expect(first.nextCursor).toBe('5');
    expect(c.pages).toHaveLength(1);
    expect(c.checks).toHaveLength(10); // Service receipt and fresh named receipt for each item.
    const late = await queue(c.client, c.client, assignment, '100');
    expect(late.items[0].id).toBe('12345678-1234-4234-9234-000000000100.v1');
    expect(late.nextCursor).toBe('105');
    const last = await queue(c.client, c.client, assignment, late.nextCursor);
    expect(last.items).toHaveLength(1);
    expect(last.nextCursor).toBeUndefined();
    expect(c.pages.map(url => url.searchParams.get('_offset'))).toEqual(['0', '100', '105']);
    expect(c.pages.every(url => url.searchParams.get('_count') === '5' && url.searchParams.get('subject') === 'Patient/assigned')).toBe(true);
});
it('keeps a continuation when receipt filtering makes the current page empty', async () => {
    const c = client(12, { receipt: 'unknown' });
    const page = await handoffs({} as ClinicApiConfig).queue(c.client, c.client, assignment);
    expect(page).toEqual({ items: [], nextCursor: '5' });
    expect(c.pages).toHaveLength(1);
    expect(c.checks).toHaveLength(5);
});
it('does not fetch sources for a foreign subject even if the scoped search misbehaves', async () => {
    const c = client(1, { foreign: true });
    expect(await handoffs({} as ClinicApiConfig).queue(c.client, c.client, assignment)).toEqual({ items: [] });
    expect(c.pages[0].searchParams.get('subject')).toBe('Patient/assigned');
    expect(c.reads).toHaveLength(0);
    expect(c.checks).toHaveLength(0);
});
it('does no queue reads for empty patient or care-team assignments', async () => {
    const c = client(10), queue = handoffs({} as ClinicApiConfig).queue;
    expect(await queue(c.client, c.client, { ...assignment, patients: [] })).toEqual({ items: [] });
    expect(await queue(c.client, c.client, { ...assignment, careTeams: [] })).toEqual({ items: [] });
    expect(c.pages).toHaveLength(0);
});
it('rejects forged cursor values and foreign continuation URLs without following them', async () => {
    const c = client(10), queue = handoffs({} as ClinicApiConfig).queue;
    for (const cursor of ['', '-5', '1', '5.0', '05', '1e2', '100005', 'https://other.test/fhir/R4/DocumentReference', '5&subject=Patient/other'])
        await expect(queue(c.client, c.client, assignment, cursor)).rejects.toMatchObject({ code: 'invalid-queue-cursor' });
    expect(c.pages).toHaveLength(0);
    const foreign = client(10, { nextUrl: 'http://other.test/fhir/R4/DocumentReference?_offset=5' });
    await expect(queue(foreign.client, foreign.client, assignment)).rejects.toMatchObject({ code: 'invalid-queue-pagination' });
    expect(foreign.pages).toHaveLength(1);
    expect(foreign.reads).toHaveLength(0);
});
it('permits only one cursor query parameter at the queue route', async () => {
    const fetcher = vi.fn(async () => { throw new Error('No upstream call expected'); });
    const handler = createClinicHandler({ origin: 'http://localhost:5173', cookieSecret: 'test-secret-'.repeat(5), mentalHealth: 'phq4', patients: {}, staff: [] } as unknown as ClinicApiConfig, { fetcher });
    for (const query of ['cursor=5&subject=Patient/other', 'cursor=5&cursor=10', 'cursor=-5', 'cursor=', 'cursor=5.0', 'cursor=100005']) {
        const response = await handler(new Request(`http://localhost:5173/api/staff/queue?${query}`));
        expect(response.status).toBe(400);
    }
    const validButUnauthenticated = await handler(new Request('http://localhost:5173/api/staff/queue?cursor=5'));
    expect(validButUnauthenticated.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
});
it('administrative projection admits only explicit logistics choices and valid dates, never raw clinical text', () => { const s = { ...snapshot, scenario: 'scheduling', topics: [{ id: 'W06', title: 'Scheduling', status: 'ready-for-review', required: true, missingDetails: [], details: [{ id: 'intent', label: 'Intent', state: 'answered', text: 'request', sourceIds: ['safe'] }, { id: 'preferredDay', label: 'Day', state: 'answered', text: 'Tuesday', sourceIds: ['safe'] }, { id: 'requestedDate', label: 'Date', state: 'answered', text: '2026-10-20', sourceIds: ['safe'] }, { id: 'timezone', label: 'Zone', state: 'answered', text: 'America/Los_Angeles', sourceIds: ['safe'] }, { id: 'visit', label: 'Visit', state: 'answered', text: 'Private clinical history', sourceIds: ['private'] }, { id: 'preferredWindow', label: 'Window', state: 'answered', text: 'Private clinical history', sourceIds: ['private'] }] }] } as Snapshot; const projected = administrativeTopics(s); expect(projected[0].details?.find(d => d.id === 'preferredDay')?.text).toBe('Tuesday'); expect(projected[0].details?.find(d => d.id === 'requestedDate')?.text).toBe('2026-10-20'); expect(JSON.stringify(projected)).not.toContain('Private clinical'); expect(projected[0].details?.every(d => !d.sourceIds.length)).toBe(true); });
