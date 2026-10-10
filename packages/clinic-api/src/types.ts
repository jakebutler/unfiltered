import type { StaffRole, ConfirmedSubmission } from '../../clinical-core/src/domain.js';
import type { ScenarioId, ClinicSessionView, SourceTurn, DeliveryView } from '../../clinic-contract/src/index.js';
import type { TopicResponse } from '../../clinic-content/src/types.js';
export interface PatientFixture {
    reference: string;
    displayName: string;
    description: string;
    careTeams: Record<'medical' | 'nutrition' | 'administrative', string>;
    context?: string;
}
export interface StaffAssignment {
    membershipId: string;
    profile: string;
    policy: string;
    name: string;
    role: StaffRole;
    patients: string[];
    careTeams: string[];
}
export interface ClinicApiConfig {
    origin: string;
    medplumBaseUrl: string;
    projectId: string;
    clientId: string;
    clientSecret: string;
    cookieSecret: string;
    patients: Record<ScenarioId, PatientFixture>;
    staff: StaffAssignment[];
    mentalHealth: 'pending' | 'phq4' | 'unscored';
}
export interface Draft {
    schema: 1;
    id: string;
    patient: string;
    scenario: ScenarioId;
    revision: number;
    savedAt: string;
    createdAt: string;
    phase: ClinicSessionView['phase'];
    activeTopic?: string;
    turns: SourceTurn[];
    activeSlot?: string;
    relevantTopicIds?: string[];
    safety?: {
        rule: import('./safety.js').EscalationRule;
        version: 'E-0.1';
        sourceId: string;
        text: string;
        at: string;
        paused: boolean;
    };
    topics: Record<string, TopicResponse>;
    requests: Record<string, {
        fingerprint: string;
        revision: number;
    }>;
    version: number;
    preview?: {
        digest: string;
        confirmation: ConfirmedSubmission;
        topics: ClinicSessionView['topics'];
    };
    confirmed?: {
        digest: string;
        /** Digest the patient reviewed; final digest also binds actual confirmation time. */
        previewDigest?: string;
        confirmation: ConfirmedSubmission;
        topics: ClinicSessionView['topics'];
        receivedAt?: string;
    };
    prior?: {
        version: number;
        digest: string;
    };
    previousDelivery?: DeliveryView;
    delivery?: DeliveryView;
    notice?: ClinicSessionView['notice'];
}
export interface StoredDraft {
    resource: import('../../clinical-core/src/fhir.js').FhirResource;
    draft: Draft;
    versionId: string;
}
export class ApiFailure extends Error {
    constructor(public readonly code: string, public readonly status = 400, public readonly retryable = false) { super(code); this.name = 'ApiFailure'; }
}
