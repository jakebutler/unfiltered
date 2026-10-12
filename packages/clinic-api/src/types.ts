import type { StaffRole, ConfirmedSubmission } from '../../clinical-core/src/domain.js';
import type { ScenarioId, ClinicSessionView, SourceTurn, DeliveryView } from '../../clinic-contract/src/index.js';
import type { TopicResponse } from '../../clinic-content/src/types.js';
import type { AdaptiveBinding, AdaptiveClarification, AdaptiveOutcome, AdaptiveProvenance, AdaptiveUpdate, DisplayedPrompt, DialogueState, EvidenceSpan } from './adaptive-validation.js';
import type { AdaptiveProposalReceipt } from './adaptive.js';
import type { DialogueOutcome } from './dialogue.js';
import type { ProvisionalCapture } from './provisional-draft.js';
import type { DigitalOceanStreamReceipt } from '../../clinical-core/src/digitalocean-stream.js';
export interface AdaptiveStreamState {
    protocol: 'durable-provisional-stream-v1';
    reply: 'pending' | 'saved' | 'withheld';
    capture: 'pending' | 'saved' | 'partial' | 'discarded';
    targetGenerations: Record<string, number>;
    replyId?: string;
    replyScope?: { revision: number; sha256: string };
    /** Navigation-only prefix audit; never projected as a clinical answer. */
    navigation?: ProvisionalCapture;
    provisional?: ProvisionalCapture;
    receipt?: DigitalOceanStreamReceipt;
    /** Frozen source-first reports/held detail; descriptive only, never projected as answers. */
    sourceInterpretation?: import('./adaptive-extraction-focused.js').SourceFirstInventory;
}
export type AdaptiveRawProposalAudit = {
    representation: 'canonical-json-v1' | 'raw-proposal-string-v1';
} & ({ retention: 'retained'; bytes: number; sha256: string; content: string }
    | { retention: 'oversize' | 'session-capacity'; bytes: number; sha256: string }
    | { retention: 'unserializable' });
export interface AdaptiveOperation {
    id: string;
    requestId: string;
    sourceId: string;
    fingerprint: string;
    status: 'accepted' | 'processing' | 'applied' | 'failed' | 'unresolved' | 'discarded';
    acceptedAt: string;
    updatedAt: string;
    binding: AdaptiveBinding;
    displayed?: DisplayedPrompt;
    dialogue?: DialogueState;
    attemptId?: string;
    processingRevision?: number;
    deadlineAt?: string;
    resultDigest?: string;
    receipt?: AdaptiveProposalReceipt;
    rawProposalAudit?: AdaptiveRawProposalAudit;
    errorCode?: string;
    updates?: AdaptiveUpdate[];
    provenance?: AdaptiveProvenance[];
    clarifications?: AdaptiveClarification[];
    coveredCandidates?: AdaptiveOutcome['coveredCandidates'];
    unresolvedQuestions?: EvidenceSpan[];
    unmapped?: AdaptiveOutcome['unmapped'];
    /** intake-interpreter-v1 audit of rejected model candidates; never patient-facing. */
    rejectedCandidates?: AdaptiveOutcome['rejectedCandidates'];
    hasUnresolvedInterpretation?: boolean;
    stream?: AdaptiveStreamState;
    queuedAfter?: string;
    queuedWaiting?: boolean;
}
export interface PatientFixture {
    reference: string;
    displayName: string;
    description: string;
    careTeams: Record<'medical' | 'nutrition' | 'administrative', string>;
    context?: string;
    /** Trusted server-loaded record context; never accepted from browser/provider requests. */
    nativeContext?: import('../../clinic-content/src/native-questionnaire.js').NativeRoutingContext;
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
    nativeQuestionnaire?: import('../../clinic-content/src/native-questionnaire.js').NativeBinding & { reference: string };
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
    questionnaireHistory?: import('../../clinic-content/src/native-questionnaire.js').NativeInactiveAnswer[];
    safety?: {
        rule: import('./safety.js').EscalationRule;
        version: 'E-0.1' | 'E-0.2';
        sourceId: string;
        text: string;
        at: string;
        paused: boolean;
        /** Set when the model gate (not the deterministic floor) found high or imminent risk. */
        via?: 'model-review';
    };
    /** Tier-1 screen hits and scoped floor hits. Each gets one model review, normally on the same turn; terminal outcomes are copied in. */
    safetySignals?: Array<{
        id: string;
        sourceId: string;
        categories: import('./safety-screen.js').SafetyCategory[];
        terms: string[];
        at: string;
        /** S1-0.x: liberal screen or scoped floor hit; safety-gate-v1: a concern the model gate found on an unflagged turn. */
        version: 'S1-0.1' | 'S1-0.2' | 'safety-gate-v1';
        /** Hard-stop wording the floor downgraded (negated, someone else's, historical, hypothetical, question, media). */
        floor?: { rule: import('./safety.js').EscalationRule; scope: Exclude<import('./safety.js').SafetyScope, 'direct'> }[];
        review?: { status: 'cleared' | 'needs-human-review'; level: 'none' | 'low' | 'moderate' | 'high' | 'imminent' };
    }>;
    /** Fail-safe: the model gate could not decide on an urgent flag, so authored help copy is shown without pausing. */
    safetyBanner?: { rule: import('./safety.js').EscalationRule; sourceId: string; at: string };
    topics: Record<string, TopicResponse>;
    requests: Record<string, {
        fingerprint: string;
        revision: number;
        operationId?: string;
    }>;
    adaptive?: {
        mode: 'adaptive' | 'guided';
        operations: Record<string, AdaptiveOperation>;
        activeOperationId?: string;
        exchange?: DialogueOutcome;
        /** Direct edits only; source interpretation cannot increment or reset these. */
        targetGenerations?: Record<string, number>;
        /** Topics whose guided fallback question was already shown twice; skipped until the patient picks them. */
        parkedTopicIds?: string[];
    };
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
