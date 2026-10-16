import { afterEach, expect, it, vi } from 'vitest';
import { runOfflineInvitationSmoke } from '../../../scripts/dev/invitations-local-smoke.mts';
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('walks named staff issue, acknowledged redemption, exact patient/workflow and identity gating without external I/O', async () => {
  const external = vi.fn(() => { throw new Error('External I/O forbidden'); }); vi.stubGlobal('fetch', external);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await runOfflineInvitationSmoke()).toEqual({ mode: 'offline', coverage: 'named-staff-invitation-to-bound-patient-session', syntheticAcknowledgmentRequired: true, identityConfirmationRequired: true, singleUse: true, replayHasNoLink: true, exactPatientAndWorkflow: true, email: 'copy-only' });
  expect(external).not.toHaveBeenCalled();
});
