import { canonicalJson } from '../../clinical-core/src/domain.js';
import type { ScenarioId } from '../../clinic-contract/src/index.js';
import { ApiFailure, type ClinicApiConfig, type PatientFixture, type Draft } from './types.js';
import type { PatientClaims } from './cookies.js';

/** Resolve only server-configured patients. A workflow never supplies patient identity. */
export function patientFixture(config: ClinicApiConfig, patient: string, scenario: ScenarioId): PatientFixture {
  const preferred = config.patients[scenario];
  if (preferred?.reference === patient) return preferred;
  const matches = Object.values(config.patients).filter(fixture => fixture.reference === patient);
  if (!matches.length || matches.some(fixture => canonicalJson(fixture) !== canonicalJson(matches[0]))) throw new ApiFailure('patient-scope-denied', 403);
  return matches[0];
}

/** Legacy drafts retain their existing scenario fixture semantics. Invitation identity is explicit. */
export function draftPatientFixture(config: ClinicApiConfig, draft: Pick<Draft, 'patient' | 'scenario'> & { invitationId?: string }): PatientFixture {
  if (draft.invitationId !== undefined) {
    if (typeof draft.invitationId !== 'string' || !/^[A-Za-z0-9.-]{1,64}$/.test(draft.invitationId)) throw new ApiFailure('session-scope-denied', 403);
    return patientFixture(config, draft.patient, draft.scenario);
  }
  const fixture = config.patients[draft.scenario];
  if (!fixture) throw new ApiFailure('session-scope-denied', 403);
  return fixture;
}

/** Only a server-signed invitation marker permits a configured patient to use another workflow. */
export function requirePatientScope(config: ClinicApiConfig, claims: PatientClaims & { invitationId?: string }): void {
  if (!Object.hasOwn(config.patients, claims.scenario)) throw new ApiFailure('session-scope-denied', 403);
  if (claims.invitationId !== undefined) {
    draftPatientFixture(config, { patient: claims.patient, scenario: claims.scenario as ScenarioId, invitationId: claims.invitationId });
  } else if (config.patients[claims.scenario as ScenarioId].reference !== claims.patient) throw new ApiFailure('session-scope-denied', 403);
}

export function requireInvitationDraftScope(claims: PatientClaims & { invitationId?: string }, draft: Draft & { invitationId?: string }): void {
  if (draft.id !== claims.sessionId || draft.patient !== claims.patient || draft.scenario !== claims.scenario || draft.invitationId !== claims.invitationId) throw new ApiFailure('session-scope-denied', 403);
}
