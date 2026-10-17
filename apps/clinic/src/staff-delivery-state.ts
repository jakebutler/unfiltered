import type { ClinicApiContract, StaffHandoffView, StaffIdentity } from '../../../packages/clinic-contract/src/index';

export type StaffActionRequest = ClinicApiContract['POST /api/staff/handoffs/:id/actions']['body'];
export interface PendingStaffAction {
  handoffId: string;
  author: string;
  request: Readonly<StaffActionRequest>;
  /** Exact local bytes are kept for replay. The authenticated server fingerprint is server-owned. */
  fingerprint: string;
  checked: boolean;
}
export function freezeStaffAction(handoff: StaffHandoffView, identity: StaffIdentity, request: StaffActionRequest): PendingStaffAction {
  const frozen = Object.freeze({ ...request });
  return { handoffId: handoff.id, author: identity.name, request: frozen, fingerprint: JSON.stringify(frozen), checked: false };
}
/** The service returns only authenticated, lineage-verified history; current workflow alone is not proof. */
export function reconcileStaffAction(pending: PendingStaffAction, handoff: StaffHandoffView): 'recorded' | 'unconfirmed' | 'conflict' {
  if (handoff.id !== pending.handoffId || handoff.version !== pending.request.expectedVersion) return 'conflict';
  const history = handoff.work.find(work => work.id === pending.request.workId)?.history ?? [];
  const matches = history.filter(action => action.actionId === pending.request.actionId);
  if (!matches.length) return 'unconfirmed';
  if (matches.length !== 1) return 'conflict';
  const action = matches[0];
  return action.outcome === pending.request.outcome && action.note === pending.request.note && action.author === pending.author ? 'recorded' : 'conflict';
}
/** A successful request from an expired account or selection must never repopulate scoped data. */
export class StaffResponseScope {
  private generation = 0;
  capture() { return this.generation; }
  invalidate() { this.generation += 1; }
  accepts(generation: number) { return generation === this.generation; }
}
export function handoffRevision(handoff: StaffHandoffView) {
  return JSON.stringify([handoff.id, handoff.version, handoff.deliveryState, handoff.anchorsVerified,
    handoff.work.map(work => [work.id, work.revision, work.delivery, work.status])]);
}
