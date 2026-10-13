/** Browser-safe clinic API views. Secrets, FHIR credentials and trusted assessments never cross this boundary. */
export type ScenarioId = 'first-intake' | 'pre-visit' | 'non-visit' | 'post-visit' | 'billing' | 'scheduling' | 'refill';
export type TopicStatus = 'not-started' | 'more-detail-needed' | 'ready-for-review' | 'stopped-with-gaps';
export type AnswerState = 'answered' | 'negative' | 'unknown' | 'declined' | 'uncertain' | 'not-asked' | 'conflicting';
export const sourceChannels = ['text', 'confirmed-transcript', 'unreviewed-transcript'] as const;
export type SourceChannel = typeof sourceChannels[number];
export interface ClinicConfig {
  clinicName: string;
  syntheticOnly: true;
  scenarios: { id: ScenarioId; title: string; description: string }[];
  conversation: { mode: 'guided' | 'adaptive'; explanation?: string };
  voice: { available: boolean; explanation?: string; input?: 'stream' | 'upload'; output?: 'provider' | 'browser' };
}
/** Channel records how these original words entered the draft; summary confirmation never relabels it. */
export interface SourceTurn { id: string; role: 'patient' | 'assistant'; text: string; at: string; corrects?: string; channel?: SourceChannel; displayedPromptId?: string; }
export interface SourceSpan { sourceId: string; start: number; end: number; transform: string; role?: 'value' | 'support'; evidenceProtocol?: 'contextual-values-v5'; }
export interface AdaptiveOperationView {
  id: string; requestId: string; sourceId: string;
  status: 'accepted' | 'processing' | 'applied' | 'failed' | 'unresolved' | 'discarded';
  acceptedAt: string; updatedAt: string; message?: string;
  updates?: { topicId: string; path: string }[];
  hasUnresolvedInterpretation?: boolean;
  stream?: { reply: 'pending' | 'saved' | 'withheld'; capture: 'pending' | 'saved' | 'partial' | 'discarded' };
  queuedAfter?: string;
  queuedWaiting?: boolean;
}
export interface AdaptiveSessionView {
  available: boolean; mode: 'adaptive' | 'guided'; operation?: AdaptiveOperationView;
  reply?: { id: string; text: string }; guidedFallbackAvailable: true;
  unresolvedSources?: { sourceId: string; reason: string }[];
}
export interface AdaptiveTurnInput { requestId: string; expectedRevision: number; text: string; channel: SourceChannel; }
export interface AdaptiveTurnResult { session: ClinicSessionView; operation: AdaptiveOperationView; }
export interface TopicView {
  id: string; title: string; status: TopicStatus; required: boolean;
  /** Why the conversation stopped on this topic (e.g. the patient preferred not to discuss it). Never inferred from affect. */
  stopReason?: 'patient-declines' | 'patient-moves-on' | 'not-applicable' | 'resistance-after-purpose' | 'safety-interruption';
  answer?: { text: string; state: AnswerState; sourceIds: string[] };
  missingDetails: string[];
  /** Interpreter limitations, never patient-reported uncertainty or a clinical conclusion. */
  interpretationGaps?: { id: string; reason: 'ambiguous' | 'unsupported-target' | 'capacity' | 'conflict' | 'ownership' | 'invalid-type' | 'unsupported-state' | 'unsupported-unknown' | 'value-not-in-source' | 'temporal-crop' | 'recognition-unreviewed' | 'unaddressed-source'; evidence: Omit<SourceSpan, 'transform'>[] }[];
  details?: { id: string; label: string; state: AnswerState; text?: string; sourceIds: string[]; editable?: boolean; provenance?: SourceSpan[]; interpretation?: { qualified: boolean; status: 'proposed' | 'conflicting' };
    /** Answer specificity (SP-0.1): detail still missing, and a reference code attached only to an exact, authored-synonym or patient-confirmed name. */
    specificity?: { needsDetail?: string; settled?: 'will-provide' | 'unknown' | 'declined'; code?: { system: string; code: string; display: string; basis: 'exact' | 'synonym' | 'patient-confirmed' } } }[];
  screening?: {
    title: string; text: string; status: 'complete' | 'incomplete';
    scores: null | { gad2: number; phq2: number; phq4: number };
    furtherAssessmentRequested?: boolean;
    clinicianReviewRequired: true; clinicalClearance: false;
    timeframe?: string; contentVersion?: string; completedAt?: string;
  };
}
export interface PromptView {
  id: string; topicId: string; text: string; purpose?: string;
  mode?: 'adaptive' | 'guided';
  choices?: { value: string; label: string }[];
  fields?: { id: string; label: string; kind: 'text' | 'number' | 'choice'; options?: { value: string; label: string }[]; required: boolean; hint?: string }[];
}
export interface DeliveryView {
  state: 'pending' | 'unknown' | 'incomplete' | 'received' | 'conflict';
  reference: string; version: number; receivedAt?: string;
  canRetryDelivery?: boolean;
  work: { id: string; revision: string; title: string; responsibility: 'medical' | 'nutrition' | 'administrative'; status: 'pending' | 'external-change' | 'received' | 'reviewed' | 'needs-information' | 'declined' | 'resolved'; delivery?: 'pending' | 'verified' | 'unknown' | 'conflict'; history?: { actionId: string; fingerprint: string; outcome: string; author: string; at: string; note: string }[]; outcome?: string; author?: string; at?: string }[];
}
export interface ClinicSessionView {
  id: string; scenario: ScenarioId; title: string;
  persona: { displayName: string; description: string };
  phase: 'identity' | 'conversation' | 'review' | 'confirmed';
  revision: number; savedAt: string; completeness: 'partial' | 'complete';
  topics: TopicView[]; turns: SourceTurn[]; currentPrompt?: PromptView;
  /** Tier-1 safety signals still awaiting a background tier-2 review; the browser requests each one. */
  safetyReview?: { pendingSignalIds: string[] };
  /** Opaque server scope of authored answers/control state, excluding provisional projections. */
  speechScopeDigest?: string;
  delivery?: DeliveryView;
  /** The last confirmed submission remains visible while an amendment is still a draft. */
  previousDelivery?: DeliveryView;
  notice?: { tone: 'info' | 'attention' | 'urgent'; text: string };
  adaptive?: AdaptiveSessionView;
}
export interface TurnInput {
  requestId: string; expectedRevision: number; promptId: string;
  action: 'answer' | 'unknown' | 'decline' | 'move-on';
  text?: string; fields?: Record<string, string>;
  channel?: SourceChannel;
  /** An explicit confirmation of the choice for this exact displayed prompt/revision. */
  choiceConfirmation?: { optionTranscript: string; confirmationTranscript: string; confirmationMethod: 'voice' | 'control' };
  /** Retain recognized choice-attempt words without interpreting or filling any answer. */
  choiceTranscriptOnly?: true;
  /** Separate initial words when a confirmation attempt remains unscored. */
  priorChoiceTranscript?: string;
}

/** A current, server-resolved utterance; it is never caller-supplied provider text. */
export function conversationSpeech(view: Pick<ClinicSessionView, 'currentPrompt' | 'adaptive'>): { id: string; text: string } | undefined {
  const prompt = view.currentPrompt, reply = view.adaptive?.reply;
  if (prompt?.choices?.length) return { id: prompt.id, text: `${prompt.text}\n${prompt.choices.map(choice => choice.label).join('. ')}.` };
  if (reply && prompt) return { id: 'conversation-current', text: `${reply.text}\n\n${prompt.text}` };
  return reply ?? (prompt ? { id: prompt.id, text: prompt.text } : undefined);
}
export interface ReviewPreview { session: ClinicSessionView; digest: string; confirmationText: string; }
export interface ApiError { error: { code: string; message: string; retryable: boolean }; }
export interface StaffIdentity { name: string; role: 'physician' | 'nurse-practitioner' | 'physician-assistant' | 'registered-dietitian' | 'administrative'; }
export interface StaffQueueItem {
  id: string; patientName: string; scenarioTitle: string; receivedAt?: string;
  completeness?: 'complete' | 'partial'; status: 'received' | 'reviewed' | 'needs-information' | 'declined' | 'resolved';
  responsibility: 'medical' | 'nutrition' | 'administrative';
}
export interface StaffHandoffView {
  id: string; patientName: string; title: string; receivedAt?: string; version: number;
  completeness?: 'partial' | 'complete'; topics: TopicView[]; sources: SourceTurn[];
  deliveryState?: DeliveryView['state']; anchorsVerified?: boolean; canResume?: boolean;
  work: DeliveryView['work'];
  allowedActions: { workId: string; outcomes: ('reviewed' | 'needs-information' | 'declined' | 'resolved')[] }[];
}

export interface StaffRecoveryItem { id: string; patientName: string; scenarioTitle: string; deliveryState: DeliveryView['state']; anchorsVerified: boolean; canResume: boolean; }

/** Same-origin JSON API contract. All mutation calls require Origin verification and an HttpOnly session. */
export interface ClinicApiContract {
  'GET /api/clinic/config': { response: ClinicConfig };
  'POST /api/clinic/sessions': { body: { scenario: ScenarioId; syntheticAcknowledged: true }; response: ClinicSessionView };
  'GET /api/clinic/session': { response: ClinicSessionView };
  'POST /api/clinic/confirm-identity': { body: { confirmed: true }; response: ClinicSessionView };
  'POST /api/clinic/turns': { body: TurnInput; response: ClinicSessionView };
  'POST /api/clinic/adaptive-turns': { body: AdaptiveTurnInput; response: AdaptiveTurnResult };
  'GET /api/clinic/adaptive-turns/:operationId': { response: AdaptiveTurnResult };
  'POST /api/clinic/adaptive-turns/:operationId/interpret': { body: Record<string, never>; response: AdaptiveTurnResult };
  'POST /api/clinic/adaptive-turns/:operationId/discard': { body: { expectedRevision: number }; response: AdaptiveTurnResult };
  'POST /api/clinic/conversation-mode': { body: { expectedRevision: number; mode: 'adaptive' | 'guided' }; response: ClinicSessionView };
  'POST /api/clinic/topics': { body: { expectedRevision: number; topicId: string; slotPath?: string }; response: ClinicSessionView };
  'POST /api/clinic/review': { body: { expectedRevision: number }; response: ReviewPreview };
  'POST /api/clinic/confirm': { body: { expectedRevision: number; digest: string }; response: ClinicSessionView };
  'GET /api/clinic/receipt': { response: ClinicSessionView };
  'POST /api/clinic/retry-delivery': { body: Record<string, never>; response: ClinicSessionView };
  'POST /api/clinic/leave': { body: Record<string, never>; response: { savedAt: string } };
  'POST /api/clinic/reject-identity': { body: Record<string, never>; response: { cleared: true } };
  'POST /api/staff/login': { body: { email: string; password: string }; response: StaffIdentity };
  'GET /api/staff/me': { response: StaffIdentity };
  'POST /api/staff/logout': { body: Record<string, never>; response: { loggedOut: true } };
  'GET /api/staff/queue': { response: { items: StaffQueueItem[]; recovery: StaffRecoveryItem[]; nextCursor?: string; recoveryCursor?: string } };
  'GET /api/staff/handoffs/:id': { response: StaffHandoffView };
  'POST /api/staff/handoffs/:id/resume': { body: Record<string, never>; response: StaffHandoffView };
  'POST /api/staff/handoffs/:id/actions': { body: { actionId: string; workId: string; expectedVersion: number; expectedWorkVersion: string; outcome: 'reviewed' | 'needs-information' | 'declined' | 'resolved'; note: string }; response: StaffHandoffView };
}

/** Clinician-only safety review queue (tier-2 outcomes that need a human). */
export type SafetyCategoryView = 'self-harm' | 'medical-urgent' | 'medication-substance' | 'eating' | 'abuse-safety' | 'mental-distress';
export type SafetyLevelView = 'none' | 'low' | 'moderate' | 'high' | 'imminent';
export interface StaffSafetyItem { sessionId: string; patientName: string; scenario: string; open: number; highestLevel: SafetyLevelView; categories: SafetyCategoryView[]; flaggedAt: string; escalated: boolean; }
export interface StaffSafetyReview {
  signalId: string; sourceId: string; screened: SafetyCategoryView[]; status: 'cleared' | 'needs-human-review'; level: SafetyLevelView; concern: boolean;
  categories: SafetyCategoryView[]; rationale: string; reviewer: string; reviewedAt: string; failure?: string; escalated?: string;
  open: boolean; message?: string; question?: string; messageAt?: string;
}
export interface StaffSafetyAction { actionId: string; signalId?: string; outcome: 'no-concern' | 'contacted-patient' | 'escalated'; note: string; by: string; role: string; at: string; }
export interface StaffSafetyView { sessionId: string; patientName: string; scenario: string; reviews: StaffSafetyReview[]; actions: StaffSafetyAction[]; }
