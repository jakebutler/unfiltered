/** Offline invitation harness. Every native/auth request stays in memory; no email or providers. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeHttpHandler } from '../../apps/clinic-server/src/http.js';
import { readDraft } from '../../packages/clinic-api/src/store.js';
import type { ClinicSessionView } from '../../packages/clinic-contract/src/index.js';
import type { InvitationIssueView } from '../../packages/clinic-contract/src/invitations.js';
import { createOfflinePhq4Clinic, requireOfflineArguments } from './phq4-local-smoke.mts';

export async function createOfflineInvitationClinic() {
  const clinic = await createOfflinePhq4Clinic();
  // A different default patient for pre-visit proves invitation identity is carried explicitly.
  clinic.config.patients['pre-visit'] = { ...clinic.config.patients['pre-visit'], reference: 'Patient/other-default-synthetic', displayName: 'Other default patient (synthetic)' };
  return clinic;
}

export async function runOfflineInvitationSmoke() {
  const { handler, origin, client, assignment, config } = await createOfflineInvitationClinic();
  async function call(path: string, body?: unknown, cookie = '') {
    return handler(new Request(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { origin, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  }
  const login = await call('/api/staff/login', { email: 'synthetic-md@example.invalid', password: 'local-smoke-only' });
  assert.equal(login.status, 200);
  const staffCookie = login.headers.get('set-cookie')!.split(';')[0];
  const request = { patient: assignment.patients[0], scenario: 'pre-visit', requestId: crypto.randomUUID() };
  const issue = await call('/api/clinic/staff/invitations', request, staffCookie);
  assert.equal(issue.status, 201);
  const invitation = await issue.json() as InvitationIssueView;
  assert.equal(invitation.emailStatus, 'copy-only'); assert(invitation.link);
  const token = new URLSearchParams(new URL(invitation.link).hash.slice(1)).get('token')!;
  const noAck = await call('/api/clinic/invitations/redeem', { token });
  assert.equal(noAck.status, 400); assert.equal(noAck.headers.get('set-cookie'), null);
  const redeemed = await call('/api/clinic/invitations/redeem', { token, syntheticAcknowledged: true });
  assert.equal(redeemed.status, 201);
  const session = await redeemed.json() as ClinicSessionView;
  const patientCookie = redeemed.headers.get('set-cookie')!.split(';')[0];
  assert.equal(session.scenario, 'pre-visit'); assert.equal(session.phase, 'identity');
  assert.equal(session.persona.displayName, config.patients['first-intake'].displayName);
  const stored = await readDraft(client, session.id, assignment.patients[0]);
  assert.equal(stored.draft.invitationId, invitation.invitationId);
  assert.equal((await call('/api/clinic/review', { expectedRevision: session.revision }, patientCookie)).status, 403);
  assert.equal((await call('/api/clinic/confirm-identity', { confirmed: true }, patientCookie)).status, 200);
  assert.equal((await call('/api/clinic/invitations/redeem', { token, syntheticAcknowledged: true })).status, 410);
  const replay = await call('/api/clinic/staff/invitations', request, staffCookie);
  const receipt = await replay.json() as InvitationIssueView;
  assert.equal(receipt.link, undefined); assert.equal(receipt.emailStatus, 'not-repeated');
  return { mode: 'offline' as const, coverage: 'named-staff-invitation-to-bound-patient-session' as const, syntheticAcknowledgmentRequired: true, identityConfirmationRequired: true, singleUse: true, replayHasNoLink: true, exactPatientAndWorkflow: true, email: 'copy-only' as const };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  requireOfflineArguments(process.argv.slice(2));
  if (process.argv.includes('--serve-local')) {
    const { handler } = await createOfflineInvitationClinic();
    createServer(nodeHttpHandler(handler)).listen(8787, '127.0.0.1', () => {
      console.log('Synthetic offline invitation backend on 127.0.0.1:8787; use clinic:dev on 127.0.0.1:5173');
      console.log('Staff fixture: synthetic-md@example.invalid / local-smoke-only (mock auth only)');
    });
  } else console.log(JSON.stringify(await runOfflineInvitationSmoke(), null, 2));
}
