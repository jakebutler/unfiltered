/** Browser-safe clinic API views. Secrets, FHIR credentials and trusted assessments never cross this boundary. */
export type ScenarioId = 'first-intake' | 'pre-visit' | 'non-visit' | 'post-visit' | 'billing' | 'scheduling' | 'refill';
export type TopicStatus = 'not-started' | 'more-detail-needed' | 'ready-for-review' | 'stopped-with-gaps';
export type AnswerState = 'answered' | 'negative' | 'unknown' | 'declined' | 'uncertain' | 'not-asked' | 'conflicting';
export interface ClinicConfig {
  clinicName: string;
  syntheticOnly: true;
  scenarios: { id: ScenarioId; title: string; description: string }[];
  conversation: { mode: 'guided' | 'adaptive'; explanation?: string };
  voice: { available: boolean; explanation?: string };
}
export interface SourceTurn { id: string; role: 'patient' | 'assistant'; text: string; at: string; corrects?: string; }
export interface TopicView {
  id: string; title: string; status: TopicStatus; required: boolean;
  answer?: { text: string; state: AnswerState; sourceIds: string[] };
  missingDetails: string[];
  details?: { id: string; label: string; state: AnswerState; text?: string; sourceIds: string[]; editable?: boolean }[];
  screening?: {
    title: string; text: string; status: 'complete' | 'incomplete';
    scores: null | { gad2: number; phq2: number; phq4: number };
    furtherAssessmentRequested?: boolean;
    clinicianReviewRequired: true; clinicalClearance: false;
    timeframe?: string; contentVersion?: string;
  };
}
export interface PromptView {
  id: string; topicId: string; text: string; purpose?: string;
  choices?: { value: string; label: string }[];
  fields?: { id: string; label: string; kind: 'text' | 'number' | 'choice'; options?: { value: string; label: string }[]; required: boolean; hint?: string }[];
}
export interface DeliveryView {
  state: 'pending' | 'unknown' | 'incomplete' | 'received' | 'conflict';
  reference: string; version: number; receivedAt?: string;
  canRetryDelivery?: boolean;
  work: { id: string; revision: string; title: string; responsibility: 'medical' | 'nutrition' | 'administrative'; status: 'received' | 'reviewed' | 'needs-information' | 'declined' | 'resolved'; outcome?: string; author?: string; at?: string }[];
}
export interface ClinicSessionView {
  id: string; scenario: ScenarioId; title: string;
  persona: { displayName: string; description: string };
  phase: 'identity' | 'conversation' | 'review' | 'confirmed';
  revision: number; savedAt: string; completeness: 'partial' | 'complete';
  topics: TopicView[]; turns: SourceTurn[]; currentPrompt?: PromptView;
  delivery?: DeliveryView;
  /** The last confirmed submission remains visible while an amendment is still a draft. */
  previousDelivery?: DeliveryView;
  notice?: { tone: 'info' | 'attention' | 'urgent'; text: string };
}
export interface TurnInput {
  requestId: string; expectedRevision: number; promptId: string;
  action: 'answer' | 'unknown' | 'decline' | 'move-on';
  text?: string; fields?: Record<string, string>;
}
export interface ReviewPreview { session: ClinicSessionView; digest: string; confirmationText: string; }
export interface ApiError { error: { code: string; message: string; retryable: boolean }; }
export interface StaffIdentity { name: string; role: 'physician' | 'nurse-practitioner' | 'physician-assistant' | 'registered-dietitian' | 'administrative'; }
export interface StaffQueueItem {
  id: string; patientName: string; scenarioTitle: string; receivedAt?: string;
  completeness: 'complete' | 'partial'; status: 'received' | 'reviewed' | 'needs-information' | 'declined' | 'resolved';
  responsibility: 'medical' | 'nutrition' | 'administrative';
}
export interface StaffHandoffView {
  id: string; patientName: string; title: string; receivedAt?: string; version: number;
  completeness: 'partial' | 'complete'; topics: TopicView[]; sources: SourceTurn[];
  work: DeliveryView['work'];
  allowedActions: { workId: string; outcomes: ('reviewed' | 'needs-information' | 'declined' | 'resolved')[] }[];
}

/** Same-origin JSON API contract. All mutation calls require Origin verification and an HttpOnly session. */
export interface ClinicApiContract {
  'GET /api/clinic/config': { response: ClinicConfig };
  'POST /api/clinic/sessions': { body: { scenario: ScenarioId; syntheticAcknowledged: true }; response: ClinicSessionView };
  'GET /api/clinic/session': { response: ClinicSessionView };
  'POST /api/clinic/confirm-identity': { body: { confirmed: true }; response: ClinicSessionView };
  'POST /api/clinic/turns': { body: TurnInput; response: ClinicSessionView };
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
  'GET /api/staff/queue': { response: { items: StaffQueueItem[]; nextCursor?: string } };
  'GET /api/staff/handoffs/:id': { response: StaffHandoffView };
  'POST /api/staff/handoffs/:id/actions': { body: { workId: string; expectedVersion: number; expectedWorkVersion: string; outcome: 'reviewed' | 'needs-information' | 'declined' | 'resolved'; note: string }; response: StaffHandoffView };
}
