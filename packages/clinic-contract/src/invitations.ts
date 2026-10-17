import type { ScenarioId } from './index.js';
export interface InvitationOptionsView {
  patients: { reference: string; displayName: string; scenarios: ScenarioId[] }[];
  workflows: { id: ScenarioId; title: string }[];
}
export interface InvitationIssueView {
  invitationId: string;
  expiresAt: string;
  /** Available only for the first acknowledged native conditional insert. */
  link?: string;
  emailStatus: 'sent' | 'failed' | 'copy-only' | 'not-repeated';
}
