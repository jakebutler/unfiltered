import type { StudyReadinessScope } from './readiness';
export type CaptureExpectation = { screen: boolean; controlledDom: boolean; alternatePath: string };
export const CONSENT_CHOICES = Object.freeze([
  { id: 'storage', required: true, checked: false, label: 'I agree to Corvo Labs storing my interview answers and corrections until the displayed retention deadline.' },
  { id: 'analysis', required: true, checked: false, label: 'I agree to Corvo Labs analyzing these answers for this study, including analysis assisted by AI when enabled.' },
  { id: 'shareTranscript', required: false, checked: false, label: 'Corvo Labs may share my transcript with the study’s client when it publishes selected research material.' },
  { id: 'retainApprovedExcerpts', required: false, checked: false, label: 'Corvo Labs may retain approved excerpts in a published report for 90 days after publication, even after the original transcript expires.' },
] as const);
export type StudyWelcome = {
  scope: StudyReadinessScope;
  title: string; introduction: string; prototypeUrl: string | null;
  context: { organization: 'Corvo Labs'; clientName: string; operatorName: string };
  purpose: 'participant' | 'readiness-test';
  consentVersion: 'research-consent-1';
  choices: Array<{ id: string; required: boolean; checked: false; label: string }>;
  capture: { screen: 'optional' | 'expected'; controlledDom: 'optional' | 'expected'; camera: 'optional'; alternatePath: string };
  fallback: string;
  deviceNotice: string;
  lifecycle: { invitationDays: 7; retentionDays: 30; expiresAt: number | null; retainUntil: number | null };
};
/** One descriptor supplies preview and participant wording; constructing it has no side effects. */
export function studyWelcome(input: { scope: StudyReadinessScope; title: string; introduction: string; prototypeUrl: string | null; clientName: string; operatorName: string; captureExpectation?: CaptureExpectation; purpose?: 'readiness-test'; expiresAt?: number; retainUntil?: number }): StudyWelcome {
  const expected = input.captureExpectation;
  return { scope: input.scope, title: input.title, introduction: input.introduction, prototypeUrl: input.prototypeUrl,
    context: { organization: 'Corvo Labs', clientName: input.clientName, operatorName: input.operatorName }, purpose: input.purpose ?? 'participant', consentVersion: 'research-consent-1', choices: CONSENT_CHOICES.map(choice => ({ ...choice })),
    capture: { screen: expected?.screen ? 'expected' : 'optional', controlledDom: expected?.controlledDom ? 'expected' : 'optional', camera: 'optional', alternatePath: expected?.alternatePath ?? 'Continue with text if a device permission is denied.' },
    fallback: input.purpose === 'readiness-test' ? 'This test uses scripted text and browser capture only. Voice, adaptive interviewing and AI analysis are disabled for this session.' : 'Begin with text. Voice is offered only when live checks permit it. Device capture needs a separate choice; continue with text if it is unavailable.',
    deviceNotice: 'Microphone, camera, screen sharing and controlled page activity each need separate consent and browser support. A test on one device does not guarantee support on another.',
    lifecycle: { invitationDays: 7, retentionDays: 30, expiresAt: input.expiresAt ?? null, retainUntil: input.retainUntil ?? null } };
}
export type CaptureTestIssue = { scope: StudyReadinessScope; requestId: string; expectedBinding: string; device: { browser: string; platform: string } };
export type CaptureTestReceipt = { invitationId: string; sessionId: string; requestId: string; scope: StudyReadinessScope; binding: string; configurationDigest: string; issuedAt: number; expiresAt: number; retainUntil: number; device: { browser: string; platform: string }; deviceContext: 'operator-reported'; revokedAt: number | null };
export type CaptureTestTerminal = { input: CaptureTestIssue; reason: 'controlled-dom-authorization-required' | 'operator-closed'; closedAt: number };
export type CaptureTestClosed = { state: 'closed'; terminal: CaptureTestTerminal };
export type CaptureTestPreview = { welcome: StudyWelcome; binding: string; configurationDigest: string; setup: { controlledDomRequired: boolean; controlledDomAuthorized: boolean } };
export const STUDY_TEST_ROUTES = Object.freeze({ close: '/api/research/capture-test/close', preview: '/api/research/study-welcome', issue: '/api/research/capture-test/issue', receipt: '/api/research/capture-test/receipt', status: '/api/research/capture-test/status' });

export const CAPTURE_TEST_STATUS_MAX_AGE_MS = 30_000;
export type CaptureTestStatus = CaptureTestClosed | { state: 'unresolved' } | { state: 'found'; receipt: CaptureTestReceipt; observedAt: number; validUntil: number; current: boolean; reason: string; domConnected: boolean; event: { batchId: string; sequence: number; kind: string; recordedAt: number; generation: number; origin: string } | null; media: Array<{ mediaId: string; modality: string; availableAt: number; bytes: number; sha256: string; mime: string; startMs: number; endMs: number; partial: boolean }>; recording: string; gaps: Array<{ modality: string; reason: string; recordedAt: number }>; cleanup: string };
