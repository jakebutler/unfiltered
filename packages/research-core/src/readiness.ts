/** Readiness is composed by the authenticated server, never inferred from browser keys or flags. */
export type StudyReadinessScope = { clientId: string; projectId: string; studyId: string; studyVersion: number };
export type StudyCapability = 'scripted-text' | 'goal-aware-interview' | 'voice' | 'private-capture' | 'analysis' | 'screen-baseline' | 'controlled-dom';
export type StudyReadinessState = 'off' | 'setup-required' | 'ready' | 'exhausted' | 'unresolved';
export const STUDY_READINESS_MAX_AGE_MS = 30_000;
export type StudyAllowance = { remaining: number; unit: 'requests' | 'calls' | 'seconds' | 'characters' | 'bytes' | 'storage-operations'; expiresAt: number };
export type StudyCapabilityReadiness = {
  id: StudyCapability;
  label: string;
  state: StudyReadinessState;
  reason: string;
  allowances: StudyAllowance[];
  /** Server gate and preauthorized native allowance must both permit a scoped opt-in. */
  canEnable: boolean;
  canDisable: boolean;
};
export type StudyReadinessSnapshot = {
  scope: StudyReadinessScope;
  /** Opaque CAS binding of saved study version, opt-ins and the server/native envelope identities. */
  revision: string;
  observedAt: number;
  /** Optional only for preserved historical receipts; missing proof is never current. */
  validUntil?: number;
  runtimeConfigurationDigest?: string;
  expiresAt: number | null;
  fallback: string;
  capabilities: StudyCapabilityReadiness[];
  /** Independent deployment gateway ceilings, not child issuance or provider spend. */
  deploymentAllowances?: Array<{ remaining: number; unit: 'requests' | 'bytes' | 'storage-operations'; expiresAt: number }>;
  /** Capacity issued to children, not provider usage or spend. Never reclaimed by OFF. */
  envelope?: { name: string; expiresAt: number; committed: StudyEnvelopeCapacity; remainingUncommitted: StudyEnvelopeCapacity };
};
export type StudyEnvelopeCapacity = { interviewCalls: number; speechSeconds: number; speechCharacters: number; captureBytes: number; analysisCalls: number };
/** Authored by the running gateway, signed with the existing private gateway authority. */
export type StudyRuntimeFacts = {
  revision: string; configurationDigest: string; observedAt: number;
  interview: { enabled: boolean; qualified: boolean; model: 'qwen3.8-max' | 'glm-5.3-flash' | null };
  voice: { enabled: boolean; qualified: boolean };
  capture: { enabled: boolean; qualified: boolean; gatewayAllocationId: string | null; cleanupAllocationId?: string };
  analysis: { enabled: boolean; qualified: boolean; model: 'qwen3.8-max' | 'glm-5.3-flash' | null };
  screenBaselineQualified: boolean;
};
export type StudyReadinessCommand = {
  scope: StudyReadinessScope;
  expectedRevision: string;
  capability: StudyCapability;
  enabled: boolean;
  requestId: string;
};
export type StudyReadinessReceipt = {
  requestId: string;
  command: StudyReadinessCommand;
  state: 'accepted' | 'denied';
  /** Fixed server-authored code, never a provider error or secret-bearing payload. */
  reason: string;
  snapshot: StudyReadinessSnapshot;
};
/** Authenticated server routes; remote availability follows deployment of this source successor. */
export const STUDY_READINESS_ROUTES = Object.freeze({
  snapshot: '/api/research/study-readiness',
  command: '/api/research/study-readiness/command',
  receipt: '/api/research/study-readiness/receipt',
});
/** Receipt lookup uses the exact original command; absence never authorizes redispatch. */
export type StudyReadinessReceiptReadback = { state: 'found'; receipt: StudyReadinessReceipt } | { state: 'unresolved' };
