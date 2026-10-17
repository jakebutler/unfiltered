import type { SpeechOutputRequest, SpeechTurnScope } from '../../speech/src/contracts.js';
import type { AuthorizedSpeechText, SpeechLease, SpeechOutcome, SpeechReservation } from '../../speech/src/server.js';

export const researchSpeechPaths = Object.freeze({ input: '/api/research/speech/input', output: '/api/research/speech/output', status: '/api/research/speech/status', receipt: '/api/research/speech/transcript', commit: '/api/research/speech/commit', barrier: '/api/research/speech/settlement' });
export interface ResearchTranscriptReceipt {
  attemptId: string;
  rawSourceId: string;
  text: string;
  promptId: string;
  expectedRevision: number;
}
export type ResearchSpeechScope = SpeechTurnScope;
export type ResearchSpeechTransportLease = { leaseId: string; requestId: string; owner: string; generation: number };
export type ResearchSpeechReservation = SpeechReservation & { transportLease?: ResearchSpeechTransportLease };
export type ResearchSpokenReceipt = { attemptId: string; rawSourceId: string; answerSourceId: string; acceptedRevision: number };
export type ResearchSpeechTerminal = { state: string; active: boolean; rawSaved: boolean; transportSettled: boolean };
export type ResearchSpeechProvider = SpeechReservation['provider'];

/** Research-only domain authority. Implement with authenticated Convex transactions;
 * a process-local ledger cannot satisfy this port. No Medplum identity or storage. */
export interface ResearchSpeechAuthority {
  status(token: string): Promise<{ enabled: boolean; continuous?: boolean; grantName?: string }>;
  authorize(token: string, scope: ResearchSpeechScope, provider: ResearchSpeechProvider): Promise<void>;
  /** Atomic, fully charged reservation bound to exact question/revision/consent.
   * Duplicate/unknown attempts are denied, never a free provider replay. */
  reserve(token: string, scope: ResearchSpeechScope, reservation: ResearchSpeechReservation): Promise<SpeechLease>;
  /** Recheck current capability, active session, revision, prompt and consent. */
  inspect(token: string, scope: ResearchSpeechScope, provider: ResearchSpeechProvider): Promise<void>;
  /** Save raw recognition once without advancing the script. Reconcile the exact
   * attempt on an uncertain write; a receipt never means participant acceptance. */
  transcript(token: string, scope: ResearchSpeechScope, text: string, outcome: SpeechOutcome): Promise<ResearchTranscriptReceipt>;
  /** Read the original saved result. No provider dispatch or transcript rewrite. */
  receipt(token: string, scope: ResearchSpeechScope): Promise<ResearchTranscriptReceipt | null>;
  terminalBarrier?(token: string, scope: ResearchSpeechScope, provider?: ResearchSpeechProvider): Promise<ResearchSpeechTerminal>;
  commitSpoken?(token: string, scope: ResearchSpeechScope): Promise<ResearchSpokenReceipt>;
  /** Resolve only the current actual interviewer prompt. No browser-supplied text. */
  output(token: string, input: SpeechOutputRequest): Promise<AuthorizedSpeechText>;
}
