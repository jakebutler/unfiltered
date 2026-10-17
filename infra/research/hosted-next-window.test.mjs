import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE, validateInput, assess } from './hosted-next-window.mjs';
const now = 1791660000000;
const input = { schema: 1, baseline: BASE, receiptName: 'stt-preflight-a4', newGrantName: 'research-hosted-stt-a4', sessionId: 'session-0001', studyId: 'study-000001', ownerId: 'owner-000001', question: { id: 'question-001', text: 'What did you see?' }, sessionRevision: 3, participantPath: 'infra/cloud/.private/participant.private.json', liveBaseline: { at: now, providersOff: true, identity: BASE } };
const observation = () => ({ at: now, session: { sessionId: input.sessionId, welcome: { scope: { studyId: input.studyId }, purpose: 'participant' }, state: 'active', revision: 3, question: { id: input.question.id, question: input.question.text }, questionCount: 1, pendingInterview: null, consent: { microphone: true, storage: true, analysis: true } }, admissions: [], envelopes: [], grants: [], sessions: [{ _id: input.sessionId, ownerId: input.ownerId, studyId: input.studyId, revision: 3 }], prospective: { grant: null }, oldA3: { grant: { studyId: input.studyId, enabled: false, chargedSeconds: 60, chargedCharacters: 17 }, sessions: [{ truncated: false, attempts: [{ requestId: '0e42401b-237e-4a7f-9606-dc6dc34a9a1e', provider: 'deepgram', state: 'unknown', reservedSeconds: 60, active: true }, { requestId: '0add2ffb-2809-4977-8669-b943f22579b6', provider: 'elevenlabs', state: 'completed', reservedCharacters: 17, active: false }] }] }, attempts: [{ requestId: '0e42401b-237e-4a7f-9606-dc6dc34a9a1e', state: 'unknown', active: true, transportLease: { leaseId: 'lease-001', generation: 4, owner: 'lease-owner', requestId: 'lease-request' } }], gateway: { slots: [{ lease: { leaseId: 'lease-001', generation: 4, owner: 'lease-owner', requestId: 'lease-request', expiresAt: 0 }, workStarted: false }] } });
test('fresh exact S input; stale scope and old grant names rejected', () => {
  assert.equal(validateInput(input, now), input);
  assert.throws(() => validateInput(input, now + 300001));
  assert.throws(() => validateInput({ ...input, baseline: { ...BASE, deploymentId: 'other' } }, now));
  assert.throws(() => validateInput({ ...input, newGrantName: 'research-hosted-stt-diagnostic-a3' }, now));
});
test('isolated historical fixture is eligible only with positive settled native transport', () => {
  assert.deepEqual(assess(input, observation()), { eligible: true, reasons: [] });
  const o = observation(); o.gateway.slots[0].lease.owner = 'foreign-owner';
  assert.equal(assess(input, o).eligible, false);
  o.gateway.slots[0].lease.generation = 5;
  assert.equal(assess(input, o).eligible, true);
});
test('ordinary admission or enabled owner envelope blocks fixture fallback, even expired', () => {
  const o = observation(); o.admissions.push({ studyId: input.studyId });
  assert.equal(assess(input, o).eligible, false);
  o.admissions = []; o.envelopes.push({ ownerId: input.ownerId, enabled: true, expiresAt: 0 });
  assert.equal(assess(input, o).eligible, false);
});
test('consent, revision, retained charges and other active transport are hard gates', () => {
  for (const mutate of [o => { o.session.consent.microphone = false; }, o => { o.session.revision++; }, o => { o.oldA3.grant.chargedSeconds = 0; }, o => { o.attempts.push({ requestId: 'foreign-attempt', state: 'unknown', active: true }); }, o => { o.prospective.grant = {}; }]) {
    const o = observation(); mutate(o); assert.equal(assess(input, o).eligible, false);
  }
});
