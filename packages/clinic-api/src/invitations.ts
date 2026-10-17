import { createHash, randomBytes } from 'node:crypto';
import { scenarioIds, scenarioTitles } from '../../clinic-content/src/workflows.js';
import type { ScenarioId } from '../../clinic-contract/src/index.js';
import type { InvitationOptionsView } from '../../clinic-contract/src/invitations.js';
import type { FhirResource } from '../../clinical-core/src/fhir.js';
import { MedplumClient } from '../../clinical-core/src/medplum.js';
import { TransportError } from '../../clinical-core/src/transport.js';
import { ApiFailure, type ClinicApiConfig, type StaffAssignment } from './types.js';
import { patientFixture } from './patient-fixture.js';

export const INVITATION_SYSTEM = 'urn:corvo:clinic:invitation';
export const INVITATION_TOKEN_SYSTEM = 'urn:corvo:clinic:invitation-token';
const WORK_KIND = 'urn:corvo:clinical:work-kind';
const INPUT_KIND = 'urn:corvo:clinic:invitation-input';
const LIFETIME = 72 * 60 * 60 * 1000;
const STORAGE_TIMEOUT_MS = 3000;
const opaque = /^[A-Za-z0-9.-]{1,64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const fail = (): never => { throw new ApiFailure('invitation-invalid', 410); };
export interface InvitationRequest { patient: string; scenario: ScenarioId; requestId: string; }
export interface InvitationReceipt { invitationId: string; expiresAt: string; link?: string; }
interface StoredInvitation { task: FhirResource; id: string; requestId: string; patient: string; scenario: ScenarioId; owner: string; requester: string; hash: string; expiresAt: string; version: string; }

async function boundedRequest(client: MedplumClient, path: string, method = 'GET', body?: unknown, headers?: Record<string, string>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ApiFailure('invitation-storage-unavailable', 503)), STORAGE_TIMEOUT_MS); });
  try { return await Promise.race([client.request(path, method, body, headers, { timeoutMs: STORAGE_TIMEOUT_MS }), deadline]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

/** The authenticated assignment and native named client must come from staffAuthentication.read. */
export function invitations(config: ClinicApiConfig) {
  function owner(assignment: StaffAssignment, patient: string, scenario: ScenarioId) {
    let fixture;
    try { fixture = patientFixture(config, patient, scenario); } catch { throw new ApiFailure('invitation-forbidden', 403); }
    const responsibility = assignment.role === 'administrative' ? 'administrative' : assignment.role === 'registered-dietitian' ? 'nutrition' : ['physician', 'physician-assistant', 'nurse-practitioner'].includes(assignment.role) ? 'medical' : undefined;
    const team = responsibility && fixture?.careTeams[responsibility];
    if (!responsibility || !assignment.patients.includes(patient) || !team || !/^CareTeam\/[A-Za-z0-9.-]{1,64}$/.test(team) || !assignment.careTeams.includes(team) || !/^Practitioner\/[A-Za-z0-9.-]{1,64}$/.test(assignment.profile)) throw new ApiFailure('invitation-forbidden', 403);
    return team;
  }
  function read(task: FhirResource): StoredInvitation {
    const identifiers = task.identifier;
    if (task.resourceType !== 'Task' || typeof task.id !== 'string' || !opaque.test(task.id) || !Array.isArray(identifiers) || identifiers.length !== 2) return fail();
    const identifier = (system: string) => {
      const rows = identifiers.filter(row => object(row).system === system);
      if (rows.length !== 1 || Object.keys(object(rows[0])).sort().join(',') !== 'system,value' || typeof object(rows[0]).value !== 'string') return fail();
      return object(rows[0]).value as string;
    };
    const requestId = identifier(INVITATION_SYSTEM), hash = identifier(INVITATION_TOKEN_SYSTEM);
    const coding = object(task.code).coding;
    if (!uuid.test(requestId) || !/^[a-f0-9]{64}$/.test(hash) || !Array.isArray(coding) || coding.length !== 1 || object(coding[0]).system !== WORK_KIND || object(coding[0]).code !== 'invitation' || task.intent !== 'order' || !['requested', 'completed'].includes(String(task.status))) return fail();
    const inputs = task.input;
    if (!Array.isArray(inputs) || inputs.length !== 3) return fail();
    const value = (name: string) => {
      const matching = inputs.filter(row => {
        const codes = object(object(row).type).coding;
        return Array.isArray(codes) && codes.length === 1 && object(codes[0]).system === INPUT_KIND && object(codes[0]).code === name;
      });
      if (matching.length !== 1 || Object.keys(object(matching[0])).sort().join(',') !== 'type,valueString' || typeof object(matching[0]).valueString !== 'string') return fail();
      return object(matching[0]).valueString as string;
    };
    const scenario = value('scenario') as ScenarioId, expiresAt = value('expiresAt');
    const authoredOn = task.authoredOn, version = object(task.meta).versionId;
    const patient = object(task.for).reference, requester = object(task.requester).reference, team = object(task.owner).reference;
    if (!(scenarioIds as readonly string[]).includes(scenario) || value('tokenHash') !== hash || typeof patient !== 'string' || typeof requester !== 'string' || typeof team !== 'string' || typeof authoredOn !== 'string' || !Number.isFinite(Date.parse(authoredOn)) || !Number.isFinite(Date.parse(expiresAt)) || new Date(expiresAt).toISOString() !== expiresAt || Date.parse(expiresAt) - Date.parse(authoredOn) !== LIFETIME || typeof version !== 'string' || !opaque.test(version)) return fail();
    const assignment = config.staff.find(row => row.profile === requester);
    if (!assignment) return fail();
    try { if (owner(assignment, patient, scenario) !== team) return fail(); } catch { return fail(); }
    return { task, id: task.id, requestId, patient, scenario, owner: team, requester, hash, expiresAt, version };
  }
  const receipt = (stored: StoredInvitation): InvitationReceipt => ({ invitationId: stored.id, expiresAt: stored.expiresAt });
  function bound(stored: StoredInvitation, input: InvitationRequest, assignment: StaffAssignment, team: string) {
    if (stored.requestId !== input.requestId || stored.patient !== input.patient || stored.scenario !== input.scenario || stored.requester !== assignment.profile || stored.owner !== team) throw new ApiFailure('invitation-request-conflict', 409);
    return stored;
  }
  async function lookup(client: MedplumClient, system: string, value: string) {
    try {
      // MedplumClient.findByIdentifier is reserved for handoff-component identifiers.
      const result = await boundedRequest(client, `Task?${new URLSearchParams({ identifier: `${system}|${value}`, _count: '2' })}`);
      const bundle = object(result.body), entries = bundle.entry ?? [];
      if (bundle.resourceType !== 'Bundle' || bundle.type !== 'searchset' || !Array.isArray(entries) || entries.length > 1 || bundle.total !== undefined && bundle.total !== entries.length || bundle.link !== undefined && (!Array.isArray(bundle.link) || bundle.link.some(link => object(link).relation === 'next'))) throw new Error('invalid-search');
      if (!entries.length) return undefined;
      const task = object(object(entries[0]).resource);
      if (task.resourceType !== 'Task' || typeof task.id !== 'string' || !opaque.test(task.id)) throw new Error('invalid-search');
      return task as FhirResource;
    } catch { throw new ApiFailure('invitation-storage-unavailable', 503); }
  }
  return {
    options(assignment: StaffAssignment): InvitationOptionsView {
      const patients: InvitationOptionsView['patients'] = [];
      for (const reference of [...new Set(assignment.patients)]) {
        const scenarios = scenarioIds.filter(scenario => { try { owner(assignment, reference, scenario); return true; } catch { return false; } });
        if (scenarios.length) patients.push({ reference, displayName: patientFixture(config, reference, scenarios[0]).displayName, scenarios });
      }
      return { patients, workflows: scenarioIds.map(id => ({ id, title: scenarioTitles[id] })) };
    },
    async issue(client: MedplumClient, assignment: StaffAssignment, input: InvitationRequest): Promise<InvitationReceipt> {
      if (!uuid.test(input.requestId) || !(scenarioIds as readonly string[]).includes(input.scenario) || !/^Patient\/[A-Za-z0-9.-]{1,64}$/.test(input.patient)) throw new ApiFailure('invalid-invitation-request');
      const team = owner(assignment, input.patient, input.scenario);
      const existing = await lookup(client, INVITATION_SYSTEM, input.requestId);
      if (existing) return receipt(bound(read(existing), input, assignment, team));
      const token = randomBytes(32).toString('hex'), hash = hashToken(token);
      const authoredOn = new Date().toISOString(), expiresAt = new Date(Date.parse(authoredOn) + LIFETIME).toISOString();
      const resource: FhirResource = { resourceType: 'Task', identifier: [{ system: INVITATION_SYSTEM, value: input.requestId }, { system: INVITATION_TOKEN_SYSTEM, value: hash }], status: 'requested', intent: 'order', code: { coding: [{ system: WORK_KIND, code: 'invitation' }] }, for: { reference: input.patient }, owner: { reference: team }, requester: { reference: assignment.profile }, authoredOn, input: Object.entries({ scenario: input.scenario, tokenHash: hash, expiresAt }).map(([code, valueString]) => ({ type: { coding: [{ system: INPUT_KIND, code }] }, valueString })) };
      let created;
      try { created = await boundedRequest(client, 'Task', 'POST', resource, { 'If-None-Exist': new URLSearchParams({ identifier: `${INVITATION_SYSTEM}|${input.requestId}` }).toString() }); }
      catch (error) {
        if (error instanceof TransportError && error.code === 'http' && [400, 401, 403, 422].includes(error.status ?? 0)) throw new ApiFailure('invitation-write-denied', error.status === 403 ? 403 : 503);
        // One read can recover a receipt, never the capability after an uncertain write.
        const recovered = await lookup(client, INVITATION_SYSTEM, input.requestId);
        if (recovered) return receipt(bound(read(recovered), input, assignment, team));
        throw new ApiFailure('invitation-outcome-unknown', 503);
      }
      const winner = bound(read(object(created.body) as FhirResource), input, assignment, team);
      const readable = await lookup(client, INVITATION_SYSTEM, input.requestId);
      if (!readable) throw new ApiFailure('invitation-outcome-unknown', 503);
      const persisted = bound(read(readable), input, assignment, team);
      if (persisted.id !== winner.id || persisted.hash !== winner.hash) throw new ApiFailure('invitation-request-conflict', 409);
      const result = receipt(persisted);
      if (created.status === 201 && persisted.hash === hash && persisted.task.status === 'requested') {
        const link = new URL('/join', config.origin); link.hash = new URLSearchParams({ token }).toString();
        result.link = link.href;
      }
      return result;
    },
    async redeem(client: MedplumClient, token: string): Promise<{ invitationId: string; patient: string; scenario: ScenarioId; expiresAt: string }> {
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return fail();
      const hash = hashToken(token), task = await lookup(client, INVITATION_TOKEN_SYSTEM, hash);
      if (!task) return fail();
      const stored = read(task);
      if (stored.hash !== hash || stored.task.status !== 'requested' || Date.parse(stored.expiresAt) <= Date.now() || Date.parse(String(stored.task.authoredOn)) > Date.now()) return fail();
      let response;
      try { response = await boundedRequest(client, `Task/${stored.id}`, 'PUT', { ...stored.task, status: 'completed' }, { 'If-Match': `W/"${stored.version}"` }); }
      catch (error) {
        if (error instanceof TransportError && error.code === 'http' && [404, 409, 412].includes(error.status ?? 0)) return fail();
        // The CAS may have completed. Never retry or grant a cookie on that uncertainty.
        throw new ApiFailure('invitation-redemption-unconfirmed', 503);
      }
      const consumed = read(object(response.body) as FhirResource);
      if (response.status !== 200 || consumed.id !== stored.id || consumed.version === stored.version || consumed.hash !== stored.hash || consumed.requestId !== stored.requestId || consumed.patient !== stored.patient || consumed.scenario !== stored.scenario || consumed.owner !== stored.owner || consumed.requester !== stored.requester || consumed.expiresAt !== stored.expiresAt || consumed.task.status !== 'completed') throw new ApiFailure('invitation-redemption-unconfirmed', 503);
      if (Date.parse(stored.expiresAt) <= Date.now()) return fail();
      return { invitationId: stored.id, patient: stored.patient, scenario: stored.scenario, expiresAt: stored.expiresAt };
    },
  };
}
