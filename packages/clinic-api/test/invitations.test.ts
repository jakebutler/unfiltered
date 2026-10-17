import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { invitations, INVITATION_SYSTEM, INVITATION_TOKEN_SYSTEM } from '../src/invitations.js';
import { patientFixture, draftPatientFixture, requirePatientScope, requireInvitationDraftScope } from '../src/patient-fixture.js';
import { MedplumClient } from '../../clinical-core/src/medplum.js';
import type { FhirResource } from '../../clinical-core/src/fhir.js';
import type { ClinicApiConfig, Draft, StaffAssignment } from '../src/types.js';
import type { PatientClaims } from '../src/cookies.js';
const patient = 'Patient/synthetic-1';
const assignment: StaffAssignment = { membershipId: 'member-1', profile: 'Practitioner/staff-1', policy: 'AccessPolicy/test', name: 'Synthetic reviewer', role: 'physician', patients: [patient], careTeams: ['CareTeam/medical-1'] };
const fixture = { reference: patient, displayName: 'Synthetic patient', description: 'Fictional information', careTeams: { medical: 'CareTeam/medical-1', nutrition: 'CareTeam/nutrition-1', administrative: 'CareTeam/admin-1' } };
const config = { origin: 'https://clinic.example', patients: { 'first-intake': fixture, 'pre-visit': { ...fixture, reference: 'Patient/synthetic-2', displayName: 'Other synthetic patient' } }, staff: [assignment] } as ClinicApiConfig;
const input = () => ({ patient, scenario: 'first-intake' as const, requestId: crypto.randomUUID() });
const tokenOf = (link: string) => new URLSearchParams(new URL(link).hash.slice(1)).get('token')!;
function storage() {
  const tasks = new Map<string, FhirResource>();
  const state = { loseCreateResponse: false, losePutResponse: false, failCreate: false, failRead: false, beforePut: undefined as (() => void) | undefined, substituteSearch: undefined as FhirResource | undefined, searchBundle: undefined as Record<string, unknown> | undefined };
  let id = 0;
  const fetcher = vi.fn(async (value: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(value)), method = init?.method ?? 'GET';
    if (method === 'GET') {
      if (state.failRead) throw new Error('offline');
      if (state.searchBundle) return Response.json(state.searchBundle);
      const key = url.searchParams.get('identifier');
      const rows = state.substituteSearch ? [state.substituteSearch] : [...tasks.values()].filter(task => (task.identifier as { system: string; value: string }[]).some(identifier => `${identifier.system}|${identifier.value}` === key));
      return Response.json({ resourceType: 'Bundle', type: 'searchset', total: rows.length, entry: rows.map(resource => ({ resource })) });
    }
    const resource = JSON.parse(String(init?.body)) as FhirResource;
    if (method === 'POST') {
      if (state.failCreate) return Response.json({}, { status: 403 });
      const key = new URLSearchParams((init?.headers as Record<string, string>)['If-None-Exist']).get('identifier');
      const existing = [...tasks.values()].find(task => (task.identifier as { system: string; value: string }[]).some(identifier => `${identifier.system}|${identifier.value}` === key));
      if (existing) return Response.json(existing, { status: 200 });
      const created = { ...resource, id: `invite-${++id}`, meta: { versionId: '1' } };
      tasks.set(created.id, created);
      if (state.loseCreateResponse) throw new Error('lost-response');
      return Response.json(created, { status: 201 });
    }
    if (method === 'PUT') {
      state.beforePut?.(); state.beforePut = undefined;
      const current = tasks.get(String(resource.id))!;
      if ((init?.headers as Record<string, string>)['If-Match'] !== `W/"${(current.meta as { versionId: string }).versionId}"`) return Response.json({}, { status: 412 });
      const updated = { ...resource, meta: { versionId: String(Number((current.meta as { versionId: string }).versionId) + 1) } };
      tasks.set(String(resource.id), updated);
      if (state.losePutResponse) throw new Error('lost-response');
      return Response.json(updated);
    }
    throw new Error('unexpected-test-request');
  });
  const client = new MedplumClient({ baseUrl: 'http://localhost/fhir/R4/', accessToken: 'test-only', timeoutMs: 100, mode: 'local' }, fetcher);
  return { tasks, state, fetcher, client, api: invitations(config) };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe('clinic invitation capabilities', () => {
  it('stores only the hash, redeems exactly once and binds the actual patient and workflow', async () => {
    const f = storage(), issued = await f.api.issue(f.client, assignment, input());
    const token = tokenOf(issued.link!);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify([...f.tasks.values()])).not.toContain(token);
    expect(JSON.stringify([...f.tasks.values()])).toContain(createHash('sha256').update(token).digest('hex'));
    expect(Date.parse(issued.expiresAt) - Date.parse(String([...f.tasks.values()][0].authoredOn))).toBe(72 * 3600000);
    expect(await f.api.redeem(f.client, token)).toEqual({ invitationId: issued.invitationId, patient, scenario: 'first-intake', expiresAt: issued.expiresAt });
    await expect(f.api.redeem(f.client, token)).rejects.toMatchObject({ code: 'invitation-invalid', status: 410 });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
  });
  it('can invite a configured assigned patient into a different workflow without changing identity', async () => {
    const f = storage(), issued = await f.api.issue(f.client, assignment, { ...input(), scenario: 'pre-visit' });
    expect(await f.api.redeem(f.client, tokenOf(issued.link!))).toMatchObject({ patient, scenario: 'pre-visit' });
  });
  it.each(['patient', 'role', 'team'] as const)('denies an unauthorized %s before any storage call', async field => {
    const f = storage(), changed = { ...assignment, ...(field === 'patient' ? { patients: [] } : field === 'team' ? { careTeams: [] } : { role: 'observer' as StaffAssignment['role'] }) };
    await expect(f.api.issue(f.client, changed, input())).rejects.toMatchObject({ status: 403 });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('replays a request receipt without the link and rejects changed request scope', async () => {
    const f = storage(), request = input(), issued = await f.api.issue(f.client, assignment, request);
    expect(await f.api.issue(f.client, assignment, request)).toEqual({ invitationId: issued.invitationId, expiresAt: issued.expiresAt });
    await expect(f.api.issue(f.client, assignment, { ...request, scenario: 'pre-visit' })).rejects.toMatchObject({ code: 'invitation-request-conflict', status: 409 });
  });
  it('concurrent conditional issue returns only one capability', async () => {
    const f = storage(), request = input();
    const results = await Promise.all([f.api.issue(f.client, assignment, request), f.api.issue(f.client, assignment, request)]);
    expect(f.tasks.size).toBe(1);
    expect(results.filter(result => result.link)).toHaveLength(1);
    expect(results[0].invitationId).toBe(results[1].invitationId);
  });
  it('an uncertain create recovers only a receipt and never retries the write', async () => {
    const f = storage(); f.state.loseCreateResponse = true;
    const result = await f.api.issue(f.client, assignment, input());
    expect(result.link).toBeUndefined();
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('a native policy denial fails without a service-client fallback', async () => {
    const f = storage(); f.state.failCreate = true;
    await expect(f.api.issue(f.client, assignment, input())).rejects.toMatchObject({ code: 'invitation-write-denied', status: 403 });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects expiry at the exact boundary without attempting consumption', async () => {
    const f = storage(), issued = await f.api.issue(f.client, assignment, input());
    vi.useFakeTimers(); vi.setSystemTime(Date.parse(issued.expiresAt));
    await expect(f.api.redeem(f.client, tokenOf(issued.link!))).rejects.toMatchObject({ status: 410 });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  });
  it('does not grant a session if the invitation expires while its consumption is in flight', async () => {
    const f = storage(), issued = await f.api.issue(f.client, assignment, input());
    vi.useFakeTimers(); f.state.beforePut = () => vi.setSystemTime(Date.parse(issued.expiresAt));
    await expect(f.api.redeem(f.client, tokenOf(issued.link!))).rejects.toMatchObject({ code: 'invitation-invalid', status: 410 });
    expect([...f.tasks.values()][0].status).toBe('completed');
  });
  it('rejects an invitation after its requesting staff authority is removed', async () => {
    const f = storage(), issued = await f.api.issue(f.client, assignment, input());
    await expect(invitations({ ...config, staff: [] }).redeem(f.client, tokenOf(issued.link!))).rejects.toMatchObject({ code: 'invitation-invalid', status: 410 });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  });
  it('CAS allows one winner when two redemptions read the unused Task', async () => {
    const f = storage(), issued = await f.api.issue(f.client, assignment, input());
    const results = await Promise.allSettled([f.api.redeem(f.client, tokenOf(issued.link!)), f.api.redeem(f.client, tokenOf(issued.link!))]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  });
  it('never grants a session or retries when consumption acknowledgement is lost', async () => {
    const f = storage(), issued = await f.api.issue(f.client, assignment, input()); f.state.losePutResponse = true;
    await expect(f.api.redeem(f.client, tokenOf(issued.link!))).rejects.toMatchObject({ code: 'invitation-redemption-unconfirmed', status: 503 });
    await expect(f.api.redeem(f.client, tokenOf(issued.link!))).rejects.toMatchObject({ code: 'invitation-invalid' });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
  });
  it.each(['code', 'for', 'owner', 'requester', 'input', 'identifier', 'meta'] as const)('rejects corrupted %s instead of trusting a search match', async field => {
    const f = storage(), issued = await f.api.issue(f.client, assignment, input());
    const stored = [...f.tasks.values()][0]; f.tasks.set(String(stored.id), { ...stored, [field]: field === 'input' ? [] : {} });
    // A malicious search result still has to match every identity and version field.
    f.state.substituteSearch = [...f.tasks.values()][0];
    await expect(f.api.redeem(f.client, tokenOf(issued.link!))).rejects.toMatchObject({ code: 'invitation-invalid' });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  });
  it('never logs capability material or provider exception messages', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const f = storage(), issued = await f.api.issue(f.client, assignment, input()), token = tokenOf(issued.link!);
    await f.api.redeem(f.client, token);
    expect(JSON.stringify(spies.flatMap(spy => spy.mock.calls))).not.toContain(token);
    expect(spies.every(spy => spy.mock.calls.length === 0)).toBe(true);
  });
  it('validates token format before any read and keeps lookup hash-only', async () => {
    const f = storage(); await expect(f.api.redeem(f.client, 'patient text')).rejects.toMatchObject({ status: 410 }); expect(f.fetcher).not.toHaveBeenCalled();
    await expect(f.api.redeem(f.client, 'a'.repeat(64))).rejects.toMatchObject({ status: 410 });
    const url = new URL(String(f.fetcher.mock.calls[0][0]));
    expect(url.searchParams.get('identifier')).toBe(`${INVITATION_TOKEN_SYSTEM}|${createHash('sha256').update('a'.repeat(64)).digest('hex')}`);
    expect(INVITATION_SYSTEM).not.toBe(INVITATION_TOKEN_SYSTEM);
  });
  it.each([
    { total: 2, entry: [] }, { total: 0, entry: [], link: [{ relation: 'next', url: 'https://not-followed.example' }] },
    { total: 1, entry: [] }, { total: -1, entry: [] }, { total: 0, entry: {} },
  ])('rejects incomplete or contradictory search results without following pages', async corruption => {
    const f = storage(); f.state.searchBundle = { resourceType: 'Bundle', type: 'searchset', ...corruption };
    await expect(f.api.redeem(f.client, 'a'.repeat(64))).rejects.toMatchObject({ code: 'invitation-storage-unavailable', status: 503 });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds an abort-ignoring storage read and never follows it with a write', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(() => new Promise<Response>(() => undefined));
    const client = new MedplumClient({ baseUrl: 'http://localhost/fhir/R4/', accessToken: 'test-only', timeoutMs: 10000, mode: 'local' }, fetcher);
    const pending = invitations(config).redeem(client, 'a'.repeat(64));
    const checked = expect(pending).rejects.toMatchObject({ code: 'invitation-storage-unavailable', status: 503 });
    await vi.advanceTimersByTimeAsync(3000); await checked;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
describe('trusted configured patient resolution', () => {
  it('uses the exact workflow fixture when it matches the patient', () => { expect(patientFixture(config, patient, 'first-intake')).toBe(fixture); });
  it('resolves an unambiguous configured patient across workflows and rejects unknown references', () => {
    expect(patientFixture(config, patient, 'pre-visit')).toBe(fixture);
    expect(() => patientFixture(config, 'Patient/not-configured', 'pre-visit')).toThrow('patient-scope-denied');
  });
  it('rejects ambiguous fallback mappings rather than selecting a different name or owner', () => {
    const ambiguous = { ...config, patients: { ...config.patients, refill: { ...fixture, displayName: 'Conflicting name' } } };
    expect(() => patientFixture(ambiguous, patient, 'pre-visit')).toThrow('patient-scope-denied');
  });
  it('retains legacy cookie mismatch rejection while allowing an explicit signed invitation scope', () => {
    const claims: PatientClaims = { kind: 'patient', patient, scenario: 'pre-visit', sessionId: crypto.randomUUID(), expires: Date.now() + 60000 };
    expect(() => requirePatientScope(config, claims)).toThrow('session-scope-denied');
    expect(() => requirePatientScope(config, { ...claims, invitationId: 'invite-1' })).not.toThrow();
    expect(() => requirePatientScope(config, { ...claims, invitationId: 'bad/reference' })).toThrow('session-scope-denied');
  });
  it('requires exact persisted invitation authority rather than just a known patient', () => {
    const claims = { kind: 'patient' as const, patient, scenario: 'pre-visit', sessionId: crypto.randomUUID(), expires: Date.now() + 60000, invitationId: 'invite-1' };
    const draft = { id: claims.sessionId, patient, scenario: 'pre-visit', invitationId: 'invite-1' } as Draft & { invitationId: string };
    expect(() => requireInvitationDraftScope(claims, draft)).not.toThrow();
    expect(() => requireInvitationDraftScope(claims, { ...draft, invitationId: 'invite-2' })).toThrow('session-scope-denied');
    expect(() => requireInvitationDraftScope({ ...claims, invitationId: undefined }, draft)).toThrow('session-scope-denied');
    expect(draftPatientFixture(config, draft)).toBe(fixture);
    expect(draftPatientFixture(config, { patient, scenario: 'pre-visit' })).toBe(config.patients['pre-visit']);
  });
});
